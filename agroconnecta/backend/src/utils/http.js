'use strict';
// Helpers HTTP: errores con código, envoltorio async y traducción de errores de PostgreSQL

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(v, campo = 'id') {
  if (!v || !UUID_RE.test(String(v))) throw new HttpError(400, `${campo} inválido`);
  return String(v).toLowerCase();
}

function num(v, campo, { min = -Infinity, max = Infinity, entero = false } = {}) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < min || n > max || (entero && !Number.isInteger(n))) {
    throw new HttpError(400, `${campo} inválido`);
  }
  return n;
}

function texto(v, campo, { max = 500, requerido = true } = {}) {
  const s = (v ?? '').toString().trim();
  if (requerido && !s) throw new HttpError(400, `${campo} es obligatorio`);
  if (s.length > max) throw new HttpError(400, `${campo} es demasiado largo (máx. ${max})`);
  return s || null;
}

function paginacion(query, maxLimit = 60) {
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit || '24', 10) || 24));
  return { limit, offset: (page - 1) * limit };
}

// Errores de PostgreSQL → respuesta HTTP clara
function pgErrorToHttp(err) {
  switch (err.code) {
    case '23505': return new HttpError(409, err.constraint && err.constraint.includes('email')
      ? 'El correo ya está registrado' : err.constraint && err.constraint.includes('rfc')
      ? 'El RFC ya está registrado' : 'El registro ya existe');
    case '23503': return new HttpError(400, 'Referencia inválida (registro relacionado inexistente)');
    case '23514': return new HttpError(400, 'Algún valor no cumple las reglas de la base de datos');
    case '22P02': return new HttpError(400, 'Formato de dato inválido');
    case '42501': return new HttpError(403, err.message.startsWith('permission denied') ? 'Acceso denegado' : err.message);
    case '22023':
    case 'P0001':
    case 'P0002':
    case 'P0003': return new HttpError(400, err.message);
    default: return null;
  }
}

module.exports = { HttpError, ah, uuid, num, texto, paginacion, pgErrorToHttp };
