'use strict';
// ============================================================
//  Publicidad local ($800/mes por anunciante: semillas, fertilizantes, maquinaria)
//   GET  /api/publicidad?ubicacion=INICIO|CATALOGO → anuncios vigentes (cuenta impresiones)
//   POST /api/publicidad/:id/clic                  → cuenta un clic
//   GET  /api/publicidad/admin                     → (ADMIN) todos, con impresiones y clics
//   POST /api/publicidad/admin · PUT /api/publicidad/admin/:id
// ============================================================
const express = require('express');
const db = require('../config/db');
const { HttpError, ah, uuid, num, texto } = require('../utils/http');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', ah(async (req, res) => {
  const ub = String(req.query.ubicacion || 'INICIO').toUpperCase();
  const rows = await db.q(req.ctx,
    `SELECT id_anunciante, nombre, giro, mensaje, url, imagen_url FROM v_anuncio_activo
      WHERE ubicacion IN ($1, 'AMBOS') ORDER BY random() LIMIT 3`, [ub === 'CATALOGO' ? 'CATALOGO' : 'INICIO']);
  for (const a of rows) await db.q(db.ANON, 'SELECT fn_anuncio_evento($1, $2)', [a.id_anunciante, 'IMPRESION']);
  res.json(rows);
}));

router.post('/:id/clic', ah(async (req, res) => {
  await db.q(db.ANON, 'SELECT fn_anuncio_evento($1, $2)', [uuid(req.params.id), 'CLIC']);
  res.json({ ok: true });
}));

router.get('/admin', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  res.json(await db.q(req.ctx,
    `SELECT a.*, (current_date BETWEEN a.fecha_inicio AND a.fecha_fin AND a.estado = 'ACTIVO') AS vigente,
            CASE WHEN a.impresiones > 0 THEN round(100.0 * a.clics / a.impresiones, 1) ELSE 0 END::float8 AS ctr
       FROM anunciante a ORDER BY a.fecha_fin DESC`));
}));

function leer(b) {
  const r = {
    nombre: texto(b.nombre, 'Nombre del anunciante', { max: 150 }),
    giro: texto(b.giro, 'Giro', { max: 60, requerido: false }) || 'Insumos agrícolas',
    contacto: texto(b.contacto, 'Contacto', { max: 150, requerido: false }),
    mensaje: texto(b.mensaje, 'Mensaje', { max: 160 }),
    url: texto(b.url, 'Enlace', { max: 500, requerido: false }),
    imagen_url: texto(b.imagen_url, 'Imagen', { max: 500, requerido: false }),
    ubicacion: String(b.ubicacion || 'AMBOS').toUpperCase(),
    cuota_mensual: b.cuota_mensual === undefined || b.cuota_mensual === '' ? null : num(b.cuota_mensual, 'Cuota', { min: 0, max: 100000 }),
    fecha_inicio: b.fecha_inicio ? String(b.fecha_inicio).slice(0, 10) : null,
    fecha_fin: b.fecha_fin ? String(b.fecha_fin).slice(0, 10) : null,
  };
  if (r.url && !/^https?:\/\//i.test(r.url)) throw new HttpError(400, 'El enlace debe empezar con http:// o https://');
  if (!['INICIO', 'CATALOGO', 'AMBOS'].includes(r.ubicacion)) throw new HttpError(400, 'Ubicación inválida');
  for (const f of ['fecha_inicio', 'fecha_fin']) if (r[f] && !/^\d{4}-\d{2}-\d{2}$/.test(r[f])) throw new HttpError(400, 'Fecha inválida');
  return r;
}

router.post('/admin', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const a = leer(req.body || {});
  const row = await db.one(req.ctx,
    `INSERT INTO anunciante(nombre, giro, contacto, mensaje, url, imagen_url, ubicacion, cuota_mensual, fecha_inicio, fecha_fin)
     VALUES ($1,$2,$3,$4,$5,$6,$7, coalesce($8, fn_param('publicidad_precio')), coalesce($9::date, current_date),
             coalesce($10::date, current_date + 30)) RETURNING id_anunciante`,
    [a.nombre, a.giro, a.contacto, a.mensaje, a.url, a.imagen_url, a.ubicacion, a.cuota_mensual, a.fecha_inicio, a.fecha_fin]);
  res.status(201).json(row);
}));

router.put('/admin/:id', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const b = req.body || {};
  const id = uuid(req.params.id);
  if (b.estado && Object.keys(b).length === 1) {
    const e = String(b.estado).toUpperCase();
    if (!['ACTIVO', 'PAUSADO'].includes(e)) throw new HttpError(400, 'Estado inválido');
    const row = await db.one(req.ctx, 'UPDATE anunciante SET estado = $2 WHERE id_anunciante = $1 RETURNING id_anunciante, estado', [id, e]);
    if (!row) throw new HttpError(404, 'Anunciante no encontrado');
    return res.json(row);
  }
  const a = leer(b);
  const row = await db.one(req.ctx,
    `UPDATE anunciante SET nombre = $2, giro = $3, contacto = $4, mensaje = $5, url = $6, imagen_url = $7, ubicacion = $8,
            cuota_mensual = coalesce($9, cuota_mensual), fecha_inicio = coalesce($10::date, fecha_inicio),
            fecha_fin = coalesce($11::date, fecha_fin)
      WHERE id_anunciante = $1 RETURNING id_anunciante`,
    [id, a.nombre, a.giro, a.contacto, a.mensaje, a.url, a.imagen_url, a.ubicacion, a.cuota_mensual, a.fecha_inicio, a.fecha_fin]);
  if (!row) throw new HttpError(404, 'Anunciante no encontrado');
  res.json(row);
}));

module.exports = router;
