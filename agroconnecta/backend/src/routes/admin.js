'use strict';
// Panel de Administración (solo ADMINISTRADOR)
// GET /api/admin/resumen · GET /api/admin/usuarios · PUT /api/admin/usuarios/:id/estado
// POST /api/admin/usuarios (crear otro admin) · PUT /api/admin/vendedores/:id/verificar
// GET /api/admin/auditoria · GET /api/admin/integridad
// v3.0: GET /indicadores · GET /finanzas · GET|PUT /alertas · GET|PUT /parametros · PUT /usuarios/:id/desbloquear
//       GET /custodia · POST /custodia/:id/liberar · POST /custodia/procesar · GET /spei · POST /spei/:grupo/confirmar
//       PUT /cultivos/:cultivo
const express = require('express');
const db = require('../config/db');
const pagos = require('../services/pagos');
const { HttpError, ah, uuid, num, texto, paginacion } = require('../utils/http');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('ADMINISTRADOR'));

router.get('/resumen', ah(async (req, res) => {
  res.json(await db.one(req.ctx,
    `SELECT (SELECT count(*) FROM producto WHERE estado <> 'INACTIVO')::int AS total_productos,
            (SELECT count(*) FROM pedido)::int AS total_pedidos,
            (SELECT count(*) FROM vendedor)::int AS total_vendedores,
            (SELECT count(*) FROM comprador)::int AS total_compradores,
            (SELECT count(*) FROM terreno WHERE estado <> 'INACTIVO')::int AS total_terrenos,
            (SELECT coalesce(sum(total), 0) FROM pedido WHERE estado = 'ENTREGADO')::float8 AS ventas_totales,
            (SELECT coalesce(sum(monto), 0) FROM pago WHERE estado = 'APROBADO')::float8 AS pagos_aprobados,
            (SELECT count(*) FROM devolucion WHERE estado IN ('SOLICITADA','EN_REVISION'))::int AS devoluciones_pendientes,
            (SELECT count(*) FROM financiamiento WHERE estado = 'ACTIVO')::int AS financiamientos_activos,
            (SELECT count(*) FROM vendedor WHERE NOT verificado)::int AS vendedores_sin_verificar,
            (SELECT count(*) FROM vendedor WHERE verificacion_estado = 'EN_REVISION')::int AS verificaciones_pendientes,
            (SELECT count(*) FROM alerta WHERE estado = 'ABIERTA')::int AS alertas_abiertas,
            (SELECT coalesce(sum(total), 0) FROM pedido WHERE custodia_estado = 'RETENIDO')::float8 AS en_custodia,
            (SELECT count(*) FROM vendedor WHERE premium_hasta > now())::int AS premium_activos,
            (SELECT coalesce(sum(comision_monto), 0) FROM pedido WHERE estado = 'ENTREGADO')::float8 AS comisiones,
            (SELECT count(*) FROM anunciante WHERE estado = 'ACTIVO' AND current_date BETWEEN fecha_inicio AND fecha_fin)::int AS anunciantes_activos`));
}));

router.get('/usuarios', ah(async (req, res) => {
  const { tipo = '', estado = '', q = '' } = req.query;
  const { limit, offset } = paginacion(req.query, 200);
  res.json(await db.q(req.ctx,
    `SELECT u.id_usuario, u.nombre, u.apellido, u.email, u.tipo_usuario, u.estado, u.fecha_registro, u.ultimo_login,
            u.bloqueado_hasta, (u.bloqueado_hasta > now()) AS bloqueado, u.totp_activo,
            s.puntos AS score_puntos, s.nivel AS score_nivel,
            v.id_vendedor, v.nombre_negocio, v.verificado, v.perfil, v.verificacion_estado,
            (v.premium_hasta > now()) AS premium
       FROM usuario u
       LEFT JOIN score_agroconfianza s ON s.id_usuario = u.id_usuario
       LEFT JOIN vendedor v ON v.id_usuario = u.id_usuario
      WHERE ($1 = '' OR u.tipo_usuario = $1) AND ($2 = '' OR u.estado = $2)
        AND ($3 = '' OR unaccent(lower(u.nombre || ' ' || u.apellido || ' ' || u.email || ' ' || coalesce(v.nombre_negocio,'')))
                        LIKE '%' || unaccent(lower($3)) || '%')
      ORDER BY u.fecha_registro DESC LIMIT $4 OFFSET $5`,
    [String(tipo).toUpperCase(), String(estado).toUpperCase(), String(q).trim(), limit, offset]));
}));

router.put('/usuarios/:id/estado', ah(async (req, res) => {
  const id = uuid(req.params.id);
  const estado = String((req.body || {}).estado || '').toUpperCase();
  if (!['ACTIVO', 'INACTIVO', 'SUSPENDIDO'].includes(estado)) throw new HttpError(400, 'Estado inválido');
  if (id === req.user.id_usuario) throw new HttpError(400, 'No puedes cambiar el estado de tu propia cuenta');
  const row = await db.one(req.ctx, 'UPDATE usuario SET estado = $2 WHERE id_usuario = $1 RETURNING id_usuario, estado', [id, estado]);
  if (!row) throw new HttpError(404, 'Usuario no encontrado');
  res.json(row);
}));

router.post('/usuarios', ah(async (req, res) => {
  const b = req.body || {};
  const password = String(b.password || '');
  if (password.length < 10) throw new HttpError(400, 'La contraseña de un administrador debe tener al menos 10 caracteres');
  const row = await db.one(req.ctx, `SELECT fn_registrar_usuario($1,$2,$3,$4,'ADMINISTRADOR') AS id_usuario`,
    [texto(b.nombre, 'Nombre', { max: 100 }), texto(b.apellido, 'Apellido', { max: 100 }),
     texto(b.email, 'Correo', { max: 150 }).toLowerCase(), password]);
  res.status(201).json(row);
}));

router.put('/usuarios/:id/desbloquear', ah(async (req, res) => {
  await db.q(req.ctx, 'SELECT fn_desbloquear_usuario($1)', [uuid(req.params.id)]);
  res.json({ message: 'Cuenta desbloqueada' });
}));

router.put('/vendedores/:id/verificar', ah(async (req, res) => {
  const verificado = (req.body || {}).verificado !== false;
  const row = await db.one(req.ctx,
    'UPDATE vendedor SET verificado = $2 WHERE id_vendedor = $1 RETURNING id_vendedor, verificado, fecha_verificacion',
    [uuid(req.params.id), verificado]);
  if (!row) throw new HttpError(404, 'Vendedor no encontrado');
  res.json(row);
}));

router.get('/auditoria', ah(async (req, res) => {
  const { limit, offset } = paginacion(req.query, 200);
  res.json(await db.q(req.ctx,
    `SELECT l.id_log, l.tabla_afectada, l.operacion, l.id_registro, l.rol_app, l.usuario_bd, l.fecha,
            l.hash_anterior, l.hash_actual, fn_usuario_display(l.usuario_app) AS usuario,
            CASE WHEN l.operacion = 'UPDATE' THEN (
              SELECT coalesce(jsonb_object_agg(k, jsonb_build_array(l.datos_anteriores -> k, l.datos_nuevos -> k)), '{}')
                FROM jsonb_object_keys(l.datos_nuevos) k
               WHERE l.datos_anteriores -> k IS DISTINCT FROM l.datos_nuevos -> k
                 AND k NOT IN ('fecha_actualizacion','hash_integridad')) END AS cambios
       FROM log_cambios l
      WHERE ($1 = '' OR l.tabla_afectada = $1)
      ORDER BY l.id_log DESC LIMIT $2 OFFSET $3`, [String(req.query.tabla || ''), limit, offset]));
}));

router.get('/integridad', ah(async (req, res) => {
  res.json(await db.q(req.ctx, 'SELECT * FROM fn_verificar_integridad()'));
}));

// ─── Indicadores y finanzas del plan de negocio ───
router.get('/indicadores', ah(async (req, res) => {
  res.json(await db.q(req.ctx, 'SELECT clave, indicador, que_mide, valor::float8 AS valor, meta::float8 AS meta, unidad, cumple FROM fn_indicadores()'));
}));

router.get('/finanzas', ah(async (req, res) => {
  const hoy = new Date();
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '') ? req.query.desde
    : new Date(hoy.getFullYear(), hoy.getMonth(), 1).toISOString().slice(0, 10);
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '') ? req.query.hasta : hoy.toISOString().slice(0, 10);
  const filas = await db.q(req.ctx, 'SELECT concepto, monto::float8 AS monto, tipo FROM fn_finanzas($1::date, $2::date)', [desde, hasta]);
  const pedidos = await db.one(req.ctx,
    `SELECT count(*)::int AS ventas, coalesce(avg(p.subtotal + p.impuestos_iva), 0)::float8 AS ticket_promedio,
            coalesce(sum(p.comision_monto) / nullif(count(*), 0), 0)::float8 AS comision_promedio,
            count(*) FILTER (WHERE p.modalidad_entrega = 'ENVIO')::int AS con_flete
       FROM pedido p JOIN envio e ON e.id_pedido = p.id_pedido
      WHERE p.estado = 'ENTREGADO' AND e.fecha_entrega::date BETWEEN $1::date AND $2::date`, [desde, hasta]);
  res.json({ desde, hasta, filas, pedidos });
}));

// ─── Alertas (volumen anormal por parcela, disputas) ───
router.get('/alertas', ah(async (req, res) => {
  const estado = String(req.query.estado || 'ABIERTA').toUpperCase();
  res.json(await db.q(req.ctx,
    `SELECT a.*, v.nombre_negocio FROM alerta a LEFT JOIN vendedor v ON v.id_vendedor = a.id_vendedor
      WHERE ($1 = 'TODAS' OR a.estado = $1) ORDER BY a.fecha DESC LIMIT 200`, [estado]));
}));
router.put('/alertas/:id', ah(async (req, res) => {
  const estado = String((req.body || {}).estado || '').toUpperCase();
  if (!['REVISADA', 'DESCARTADA', 'ABIERTA'].includes(estado)) throw new HttpError(400, 'Estado inválido');
  const row = await db.one(req.ctx,
    `UPDATE alerta SET estado = $2, fecha_cierre = CASE WHEN $2 = 'ABIERTA' THEN NULL ELSE now() END
      WHERE id_alerta = $1 RETURNING id_alerta, estado`, [uuid(req.params.id), estado]);
  if (!row) throw new HttpError(404, 'Alerta no encontrada');
  res.json(row);
}));

// ─── Parámetros del negocio (comisiones, flete, custodia, pasarelas, Premium) ───
router.get('/parametros', ah(async (req, res) => {
  res.json(await db.q(req.ctx, 'SELECT clave, valor::float8 AS valor, texto, descripcion, grupo, fecha_actualizacion FROM parametro ORDER BY grupo, clave'));
}));
router.put('/parametros/:clave', ah(async (req, res) => {
  const b = req.body || {};
  const clave = String(req.params.clave);
  const actual = await db.one(req.ctx, 'SELECT valor, texto FROM parametro WHERE clave = $1', [clave]);
  if (!actual) throw new HttpError(404, 'Parámetro no encontrado');
  const valor = actual.valor !== null ? num(b.valor, 'Valor', { min: 0, max: 1e9 }) : null;
  if (/^comision|_pct$|iva_general/.test(clave) && valor !== null && valor >= 1) throw new HttpError(400, 'Los porcentajes van como fracción (4 % = 0.04)');
  const txt = actual.texto !== null ? texto(b.texto, 'Texto', { max: 200 }) : null;
  res.json(await db.one(req.ctx, 'UPDATE parametro SET valor = $2, texto = $3 WHERE clave = $1 RETURNING clave, valor, texto', [clave, valor, txt]));
}));
router.put('/cultivos/:cultivo', ah(async (req, res) => {
  const row = await db.one(req.ctx,
    'UPDATE cultivo_referencia SET rendimiento_t_ha = $2 WHERE cultivo = $1 RETURNING cultivo, rendimiento_t_ha',
    [String(req.params.cultivo), num((req.body || {}).rendimiento_t_ha, 'Rendimiento', { min: 0.01, max: 1000 })]);
  if (!row) throw new HttpError(404, 'Cultivo no encontrado');
  res.json(row);
}));

// ─── Pagos en custodia ───
router.get('/custodia', ah(async (req, res) => {
  const estado = String(req.query.estado || 'RETENIDO').toUpperCase();
  res.json(await db.q(req.ctx,
    `SELECT p.id_pedido, p.folio, p.estado, p.total, p.neto_vendedor, p.comision_monto, p.custodia_estado,
            p.recepcion_confirmada_en, p.recepcion_automatica, p.liberar_despues_de, p.custodia_liberada_en,
            v.nombre_negocio AS vendedor, fn_comprador_display(p.id_comprador) AS comprador, e.fecha_entrega,
            (SELECT d.estado FROM devolucion d WHERE d.id_pedido = p.id_pedido) AS devolucion_estado
       FROM pedido p JOIN vendedor v ON v.id_vendedor = p.id_vendedor LEFT JOIN envio e ON e.id_pedido = p.id_pedido
      WHERE ($1 = 'TODOS' OR p.custodia_estado = $1)
      ORDER BY p.fecha_pedido DESC LIMIT 200`, [estado]));
}));
router.post('/custodia/:id/liberar', ah(async (req, res) => {
  await db.q(req.ctx, 'SELECT fn_liberar_custodia($1)', [uuid(req.params.id)]);
  res.json({ message: 'Pago liberado al vendedor' });
}));
router.post('/custodia/procesar', ah(async (req, res) => {
  res.json(await db.one(req.ctx, 'SELECT * FROM fn_procesar_custodia()'));
}));

// ─── Depósitos SPEI por confirmar (en producción los confirma el banco/STP) ───
router.get('/spei', ah(async (req, res) => {
  res.json(await db.q(req.ctx,
    `SELECT p.grupo_compra, min(g.proveedor_ref) AS referencia, sum(p.total)::float8 AS total,
            string_agg('#' || p.folio, ', ' ORDER BY p.folio) AS pedidos, min(p.fecha_pedido) AS fecha,
            fn_comprador_display(min(p.id_comprador::text)::uuid) AS comprador
       FROM pedido p
       JOIN LATERAL (SELECT metodo, estado, proveedor_ref FROM pago WHERE id_pedido = p.id_pedido
                     ORDER BY fecha_creacion DESC LIMIT 1) g ON true
      WHERE g.metodo = 'SPEI' AND g.estado = 'PENDIENTE' AND p.estado = 'PENDIENTE'
      GROUP BY p.grupo_compra ORDER BY min(p.fecha_pedido) DESC`));
}));
router.post('/spei/:grupo/confirmar', ah(async (req, res) => {
  const b = req.body || {};
  res.json(await pagos.confirmarSpei(uuid(req.params.grupo, 'Compra'),
    b.monto === undefined || b.monto === '' ? undefined : num(b.monto, 'Monto', { min: 0.01 }),
    texto(b.clave_rastreo, 'Clave de rastreo', { max: 60, requerido: false })));
}));

module.exports = router;
