'use strict';
// ============================================================
//  Conexión a PostgreSQL con pool.
//  Cada operación corre en una transacción donde se fija el
//  "contexto" del usuario (app.user_id / app.role / app.rol_id).
//  Las políticas RLS de la base usan ese contexto.
// ============================================================
const { Pool, types } = require('pg');
const env = require('./env');

// NUMERIC → number de JS (los montos del pilotos caben sin perder precisión)
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));
// BIGINT (count, folio) → number
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));

const pool = new Pool(env.DB);
pool.on('error', err => console.error('Error inesperado en el pool de PostgreSQL:', err.message));

const ANON = Object.freeze({ user_id: '', role: 'ANON', rol_id: '' });
const SISTEMA = Object.freeze({ user_id: '', role: 'SISTEMA', rol_id: '' });

async function setContext(client, ctx = ANON) {
  await client.query(
    `SELECT set_config('app.user_id', $1, true),
            set_config('app.role',    $2, true),
            set_config('app.rol_id',  $3, true)`,
    [ctx.user_id || '', ctx.role || 'ANON', ctx.rol_id || '']
  );
}

/** Ejecuta fn(client) dentro de una transacción con el contexto dado. */
async function tx(ctx, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setContext(client, ctx);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignorar */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Una sola consulta con contexto → rows */
async function q(ctx, sql, params = []) {
  return tx(ctx, async c => (await c.query(sql, params)).rows);
}

/** Primera fila o null */
async function one(ctx, sql, params = []) {
  const rows = await q(ctx, sql, params);
  return rows[0] || null;
}

async function waitForDb(retries = 30) {
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.log(`⏳ Esperando a PostgreSQL (${i}/${retries}): ${err.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('No fue posible conectar con PostgreSQL');
}

module.exports = { pool, tx, q, one, ANON, SISTEMA, waitForDb };
