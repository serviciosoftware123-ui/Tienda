'use strict';
// POST /api/auth/register · POST /api/auth/login · POST /api/auth/login/2fa · POST /api/auth/logout
// GET /api/auth/me · PUT /api/auth/perfil · PUT /api/auth/password
// POST /api/auth/2fa/iniciar · POST /api/auth/2fa/activar · POST /api/auth/2fa/desactivar
// GET  /api/auth/aviso  (versión vigente del aviso de privacidad)
const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const db = require('../config/db');
const QRCode = require('qrcode');
const { sha256, cifrar, descifrar, indiceCiego } = require('../utils/seguridad');
const { HttpError, ah, texto, num } = require('../utils/http');
const { requireAuth } = require('../middleware/auth');
const totp = require('../utils/totp');
const { coordenadas } = require('../utils/municipios');

const router = express.Router();

const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos.' },
});

const RFC_RE = /^([A-ZÑ&]{3,4})\d{6}([A-Z\d]{3})$/;

async function crearSesion(req, u) {
  const jti = crypto.randomBytes(16).toString('hex');
  const token = jwt.sign(
    { sub: u.id_usuario, rol: u.tipo_usuario, jti },
    env.JWT_SECRET, { algorithm: 'HS256', expiresIn: `${env.JWT_EXPIRES_HOURS}h` });
  const expira = new Date(Date.now() + env.JWT_EXPIRES_HOURS * 3600 * 1000);
  await db.pool.query('SELECT agro.fn_sesion_crear($1,$2,$3,$4,$5)',
    [u.id_usuario, sha256(token), req.ip || null, (req.headers['user-agent'] || '').slice(0, 500), expira]);
  return { token, expira };
}

async function perfil(ctx, id_usuario) {
  return db.tx(ctx, async c => {
    const u = (await c.query(
      `SELECT u.id_usuario, u.nombre, u.apellido, u.email, u.tipo_usuario, u.estado, u.telefono_cifrado,
              u.fecha_registro, u.totp_activo, u.version_aviso, u.acepto_privacidad_en,
              s.puntos AS score_puntos, s.nivel AS score_nivel, s.total_transacciones
         FROM usuario u LEFT JOIN score_agroconfianza s ON s.id_usuario = u.id_usuario
        WHERE u.id_usuario = $1`, [id_usuario])).rows[0];
    if (!u) throw new HttpError(404, 'Usuario no encontrado');
    const out = {
      id_usuario: u.id_usuario, nombre: u.nombre, apellido: u.apellido, email: u.email,
      tipo_usuario: u.tipo_usuario, estado: u.estado, telefono: descifrar(u.telefono_cifrado),
      fecha_registro: u.fecha_registro, totp_activo: u.totp_activo,
      aviso: { version: u.version_aviso, aceptado: u.acepto_privacidad_en },
      initials: (u.nombre[0] + (u.apellido || ' ')[0]).toUpperCase(),
      score: { puntos: u.score_puntos || 0, nivel: u.score_nivel || 'BRONCE', transacciones: u.total_transacciones || 0 },
    };
    if (u.tipo_usuario === 'VENDEDOR') {
      const v = (await c.query(
        `SELECT id_vendedor, nombre_negocio, verificado, ubicacion, descripcion, rfc_cifrado,
                ST_Y(geom) AS lat, ST_X(geom) AS lng, perfil, verificacion_estado, verificacion_nota,
                premium_hasta, (premium_hasta IS NOT NULL AND premium_hasta > now()) AS premium, promo_usada
           FROM vendedor WHERE id_usuario = $1`, [id_usuario])).rows[0];
      if (v) Object.assign(out, {
        id_rol: v.id_vendedor, nombre_negocio: v.nombre_negocio, verificado: v.verificado,
        ubicacion: v.ubicacion, descripcion: v.descripcion, lat: v.lat, lng: v.lng, rfc: descifrar(v.rfc_cifrado),
        perfil: v.perfil, verificacion_estado: v.verificacion_estado, verificacion_nota: v.verificacion_nota,
        premium: v.premium, premium_hasta: v.premium_hasta, promo_usada: v.promo_usada,
      });
    } else if (u.tipo_usuario === 'COMPRADOR') {
      const cp = (await c.query('SELECT id_comprador, direccion, ciudad, ST_Y(geom) AS lat, ST_X(geom) AS lng FROM comprador WHERE id_usuario = $1', [id_usuario])).rows[0];
      if (cp) Object.assign(out, { id_rol: cp.id_comprador, direccion: cp.direccion, ciudad: cp.ciudad, lat: cp.lat, lng: cp.lng });
    } else {
      const a = (await c.query('SELECT id_admin, nivel_acceso FROM administrador WHERE id_usuario = $1', [id_usuario])).rows[0];
      if (a) Object.assign(out, { id_rol: a.id_admin, nivel_acceso: a.nivel_acceso });
    }
    return out;
  });
}

// ── Registro (COMPRADOR o VENDEDOR; los admins los crea otro admin) ──
router.post('/register', limiteLogin, ah(async (req, res) => {
  const b = req.body || {};
  const tipo = String(b.tipo_usuario || '').toUpperCase();
  if (!['COMPRADOR', 'VENDEDOR'].includes(tipo)) throw new HttpError(400, 'Elige comprador o vendedor');
  const nombre = texto(b.nombre, 'Nombre', { max: 100 });
  const apellido = texto(b.apellido, 'Apellido', { max: 100 });
  const email = texto(b.email, 'Correo', { max: 150 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Correo inválido');
  const password = String(b.password || '');
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres, con letras y números');
  }
  const telefono = b.telefono ? texto(b.telefono, 'Teléfono', { max: 20 }) : null;
  if (telefono && !/^[\d\s+()-]{8,20}$/.test(telefono)) throw new HttpError(400, 'Teléfono inválido');

  if (b.acepto_aviso !== true && b.acepto_aviso !== 'true') {
    throw new HttpError(400, 'Debes aceptar el aviso de privacidad y los términos y condiciones');
  }
  let negocio = null, rfc = null, lat = null, lng = null, ubicacion = null, perfilVend = null;
  if (tipo === 'COMPRADOR' && b.municipio) {
    const c = coordenadas(b.municipio);
    if (c) { lat = c.lat; lng = c.lng; }
  }
  if (tipo === 'VENDEDOR') {
    perfilVend = String(b.perfil || 'PRODUCTOR').toUpperCase();
    if (!['PRODUCTOR', 'ACOPIADOR'].includes(perfilVend)) throw new HttpError(400, 'Elige productor o acopiador');
    negocio = texto(b.nombre_negocio, 'Nombre del negocio', { max: 200 });
    if (b.rfc) {
      rfc = String(b.rfc).trim().toUpperCase();
      if (!RFC_RE.test(rfc)) throw new HttpError(400, 'RFC con formato inválido');
    }
    ubicacion = b.ubicacion ? texto(b.ubicacion, 'Ubicación', { max: 300 }) : null;
    if (b.lat !== undefined && b.lat !== '' && b.lng !== undefined && b.lng !== '') {
      lat = num(b.lat, 'Latitud', { min: -90, max: 90 });
      lng = num(b.lng, 'Longitud', { min: -180, max: 180 });
    }
  }

  const { rows } = await db.pool.query(
    `SELECT agro.fn_registrar_usuario_v3($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) AS id`,
    [nombre, apellido, email, password, tipo, cifrar(telefono), negocio, cifrar(rfc), indiceCiego(rfc),
     ubicacion, lat, lng, b.direccion || null, b.ciudad || null, b.descripcion || null, perfilVend, env.VERSION_AVISO]);

  const u = { id_usuario: rows[0].id, tipo_usuario: tipo };
  const { token, expira } = await crearSesion(req, u);
  const ses = await db.pool.query('SELECT * FROM agro.fn_sesion_validar($1)', [sha256(token)]);
  const ctx = { user_id: u.id_usuario, role: tipo, rol_id: ses.rows[0].id_rol };
  res.status(201).json({ token, expira, session: await perfil(ctx, u.id_usuario) });
}));

// ── Login ──
router.post('/login', limiteLogin, ah(async (req, res) => {
  const email = String((req.body || {}).email || '').trim();
  const password = String((req.body || {}).password || '');
  if (!email || !password) throw new HttpError(400, 'Correo y contraseña son obligatorios');

  const { rows } = await db.pool.query('SELECT * FROM agro.fn_auth_login($1,$2)', [email, password]);
  const r = rows[0];
  if (r.resultado === 'BLOQUEADO') throw new HttpError(429, 'Cuenta bloqueada 15 minutos por intentos fallidos');
  if (r.resultado === 'SUSPENDIDO') throw new HttpError(403, 'Tu cuenta está suspendida. Contacta al administrador.');
  if (r.resultado === 'INACTIVO') throw new HttpError(403, 'Tu cuenta está inactiva');
  if (r.resultado !== 'OK') throw new HttpError(401, 'Correo o contraseña incorrectos');

  // Verificación en dos pasos: primero un pase temporal de 5 minutos, luego el código de 6 dígitos
  if (r.totp_activo) {
    const pase = jwt.sign({ sub: r.id_usuario, rol: r.tipo_usuario, uso: '2fa' }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
    return res.json({ requiere_2fa: true, token_2fa: pase });
  }
  const { token, expira } = await crearSesion(req, r);
  const ctx = { user_id: r.id_usuario, role: r.tipo_usuario, rol_id: r.id_rol || '' };
  res.json({ token, expira, session: await perfil(ctx, r.id_usuario) });
}));

router.post('/login/2fa', limiteLogin, ah(async (req, res) => {
  const { token_2fa: pase, codigo } = req.body || {};
  let datos;
  try {
    datos = jwt.verify(String(pase || ''), env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (_) { throw new HttpError(401, 'El paso de verificación expiró. Inicia sesión de nuevo.'); }
  if (datos.uso !== '2fa') throw new HttpError(401, 'Pase inválido');
  const sec = await db.pool.query('SELECT agro.fn_totp_secreto($1) AS s', [datos.sub]);
  const secreto = descifrar(sec.rows[0] && sec.rows[0].s);
  if (!secreto) throw new HttpError(401, 'No se pudo validar la verificación en dos pasos');
  if (!totp.verificar(secreto, codigo)) {
    const bloqueado = (await db.pool.query('SELECT agro.fn_totp_fallo($1) AS b', [datos.sub])).rows[0].b;
    throw new HttpError(bloqueado ? 429 : 401, bloqueado ? 'Cuenta bloqueada 15 minutos por intentos fallidos' : 'Código incorrecto');
  }
  await db.pool.query('SELECT agro.fn_totp_exito($1)', [datos.sub]);
  const { token, expira } = await crearSesion(req, { id_usuario: datos.sub, tipo_usuario: datos.rol });
  const val = (await db.pool.query('SELECT * FROM agro.fn_sesion_validar($1)', [sha256(token)])).rows[0];
  const ctx = { user_id: val.id_usuario, role: val.tipo_usuario, rol_id: val.id_rol || '' };
  res.json({ token, expira, session: await perfil(ctx, val.id_usuario) });
}));

router.get('/aviso', (_req, res) => res.json({ version: env.VERSION_AVISO }));

// ── Verificación en dos pasos (administradores y vendedores) ──
router.post('/2fa/iniciar', requireAuth, ah(async (req, res) => {
  if (req.user.tipo_usuario === 'COMPRADOR') throw new HttpError(403, 'Disponible para administradores y vendedores');
  const act = await db.one(req.ctx, 'SELECT totp_activo FROM usuario WHERE id_usuario = $1', [req.user.id_usuario]);
  if (act && act.totp_activo) throw new HttpError(400, 'Ya tienes activa la verificación en dos pasos');
  const secreto = totp.nuevoSecreto();
  await db.q(req.ctx, 'SELECT fn_totp_configurar($1, false)', [cifrar(secreto)]);
  const url = totp.urlOtpauth(secreto, req.user.email);
  res.json({ secreto, otpauth: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
}));

router.post('/2fa/activar', requireAuth, ah(async (req, res) => {
  const sec = await db.pool.query('SELECT agro.fn_totp_secreto($1) AS s', [req.user.id_usuario]);
  const secreto = descifrar(sec.rows[0] && sec.rows[0].s);
  if (!secreto) throw new HttpError(400, 'Primero genera el código QR');
  if (!totp.verificar(secreto, (req.body || {}).codigo)) throw new HttpError(400, 'Código incorrecto. Revisa la hora de tu celular.');
  await db.q(req.ctx, 'SELECT fn_totp_configurar($1, true)', [sec.rows[0].s]);
  res.json({ message: 'Verificación en dos pasos activada', totp_activo: true });
}));

router.post('/2fa/desactivar', requireAuth, ah(async (req, res) => {
  const sec = await db.pool.query('SELECT agro.fn_totp_secreto($1) AS s', [req.user.id_usuario]);
  const secreto = descifrar(sec.rows[0] && sec.rows[0].s);
  if (secreto && !totp.verificar(secreto, (req.body || {}).codigo)) throw new HttpError(400, 'Código incorrecto');
  await db.q(req.ctx, 'SELECT fn_totp_configurar(NULL, false)');
  res.json({ message: 'Verificación en dos pasos desactivada', totp_activo: false });
}));

router.post('/logout', ah(async (req, res) => {
  if (req.token) await db.pool.query('SELECT agro.fn_sesion_cerrar($1)', [sha256(req.token)]);
  res.json({ message: 'Sesión cerrada' });
}));

router.get('/me', requireAuth, ah(async (req, res) => {
  res.json(await perfil(req.ctx, req.user.id_usuario));
}));

router.put('/perfil', requireAuth, ah(async (req, res) => {
  const b = req.body || {};
  await db.tx(req.ctx, async c => {
    if (b.nombre || b.apellido || b.telefono !== undefined) {
      await c.query(
        `UPDATE usuario SET nombre = coalesce($2, nombre), apellido = coalesce($3, apellido),
                telefono_cifrado = CASE WHEN $5 THEN $4 ELSE telefono_cifrado END
          WHERE id_usuario = $1`,
        [req.user.id_usuario, b.nombre ? texto(b.nombre, 'Nombre', { max: 100 }) : null,
         b.apellido ? texto(b.apellido, 'Apellido', { max: 100 }) : null,
         b.telefono !== undefined ? cifrar(b.telefono) : null, b.telefono !== undefined]);
    }
    if (req.user.tipo_usuario === 'COMPRADOR' && (b.direccion !== undefined || b.ciudad !== undefined)) {
      await c.query('UPDATE comprador SET direccion = coalesce($2, direccion), ciudad = coalesce($3, ciudad) WHERE id_usuario = $1',
        [req.user.id_usuario, b.direccion ?? null, b.ciudad ?? null]);
    }
  });
  res.json(await perfil(req.ctx, req.user.id_usuario));
}));

router.put('/password', requireAuth, ah(async (req, res) => {
  const { actual, nueva } = req.body || {};
  if (!nueva || String(nueva).length < 8 || !/[A-Za-z]/.test(nueva) || !/\d/.test(nueva)) {
    throw new HttpError(400, 'La nueva contraseña debe tener al menos 8 caracteres, con letras y números');
  }
  const r = await db.one(req.ctx, 'SELECT fn_cambiar_password($1,$2) AS ok', [String(actual || ''), String(nueva)]);
  if (!r.ok) throw new HttpError(400, 'La contraseña actual no es correcta');
  res.json({ message: 'Contraseña actualizada. Vuelve a iniciar sesión.' });
}));

module.exports = { router, perfil };
