'use strict';
// ============================================================
//  Perfiles públicos
//  GET /api/perfiles/vendedor/:id   → datos, reputación, productos, terrenos, reseñas
//                                     + pedidos que el comprador con sesión puede calificar
//  GET /api/perfiles/comprador/:id  → reputación del comprador y reseñas que escribió (con sesión)
// ============================================================
const express = require('express');
const db = require('../config/db');
const { HttpError, ah, uuid } = require('../utils/http');
const { requireAuth } = require('../middleware/auth');
const { descifrar } = require('../utils/seguridad');

const router = express.Router();

async function resumen(c, campo, id) {
  const r = (await c.query(
    `SELECT count(*)::int AS total, coalesce(round(avg(puntuacion), 1), 0)::float8 AS promedio,
            count(*) FILTER (WHERE puntuacion = 5)::int AS c5, count(*) FILTER (WHERE puntuacion = 4)::int AS c4,
            count(*) FILTER (WHERE puntuacion = 3)::int AS c3, count(*) FILTER (WHERE puntuacion = 2)::int AS c2,
            count(*) FILTER (WHERE puntuacion = 1)::int AS c1
       FROM v_calificacion_publica WHERE ${campo} = $1`, [id])).rows[0];
  return { total: r.total, promedio: r.promedio, distribucion: { 5: r.c5, 4: r.c4, 3: r.c3, 2: r.c2, 1: r.c1 } };
}

router.get('/vendedor/:id', ah(async (req, res) => {
  const id = uuid(req.params.id, 'vendedor');
  const out = await db.tx(req.ctx, async c => {
    const v = (await c.query(
      `SELECT id_vendedor, nombre_negocio, verificado, ubicacion, descripcion, lat, lng, rating, total_calificaciones,
              ventas, score_nivel, score_puntos, miembro_desde, responsable, perfil, premium, verificacion_estado,
              superficie_ha, cultivos
         FROM v_vendedor_publico WHERE id_vendedor = $1`, [id])).rows[0];
    if (!v) return null;
    v.parcelas = (await c.query(
      `SELECT nombre, municipio, superficie_ha, cultivo, tenencia FROM parcela
        WHERE id_vendedor = $1 AND estado = 'ACTIVA' ORDER BY nombre`, [id])).rows;
    v.productos = (await c.query(
      `SELECT id_producto AS id, nombre, precio, stock, unidad_medida AS unidad, estado, imagen, categoria, ubicacion
         FROM v_producto_catalogo WHERE id_vendedor = $1 ORDER BY estado, fecha_publicacion DESC LIMIT 48`, [id])).rows;
    v.terrenos = (await c.query(
      `SELECT id_terreno AS id, titulo, superficie_ha AS superficie, ubicacion, precio, tipo_operacion AS operacion, imagen, estado
         FROM v_terreno_catalogo WHERE id_vendedor = $1 ORDER BY fecha_publicacion DESC`, [id])).rows;
    v.resumen = await resumen(c, 'id_vendedor', id);
    v.resenas = (await c.query(
      `SELECT id_calificacion, id_comprador, comprador, puntuacion, comentario, fecha, productos
         FROM v_calificacion_publica WHERE id_vendedor = $1 ORDER BY fecha DESC LIMIT 60`, [id])).rows;
    // Contacto oculto: teléfono y correo solo después de un pedido formal con este vendedor
    if (req.user) {
      await c.query('SAVEPOINT contacto');
      try {
        const k = (await c.query('SELECT * FROM fn_contacto_vendedor($1)', [id])).rows[0];
        if (k) v.contacto = { nombre: k.nombre, email: k.email, telefono: descifrar(k.telefono_cifrado) };
        await c.query('RELEASE SAVEPOINT contacto');
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT contacto');
        v.contacto_oculto = e.message;
      }
    } else {
      v.contacto_oculto = 'Inicia sesión y haz un pedido para ver el teléfono del vendedor';
    }
    // Pedidos entregados de este vendedor que el comprador aún no califica
    if (req.user && req.user.tipo_usuario === 'COMPRADOR') {
      v.por_calificar = (await c.query(
        `SELECT p.id_pedido, p.folio, p.fecha_pedido, p.total,
                (SELECT string_agg(d.nombre_producto, ', ') FROM detalle_pedido d WHERE d.id_pedido = p.id_pedido) AS productos
           FROM pedido p
          WHERE p.id_comprador = $1 AND p.id_vendedor = $2 AND p.estado = 'ENTREGADO'
            AND NOT EXISTS (SELECT 1 FROM calificacion k WHERE k.id_pedido = p.id_pedido)
          ORDER BY p.fecha_pedido DESC`, [req.ctx.rol_id, id])).rows;
      v.compras_con_vendedor = (await c.query(
        'SELECT count(*)::int AS n FROM pedido WHERE id_comprador = $1 AND id_vendedor = $2', [req.ctx.rol_id, id])).rows[0].n;
    }
    return v;
  });
  if (!out) throw new HttpError(404, 'Vendedor no encontrado');
  res.json(out);
}));

router.get('/comprador/:id', requireAuth, ah(async (req, res) => {
  const id = uuid(req.params.id, 'comprador');
  const out = await db.tx(req.ctx, async c => {
    const p = (await c.query('SELECT * FROM fn_perfil_comprador($1)', [id])).rows[0];
    if (!p) return null;
    p.resumen = await resumen(c, 'id_comprador', id);
    p.resenas = (await c.query(
      `SELECT id_calificacion, id_vendedor, vendedor_nombre, puntuacion, comentario, fecha, productos
         FROM v_calificacion_publica WHERE id_comprador = $1 ORDER BY fecha DESC LIMIT 60`, [id])).rows;
    p.es_yo = req.ctx.rol_id === id;
    return p;
  });
  if (!out) throw new HttpError(404, 'Comprador no encontrado');
  res.json(out);
}));

module.exports = router;
