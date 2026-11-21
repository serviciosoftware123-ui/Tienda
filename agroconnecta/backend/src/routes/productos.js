'use strict';
// ============================================================
//  GET  /api/productos              → catálogo con filtros (q, categoria, vendedor, cerca de lat/lng)
//  GET  /api/productos/:id          → detalle + imágenes + reseñas del vendedor
//  POST /api/productos/lote         → precios/stock vigentes de varios productos (carrito)
//  POST /api/productos              → crear (VENDEDOR)
//  PUT  /api/productos/:id          → editar (dueño o ADMIN) — incluye imágenes
//  PUT  /api/productos/:id/estado   → ACTIVO | INACTIVO | AGOTADO (soft delete)
// ============================================================
const express = require('express');
const db = require('../config/db');
const { HttpError, ah, uuid, num, texto, paginacion } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const { resolverImagen } = require('../services/imagenes');

const router = express.Router();

const CAMPOS = `id_producto AS id, id_vendedor, id_categoria, nombre, precio, stock, unidad_medida AS unidad,
  moneda, estado, tags, fecha_publicacion, ubicacion, lat, lng, categoria, categoria_tipo, imagen,
  vendedor_nombre, vendedor_verificado, vendedor_ubicacion, vendedor_rating, vendedor_ventas, vendedor_calificaciones,
  vendedor_perfil, vendedor_premium, tasa_iva, id_parcela, parcela_nombre, parcela_cultivo, parcela_ha`;

router.get('/', ah(async (req, res) => {
  const { q = '', categoria = '', estado = '', vendedor = '', orden = 'recientes' } = req.query;
  const { limit, offset } = paginacion(req.query, 100);
  const params = [];
  const where = [];
  if (q.trim()) {
    params.push(q.trim().slice(0, 100));
    where.push(`unaccent(lower(concat_ws(' ', nombre, categoria, vendedor_nombre, ubicacion,
                 array_to_string(tags, ' '), descripcion))) LIKE '%' || unaccent(lower($${params.length})) || '%'`);
  }
  if (categoria) {
    params.push(categoria);
    where.push(/^[0-9a-f-]{36}$/i.test(categoria) ? `id_categoria = $${params.length}::uuid` : `categoria = $${params.length}`);
  }
  if (estado) { params.push(String(estado).toUpperCase()); where.push(`estado = $${params.length}`); }
  if (vendedor) { params.push(uuid(vendedor, 'vendedor')); where.push(`id_vendedor = $${params.length}`); }
  // «Directo del productor»: oculta lo que publican los acopiadores
  if (req.query.directo === '1' || req.query.directo === 'true') where.push(`vendedor_perfil = 'PRODUCTOR'`);

  // Búsqueda geográfica con PostGIS (distancia real en km sobre la esfera)
  let distancia = 'NULL::float8 AS distancia_km';
  if (req.query.lat && req.query.lng) {
    const lat = num(req.query.lat, 'lat', { min: -90, max: 90 });
    const lng = num(req.query.lng, 'lng', { min: -180, max: 180 });
    params.push(lng, lat);
    const punto = `ST_SetSRID(ST_MakePoint($${params.length - 1}::float8, $${params.length}::float8), 4326)::geography`;
    distancia = `round((ST_Distance(ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, ${punto}) / 1000)::numeric, 1)::float8 AS distancia_km`;
    if (req.query.radio_km) {
      params.push(num(req.query.radio_km, 'radio_km', { min: 1, max: 2000 }) * 1000);
      where.push(`ST_DWithin(ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, ${punto}, $${params.length}::float8)`);
    }
  }
  // Los vendedores Premium aparecen primero (posicionamiento destacado)
  const ordenes = {
    recientes: 'vendedor_premium DESC, fecha_publicacion DESC', precio_asc: 'precio ASC', precio_desc: 'precio DESC',
    rating: 'vendedor_rating DESC, fecha_publicacion DESC', cercania: 'distancia_km ASC NULLS LAST',
  };
  params.push(limit, offset);
  const rows = await db.q(req.ctx,
    `SELECT ${CAMPOS}, ${distancia} FROM v_producto_catalogo
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${ordenes[orden] || ordenes.recientes}
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json(rows);
}));

router.post('/lote', ah(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 100).map(i => uuid(i)) : [];
  if (!ids.length) return res.json([]);
  res.json(await db.q(req.ctx, `SELECT ${CAMPOS} FROM v_producto_catalogo WHERE id_producto = ANY($1::uuid[])`, [ids]));
}));

router.get('/:id', ah(async (req, res) => {
  const id = uuid(req.params.id);
  const out = await db.tx(req.ctx, async c => {
    let p = (await c.query(`SELECT ${CAMPOS}, descripcion FROM v_producto_catalogo WHERE id_producto = $1`, [id])).rows[0];
    if (!p) {
      // El dueño (o admin) también puede ver sus productos INACTIVOS
      p = (await c.query(
        `SELECT p.id_producto AS id, p.id_vendedor, p.id_categoria, p.nombre, p.descripcion, p.precio, p.stock,
                p.unidad_medida AS unidad, p.estado, p.tags, p.ubicacion, ST_Y(p.geom) AS lat, ST_X(p.geom) AS lng,
                c.nombre AS categoria, v.nombre_negocio AS vendedor_nombre, 0::float8 AS vendedor_rating, 0 AS vendedor_ventas,
                v.perfil AS vendedor_perfil, v.verificado AS vendedor_verificado, p.id_parcela,
                coalesce(p.tasa_iva, c.tasa_iva)::float8 AS tasa_iva, p.tasa_iva AS tasa_iva_producto
           FROM producto p JOIN categoria c USING (id_categoria) JOIN vendedor v USING (id_vendedor)
          WHERE p.id_producto = $1 AND (p.id_vendedor = app_rol_id() OR es_admin())`, [id])).rows[0];
    }
    if (!p) return null;
    p.imagenes = (await c.query(
      `SELECT id_imagen, url, es_principal, orden, origen FROM producto_imagen
        WHERE id_producto = $1 ORDER BY es_principal DESC, orden`, [id])).rows;
    if (!p.imagen && p.imagenes[0]) p.imagen = p.imagenes[0].url;
    p.calificaciones = (await c.query(
      `SELECT comprador AS usuario, puntuacion, comentario, fecha, productos
         FROM v_calificacion_publica WHERE id_vendedor = $1 ORDER BY fecha DESC LIMIT 10`, [p.id_vendedor])).rows;
    return p;
  });
  if (!out) throw new HttpError(404, 'Producto no encontrado');
  res.json(out);
}));

function leerProducto(b, parcial = false) {
  const r = {};
  if (!parcial || b.nombre !== undefined) r.nombre = texto(b.nombre, 'Nombre', { max: 200 });
  if (!parcial || b.descripcion !== undefined) r.descripcion = texto(b.descripcion, 'Descripción', { max: 5000, requerido: false });
  if (!parcial || b.precio !== undefined) r.precio = num(b.precio, 'Precio', { min: 0.01, max: 9999999999 });
  if (!parcial || b.stock !== undefined) r.stock = num(b.stock, 'Stock', { min: 0, max: 9999999999 });
  if (!parcial || b.unidad_medida !== undefined) r.unidad_medida = texto(b.unidad_medida, 'Unidad', { max: 30 });
  if (!parcial || b.id_categoria !== undefined) r.id_categoria = uuid(b.id_categoria, 'Categoría');
  if (b.estado !== undefined) {
    r.estado = String(b.estado).toUpperCase();
    if (!['ACTIVO', 'INACTIVO', 'AGOTADO'].includes(r.estado)) throw new HttpError(400, 'Estado inválido');
  }
  if (b.ubicacion !== undefined) r.ubicacion = texto(b.ubicacion, 'Ubicación', { max: 300, requerido: false });
  if (b.lat !== undefined && b.lat !== '' && b.lat !== null && b.lng !== undefined && b.lng !== '' && b.lng !== null) {
    r.lat = num(b.lat, 'Latitud', { min: -90, max: 90 });
    r.lng = num(b.lng, 'Longitud', { min: -180, max: 180 });
  }
  if (b.id_parcela !== undefined) r.id_parcela = b.id_parcela ? uuid(b.id_parcela, 'Parcela') : null;
  if (b.tasa_iva !== undefined) {
    // '' o null = la tasa de la categoría; 0 = tasa 0 % (art. 2-A LIVA); 0.16 = tasa general
    if (b.tasa_iva === '' || b.tasa_iva === null || b.tasa_iva === 'CATEGORIA') r.tasa_iva = null;
    else {
      r.tasa_iva = Number(b.tasa_iva);
      if (![0, 0.16].includes(r.tasa_iva)) throw new HttpError(400, 'Tasa de IVA inválida (0 o 0.16)');
    }
  }
  if (b.tags !== undefined) {
    const t = Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',');
    r.tags = t.map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 15);
  }
  return r;
}

async function resolverImagenes(lista) {
  if (lista === undefined) return undefined;
  const arr = (Array.isArray(lista) ? lista : [lista]).map(x => String(x || '').trim()).filter(Boolean).slice(0, 6);
  const out = [];
  for (const entrada of arr) out.push(await resolverImagen(entrada));   // descarga los links pegados
  return out;
}

async function guardarImagenes(c, idProducto, imagenes) {
  if (imagenes === undefined) return;
  await c.query('DELETE FROM producto_imagen WHERE id_producto = $1', [idProducto]);
  let orden = 1;
  for (const img of imagenes) {
    await c.query(
      `INSERT INTO producto_imagen(id_producto, url, url_origen, sha256, origen, es_principal, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [idProducto, img.url, img.url_origen, img.sha256, img.origen, orden === 1, orden]);
    orden++;
  }
}

router.post('/', requireRole('VENDEDOR'), ah(async (req, res) => {
  const p = leerProducto(req.body || {});
  const imagenes = await resolverImagenes(req.body.imagenes || []);
  const row = await db.tx(req.ctx, async c => {
    const r = (await c.query(
      `INSERT INTO producto(id_vendedor, id_categoria, nombre, descripcion, precio, stock, unidad_medida, estado,
                            ubicacion, geom, tags, modificado_por, id_parcela, tasa_iva)
       VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'ACTIVO'),$9,
               CASE WHEN $10::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($11::float8, $10::float8), 4326) END,
               coalesce($12, '{}'::text[]), $13, $14, $15)
       RETURNING id_producto`,
      [req.ctx.rol_id, p.id_categoria, p.nombre, p.descripcion, p.precio, p.stock, p.unidad_medida, p.estado || null,
       p.ubicacion || null, p.lat ?? null, p.lng ?? null, p.tags || null, req.user.id_usuario,
       p.id_parcela ?? null, p.tasa_iva ?? null])).rows[0];
    await guardarImagenes(c, r.id_producto, imagenes);
    return r;
  });
  res.status(201).json({ id: row.id_producto, message: 'Producto publicado' });
}));

router.put('/:id', requireRole('VENDEDOR', 'ADMINISTRADOR'), ah(async (req, res) => {
  const id = uuid(req.params.id);
  const p = leerProducto(req.body || {}, true);
  const imagenes = await resolverImagenes(req.body.imagenes);
  const ok = await db.tx(req.ctx, async c => {
    const r = await c.query(
      `UPDATE producto SET
          nombre = coalesce($2, nombre), descripcion = CASE WHEN $3::boolean THEN $4 ELSE descripcion END,
          precio = coalesce($5, precio), stock = coalesce($6, stock), unidad_medida = coalesce($7, unidad_medida),
          id_categoria = coalesce($8, id_categoria), estado = coalesce($9, estado),
          ubicacion = CASE WHEN $10::boolean THEN $11 ELSE ubicacion END,
          geom = CASE WHEN $12::float8 IS NULL THEN geom ELSE ST_SetSRID(ST_MakePoint($13::float8, $12::float8), 4326) END,
          tags = coalesce($14, tags), modificado_por = $15,
          id_parcela = CASE WHEN $16::boolean THEN $17::uuid ELSE id_parcela END,
          tasa_iva = CASE WHEN $18::boolean THEN $19::numeric ELSE tasa_iva END
        WHERE id_producto = $1 RETURNING id_producto`,
      [id, p.nombre ?? null, p.descripcion !== undefined, p.descripcion ?? null, p.precio ?? null, p.stock ?? null,
       p.unidad_medida ?? null, p.id_categoria ?? null, p.estado ?? null, p.ubicacion !== undefined, p.ubicacion ?? null,
       p.lat ?? null, p.lng ?? null, p.tags ?? null, req.user.id_usuario,
       p.id_parcela !== undefined, p.id_parcela ?? null, p.tasa_iva !== undefined, p.tasa_iva ?? null]);
    if (!r.rowCount) return false;
    await guardarImagenes(c, id, imagenes);
    return true;
  });
  if (!ok) throw new HttpError(404, 'Producto no encontrado o sin permiso');
  res.json({ id, message: 'Producto actualizado' });
}));

router.put('/:id/estado', requireRole('VENDEDOR', 'ADMINISTRADOR'), ah(async (req, res) => {
  const id = uuid(req.params.id);
  const estado = String((req.body || {}).estado || '').toUpperCase();
  if (!['ACTIVO', 'INACTIVO', 'AGOTADO'].includes(estado)) throw new HttpError(400, 'Estado inválido');
  const row = await db.one(req.ctx,
    `UPDATE producto SET estado = $2, modificado_por = $3 WHERE id_producto = $1 RETURNING id_producto, estado`,
    [id, estado, req.user.id_usuario]);
  if (!row) throw new HttpError(404, 'Producto no encontrado o sin permiso');
  res.json(row);
}));

module.exports = router;
