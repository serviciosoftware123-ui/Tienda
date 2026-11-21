'use strict';
// ============================================================
//  Parcelas del productor (candado «Parcela y venta coherentes»)
//  GET  /api/parcelas/cultivos      → cultivos con rendimiento de referencia (t/ha/año)
//  GET  /api/parcelas               → mis parcelas con volumen publicado vs. esperado (VENDEDOR)
//  POST /api/parcelas               → registrar parcela
//  PUT  /api/parcelas/:id           → editar
//  PUT  /api/parcelas/:id/estado    → ACTIVA | INACTIVA
//  Si lo publicado supera la producción anual esperada × 1.2, la BD crea una alerta para el admin.
// ============================================================
const express = require('express');
const db = require('../config/db');
const { HttpError, ah, uuid, num, texto } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const { coordenadas } = require('../utils/municipios');

const router = express.Router();
const TENENCIAS = ['PROPIA', 'EJIDAL', 'ARRENDADA', 'COMUNAL'];

router.get('/cultivos', ah(async (req, res) => {
  res.json(await db.q(req.ctx, 'SELECT cultivo, rendimiento_t_ha::float8 AS rendimiento_t_ha, fuente FROM cultivo_referencia ORDER BY cultivo'));
}));

router.get('/', requireRole('VENDEDOR', 'ADMINISTRADOR'), ah(async (req, res) => {
  const idv = req.user.tipo_usuario === 'VENDEDOR' ? req.ctx.rol_id : (req.query.vendedor ? uuid(req.query.vendedor) : null);
  res.json(await db.q(req.ctx,
    `SELECT pa.id_parcela, pa.id_vendedor, pa.nombre, pa.municipio, pa.superficie_ha::float8 AS superficie_ha, pa.cultivo,
            pa.tenencia, pa.estado, ST_Y(pa.geom) AS lat, ST_X(pa.geom) AS lng, cr.rendimiento_t_ha::float8 AS rendimiento_t_ha,
            round(pa.superficie_ha * cr.rendimiento_t_ha, 1)::float8 AS produccion_anual_t,
            (SELECT round(coalesce(sum(fn_a_toneladas(p.stock, p.unidad_medida)), 0), 2) FROM producto p
              WHERE p.id_parcela = pa.id_parcela AND p.estado <> 'INACTIVO')::float8 AS publicado_t,
            (SELECT count(*) FROM producto p WHERE p.id_parcela = pa.id_parcela AND p.estado <> 'INACTIVO')::int AS productos,
            EXISTS (SELECT 1 FROM alerta a WHERE a.id_referencia = pa.id_parcela AND a.estado = 'ABIERTA') AS en_revision
       FROM parcela pa JOIN cultivo_referencia cr ON cr.cultivo = pa.cultivo
      WHERE ($1::uuid IS NULL OR pa.id_vendedor = $1)
      ORDER BY pa.estado, pa.nombre`, [idv]));
}));

function leer(b, parcial = false) {
  const r = {};
  if (!parcial || b.nombre !== undefined) r.nombre = texto(b.nombre, 'Nombre de la parcela', { max: 120 });
  if (!parcial || b.municipio !== undefined) r.municipio = texto(b.municipio, 'Municipio', { max: 120 });
  if (!parcial || b.superficie_ha !== undefined) r.superficie_ha = num(b.superficie_ha, 'Superficie (ha)', { min: 0.01, max: 5000 });
  if (!parcial || b.cultivo !== undefined) r.cultivo = texto(b.cultivo, 'Cultivo', { max: 60 });
  if (b.tenencia !== undefined) {
    r.tenencia = String(b.tenencia).toUpperCase();
    if (!TENENCIAS.includes(r.tenencia)) throw new HttpError(400, 'Tenencia inválida');
  }
  const c = r.municipio ? coordenadas(r.municipio) : null;
  if (b.lat !== undefined && b.lat !== '' && b.lng !== undefined && b.lng !== '') {
    r.lat = num(b.lat, 'Latitud', { min: -90, max: 90 }); r.lng = num(b.lng, 'Longitud', { min: -180, max: 180 });
  } else if (c) { r.lat = c.lat; r.lng = c.lng; }
  return r;
}

router.post('/', requireRole('VENDEDOR'), ah(async (req, res) => {
  const p = leer(req.body || {});
  const row = await db.one(req.ctx,
    `INSERT INTO parcela(id_vendedor, nombre, municipio, superficie_ha, cultivo, tenencia, geom)
     VALUES ($1,$2,$3,$4,$5,coalesce($6,'PROPIA'),
             CASE WHEN $7::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($8::float8, $7::float8), 4326) END)
     RETURNING id_parcela`,
    [req.ctx.rol_id, p.nombre, p.municipio, p.superficie_ha, p.cultivo, p.tenencia || null, p.lat ?? null, p.lng ?? null]);
  res.status(201).json({ id: row.id_parcela, message: 'Parcela registrada' });
}));

router.put('/:id', requireRole('VENDEDOR', 'ADMINISTRADOR'), ah(async (req, res) => {
  const p = leer(req.body || {}, true);
  const row = await db.one(req.ctx,
    `UPDATE parcela SET nombre = coalesce($2, nombre), municipio = coalesce($3, municipio),
            superficie_ha = coalesce($4, superficie_ha), cultivo = coalesce($5, cultivo), tenencia = coalesce($6, tenencia),
            geom = CASE WHEN $7::float8 IS NULL THEN geom ELSE ST_SetSRID(ST_MakePoint($8::float8, $7::float8), 4326) END
      WHERE id_parcela = $1 RETURNING id_parcela`,
    [uuid(req.params.id), p.nombre ?? null, p.municipio ?? null, p.superficie_ha ?? null, p.cultivo ?? null,
     p.tenencia ?? null, p.lat ?? null, p.lng ?? null]);
  if (!row) throw new HttpError(404, 'Parcela no encontrada');
  res.json({ id: row.id_parcela, message: 'Parcela actualizada' });
}));

router.put('/:id/estado', requireRole('VENDEDOR', 'ADMINISTRADOR'), ah(async (req, res) => {
  const estado = String((req.body || {}).estado || '').toUpperCase();
  if (!['ACTIVA', 'INACTIVA'].includes(estado)) throw new HttpError(400, 'Estado inválido');
  const id = uuid(req.params.id);
  if (estado === 'INACTIVA') {
    const n = await db.one(req.ctx, `SELECT count(*)::int AS n FROM producto WHERE id_parcela = $1 AND estado <> 'INACTIVO'`, [id]);
    if (n.n) throw new HttpError(409, `La parcela tiene ${n.n} producto(s) publicados`);
  }
  const row = await db.one(req.ctx, 'UPDATE parcela SET estado = $2 WHERE id_parcela = $1 RETURNING id_parcela, estado', [id, estado]);
  if (!row) throw new HttpError(404, 'Parcela no encontrada');
  res.json(row);
}));

module.exports = router;
