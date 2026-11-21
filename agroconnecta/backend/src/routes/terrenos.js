'use strict';
// ============================================================
//  Terrenos (PostGIS)
//  GET  /api/terrenos?q=&operacion=&lat=&lng=&radio_km=   → búsqueda por cercanía con ST_DWithin
//  GET  /api/terrenos/:id                                 → detalle + contacto (con sesión)
//  POST /api/terrenos · PUT /api/terrenos/:id · PUT /api/terrenos/:id/estado   (VENDEDOR dueño / ADMIN)
// ============================================================
const express = require('express');
const db = require('../config/db');
const { HttpError, ah, uuid, num, texto, paginacion } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const { resolverImagen } = require('../services/imagenes');
const { descifrar } = require('../utils/seguridad');

const router = express.Router();

const CAMPOS = `id_terreno AS id, id_vendedor, titulo, superficie_ha AS superficie, ubicacion, lat, lng, precio, moneda,
  tipo_operacion AS operacion, estado, tags, fecha_publicacion, imagen, vendedor_nombre, vendedor_verificado, vendedor_rating`;

router.get('/', ah(async (req, res) => {
  const { q = '', operacion = '', estado = 'DISPONIBLE' } = req.query;
  const { limit, offset } = paginacion(req.query, 100);
  const params = [];
  const where = [];
  if (estado) { params.push(String(estado).toUpperCase()); where.push(`estado = $${params.length}`); }
  if (operacion) { params.push(String(operacion).toUpperCase()); where.push(`tipo_operacion = $${params.length}`); }
  if (q.trim()) {
    params.push(q.trim().slice(0, 100));
    where.push(`unaccent(lower(concat_ws(' ', titulo, ubicacion, descripcion, vendedor_nombre, array_to_string(tags, ' '))))
                LIKE '%' || unaccent(lower($${params.length})) || '%'`);
  }
  let distancia = 'NULL::float8 AS distancia_km';
  let orden = 'fecha_publicacion DESC';
  if (req.query.lat && req.query.lng) {
    params.push(num(req.query.lng, 'lng', { min: -180, max: 180 }), num(req.query.lat, 'lat', { min: -90, max: 90 }));
    const punto = `ST_SetSRID(ST_MakePoint($${params.length - 1}::float8, $${params.length}::float8), 4326)::geography`;
    distancia = `round((ST_Distance(geom::geography, ${punto}) / 1000)::numeric, 1)::float8 AS distancia_km`;
    orden = 'distancia_km ASC';
    if (req.query.radio_km) {
      params.push(num(req.query.radio_km, 'radio_km', { min: 1, max: 2000 }) * 1000);
      where.push(`ST_DWithin(geom::geography, ${punto}, $${params.length}::float8)`);
    }
  }
  params.push(limit, offset);
  res.json(await db.q(req.ctx,
    `SELECT ${CAMPOS}, ${distancia} FROM v_terreno_catalogo
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${orden} LIMIT $${params.length - 1} OFFSET $${params.length}`, params));
}));

router.get('/:id', ah(async (req, res) => {
  const id = uuid(req.params.id);
  const t = await db.tx(req.ctx, async c => {
    const r = (await c.query(`SELECT ${CAMPOS}, descripcion FROM v_terreno_catalogo WHERE id_terreno = $1`, [id])).rows[0];
    if (!r) return null;
    r.imagenes = (await c.query(
      'SELECT id_imagen, url, es_principal, orden FROM terreno_imagen WHERE id_terreno = $1 ORDER BY es_principal DESC, orden', [id])).rows;
    if (req.user) {
      const k = (await c.query('SELECT * FROM fn_contacto_terreno($1)', [r.id_terreno || id])).rows[0];
      if (k) r.contacto = { nombre: k.nombre, email: k.email, telefono: descifrar(k.telefono_cifrado) };
    }
    return r;
  });
  if (!t) throw new HttpError(404, 'Terreno no encontrado');
  res.json(t);
}));

function leerTerreno(b, parcial = false) {
  const r = {};
  if (!parcial || b.titulo !== undefined) r.titulo = texto(b.titulo, 'Título', { max: 300 });
  if (!parcial || b.descripcion !== undefined) r.descripcion = texto(b.descripcion, 'Descripción', { max: 5000, requerido: false });
  if (!parcial || b.superficie_ha !== undefined) r.superficie_ha = num(b.superficie_ha, 'Superficie', { min: 0.01, max: 99999999 });
  if (!parcial || b.ubicacion !== undefined) r.ubicacion = texto(b.ubicacion, 'Ubicación', { max: 300 });
  if (!parcial || b.precio !== undefined) r.precio = num(b.precio, 'Precio', { min: 0.01, max: 999999999999 });
  if (!parcial || b.tipo_operacion !== undefined) {
    r.tipo_operacion = String(b.tipo_operacion || '').toUpperCase();
    if (!['VENTA', 'ARRENDAMIENTO'].includes(r.tipo_operacion)) throw new HttpError(400, 'Operación inválida');
  }
  if (!parcial || b.lat !== undefined) {
    r.lat = num(b.lat, 'Latitud', { min: -90, max: 90 });
    r.lng = num(b.lng, 'Longitud', { min: -180, max: 180 });
  }
  if (b.estado !== undefined) {
    r.estado = String(b.estado).toUpperCase();
    if (!['DISPONIBLE', 'VENDIDO', 'ARRENDADO', 'INACTIVO'].includes(r.estado)) throw new HttpError(400, 'Estado inválido');
  }
  if (b.tags !== undefined) {
    r.tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(','))
      .map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 15);
  }
  return r;
}

async function guardarImagenes(c, id, lista) {
  if (lista === undefined) return;
  const arr = (Array.isArray(lista) ? lista : [lista]).map(x => String(x || '').trim()).filter(Boolean).slice(0, 6);
  const imgs = [];
  for (const e of arr) imgs.push(await resolverImagen(e));
  await c.query('DELETE FROM terreno_imagen WHERE id_terreno = $1', [id]);
  let orden = 1;
  for (const img of imgs) {
    await c.query(
      `INSERT INTO terreno_imagen(id_terreno, url, url_origen, sha256, origen, es_principal, orden) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, img.url, img.url_origen, img.sha256, img.origen, orden === 1, orden]);
    orden++;
  }
}

router.post('/', requireRole('VENDEDOR'), ah(async (req, res) => {
  const t = leerTerreno(req.body || {});
  const row = await db.tx(req.ctx, async c => {
    const r = (await c.query(
      `INSERT INTO terreno(id_vendedor, titulo, descripcion, superficie_ha, ubicacion, geom, precio, tipo_operacion,
                           estado, tags, modificado_por)
       VALUES ($1,$2,$3,$4,$5, ST_SetSRID(ST_MakePoint($6::float8, $7::float8), 4326), $8, $9,
               coalesce($10,'DISPONIBLE'), coalesce($11,'{}'::text[]), $12)
       RETURNING id_terreno`,
      [req.ctx.rol_id, t.titulo, t.descripcion, t.superficie_ha, t.ubicacion, t.lng, t.lat, t.precio,
       t.tipo_operacion, t.estado || null, t.tags || null, req.user.id_usuario])).rows[0];
    await guardarImagenes(c, r.id_terreno, req.body.imagenes || []);
    return r;
  });
  res.status(201).json({ id: row.id_terreno, message: 'Terreno publicado' });
}));

router.put('/:id', requireRole('VENDEDOR', 'ADMINISTRADOR'), ah(async (req, res) => {
  const id = uuid(req.params.id);
  const t = leerTerreno(req.body || {}, true);
  const ok = await db.tx(req.ctx, async c => {
    const r = await c.query(
      `UPDATE terreno SET titulo = coalesce($2, titulo),
          descripcion = CASE WHEN $3::boolean THEN $4 ELSE descripcion END,
          superficie_ha = coalesce($5, superficie_ha), ubicacion = coalesce($6, ubicacion),
          geom = CASE WHEN $7::float8 IS NULL THEN geom ELSE ST_SetSRID(ST_MakePoint($8::float8, $7::float8), 4326) END,
          precio = coalesce($9, precio), tipo_operacion = coalesce($10, tipo_operacion),
          estado = coalesce($11, estado), tags = coalesce($12, tags), modificado_por = $13
        WHERE id_terreno = $1 RETURNING id_terreno`,
      [id, t.titulo ?? null, t.descripcion !== undefined, t.descripcion ?? null, t.superficie_ha ?? null,
       t.ubicacion ?? null, t.lat ?? null, t.lng ?? null, t.precio ?? null, t.tipo_operacion ?? null,
       t.estado ?? null, t.tags ?? null, req.user.id_usuario]);
    if (!r.rowCount) return false;
    await guardarImagenes(c, id, req.body.imagenes);
    return true;
  });
  if (!ok) throw new HttpError(404, 'Terreno no encontrado o sin permiso');
  res.json({ id, message: 'Terreno actualizado' });
}));

router.put('/:id/estado', requireRole('VENDEDOR', 'ADMINISTRADOR'), ah(async (req, res) => {
  const id = uuid(req.params.id);
  const estado = String((req.body || {}).estado || '').toUpperCase();
  if (!['DISPONIBLE', 'VENDIDO', 'ARRENDADO', 'INACTIVO'].includes(estado)) throw new HttpError(400, 'Estado inválido');
  const row = await db.one(req.ctx,
    'UPDATE terreno SET estado = $2, modificado_por = $3 WHERE id_terreno = $1 RETURNING id_terreno, estado',
    [id, estado, req.user.id_usuario]);
  if (!row) throw new HttpError(404, 'Terreno no encontrado o sin permiso');
  res.json(row);
}));

module.exports = router;
