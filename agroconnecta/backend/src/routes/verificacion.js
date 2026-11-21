'use strict';
// ============================================================
//  Identidad verificada → insignia «Productor Verificado»
//  Vendedor:
//   GET  /api/verificacion                 → estado y documentos cargados
//   POST /api/verificacion/documentos      → subir INE, comprobante de domicilio o documento de la parcela
//                                            (multipart: "archivo" + "tipo"; JPG, PNG o PDF)
//   POST /api/verificacion/enviar          → mandar a revisión (requiere los 3 documentos)
//  Administrador:
//   GET  /api/verificacion/pendientes      → vendedores en revisión con sus documentos
//   GET  /api/verificacion/documentos/:id/archivo → ver el documento (se descifra al vuelo)
//   PUT  /api/verificacion/documentos/:id  → ACEPTADO | RECHAZADO (+ nota)
//   PUT  /api/verificacion/vendedores/:id  → VERIFICADO | RECHAZADO (+ nota) · perfil PRODUCTOR | ACOPIADOR
//
//  Los archivos se guardan CIFRADOS (AES-256-GCM) en una carpeta privada que
//  no se publica; su nombre es aleatorio y se registra la huella SHA-256.
// ============================================================
const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const env = require('../config/env');
const db = require('../config/db');
const { HttpError, ah, uuid, texto } = require('../utils/http');
const { requireRole } = require('../middleware/auth');
const { cifrarBuffer, descifrarBuffer } = require('../utils/seguridad');

const router = express.Router();
const MAX = env.MAX_DOC_MB * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX, files: 1 } });
const TIPOS = { INE: 'INE', COMPROBANTE_DOMICILIO: 'Comprobante de domicilio', DOCUMENTO_PARCELA: 'Documento de la parcela' };

function mimeReal(buf) {
  if (buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

async function documentos(c, idVendedor) {
  return (await c.query(
    `SELECT id_documento, tipo, nombre_original, mime, tamano_bytes, sha256, estado, nota, fecha_carga, fecha_revision
       FROM documento_verificacion WHERE id_vendedor = $1 AND estado <> 'REEMPLAZADO'
      ORDER BY tipo, fecha_carga DESC`, [idVendedor])).rows;
}

router.get('/', requireRole('VENDEDOR'), ah(async (req, res) => {
  const out = await db.tx(req.ctx, async c => {
    const v = (await c.query(
      'SELECT verificacion_estado, verificacion_nota, verificado, fecha_verificacion, perfil FROM vendedor WHERE id_vendedor = $1',
      [req.ctx.rol_id])).rows[0];
    return { ...v, documentos: await documentos(c, req.ctx.rol_id), tipos: TIPOS };
  });
  res.json(out);
}));

router.post('/documentos', requireRole('VENDEDOR'), (req, res, next) => {
  upload.single('archivo')(req, res, err => {
    if (err) return next(new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
      err.code === 'LIMIT_FILE_SIZE' ? `El archivo supera ${env.MAX_DOC_MB} MB` : 'No se pudo leer el archivo'));
    next();
  });
}, ah(async (req, res) => {
  const tipo = String((req.body || {}).tipo || '').toUpperCase();
  if (!TIPOS[tipo]) throw new HttpError(400, 'Tipo de documento inválido');
  if (!req.file || !req.file.buffer.length) throw new HttpError(400, 'Selecciona el archivo');
  const mime = mimeReal(req.file.buffer);
  if (!mime) throw new HttpError(400, 'Formato no permitido. Usa JPG, PNG o PDF');
  const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const nombre = `${crypto.randomBytes(16).toString('hex')}.bin`;
  const carpeta = path.join(env.DOCS_DIR, String(req.ctx.rol_id));
  await fs.mkdir(carpeta, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(carpeta, nombre), cifrarBuffer(req.file.buffer), { mode: 0o600 });
  const row = await db.one(req.ctx,
    `INSERT INTO documento_verificacion(id_vendedor, tipo, nombre_original, ruta, sha256, mime, tamano_bytes)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id_documento, tipo, estado, sha256`,
    [req.ctx.rol_id, tipo, String(req.file.originalname || '').slice(0, 200), `${req.ctx.rol_id}/${nombre}`, sha, mime, req.file.size]);
  res.status(201).json({ ...row, message: `${TIPOS[tipo]} cargado` });
}));

router.post('/enviar', requireRole('VENDEDOR'), ah(async (req, res) => {
  const r = await db.one(req.ctx, 'SELECT fn_verificacion_enviar() AS estado');
  res.json({ estado: r.estado, message: 'Tus documentos están en revisión. Te avisaremos al verificarte.' });
}));

// ─── Administrador ───
router.get('/pendientes', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const estado = String(req.query.estado || 'EN_REVISION').toUpperCase();
  const out = await db.tx(req.ctx, async c => {
    const vs = (await c.query(
      `SELECT v.id_vendedor, v.nombre_negocio, v.perfil, v.verificacion_estado, v.verificacion_nota, v.ubicacion,
              u.nombre || ' ' || u.apellido AS responsable, u.email, u.fecha_registro,
              (SELECT count(*) FROM parcela pa WHERE pa.id_vendedor = v.id_vendedor AND pa.estado = 'ACTIVA')::int AS parcelas,
              (SELECT coalesce(sum(superficie_ha), 0) FROM parcela pa WHERE pa.id_vendedor = v.id_vendedor AND pa.estado = 'ACTIVA')::float8 AS hectareas
         FROM vendedor v JOIN usuario u ON u.id_usuario = v.id_usuario
        WHERE ($1 = 'TODOS' OR v.verificacion_estado = $1)
        ORDER BY u.fecha_registro DESC LIMIT 200`, [estado])).rows;
    for (const v of vs) v.documentos = await documentos(c, v.id_vendedor);
    return vs;
  });
  res.json(out);
}));

router.get('/documentos/:id/archivo', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const d = await db.one(req.ctx, 'SELECT ruta, mime, tipo, sha256 FROM documento_verificacion WHERE id_documento = $1', [uuid(req.params.id)]);
  if (!d) throw new HttpError(404, 'Documento no encontrado');
  const ruta = path.join(env.DOCS_DIR, d.ruta);
  if (!ruta.startsWith(env.DOCS_DIR + path.sep)) throw new HttpError(400, 'Ruta inválida');
  let buf;
  try { buf = descifrarBuffer(await fs.readFile(ruta)); } catch (_) { throw new HttpError(410, 'El archivo no existe o fue alterado'); }
  const integro = crypto.createHash('sha256').update(buf).digest('hex') === d.sha256;
  res.set({
    'Content-Type': d.mime, 'Content-Disposition': `inline; filename="${d.tipo.toLowerCase()}"`,
    'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'X-Integridad-SHA256': integro ? 'ok' : 'ALTERADO',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
  });
  res.send(buf);
}));

router.put('/documentos/:id', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const estado = String((req.body || {}).estado || '').toUpperCase();
  if (!['ACEPTADO', 'RECHAZADO'].includes(estado)) throw new HttpError(400, 'Estado inválido');
  const row = await db.one(req.ctx,
    `UPDATE documento_verificacion SET estado = $2, nota = $3, fecha_revision = now()
      WHERE id_documento = $1 AND estado IN ('PENDIENTE','ACEPTADO','RECHAZADO') RETURNING id_documento, estado`,
    [uuid(req.params.id), estado, texto(req.body.nota, 'Nota', { max: 300, requerido: false })]);
  if (!row) throw new HttpError(404, 'Documento no encontrado');
  res.json(row);
}));

router.put('/vendedores/:id', requireRole('ADMINISTRADOR'), ah(async (req, res) => {
  const b = req.body || {};
  const id = uuid(req.params.id);
  const estado = b.estado ? String(b.estado).toUpperCase() : null;
  const perfil = b.perfil ? String(b.perfil).toUpperCase() : null;
  if (estado && !['VERIFICADO', 'RECHAZADO'].includes(estado)) throw new HttpError(400, 'Estado inválido');
  if (perfil && !['PRODUCTOR', 'ACOPIADOR'].includes(perfil)) throw new HttpError(400, 'Perfil inválido');
  const nota = texto(b.nota, 'Nota', { max: 500, requerido: false });
  if (estado === 'RECHAZADO' && !nota) throw new HttpError(400, 'Escribe el motivo del rechazo para el vendedor');
  const row = await db.one(req.ctx,
    `UPDATE vendedor SET verificacion_estado = coalesce($2, verificacion_estado), perfil = coalesce($3, perfil),
            verificacion_nota = CASE WHEN $2 IS NULL THEN verificacion_nota ELSE $4 END
      WHERE id_vendedor = $1 RETURNING id_vendedor, verificacion_estado, verificado, perfil`,
    [id, estado, perfil, nota]);
  if (!row) throw new HttpError(404, 'Vendedor no encontrado');
  res.json(row);
}));

module.exports = router;
