'use strict';
// GET  /api/pagos/metodos
// POST /api/pagos/simulado/confirmar      { grupo, tarjeta }
// POST /api/pagos/spei/simular            { grupo }           (piloto: simula el depósito SPEI)
// POST /api/pagos/stripe/confirmar        { session_id }      (al regresar de Stripe)
// POST /api/pagos/mercadopago/confirmar   { payment_id }      (al regresar de Mercado Pago)
// POST /api/pagos/stripe/webhook · POST /api/pagos/mercadopago/webhook   (en la nube con HTTPS)
const express = require('express');
const db = require('../config/db');
const pagos = require('../services/pagos');
const env = require('../config/env');
const { HttpError, ah, uuid } = require('../utils/http');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/metodos', (_req, res) => res.json(pagos.metodosDisponibles()));

async function verificarDueno(req, grupo) {
  const r = await db.one(req.ctx, 'SELECT count(*)::int AS n FROM pedido WHERE grupo_compra = $1 AND id_comprador = $2',
    [grupo, req.ctx.rol_id]);
  if (!r || !r.n) throw new HttpError(404, 'Compra no encontrada');
}

router.post('/simulado/confirmar', requireRole('COMPRADOR'), ah(async (req, res) => {
  const grupo = uuid((req.body || {}).grupo, 'Compra');
  await verificarDueno(req, grupo);
  const r = await pagos.confirmarSimulado(grupo, req.body.tarjeta);
  res.json(r);
}));

router.post('/spei/simular', requireRole('COMPRADOR'), ah(async (req, res) => {
  if (!env.PAGO_SIMULADO) throw new HttpError(400, 'La simulación de depósitos está desactivada');
  const grupo = uuid((req.body || {}).grupo, 'Compra');
  await verificarDueno(req, grupo);
  res.json(await pagos.confirmarSpei(grupo));
}));

router.post('/stripe/confirmar', requireRole('COMPRADOR'), ah(async (req, res) => {
  if (!req.body || !req.body.session_id) throw new HttpError(400, 'Falta session_id');
  const r = await pagos.confirmarStripe(req.body.session_id);
  await verificarDueno(req, r.grupo);
  res.json(r);
}));

router.post('/mercadopago/confirmar', requireRole('COMPRADOR'), ah(async (req, res) => {
  if (!req.body || !req.body.payment_id) throw new HttpError(400, 'Falta payment_id');
  const r = await pagos.confirmarMercadoPago(req.body.payment_id);
  await verificarDueno(req, r.grupo);
  res.json(r);
}));

// Webhook de Stripe: el cuerpo llega en crudo (express.raw) para verificar la firma
async function stripeWebhook(req, res) {
  let evento;
  try {
    evento = pagos.stripeWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    return res.status(400).send(`Firma inválida: ${err.message}`);
  }
  if (evento.type === 'checkout.session.completed') {
    try { await pagos.confirmarStripe(evento.data.object.id); } catch (e) { console.error('Webhook Stripe:', e.message); }
  }
  res.json({ recibido: true });
}

// Webhook de Mercado Pago: se vuelve a consultar el pago a la API de MP (no se confía en el cuerpo)
router.post('/mercadopago/webhook', ah(async (req, res) => {
  const tipo = req.body && (req.body.type || req.body.topic);
  const id = (req.body && req.body.data && req.body.data.id) || req.query['data.id'] || req.query.id;
  if (tipo === 'payment' && id) {
    try { await pagos.confirmarMercadoPago(id); } catch (e) { console.error('Webhook MP:', e.message); }
  }
  res.json({ recibido: true });
}));

module.exports = { router, stripeWebhook };
