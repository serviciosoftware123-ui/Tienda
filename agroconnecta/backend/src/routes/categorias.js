'use strict';
// GET /api/categorias · POST · PUT /:id · PUT /:id/estado  (escritura solo ADMIN)
const express = require('express');
const db = require('../config/db');
const { HttpError, ah, uuid, texto } = require('../utils/http');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
const TIPOS = ['CULTIVO', 'MAQUINARIA', 'EQUIPO', 'TERRENO'];
function tasaIva(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (![0, 0.16].includes(n)) throw new HttpError(400, 'Tasa de IVA inválida (0 o 0.16)');
  return n;
}

router.get('/', ah(async (req, res) => {
  const todas = req.query.todas === '1' && req.user && req.user.tipo_usuario === 'ADMINISTRADOR';
  const rows = await db.q(req.ctx,
    `SELECT c.id_categoria, c.nombre, c.tipo, c.estado, c.id_categoria_padre, c.tasa_iva::float8 AS tasa_iva,
            (SELECT count(*) FROM v_producto_catalogo p WHERE p.id_categoria = c.id_categoria)::int AS productos
       FROM categoria c
      WHERE ($1 OR c.estado = 'ACTIVO')
      ORDER BY c.nombre`, [todas]);
  res.json(rows);
}));

router.post('/', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const nombre = texto(req.body.nombre, 'Nombre', { max: 100 });
  const tipo = String(req.body.tipo || '').toUpperCase();
  if (!TIPOS.includes(tipo)) throw new HttpError(400, 'Tipo de categoría inválido');
  const padre = req.body.id_categoria_padre ? uuid(req.body.id_categoria_padre, 'Categoría padre') : null;
  const tasa = tasaIva(req.body.tasa_iva, tipo === 'CULTIVO' ? 0 : 0.16);
  const row = await db.one(req.ctx,
    `INSERT INTO categoria(nombre, tipo, id_categoria_padre, tasa_iva) VALUES ($1,$2,$3,$4) RETURNING *`, [nombre, tipo, padre, tasa]);
  res.status(201).json(row);
}));

router.put('/:id', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const id = uuid(req.params.id);
  const nombre = texto(req.body.nombre, 'Nombre', { max: 100 });
  const tipo = String(req.body.tipo || '').toUpperCase();
  if (!TIPOS.includes(tipo)) throw new HttpError(400, 'Tipo de categoría inválido');
  const tasa = req.body.tasa_iva === undefined ? null : tasaIva(req.body.tasa_iva, 0.16);
  const row = await db.one(req.ctx,
    `UPDATE categoria SET nombre = $2, tipo = $3, tasa_iva = coalesce($4, tasa_iva) WHERE id_categoria = $1 RETURNING *`,
    [id, nombre, tipo, tasa]);
  if (!row) throw new HttpError(404, 'Categoría no encontrada');
  res.json(row);
}));

// Soft delete: no se desactiva si tiene productos activos
router.put('/:id/estado', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const id = uuid(req.params.id);
  const estado = String(req.body.estado || '').toUpperCase();
  if (!['ACTIVO', 'INACTIVO'].includes(estado)) throw new HttpError(400, 'Estado inválido');
  const row = await db.tx(req.ctx, async c => {
    if (estado === 'INACTIVO') {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM producto WHERE id_categoria = $1 AND estado <> 'INACTIVO'`, [id]);
      if (rows[0].n > 0) throw new HttpError(409, `La categoría tiene ${rows[0].n} producto(s) activos`);
    }
    return (await c.query('UPDATE categoria SET estado = $2 WHERE id_categoria = $1 RETURNING *', [id, estado])).rows[0];
  });
  if (!row) throw new HttpError(404, 'Categoría no encontrada');
  res.json(row);
}));

module.exports = router;
