'use strict';
// Panel del vendedor ("Mi Tienda")
// GET /api/tienda/mi-tienda · PUT /api/tienda/mi-tienda · GET /api/tienda/productos
// GET /api/tienda/terrenos · GET /api/tienda/estadisticas
// v3.0: GET /api/tienda/liquidaciones (comisión, neto y custodia de cada venta)
//       GET /api/tienda/estadisticas-premium (ventas por mes, productos estrella, clientes recurrentes)
const express = require('express');
const db = require('../config/db');
const { ah, num, texto } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const { cifrar, descifrar, indiceCiego } = require('../utils/seguridad');
const { HttpError } = require('../utils/http');

const router = express.Router();
router.use(requireRole('VENDEDOR'));

router.get('/mi-tienda', ah(async (req, res) => {
  const v = await db.one(req.ctx,
    `SELECT v.id_vendedor, v.nombre_negocio, v.verificado, v.fecha_verificacion, v.ubicacion, v.descripcion,
            v.rfc_cifrado, ST_Y(v.geom) AS lat, ST_X(v.geom) AS lng,
            vp.rating, vp.total_calificaciones, vp.ventas, vp.score_nivel, vp.score_puntos,
            v.perfil, v.verificacion_estado, v.verificacion_nota, v.premium_hasta,
            (v.premium_hasta IS NOT NULL AND v.premium_hasta > now()) AS premium, v.promo_usada
       FROM vendedor v LEFT JOIN v_vendedor_publico vp ON vp.id_vendedor = v.id_vendedor
      WHERE v.id_vendedor = $1`, [req.ctx.rol_id]);
  if (!v) throw new HttpError(404, 'Perfil de vendedor no encontrado');
  v.rfc = descifrar(v.rfc_cifrado);
  delete v.rfc_cifrado;
  res.json(v);
}));

router.put('/mi-tienda', ah(async (req, res) => {
  const b = req.body || {};
  const rfc = b.rfc ? String(b.rfc).trim().toUpperCase() : null;
  if (rfc && !/^([A-ZÑ&]{3,4})\d{6}([A-Z\d]{3})$/.test(rfc)) throw new HttpError(400, 'RFC con formato inválido');
  const tieneGeo = b.lat !== undefined && b.lat !== '' && b.lat !== null;
  const row = await db.one(req.ctx,
    `UPDATE vendedor SET nombre_negocio = coalesce($2, nombre_negocio), descripcion = coalesce($3, descripcion),
            ubicacion = coalesce($4, ubicacion),
            geom = CASE WHEN $5::boolean THEN ST_SetSRID(ST_MakePoint($7::float8, $6::float8), 4326) ELSE geom END,
            rfc_cifrado = CASE WHEN $8::text IS NULL THEN rfc_cifrado ELSE $9 END,
            rfc_hash = CASE WHEN $8::text IS NULL THEN rfc_hash ELSE $10 END
      WHERE id_vendedor = $1 RETURNING id_vendedor`,
    [req.ctx.rol_id, b.nombre_negocio ? texto(b.nombre_negocio, 'Negocio', { max: 200 }) : null,
     b.descripcion ? texto(b.descripcion, 'Descripción', { max: 3000 }) : null,
     b.ubicacion ? texto(b.ubicacion, 'Ubicación', { max: 300 }) : null,
     tieneGeo, tieneGeo ? num(b.lat, 'Latitud', { min: -90, max: 90 }) : null,
     tieneGeo ? num(b.lng, 'Longitud', { min: -180, max: 180 }) : null,
     rfc, cifrar(rfc), indiceCiego(rfc)]);
  res.json({ ok: !!row });
}));

router.get('/productos', ah(async (req, res) => {
  res.json(await db.q(req.ctx,
    `SELECT p.id_producto AS id, p.nombre, p.descripcion, p.precio, p.stock, p.unidad_medida AS unidad, p.estado,
            p.id_categoria, c.nombre AS categoria, p.ubicacion, ST_Y(p.geom) AS lat, ST_X(p.geom) AS lng, p.tags,
            p.fecha_publicacion, p.id_parcela, pa.nombre AS parcela_nombre, p.tasa_iva AS tasa_iva_producto,
            coalesce(p.tasa_iva, c.tasa_iva)::float8 AS tasa_iva,
            (SELECT i.url FROM producto_imagen i WHERE i.id_producto = p.id_producto ORDER BY i.es_principal DESC, i.orden LIMIT 1) AS imagen,
            (SELECT coalesce(json_agg(i.url ORDER BY i.es_principal DESC, i.orden), '[]') FROM producto_imagen i
              WHERE i.id_producto = p.id_producto) AS imagenes,
            (SELECT coalesce(sum(d.cantidad), 0) FROM detalle_pedido d JOIN pedido pe ON pe.id_pedido = d.id_pedido
              WHERE d.id_producto = p.id_producto AND pe.estado NOT IN ('CANCELADO','DEVUELTO'))::float8 AS vendidos
       FROM producto p JOIN categoria c ON c.id_categoria = p.id_categoria
       LEFT JOIN parcela pa ON pa.id_parcela = p.id_parcela
      WHERE p.id_vendedor = $1 AND ($2 = '' OR p.estado = $2)
      ORDER BY (p.estado = 'INACTIVO'), p.fecha_publicacion DESC`,
    [req.ctx.rol_id, String(req.query.estado || '').toUpperCase()]));
}));

router.get('/terrenos', ah(async (req, res) => {
  res.json(await db.q(req.ctx,
    `SELECT t.id_terreno AS id, t.titulo, t.descripcion, t.superficie_ha AS superficie, t.ubicacion,
            ST_Y(t.geom) AS lat, ST_X(t.geom) AS lng, t.precio, t.tipo_operacion AS operacion, t.estado, t.tags,
            (SELECT i.url FROM terreno_imagen i WHERE i.id_terreno = t.id_terreno ORDER BY i.es_principal DESC, i.orden LIMIT 1) AS imagen,
            (SELECT coalesce(json_agg(i.url ORDER BY i.es_principal DESC, i.orden), '[]') FROM terreno_imagen i
              WHERE i.id_terreno = t.id_terreno) AS imagenes
       FROM terreno t WHERE t.id_vendedor = $1
      ORDER BY (t.estado = 'INACTIVO'), t.fecha_actualizacion DESC`, [req.ctx.rol_id]));
}));

router.get('/estadisticas', ah(async (req, res) => {
  const r = await db.one(req.ctx,
    `SELECT
       (SELECT count(*) FROM pedido WHERE id_vendedor = $1)::int AS pedidos_totales,
       (SELECT count(*) FROM pedido WHERE id_vendedor = $1 AND estado IN ('PENDIENTE','CONFIRMADO','EN_CAMINO'))::int AS pedidos_activos,
       (SELECT coalesce(sum(total), 0) FROM pedido WHERE id_vendedor = $1 AND estado = 'ENTREGADO')::float8 AS total_vendido,
       (SELECT count(*) FROM producto WHERE id_vendedor = $1 AND estado <> 'INACTIVO')::int AS productos,
       (SELECT count(*) FROM producto WHERE id_vendedor = $1 AND estado = 'ACTIVO')::int AS activos,
       (SELECT count(*) FROM producto WHERE id_vendedor = $1 AND estado = 'AGOTADO')::int AS agotados,
       (SELECT count(*) FROM terreno WHERE id_vendedor = $1 AND estado <> 'INACTIVO')::int AS terrenos`, [req.ctx.rol_id]);
  res.json(r);
}));

router.get('/liquidaciones', ah(async (req, res) => {
  const out = await db.tx(req.ctx, async c => {
    const filas = (await c.query(
      `SELECT p.id_pedido, p.folio, p.fecha_pedido, p.estado, p.subtotal, p.impuestos_iva, p.costo_envio, p.total,
              p.comision_pct::float8 AS comision_pct, p.comision_monto, p.iva_comision, p.neto_vendedor,
              p.custodia_estado, p.recepcion_confirmada_en, p.liberar_despues_de, p.custodia_liberada_en,
              g.metodo AS pago_metodo, g.estado AS pago_estado, fn_comprador_display(p.id_comprador) AS comprador
         FROM pedido p
         LEFT JOIN LATERAL (SELECT metodo, estado FROM pago WHERE id_pedido = p.id_pedido ORDER BY fecha_creacion DESC LIMIT 1) g ON true
        WHERE p.id_vendedor = $1 AND p.estado <> 'CANCELADO'
        ORDER BY p.fecha_pedido DESC LIMIT 300`, [req.ctx.rol_id])).rows;
    const tot = (await c.query(
      `SELECT coalesce(sum(neto_vendedor) FILTER (WHERE custodia_estado = 'RETENIDO'), 0)::float8 AS retenido,
              coalesce(sum(neto_vendedor) FILTER (WHERE custodia_estado = 'LIBERADO'), 0)::float8 AS liberado,
              coalesce(sum(comision_monto + iva_comision) FILTER (WHERE estado = 'ENTREGADO'), 0)::float8 AS comisiones,
              -- en efectivo el vendedor cobra directo; la comisión queda por pagar a la plataforma
              coalesce(sum(comision_monto + iva_comision) FILTER (WHERE estado = 'ENTREGADO' AND custodia_estado = 'NO_APLICA'), 0)::float8 AS comision_por_pagar
         FROM pedido WHERE id_vendedor = $1 AND estado <> 'CANCELADO'`, [req.ctx.rol_id])).rows[0];
    return { totales: tot, pedidos: filas };
  });
  res.json(out);
}));

router.get('/estadisticas-premium', ah(async (req, res) => {
  const out = await db.tx(req.ctx, async c => {
    const v = (await c.query('SELECT premium_hasta > now() AS premium FROM vendedor WHERE id_vendedor = $1', [req.ctx.rol_id])).rows[0];
    if (!v || !v.premium) throw new HttpError(403, 'Las estadísticas avanzadas son un beneficio Premium');
    const meses = (await c.query(
      `SELECT to_char(date_trunc('month', fecha_pedido), 'YYYY-MM') AS mes, count(*)::int AS pedidos,
              sum(subtotal + impuestos_iva)::float8 AS ventas, sum(neto_vendedor)::float8 AS neto
         FROM pedido WHERE id_vendedor = $1 AND estado = 'ENTREGADO' AND fecha_pedido > now() - interval '12 months'
        GROUP BY 1 ORDER BY 1`, [req.ctx.rol_id])).rows;
    const productos = (await c.query(
      `SELECT d.nombre_producto AS nombre, sum(d.cantidad)::float8 AS cantidad, sum(d.subtotal)::float8 AS ventas, count(DISTINCT d.id_pedido)::int AS pedidos
         FROM detalle_pedido d JOIN pedido p ON p.id_pedido = d.id_pedido
        WHERE p.id_vendedor = $1 AND p.estado NOT IN ('CANCELADO','DEVUELTO')
        GROUP BY d.nombre_producto ORDER BY ventas DESC LIMIT 8`, [req.ctx.rol_id])).rows;
    const clientes = (await c.query(
      `SELECT count(DISTINCT id_comprador)::int AS compradores,
              count(DISTINCT id_comprador) FILTER (WHERE n > 1)::int AS recurrentes
         FROM (SELECT id_comprador, count(*) OVER (PARTITION BY id_comprador) AS n FROM pedido
                WHERE id_vendedor = $1 AND estado NOT IN ('CANCELADO')) x`, [req.ctx.rol_id])).rows[0];
    const vistas = (await c.query(
      `SELECT coalesce(round(avg(puntuacion), 2), 0)::float8 AS rating, count(*)::int AS resenas
         FROM calificacion WHERE id_vendedor = $1`, [req.ctx.rol_id])).rows[0];
    return { meses, productos, clientes, calificaciones: vistas };
  });
  res.json(out);
}));

module.exports = router;
