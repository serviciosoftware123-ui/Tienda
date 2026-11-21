'use strict';
// ============================================================
//  Transportistas aliados (logística cuando el productor no tiene transporte)
//   GET  /api/transportistas          → activos (vendedor/admin; el admin ve todos con ?todos=1)
//   GET  /api/transportistas/tarifa   → parámetros del flete (banderazo, $/km, margen)
//   POST /api/transportistas · PUT /api/transportistas/:id   (ADMIN)
// ============================================================
const express = require('express');
const db = require('../config/db');
const { HttpError, ah, uuid, num, texto } = require('../utils/http');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/tarifa', ah(async (req, res) => {
  res.json(await db.one(req.ctx,
    `SELECT fn_param('flete_banderazo')::float8 AS banderazo, fn_param('flete_tarifa_km')::float8 AS tarifa_km,
            fn_param('flete_factor_ruta')::float8 AS factor_ruta, fn_param('flete_margen')::float8 AS margen`));
}));

router.get('/', requireAuth, ah(async (req, res) => {
  const todos = req.query.todos === '1' && req.user.tipo_usuario === 'ADMINISTRADOR';
  res.json(await db.q(req.ctx,
    `SELECT t.*, (SELECT count(*) FROM envio e WHERE e.id_transportista = t.id_transportista)::int AS envios
       FROM transportista t WHERE ($1 OR t.estado = 'ACTIVO') ORDER BY t.estado, t.nombre`, [todos]));
}));

function leer(b) {
  return {
    nombre: texto(b.nombre, 'Nombre', { max: 150 }),
    telefono: texto(b.telefono, 'Teléfono', { max: 20, requerido: false }),
    zona: texto(b.zona, 'Zona que cubre', { max: 200 }),
    vehiculo: texto(b.vehiculo, 'Vehículo', { max: 120, requerido: false }),
    capacidad_ton: b.capacidad_ton === undefined || b.capacidad_ton === '' ? null : num(b.capacidad_ton, 'Capacidad', { min: 0, max: 100 }),
  };
}

router.post('/', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const t = leer(req.body || {});
  res.status(201).json(await db.one(req.ctx,
    `INSERT INTO transportista(nombre, telefono, zona, vehiculo, capacidad_ton) VALUES ($1,$2,$3,$4,$5) RETURNING id_transportista`,
    [t.nombre, t.telefono, t.zona, t.vehiculo, t.capacidad_ton]));
}));

router.put('/:id', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const b = req.body || {};
  const id = uuid(req.params.id);
  if (b.estado && Object.keys(b).length === 1) {
    const e = String(b.estado).toUpperCase();
    if (!['ACTIVO', 'INACTIVO'].includes(e)) throw new HttpError(400, 'Estado inválido');
    const row = await db.one(req.ctx, 'UPDATE transportista SET estado = $2 WHERE id_transportista = $1 RETURNING id_transportista, estado', [id, e]);
    if (!row) throw new HttpError(404, 'Transportista no encontrado');
    return res.json(row);
  }
  const t = leer(b);
  const row = await db.one(req.ctx,
    `UPDATE transportista SET nombre = $2, telefono = $3, zona = $4, vehiculo = $5, capacidad_ton = $6
      WHERE id_transportista = $1 RETURNING id_transportista`, [id, t.nombre, t.telefono, t.zona, t.vehiculo, t.capacidad_ton]);
  if (!row) throw new HttpError(404, 'Transportista no encontrado');
  res.json(row);
}));

module.exports = router;
