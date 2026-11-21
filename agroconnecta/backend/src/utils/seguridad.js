'use strict';
// ============================================================
//  Utilidades criptográficas de la API
//   • sha256()        → hash del token de sesión (lo único que se guarda)
//   • cifrar/descifrar → AES-256-GCM para teléfono y RFC
//   • indiceCiego()   → HMAC-SHA256 para buscar/evitar duplicados sin descifrar
// ============================================================
const crypto = require('crypto');
const env = require('../config/env');

const KEY = Buffer.from(env.DATA_ENCRYPTION_KEY, 'hex');
const HMAC_KEY = crypto.createHash('sha256').update(Buffer.concat([KEY, Buffer.from('indice-ciego')])).digest();

function sha256(texto) {
  return crypto.createHash('sha256').update(String(texto)).digest('hex');
}

/** AES-256-GCM → Buffer [iv(12) | tag(16) | datos] */
function cifrar(texto) {
  if (texto === undefined || texto === null || String(texto).trim() === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const datos = Buffer.concat([cipher.update(String(texto).trim(), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), datos]);
}

function descifrar(buf) {
  if (!buf) return null;
  try {
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const datos = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(datos), decipher.final()]).toString('utf8');
  } catch (_) {
    return null; // dato alterado o clave distinta
  }
}

/** AES-256-GCM para archivos (documentos de verificación): [iv(12) | tag(16) | datos] */
function cifrarBuffer(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const datos = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), datos]);
}
function descifrarBuffer(buf) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);   // lanza error si el archivo fue alterado
}

function indiceCiego(texto) {
  if (!texto) return null;
  return crypto.createHmac('sha256', HMAC_KEY).update(String(texto).trim().toUpperCase()).digest('hex');
}

/** Enmascara: "5512345678" → "******5678" */
function enmascarar(texto, visibles = 4) {
  if (!texto) return null;
  const s = String(texto);
  return s.length <= visibles ? s : '*'.repeat(s.length - visibles) + s.slice(-visibles);
}

module.exports = { sha256, cifrar, descifrar, cifrarBuffer, descifrarBuffer, indiceCiego, enmascarar };
