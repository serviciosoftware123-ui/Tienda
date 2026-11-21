'use strict';
// ============================================================
//  Reputación y postventa
//  /api/calificaciones  · /api/devoluciones · /api/financiamiento · /api/score
// ============================================================
const express = require('express');
const db = require('../config/db');
const { HttpError, ah, uuid, num, texto, paginacion } = require('../utils/http');
const { requireAuth, requireRole } = require('../middleware/auth');

// ─── Calificaciones ──────────────────────────────────────────
const calificaciones = express.Router();

calificaciones.get('/resumen', ah(async (req, res) => {
  const idv = req.query.id_vendedor ? uuid(req.query.id_vendedor, 'vendedor') : null;
  const r = await db.one(req.ctx,
    `SELECT count(*)::int AS total, coalesce(round(avg(puntuacion), 1), 0)::float8 AS promedio,
            count(*) FILTER (WHERE puntuacion = 5)::int AS c5, count(*) FILTER (WHERE puntuacion = 4)::int AS c4,
            count(*) FILTER (WHERE puntuacion = 3)::int AS c3, count(*) FILTER (WHERE puntuacion = 2)::int AS c2,
            count(*) FILTER (WHERE puntuacion = 1)::int AS c1
       FROM v_calificacion_publica WHERE ($1::uuid IS NULL OR id_vendedor = $1)`, [idv]);
  res.json({ total: r.total, promedio: r.promedio, distribucion: { 5: r.c5, 4: r.c4, 3: r.c3, 2: r.c2, 1: r.c1 } });
}));

calificaciones.get('/', ah(async (req, res) => {
  const idv = req.query.id_vendedor ? uuid(req.query.id_vendedor, 'vendedor') : null;
  const { limit, offset } = paginacion(req.query, 100);
  res.json(await db.q(req.ctx,
    `SELECT id_calificacion, id_vendedor, id_comprador, vendedor_nombre, comprador, puntuacion, comentario, fecha, productos
       FROM v_calificacion_publica WHERE ($1::uuid IS NULL OR id_vendedor = $1)
      ORDER BY fecha DESC LIMIT $2 OFFSET $3`, [idv, limit, offset]));
}));

// Pedidos entregados que el comprador aún no califica
calificaciones.get('/pendientes', requireRole('COMPRADOR'), ah(async (req, res) => {
  res.json(await db.q(req.ctx,
    `SELECT p.id_pedido, p.folio, p.fecha_pedido, p.total, p.id_vendedor, v.nombre_negocio AS vendedor_nombre,
            (SELECT string_agg(d.nombre_producto, ', ') FROM detalle_pedido d WHERE d.id_pedido = p.id_pedido) AS productos
       FROM pedido p JOIN vendedor v ON v.id_vendedor = p.id_vendedor
      WHERE p.id_comprador = $1 AND p.estado = 'ENTREGADO'
        AND NOT EXISTS (SELECT 1 FROM calificacion c WHERE c.id_pedido = p.id_pedido)
      ORDER BY p.fecha_pedido DESC`, [req.ctx.rol_id]));
}));

calificaciones.post('/', requireRole('COMPRADOR'), ah(async (req, res) => {
  const b = req.body || {};
  const id = uuid(b.id_pedido, 'Pedido');
  const puntuacion = num(b.puntuacion, 'Calificación', { min: 1, max: 5, entero: true });
  const comentario = texto(b.comentario, 'Comentario', { max: 1000, requerido: false });
  await db.q(req.ctx,
    'INSERT INTO calificacion(id_pedido, id_comprador, puntuacion, comentario) VALUES ($1,$2,$3,$4)',
    [id, req.ctx.rol_id, puntuacion, comentario]);
  res.status(201).json({ message: '¡Gracias por tu calificación!' });
}));

// ─── Devoluciones ────────────────────────────────────────────
const devoluciones = express.Router();

devoluciones.get('/', requireAuth, ah(async (req, res) => {
  const { estado = '' } = req.query;
  res.json(await db.q(req.ctx,
    `SELECT d.id_devolucion, d.id_pedido, p.folio, d.tipo, d.motivo, d.estado, d.evidencia_url, d.resolucion, p.estado AS pedido_estado,
            p.custodia_estado, (SELECT count(*) FROM devolucion_mensaje m WHERE m.id_devolucion = d.id_devolucion)::int AS mensajes,
            d.fecha_solicitud, d.fecha_resolucion, p.total, v.nombre_negocio AS vendedor_nombre,
            fn_comprador_display(d.id_comprador) AS comprador_nombre
       FROM devolucion d JOIN pedido p ON p.id_pedido = d.id_pedido JOIN vendedor v ON v.id_vendedor = p.id_vendedor
      WHERE ($1 = '' OR d.estado = ANY(string_to_array($1, ',')))
      ORDER BY d.fecha_solicitud DESC LIMIT 200`, [String(estado).toUpperCase()]));
}));

devoluciones.post('/', requireRole('COMPRADOR'), ah(async (req, res) => {
  const b = req.body || {};
  const row = await db.one(req.ctx,
    `INSERT INTO devolucion(id_pedido, id_comprador, motivo, evidencia_url, tipo) VALUES ($1,$2,$3,$4,$5) RETURNING id_devolucion, estado, tipo`,
    [uuid(b.id_pedido, 'Pedido'), req.ctx.rol_id, texto(b.motivo, 'Motivo', { max: 2000 }),
     b.evidencia_url ? texto(b.evidencia_url, 'Evidencia', { max: 500 }) : null,
     String(b.tipo || 'DEVOLUCION').toUpperCase() === 'DISPUTA' ? 'DISPUTA' : 'DEVOLUCION']);
  res.status(201).json(row);
}));

devoluciones.put('/:id/estado', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const estado = String((req.body || {}).estado || '').toUpperCase();
  if (!['EN_REVISION', 'APROBADA', 'RECHAZADA', 'RESUELTA'].includes(estado)) throw new HttpError(400, 'Estado inválido');
  const row = await db.one(req.ctx,
    'UPDATE devolucion SET estado = $2, resolucion = coalesce($3, resolucion) WHERE id_devolucion = $1 RETURNING id_devolucion, estado',
    [uuid(req.params.id), estado, texto(req.body.resolucion, 'Resolución', { max: 2000, requerido: false })]);
  if (!row) throw new HttpError(404, 'Devolución no encontrada');
  res.json(row);
}));

// Mediación: mensajes entre comprador, vendedor y administrador
devoluciones.get('/:id/mensajes', requireAuth, ah(async (req, res) => {
  const id = uuid(req.params.id);
  const out = await db.tx(req.ctx, async c => {
    const d = (await c.query(
      `SELECT d.id_devolucion, d.tipo, d.estado, d.motivo, d.resolucion, p.folio
         FROM devolucion d JOIN pedido p ON p.id_pedido = d.id_pedido WHERE d.id_devolucion = $1`, [id])).rows[0];
    if (!d) return null;
    d.mensajes = (await c.query(
      `SELECT m.id_mensaje, m.rol, m.mensaje, m.fecha, fn_usuario_display(m.id_usuario) AS autor,
              (m.id_usuario = $2) AS mio
         FROM devolucion_mensaje m WHERE m.id_devolucion = $1 ORDER BY m.fecha`, [id, req.user.id_usuario])).rows;
    return d;
  });
  if (!out) throw new HttpError(404, 'Caso no encontrado');
  res.json(out);
}));

devoluciones.post('/:id/mensajes', requireAuth, ah(async (req, res) => {
  const row = await db.one(req.ctx,
    'INSERT INTO devolucion_mensaje(id_devolucion, mensaje) VALUES ($1,$2) RETURNING id_mensaje, fecha',
    [uuid(req.params.id), texto((req.body || {}).mensaje, 'Mensaje', { max: 2000 })]);
  if (!row) throw new HttpError(404, 'Caso no encontrado');
  res.status(201).json(row);
}));

// ─── Financiamiento ──────────────────────────────────────────
const financiamiento = express.Router();

financiamiento.get('/', requireAuth, ah(async (req, res) => {
  res.json(await db.q(req.ctx,
    `SELECT f.id_financiamiento, f.id_pedido, p.folio, f.monto_total, f.num_plazos, f.monto_plazo, f.tasa_mensual,
            f.plazos_pagados, f.estado, f.fecha_inicio, fn_comprador_display(f.id_comprador) AS comprador_nombre,
            round(f.monto_plazo * f.num_plazos, 2)::float8 AS total_a_pagar
       FROM financiamiento f JOIN pedido p ON p.id_pedido = f.id_pedido
      ORDER BY f.fecha_inicio DESC LIMIT 200`));
}));

// El admin registra el abono de un plazo
financiamiento.put('/:id/abono', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const row = await db.one(req.ctx,
    `UPDATE financiamiento SET plazos_pagados = plazos_pagados + 1,
            estado = CASE WHEN plazos_pagados + 1 >= num_plazos THEN 'PAGADO' ELSE estado END
      WHERE id_financiamiento = $1 AND estado IN ('ACTIVO', 'VENCIDO')
      RETURNING id_financiamiento, plazos_pagados, num_plazos, estado`, [uuid(req.params.id)]);
  if (!row) throw new HttpError(404, 'Plan no encontrado o ya liquidado');
  res.json(row);
}));

financiamiento.put('/:id/estado', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const estado = String((req.body || {}).estado || '').toUpperCase();
  if (!['ACTIVO', 'PAGADO', 'VENCIDO', 'CANCELADO'].includes(estado)) throw new HttpError(400, 'Estado inválido');
  const row = await db.one(req.ctx,
    'UPDATE financiamiento SET estado = $2 WHERE id_financiamiento = $1 RETURNING id_financiamiento, estado',
    [uuid(req.params.id), estado]);
  if (!row) throw new HttpError(404, 'Plan no encontrado');
  res.json(row);
}));

// ─── Score AgroConfianza ─────────────────────────────────────
const score = express.Router();

score.get('/me', requireAuth, ah(async (req, res) => {
  res.json(await db.one(req.ctx,
    'SELECT puntos, nivel, total_transacciones FROM score_agroconfianza WHERE id_usuario = $1', [req.user.id_usuario]));
}));

score.get('/:id_usuario', ah(async (req, res) => {
  const r = await db.one(req.ctx,
    `SELECT s.puntos, s.nivel, s.total_transacciones, fn_usuario_display(s.id_usuario) AS usuario
       FROM score_agroconfianza s WHERE s.id_usuario = $1`, [uuid(req.params.id_usuario)]);
  if (!r) throw new HttpError(404, 'Usuario no encontrado');
  res.json(r);
}));

module.exports = { calificaciones, devoluciones, financiamiento, score };
