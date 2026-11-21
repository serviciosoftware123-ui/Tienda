'use strict';
// ============================================================
//  Membresía Premium ($199 + IVA al mes)
//  Beneficios: posición destacada en el catálogo, estadísticas avanzadas,
//  Reporte AgroConfianza en PDF y verificación en dos pasos.
//   GET  /api/membresias              → estado Premium, precio y pagos (VENDEDOR)
//   POST /api/membresias              → { metodo } inicia el pago de un mes
//   POST /api/membresias/promocion    → { codigo } primer mes gratis (código de alianza, una vez)
//   POST /api/membresias/:id/simulado → { tarjeta } pago con tarjeta de prueba
//   POST /api/membresias/:id/spei     → simular el depósito SPEI (piloto)
//   POST /api/membresias/stripe/confirmar · /mercadopago/confirmar (al regresar del proveedor)
//   GET  /api/membresias/todas        → (ADMIN) todas las membresías
// ============================================================
const express = require('express');
const env = require('../config/env');
const db = require('../config/db');
const pagos = require('../services/pagos');
const { HttpError, ah, uuid } = require('../utils/http');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireRole('VENDEDOR'), ah(async (req, res) => {
  const out = await db.tx(req.ctx, async c => {
    const v = (await c.query(
      `SELECT premium_hasta, (premium_hasta IS NOT NULL AND premium_hasta > now()) AS activa, promo_usada
         FROM vendedor WHERE id_vendedor = $1`, [req.ctx.rol_id])).rows[0];
    const precio = (await c.query(
      `SELECT fn_param('membresia_precio')::float8 AS precio, fn_param('iva_general')::float8 AS iva,
              fn_param('membresia_dias')::int AS dias`)).rows[0];
    const historial = (await c.query(
      `SELECT id_membresia, folio, metodo, monto, iva, total, estado, referencia, proveedor_ref, periodo_inicio, periodo_fin, fecha_creacion
         FROM membresia WHERE id_vendedor = $1 ORDER BY fecha_creacion DESC LIMIT 24`, [req.ctx.rol_id])).rows;
    return { ...v, precio: precio.precio, iva: Math.round(precio.precio * precio.iva * 100) / 100,
      total: Math.round(precio.precio * (1 + precio.iva) * 100) / 100, dias: precio.dias, historial,
      metodos: pagos.metodosMembresia() };
  });
  res.json(out);
}));

router.post('/', requireRole('VENDEDOR'), ah(async (req, res) => {
  const metodo = String((req.body || {}).metodo || '').toUpperCase();
  pagos.validarMetodo(metodo, pagos.metodosMembresia());
  const m = await db.tx(req.ctx, async c => {
    // un solo cobro pendiente a la vez
    await c.query(`SELECT 1 FROM membresia WHERE id_vendedor = $1 AND estado = 'PENDIENTE' FOR UPDATE`, [req.ctx.rol_id]);
    return (await c.query(
      `INSERT INTO membresia(id_vendedor, metodo) VALUES ($1,$2) RETURNING id_membresia, folio, metodo, monto, iva, total`,
      [req.ctx.rol_id, metodo])).rows[0];
  });
  // los intentos anteriores pendientes se cancelan
  await db.tx(db.SISTEMA, c => c.query(
    `UPDATE membresia SET estado = 'CANCELADA' WHERE id_vendedor = $1 AND estado = 'PENDIENTE' AND id_membresia <> $2`,
    [req.ctx.rol_id, m.id_membresia]));
  const pago = await pagos.iniciarPagoMembresia({ membresia: m, email: req.user.email });
  res.status(201).json({ membresia: m, pago });
}));

router.post('/promocion', requireRole('VENDEDOR'), ah(async (req, res) => {
  const r = await db.one(req.ctx, 'SELECT fn_membresia_promocion($1) AS id', [String((req.body || {}).codigo || '')]);
  res.status(201).json({ id_membresia: r.id, message: '¡Listo! Tu primer mes Premium es gratis.' });
}));

async function dueno(req, id) {
  const m = await db.one(req.ctx, 'SELECT id_membresia, metodo, estado FROM membresia WHERE id_membresia = $1', [id]);
  if (!m) throw new HttpError(404, 'Membresía no encontrada');
  return m;
}

router.post('/:id/simulado', requireRole('VENDEDOR'), ah(async (req, res) => {
  const id = uuid(req.params.id);
  await dueno(req, id);
  res.json(await pagos.confirmarMembresiaSimulada(id, (req.body || {}).tarjeta));
}));

router.post('/:id/spei', requireRole('VENDEDOR'), ah(async (req, res) => {
  if (!env.PAGO_SIMULADO) throw new HttpError(400, 'La simulación de depósitos está desactivada');
  const id = uuid(req.params.id);
  const m = await dueno(req, id);
  if (m.metodo !== 'SPEI') throw new HttpError(400, 'Esta membresía no se paga por SPEI');
  res.json(await pagos.resolverMembresia(id, 'SPEI', { aprobado: true, referencia: `SPEI-${Date.now().toString(36).toUpperCase()}` }));
}));

router.post('/stripe/confirmar', requireRole('VENDEDOR'), ah(async (req, res) => {
  if (!req.body || !req.body.session_id) throw new HttpError(400, 'Falta session_id');
  res.json(await pagos.confirmarStripe(req.body.session_id));
}));

router.post('/mercadopago/confirmar', requireRole('VENDEDOR'), ah(async (req, res) => {
  if (!req.body || !req.body.payment_id) throw new HttpError(400, 'Falta payment_id');
  res.json(await pagos.confirmarMercadoPago(req.body.payment_id));
}));

router.get('/todas', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  res.json(await db.q(req.ctx,
    `SELECT m.id_membresia, m.folio, v.nombre_negocio, m.metodo, m.monto, m.iva, m.total, m.comision_pasarela, m.estado,
            m.referencia, m.periodo_inicio, m.periodo_fin, m.fecha_creacion
       FROM membresia m JOIN vendedor v ON v.id_vendedor = m.id_vendedor
      ORDER BY m.fecha_creacion DESC LIMIT 300`));
}));

module.exports = router;
