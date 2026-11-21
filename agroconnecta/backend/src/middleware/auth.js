'use strict';
// ============================================================
//  Autenticación:
//   1. Verifica la firma del JWT (HS256).
//   2. Calcula SHA-256 del token y lo valida contra la tabla SESION
//      (así un logout o una suspensión invalidan el token al instante).
//   3. Arma req.ctx = { user_id, role, rol_id } que la BD usa para RLS.
// ============================================================
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { pool, ANON } = require('../config/db');
const { sha256 } = require('../utils/seguridad');
const { HttpError } = require('../utils/http');

function tokenDe(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

async function cargarSesion(req, _res, next) {
  req.ctx = ANON;
  req.user = null;
  const token = tokenDe(req);
  if (!token) return next();
  // En login/registro se ignora un token viejo que el navegador haya guardado
  if (/^\/auth\/(login|register)$/.test(req.path)) return next();
  try {
    jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    const { rows } = await pool.query('SELECT * FROM agro.fn_sesion_validar($1)', [sha256(token)]);
    if (!rows[0]) return next(new HttpError(401, 'Tu sesión expiró. Inicia sesión de nuevo.'));
    const u = rows[0];
    req.user = u;
    req.token = token;
    req.ctx = { user_id: u.id_usuario, role: u.tipo_usuario, rol_id: u.id_rol || '' };
    next();
  } catch (_) {
    next(new HttpError(401, 'Tu sesión expiró. Inicia sesión de nuevo.'));
  }
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Inicia sesión para continuar'));
  next();
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'Inicia sesión para continuar'));
    if (!roles.includes(req.user.tipo_usuario)) return next(new HttpError(403, 'Tu tipo de cuenta no tiene acceso a esta acción'));
    next();
  };
}

module.exports = { cargarSesion, requireAuth, requireRole, tokenDe };
