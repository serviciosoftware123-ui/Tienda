'use strict';
// ============================================================
//  Pagos de prueba
//   • SPEI           → transferencia con CLABE y referencia (forma de pago principal
//                      para mayoreo: cuesta $7 + IVA por operación, no un porcentaje)
//   • SIMULADO       → tarjeta de prueba dentro de AgroConnecta (siempre disponible)
//   • EFECTIVO       → contra entrega (se aprueba cuando el vendedor entrega)
//   • FINANCIAMIENTO → plan a plazos AgroConnecta (1.5 % mensual simple)
//   • STRIPE         → Stripe Checkout en modo prueba  (requiere STRIPE_SECRET_KEY sk_test_...)
//   • MERCADOPAGO    → Checkout Pro en modo prueba     (requiere MP_ACCESS_TOKEN de prueba)
//  El servidor SIEMPRE vuelve a consultar al proveedor para confirmar un pago
//  y compara el monto cobrado contra el total guardado en la base.
//  Los pagos en línea aprobados quedan EN CUSTODIA hasta que el comprador
//  confirma de recibido (+48 h); eso lo controla la base de datos.
//  Las membresías Premium usan los mismos proveedores (referencia "MEM:<id>").
// ============================================================
const env = require('../config/env');
const db = require('../config/db');
const { HttpError } = require('../utils/http');

let stripe = null;
if (env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(env.STRIPE_SECRET_KEY);
}
let mp = null;
if (env.MP_ACCESS_TOKEN) {
  const { MercadoPagoConfig } = require('mercadopago');
  mp = new MercadoPagoConfig({ accessToken: env.MP_ACCESS_TOKEN, options: { timeout: 10000 } });
}

const TARJETAS_PRUEBA = {
  '4242424242424242': 'APROBADO',   // Visa de prueba: aprobada
  '5555555555554444': 'APROBADO',   // Mastercard de prueba: aprobada
  '4000000000000002': 'RECHAZADO',  // rechazada (fondos insuficientes)
};

function metodosDisponibles() {
  const m = [
    { id: 'SPEI', nombre: 'Transferencia SPEI', descripcion: 'Recomendado para mayoreo · te damos CLABE y referencia', enLinea: true },
    { id: 'SIMULADO', nombre: 'Tarjeta de prueba (simulada)', descripcion: 'Usa 4242 4242 4242 4242 · cualquier fecha futura · CVV 123', enLinea: true },
    { id: 'EFECTIVO', nombre: 'Efectivo contra entrega', descripcion: 'Pagas al recibir o recoger tu pedido', enLinea: false },
    { id: 'FINANCIAMIENTO', nombre: 'Financiamiento AgroConnecta', descripcion: 'De 3 a 12 pagos mensuales · 1.5 % mensual', enLinea: false },
  ];
  if (stripe) m.push({ id: 'STRIPE', nombre: 'Stripe (modo prueba)', descripcion: 'Tarjeta 4242 4242 4242 4242 en la página de Stripe', enLinea: true });
  if (mp) m.push({ id: 'MERCADOPAGO', nombre: 'Mercado Pago (modo prueba)', descripcion: 'Checkout Pro con tarjetas de prueba de Mercado Pago', enLinea: true });
  return m.filter(x => x.id !== 'SIMULADO' || env.PAGO_SIMULADO);
}

function metodosMembresia() {
  return metodosDisponibles().filter(m => ['SPEI', 'SIMULADO', 'STRIPE', 'MERCADOPAGO'].includes(m.id));
}

function validarMetodo(metodo, lista = metodosDisponibles()) {
  if (!lista.some(m => m.id === metodo)) {
    throw new HttpError(400, `Método de pago no disponible: ${metodo}`);
  }
}

async function pedidosDelGrupo(client, grupo) {
  const { rows } = await client.query(
    `SELECT p.id_pedido, p.folio, p.total, p.estado, v.nombre_negocio, g.metodo, g.estado AS pago_estado, g.proveedor_ref
       FROM pedido p
       JOIN vendedor v ON v.id_vendedor = p.id_vendedor
       JOIN LATERAL (SELECT metodo, estado, proveedor_ref FROM pago WHERE id_pedido = p.id_pedido
                     ORDER BY fecha_creacion DESC LIMIT 1) g ON true
      WHERE p.grupo_compra = $1
      ORDER BY p.folio`, [grupo]);
  return rows;
}

const centavos = n => Math.round(Number(n) * 100);

async function datosSpei(referencia, total) {
  const r = await db.one(db.ANON, `SELECT fn_param_texto('clabe_plataforma') AS clabe`);
  return {
    tipo: 'SPEI', total, referencia,
    clabe: r.clabe, banco: 'STP (cuenta DEMO del piloto)', beneficiario: 'AgroConnecta Sureste S.A.S.',
    simulable: env.PAGO_SIMULADO,
    nota: 'Haz la transferencia con la referencia exacta. Se aprueba al recibir el depósito.',
  };
}

/** Crea la sesión de pago con el proveedor y devuelve a dónde mandar al comprador */
async function iniciarPago({ grupo, metodo, pedidos, email }) {
  const total = pedidos.reduce((s, p) => s + Number(p.total), 0);
  const volver = `${env.PUBLIC_URL}/Pedidos.html`;

  if (metodo === 'SIMULADO') return { tipo: 'SIMULADO', grupo, total };
  if (metodo === 'EFECTIVO' || metodo === 'FINANCIAMIENTO') return { tipo: 'LISTO', grupo, total };
  if (metodo === 'SPEI') {
    const referencia = `AC${String(pedidos[0].folio).padStart(7, '0')}`;
    await marcarReferencia(grupo, 'SPEI', referencia);
    return { ...(await datosSpei(referencia, total)), grupo };
  }

  if (metodo === 'STRIPE') {
    if (!stripe) throw new HttpError(400, 'Stripe no está configurado');
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email || undefined,
      client_reference_id: grupo,
      metadata: { grupo },
      line_items: pedidos.map(p => ({
        quantity: 1,
        price_data: {
          currency: 'mxn',
          unit_amount: centavos(p.total),
          product_data: { name: `Pedido #${p.folio} · ${p.nombre_negocio}`, description: 'Impuestos y flete incluidos' },
        },
      })),
      success_url: `${volver}?pago=stripe&grupo=${grupo}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${volver}?pago=cancelado&grupo=${grupo}`,
    });
    await marcarReferencia(grupo, 'STRIPE', session.id);
    return { tipo: 'REDIRECT', url: session.url, grupo, total };
  }

  if (metodo === 'MERCADOPAGO') {
    if (!mp) throw new HttpError(400, 'Mercado Pago no está configurado');
    const { Preference } = require('mercadopago');
    const https = env.PUBLIC_URL.startsWith('https://');
    const pref = await new Preference(mp).create({
      body: {
        external_reference: grupo,
        items: pedidos.map(p => ({
          id: String(p.folio), title: `Pedido #${p.folio} · ${p.nombre_negocio}`,
          quantity: 1, unit_price: Number(p.total), currency_id: 'MXN',
        })),
        payer: email ? { email } : undefined,
        back_urls: {
          success: `${volver}?pago=mercadopago&grupo=${grupo}`,
          failure: `${volver}?pago=fallido&grupo=${grupo}`,
          pending: `${volver}?pago=pendiente&grupo=${grupo}`,
        },
        ...(https ? { auto_return: 'approved', notification_url: `${env.PUBLIC_URL}/api/pagos/mercadopago/webhook` } : {}),
        statement_descriptor: 'AGROCONNECTA',
      },
    });
    await marcarReferencia(grupo, 'MERCADOPAGO', pref.id);
    const url = env.MP_ACCESS_TOKEN.startsWith('TEST-') ? (pref.sandbox_init_point || pref.init_point) : pref.init_point;
    return { tipo: 'REDIRECT', url, grupo, total };
  }
  throw new HttpError(400, 'Método de pago inválido');
}

async function marcarReferencia(grupo, metodo, ref) {
  await db.tx(db.SISTEMA, c => c.query(
    `UPDATE pago SET proveedor_ref = $3
      WHERE metodo = $2 AND estado = 'PENDIENTE'
        AND id_pedido IN (SELECT id_pedido FROM pedido WHERE grupo_compra = $1)`, [grupo, metodo, ref]));
}

/** Marca como aprobados (o rechazados) los pagos de un grupo, validando el monto */
async function resolverGrupo(grupo, metodo, { aprobado, referencia, montoCobrado }) {
  return db.tx(db.SISTEMA, async c => {
    const pedidos = await pedidosDelGrupo(c, grupo);
    if (!pedidos.length) throw new HttpError(404, 'Compra no encontrada');
    const esperado = pedidos.filter(p => p.metodo === metodo && p.pago_estado === 'PENDIENTE')
      .reduce((s, p) => s + centavos(p.total), 0);
    if (!esperado) return { grupo, estado: 'SIN_PENDIENTES', pedidos: pedidos.map(p => p.folio) };
    if (aprobado && montoCobrado !== undefined && centavos(montoCobrado) !== esperado) {
      throw new HttpError(409, 'El monto cobrado no coincide con el total del pedido');
    }
    await c.query(
      `UPDATE pago SET estado = $3, referencia = coalesce($4, referencia)
        WHERE metodo = $2 AND estado = 'PENDIENTE'
          AND id_pedido IN (SELECT id_pedido FROM pedido WHERE grupo_compra = $1)`,
      [grupo, metodo, aprobado ? 'APROBADO' : 'RECHAZADO', referencia || null]);
    return { grupo, estado: aprobado ? 'APROBADO' : 'RECHAZADO', pedidos: pedidos.map(p => p.folio) };
  });
}

async function confirmarSimulado(grupo, tarjeta) {
  const num = String(tarjeta || '').replace(/\D/g, '');
  const resultado = TARJETAS_PRUEBA[num];
  if (!resultado) throw new HttpError(400, 'Usa una tarjeta de prueba: 4242 4242 4242 4242');
  return resolverGrupo(grupo, 'SIMULADO', {
    aprobado: resultado === 'APROBADO',
    referencia: `SIM-${Date.now().toString(36).toUpperCase()}-${num.slice(-4)}`,
  });
}

/** Depósito SPEI: en el piloto se simula; en producción lo confirma el webhook del banco/STP o el admin */
async function confirmarSpei(grupo, monto, clave = null) {
  const r = await db.one(db.SISTEMA,
    `SELECT sum(p.total) AS total FROM pedido p
       JOIN LATERAL (SELECT metodo, estado FROM pago WHERE id_pedido = p.id_pedido ORDER BY fecha_creacion DESC LIMIT 1) g ON true
      WHERE p.grupo_compra = $1 AND g.metodo = 'SPEI' AND g.estado = 'PENDIENTE'`, [grupo]);
  return resolverGrupo(grupo, 'SPEI', {
    aprobado: true,
    referencia: clave || `SPEI-${Date.now().toString(36).toUpperCase()}`,
    montoCobrado: monto === undefined || monto === null ? (r && r.total) : monto,
  });
}

async function confirmarStripe(sessionId) {
  if (!stripe) throw new HttpError(400, 'Stripe no está configurado');
  const s = await stripe.checkout.sessions.retrieve(String(sessionId));
  const meta = s.metadata || {};
  if (meta.membresia) {
    if (s.payment_status !== 'paid') return { membresia: meta.membresia, estado: 'PENDIENTE' };
    return resolverMembresia(meta.membresia, 'STRIPE', {
      aprobado: true, referencia: typeof s.payment_intent === 'string' ? s.payment_intent : s.id,
      montoCobrado: (s.amount_total || 0) / 100,
    });
  }
  const grupo = meta.grupo;
  if (!grupo) throw new HttpError(400, 'Sesión de Stripe sin referencia');
  if (s.payment_status !== 'paid') return { grupo, estado: 'PENDIENTE' };
  return resolverGrupo(grupo, 'STRIPE', {
    aprobado: true, referencia: typeof s.payment_intent === 'string' ? s.payment_intent : s.id,
    montoCobrado: (s.amount_total || 0) / 100,
  });
}

function stripeWebhookEvent(rawBody, firma) {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) throw new HttpError(400, 'Webhook de Stripe no configurado');
  return stripe.webhooks.constructEvent(rawBody, firma, env.STRIPE_WEBHOOK_SECRET);
}

async function confirmarMercadoPago(paymentId) {
  if (!mp) throw new HttpError(400, 'Mercado Pago no está configurado');
  const { Payment } = require('mercadopago');
  const p = await new Payment(mp).get({ id: String(paymentId) });
  const ref = String(p.external_reference || '');
  if (!ref) throw new HttpError(400, 'Pago de Mercado Pago sin referencia');
  if (ref.startsWith('MEM:')) {
    const id = ref.slice(4);
    if (p.status === 'approved') return resolverMembresia(id, 'MERCADOPAGO', { aprobado: true, referencia: String(p.id), montoCobrado: p.transaction_amount });
    if (['rejected', 'cancelled'].includes(p.status)) return resolverMembresia(id, 'MERCADOPAGO', { aprobado: false, referencia: String(p.id) });
    return { membresia: id, estado: 'PENDIENTE' };
  }
  if (p.status === 'approved') {
    return resolverGrupo(ref, 'MERCADOPAGO', { aprobado: true, referencia: String(p.id), montoCobrado: p.transaction_amount });
  }
  if (['rejected', 'cancelled'].includes(p.status)) {
    return resolverGrupo(ref, 'MERCADOPAGO', { aprobado: false, referencia: String(p.id) });
  }
  return { grupo: ref, estado: 'PENDIENTE' };
}

// ─── Membresía Premium ───────────────────────────────────────
async function iniciarPagoMembresia({ membresia, email }) {
  const { id_membresia: id, metodo, total, folio } = membresia;
  const volver = `${env.PUBLIC_URL}/Tienda.html?tab=premium`;
  if (metodo === 'SIMULADO') return { tipo: 'SIMULADO', id_membresia: id, total };
  if (metodo === 'SPEI') {
    const referencia = `MEM${String(folio).padStart(6, '0')}`;
    await db.tx(db.SISTEMA, c => c.query('UPDATE membresia SET proveedor_ref = $2 WHERE id_membresia = $1', [id, referencia]));
    return { ...(await datosSpei(referencia, total)), id_membresia: id };
  }
  if (metodo === 'STRIPE') {
    if (!stripe) throw new HttpError(400, 'Stripe no está configurado');
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', customer_email: email || undefined, client_reference_id: id, metadata: { membresia: id },
      line_items: [{ quantity: 1, price_data: { currency: 'mxn', unit_amount: centavos(total),
        product_data: { name: 'Membresía Premium AgroConnecta (30 días)', description: 'IVA incluido' } } }],
      success_url: `${volver}&pago=stripe&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${volver}&pago=cancelado`,
    });
    await db.tx(db.SISTEMA, c => c.query('UPDATE membresia SET proveedor_ref = $2 WHERE id_membresia = $1', [id, session.id]));
    return { tipo: 'REDIRECT', url: session.url, id_membresia: id, total };
  }
  if (metodo === 'MERCADOPAGO') {
    if (!mp) throw new HttpError(400, 'Mercado Pago no está configurado');
    const { Preference } = require('mercadopago');
    const pref = await new Preference(mp).create({
      body: {
        external_reference: `MEM:${id}`,
        items: [{ id: `MEM-${folio}`, title: 'Membresía Premium AgroConnecta (30 días)', quantity: 1, unit_price: Number(total), currency_id: 'MXN' }],
        payer: email ? { email } : undefined,
        back_urls: { success: `${volver}&pago=mercadopago`, failure: `${volver}&pago=fallido`, pending: `${volver}&pago=pendiente` },
      },
    });
    await db.tx(db.SISTEMA, c => c.query('UPDATE membresia SET proveedor_ref = $2 WHERE id_membresia = $1', [id, pref.id]));
    const url = env.MP_ACCESS_TOKEN.startsWith('TEST-') ? (pref.sandbox_init_point || pref.init_point) : pref.init_point;
    return { tipo: 'REDIRECT', url, id_membresia: id, total };
  }
  throw new HttpError(400, 'Método de pago inválido');
}

async function resolverMembresia(id, metodo, { aprobado, referencia, montoCobrado }) {
  return db.tx(db.SISTEMA, async c => {
    const m = (await c.query('SELECT id_membresia, metodo, total, estado FROM membresia WHERE id_membresia = $1', [id])).rows[0];
    if (!m || m.metodo !== metodo) throw new HttpError(404, 'Membresía no encontrada');
    if (m.estado !== 'PENDIENTE') return { id_membresia: id, estado: m.estado };
    if (aprobado && montoCobrado !== undefined && centavos(montoCobrado) !== centavos(m.total)) {
      throw new HttpError(409, 'El monto cobrado no coincide con la membresía');
    }
    const r = (await c.query(
      `UPDATE membresia SET estado = $2, referencia = coalesce($3, referencia) WHERE id_membresia = $1
       RETURNING id_membresia, estado, periodo_inicio, periodo_fin`,
      [id, aprobado ? 'PAGADA' : 'RECHAZADA', referencia || null])).rows[0];
    return r;
  });
}

async function confirmarMembresiaSimulada(id, tarjeta) {
  const num = String(tarjeta || '').replace(/\D/g, '');
  const resultado = TARJETAS_PRUEBA[num];
  if (!resultado) throw new HttpError(400, 'Usa una tarjeta de prueba: 4242 4242 4242 4242');
  return resolverMembresia(id, 'SIMULADO', {
    aprobado: resultado === 'APROBADO', referencia: `SIM-${Date.now().toString(36).toUpperCase()}-${num.slice(-4)}`,
  });
}

module.exports = {
  metodosDisponibles, metodosMembresia, validarMetodo, iniciarPago, pedidosDelGrupo,
  confirmarSimulado, confirmarSpei, confirmarStripe, stripeWebhookEvent, confirmarMercadoPago,
  iniciarPagoMembresia, resolverMembresia, confirmarMembresiaSimulada,
};
