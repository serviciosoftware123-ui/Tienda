'use strict';
// ============================================================
//  Pedidos
//  POST /api/pedidos                    → checkout (COMPRADOR). Un pedido por vendedor,
//                                         todos ligados por "grupo_compra".
//  GET  /api/pedidos                    → mis pedidos (comprador) / pedidos recibidos (vendedor) / todos (admin)
//  GET  /api/pedidos/:id                → detalle completo: productos, envío + historial, pago, reseña, devolución
//  PUT  /api/pedidos/:id/estado         → CONFIRMADO → EN_CAMINO → ENTREGADO, o CANCELADO
//  PUT  /api/pedidos/:id/envio          → paquetería y número de guía (VENDEDOR)
//  POST /api/pedidos/grupo/:grupo/pagar → reintentar el pago (COMPRADOR)
//  POST /api/pedidos/cotizar            → flete por vendedor (PostGIS) + IVA por producto, antes de pagar
//  POST /api/pedidos/:id/recibido       → el comprador confirma de recibido (inicia la liberación del pago)
//
//  Dinero de cada pedido (lo calcula la BASE DE DATOS, nunca el navegador):
//   subtotal + IVA por renglón (0 % agrícola / 16 %) + flete = total que paga el comprador
//   comisión (4 % productor · 8 % acopiador) + IVA de la comisión → neto que recibe el vendedor
// ============================================================
const express = require('express');
const crypto = require('crypto');
const db = require('../config/db');
const pagos = require('../services/pagos');
const { HttpError, ah, uuid, num, texto, paginacion } = require('../utils/http');
const { requireAuth, requireRole } = require('../middleware/auth');
const { coordenadas } = require('../utils/municipios');

const router = express.Router();

/** Punto de entrega: municipio de la lista o lat/lng exactos */
function destinoDe(b) {
  if (b.lat !== undefined && b.lat !== null && b.lat !== '' && b.lng !== undefined && b.lng !== null && b.lng !== '') {
    return { lat: num(b.lat, 'Latitud', { min: -90, max: 90 }), lng: num(b.lng, 'Longitud', { min: -180, max: 180 }) };
  }
  const c = coordenadas(b.municipio);
  if (!c) throw new HttpError(400, 'Elige el municipio de entrega para calcular el flete');
  return c;
}

function leerItems(b) {
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw new HttpError(400, 'Tu carrito está vacío');
  if (items.length > 50) throw new HttpError(400, 'Demasiados productos en un pedido');
  const cantidades = new Map();
  for (const it of items) {
    const id = uuid(it.id_producto, 'Producto');
    cantidades.set(id, (cantidades.get(id) || 0) + num(it.cantidad, 'Cantidad', { min: 0.01, max: 1e9 }));
  }
  return cantidades;
}

// Los compradores no necesitan ver la comisión interna del vendedor
function paraComprador(req, p) {
  if (req.user.tipo_usuario !== 'COMPRADOR' || !p) return p;
  for (const k of ['comision_pct', 'comision_monto', 'iva_comision', 'neto_vendedor', 'margen_logistica']) delete p[k];
  return p;
}

router.post('/cotizar', ah(async (req, res) => {
  const b = req.body || {};
  const cantidades = leerItems(b);
  const modalidad = String(b.modalidad_entrega || 'ENVIO').toUpperCase();
  const destino = modalidad === 'ENVIO' ? destinoDe(b) : null;
  const out = await db.tx(req.ctx, async c => {
    const { rows: prods } = await c.query(
      `SELECT id_producto, id_vendedor, vendedor_nombre, nombre, precio, tasa_iva, stock, unidad_medida
         FROM v_producto_catalogo WHERE id_producto = ANY($1::uuid[]) AND estado = 'ACTIVO'`, [[...cantidades.keys()]]);
    const vendedores = new Map();
    for (const p of prods) {
      const cant = cantidades.get(p.id_producto);
      const sub = Math.round(cant * p.precio * 100) / 100;
      const iva = Math.round(sub * p.tasa_iva * 100) / 100;
      if (!vendedores.has(p.id_vendedor)) vendedores.set(p.id_vendedor, { id_vendedor: p.id_vendedor, vendedor: p.vendedor_nombre, subtotal: 0, iva: 0, productos: [] });
      const v = vendedores.get(p.id_vendedor);
      v.subtotal += sub; v.iva += iva;
      v.productos.push({ id_producto: p.id_producto, nombre: p.nombre, cantidad: cant, subtotal: sub, tasa_iva: p.tasa_iva, iva, sin_stock: cant > p.stock });
    }
    const lista = [];
    for (const v of vendedores.values()) {
      let flete = { distancia_km: null, costo_envio: 0, costo_transportista: 0, margen: 0 };
      if (destino) flete = (await c.query('SELECT * FROM fn_cotizar_flete($1,$2,$3)', [v.id_vendedor, destino.lat, destino.lng])).rows[0];
      v.subtotal = Math.round(v.subtotal * 100) / 100;
      v.iva = Math.round(v.iva * 100) / 100;
      v.flete = flete;
      v.total = Math.round((v.subtotal + v.iva + Number(flete.costo_envio)) * 100) / 100;
      lista.push(v);
    }
    return lista;
  });
  res.json({
    vendedores: out,
    subtotal: out.reduce((s, v) => s + v.subtotal, 0),
    iva: out.reduce((s, v) => s + v.iva, 0),
    envio: out.reduce((s, v) => s + Number(v.flete.costo_envio), 0),
    total: Math.round(out.reduce((s, v) => s + v.total, 0) * 100) / 100,
    no_disponibles: [...cantidades.keys()].filter(id => !out.some(v => v.productos.some(p => p.id_producto === id))),
  });
}));

router.post('/', requireRole('COMPRADOR'), ah(async (req, res) => {
  const b = req.body || {};
  const modalidad = String(b.modalidad_entrega || '').toUpperCase();
  if (!['ENVIO', 'RECOLECCION'].includes(modalidad)) throw new HttpError(400, 'Elige envío o recolección');
  const metodo = String(b.metodo_pago || 'SIMULADO').toUpperCase();
  pagos.validarMetodo(metodo);
  const plazos = metodo === 'FINANCIAMIENTO' ? num(b.num_plazos, 'Plazos', { min: 1, max: 36, entero: true }) : null;
  if (plazos !== null && ![3, 6, 9, 12].includes(plazos)) throw new HttpError(400, 'Plazos permitidos: 3, 6, 9 o 12');
  const direccion = modalidad === 'ENVIO' ? texto(b.direccion_entrega, 'Dirección de entrega', { max: 300 }) : null;
  const destino = modalidad === 'ENVIO' ? destinoDe(b) : null;
  const notas = texto(b.notas, 'Notas', { max: 500, requerido: false });
  const cantidades = leerItems(b);

  const grupo = crypto.randomUUID();
  const creados = await db.tx(req.ctx, async c => {
    const { rows: prods } = await c.query(
      'SELECT id_producto, id_vendedor, nombre FROM v_producto_catalogo WHERE id_producto = ANY($1::uuid[])',
      [[...cantidades.keys()]]);
    if (prods.length !== cantidades.size) throw new HttpError(400, 'Algún producto del carrito ya no está disponible');

    const porVendedor = new Map();
    for (const p of prods) {
      if (!porVendedor.has(p.id_vendedor)) porVendedor.set(p.id_vendedor, []);
      porVendedor.get(p.id_vendedor).push(p);
    }
    const out = [];
    for (const [idVendedor, lista] of porVendedor) {
      const ped = (await c.query(
        `INSERT INTO pedido(grupo_compra, id_comprador, id_vendedor, modalidad_entrega, direccion_entrega, notas,
                            destino_geom, modificado_por)
         VALUES ($1,$2,$3,$4,$5,$6,
                 CASE WHEN $7::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($8::float8, $7::float8), 4326) END, $9)
         RETURNING id_pedido`,
        [grupo, req.ctx.rol_id, idVendedor, modalidad, direccion, notas,
         destino ? destino.lat : null, destino ? destino.lng : null, req.user.id_usuario])).rows[0];
      for (const p of lista) {
        // El precio NO viaja desde el navegador: el trigger lo toma de la tabla PRODUCTO
        await c.query('INSERT INTO detalle_pedido(id_pedido, id_producto, cantidad) VALUES ($1,$2,$3)',
          [ped.id_pedido, p.id_producto, cantidades.get(p.id_producto)]);
      }
      await c.query('INSERT INTO pago(id_pedido, metodo) VALUES ($1,$2)', [ped.id_pedido, metodo]);
      if (metodo === 'FINANCIAMIENTO') {
        await c.query('INSERT INTO financiamiento(id_comprador, id_pedido, num_plazos) VALUES ($1,$2,$3)',
          [req.ctx.rol_id, ped.id_pedido, plazos]);
      }
      out.push(ped.id_pedido);
    }
    return pagos.pedidosDelGrupo(c, grupo);
  });

  // Financiamiento: el plan queda aprobado al crearse
  if (metodo === 'FINANCIAMIENTO') {
    await db.tx(db.SISTEMA, c => c.query(
      `UPDATE pago SET estado = 'APROBADO', referencia = 'FIN-' || upper(substr(md5(random()::text), 1, 8))
        WHERE metodo = 'FINANCIAMIENTO' AND estado = 'PENDIENTE'
          AND id_pedido IN (SELECT id_pedido FROM pedido WHERE grupo_compra = $1)`, [grupo]));
  }

  let pago;
  try {
    pago = await pagos.iniciarPago({ grupo, metodo, pedidos: creados, email: req.user.email });
  } catch (err) {
    console.error('Error al iniciar el pago:', err.message);
    pago = { tipo: 'ERROR', mensaje: 'Tu pedido se guardó, pero no se pudo abrir el pago. Reintenta desde "Pedidos".' };
  }
  res.status(201).json({
    grupo, metodo, pago,
    total: creados.reduce((s, p) => s + Number(p.total), 0),
    pedidos: creados.map(p => ({ id_pedido: p.id_pedido, folio: p.folio, total: p.total, vendedor: p.nombre_negocio })),
  });
}));

router.post('/grupo/:grupo/pagar', requireRole('COMPRADOR'), ah(async (req, res) => {
  const grupo = uuid(req.params.grupo, 'Compra');
  const metodo = String((req.body || {}).metodo_pago || '').toUpperCase();
  pagos.validarMetodo(metodo);
  if (metodo === 'FINANCIAMIENTO') throw new HttpError(400, 'El financiamiento se elige al hacer el pedido');
  // Los intentos anteriores que quedaron pendientes se cancelan (solo el sistema cambia estados de pago)
  await db.one(req.ctx, 'SELECT count(*) FROM pedido WHERE grupo_compra = $1 AND id_comprador = $2', [grupo, req.ctx.rol_id])
    .then(r => { if (!r || !r.count) throw new HttpError(404, 'Compra no encontrada'); });
  await db.tx(db.SISTEMA, c => c.query(
    `UPDATE pago SET estado = 'CANCELADO' WHERE estado = 'PENDIENTE'
        AND id_pedido IN (SELECT id_pedido FROM pedido WHERE grupo_compra = $1 AND estado = 'PENDIENTE')`, [grupo]));
  const pendientes = await db.tx(req.ctx, async c => {
    const lista = (await pagos.pedidosDelGrupo(c, grupo)).filter(p => p.estado === 'PENDIENTE' && p.pago_estado !== 'APROBADO');
    if (!lista.length) throw new HttpError(400, 'No hay pagos pendientes en esta compra');
    for (const p of lista) await c.query('INSERT INTO pago(id_pedido, metodo) VALUES ($1,$2)', [p.id_pedido, metodo]);
    return pagos.pedidosDelGrupo(c, grupo);
  });
  const pago = await pagos.iniciarPago({
    grupo, metodo, pedidos: pendientes.filter(p => p.metodo === metodo && p.pago_estado === 'PENDIENTE'), email: req.user.email,
  });
  res.json({ grupo, metodo, pago });
}));

router.get('/', requireAuth, ah(async (req, res) => {
  const { estado = '', buscar = '', grupo = '' } = req.query;
  const { limit, offset } = paginacion(req.query, 100);
  const params = [];
  const where = [];
  if (estado) { params.push(String(estado).toUpperCase()); where.push(`p.estado = $${params.length}`); }
  if (grupo) { params.push(uuid(grupo, 'Compra')); where.push(`p.grupo_compra = $${params.length}`); }
  if (buscar.trim()) {
    params.push(buscar.trim().replace(/^#/, ''));
    where.push(`(p.folio::text LIKE '%' || $${params.length} || '%' OR p.id_pedido::text LIKE lower($${params.length}) || '%')`);
  }
  params.push(limit, offset);
  const rows = await db.q(req.ctx,
    `SELECT p.id_pedido, p.folio, p.grupo_compra, p.subtotal, p.impuestos_iva, p.costo_envio, p.total, p.estado,
            p.fecha_pedido, p.modalidad_entrega, p.id_vendedor, p.id_comprador, v.nombre_negocio AS vendedor_nombre,
            p.comision_pct, p.comision_monto, p.iva_comision, p.neto_vendedor, p.margen_logistica, p.distancia_km,
            p.custodia_estado, p.recepcion_confirmada_en, p.liberar_despues_de, p.custodia_liberada_en, v.perfil AS vendedor_perfil,
            fn_comprador_display(p.id_comprador) AS comprador,
            (SELECT count(*) FROM detalle_pedido d WHERE d.id_pedido = p.id_pedido)::int AS num_productos,
            (SELECT string_agg(d.nombre_producto, ', ') FROM detalle_pedido d WHERE d.id_pedido = p.id_pedido) AS productos,
            g.metodo AS pago_metodo, g.estado AS pago_estado,
            EXISTS (SELECT 1 FROM calificacion c WHERE c.id_pedido = p.id_pedido) AS calificado,
            (SELECT dv.estado FROM devolucion dv WHERE dv.id_pedido = p.id_pedido) AS devolucion_estado
       FROM pedido p
       JOIN vendedor v ON v.id_vendedor = p.id_vendedor
       LEFT JOIN LATERAL (SELECT metodo, estado FROM pago WHERE id_pedido = p.id_pedido
                          ORDER BY fecha_creacion DESC LIMIT 1) g ON true
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.fecha_pedido DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json(rows.map(r => paraComprador(req, r)));
}));

router.get('/:id', requireAuth, ah(async (req, res) => {
  const id = uuid(req.params.id);
  const out = await db.tx(req.ctx, async c => {
    const p = (await c.query(
      `SELECT p.*, v.nombre_negocio AS vendedor_nombre, fn_comprador_display(p.id_comprador) AS comprador
         FROM pedido p JOIN vendedor v ON v.id_vendedor = p.id_vendedor WHERE p.id_pedido = $1`, [id])).rows[0];
    if (!p) return null;
    delete p.hash_integridad;
    delete p.destino_geom;
    p.detalles = (await c.query(
      `SELECT d.id_detalle, d.id_producto, d.nombre_producto, d.cantidad, d.precio_unitario, d.subtotal, d.tasa_iva, d.iva_monto,
              pr.unidad_medida AS unidad,
              (SELECT i.url FROM producto_imagen i WHERE i.id_producto = d.id_producto ORDER BY i.es_principal DESC, i.orden LIMIT 1) AS imagen
         FROM detalle_pedido d JOIN producto pr ON pr.id_producto = d.id_producto
        WHERE d.id_pedido = $1`, [id])).rows;
    p.envio = (await c.query(
      `SELECT e.id_envio, e.modalidad, e.estado, e.transportista, e.numero_guia, e.fecha_estimada, e.fecha_entrega,
              e.id_transportista, t.nombre AS transportista_aliado, t.telefono AS transportista_telefono, t.vehiculo AS transportista_vehiculo
         FROM envio e LEFT JOIN transportista t ON t.id_transportista = e.id_transportista WHERE e.id_pedido = $1`, [id])).rows[0] || null;
    if (p.envio) {
      p.envio.historial = (await c.query(
        'SELECT estado_anterior, estado_nuevo, descripcion, fecha_cambio FROM historial_envio WHERE id_envio = $1 ORDER BY fecha_cambio',
        [p.envio.id_envio])).rows;
    }
    p.pagos = (await c.query(
      'SELECT id_pago, metodo, monto, estado, referencia, proveedor_ref, fecha_pago, fecha_creacion FROM pago WHERE id_pedido = $1 ORDER BY fecha_creacion DESC', [id])).rows;
    p.pago = p.pagos[0] || null;
    p.calificacion = (await c.query('SELECT puntuacion, comentario, fecha FROM calificacion WHERE id_pedido = $1', [id])).rows[0] || null;
    p.devolucion = (await c.query(
      'SELECT id_devolucion, tipo, motivo, estado, resolucion, evidencia_url, fecha_solicitud, fecha_resolucion FROM devolucion WHERE id_pedido = $1', [id])).rows[0] || null;
    p.financiamiento = (await c.query(
      'SELECT id_financiamiento, monto_total, num_plazos, monto_plazo, tasa_mensual, plazos_pagados, estado FROM financiamiento WHERE id_pedido = $1', [id])).rows[0] || null;
    return p;
  });
  if (!out) throw new HttpError(404, 'Pedido no encontrado');
  res.json(paraComprador(req, out));
}));

router.post('/:id/recibido', requireRole('COMPRADOR'), ah(async (req, res) => {
  const id = uuid(req.params.id);
  const r = await db.one(req.ctx, 'SELECT fn_confirmar_recepcion($1) AS liberar', [id]);
  res.json({ message: '¡Gracias! Confirmaste de recibido.', liberar_despues_de: r.liberar });
}));

router.put('/:id/estado', requireAuth, ah(async (req, res) => {
  const id = uuid(req.params.id);
  const estado = String((req.body || {}).estado || '').toUpperCase();
  if (!['CONFIRMADO', 'EN_CAMINO', 'ENTREGADO', 'CANCELADO'].includes(estado)) throw new HttpError(400, 'Estado inválido');
  const row = await db.one(req.ctx,
    'UPDATE pedido SET estado = $2, modificado_por = $3 WHERE id_pedido = $1 RETURNING id_pedido, folio, estado',
    [id, estado, req.user.id_usuario]);
  if (!row) throw new HttpError(404, 'Pedido no encontrado o sin permiso');
  res.json(row);
}));

router.put('/:id/envio', requireRole('VENDEDOR', 'ADMINISTRADOR'), ah(async (req, res) => {
  const id = uuid(req.params.id);
  const b = req.body || {};
  const fecha = b.fecha_estimada ? String(b.fecha_estimada).slice(0, 10) : null;
  if (fecha && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new HttpError(400, 'Fecha inválida');
  const row = await db.one(req.ctx,
    `UPDATE envio SET transportista = coalesce($2, (SELECT nombre FROM transportista WHERE id_transportista = $5::uuid)),
            numero_guia = $3, fecha_estimada = coalesce($4::date, fecha_estimada), id_transportista = $5::uuid
      WHERE id_pedido = $1 RETURNING *`,
    [id, texto(b.transportista, 'Paquetería', { max: 120, requerido: false }),
     texto(b.numero_guia, 'Número de guía', { max: 120, requerido: false }), fecha,
     b.id_transportista ? uuid(b.id_transportista, 'Transportista') : null]);
  if (!row) throw new HttpError(404, 'Envío no encontrado o sin permiso');
  res.json(row);
}));

module.exports = router;
