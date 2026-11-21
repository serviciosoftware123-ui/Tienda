'use strict';
// ============================================================
//  Verificación en dos pasos — TOTP (RFC 6238, compatible con
//  Google Authenticator, Microsoft Authenticator, Authy…)
//   • Secreto de 20 bytes en Base32; código de 6 dígitos cada 30 s
//   • Se acepta ±1 intervalo (reloj del celular desfasado)
//   • El secreto se guarda cifrado con AES-256-GCM en la BD
// ============================================================
const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, valor = 0, out = '';
  for (const byte of buf) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALFABETO[(valor << (5 - bits)) & 31];
  return out;
}

function base32Decode(txt) {
  const limpio = String(txt).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, valor = 0;
  const out = [];
  for (const c of limpio) {
    valor = (valor << 5) | ALFABETO.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function nuevoSecreto() {
  return base32Encode(crypto.randomBytes(20));
}

function codigo(secreto, instante = Date.now(), paso = 30) {
  const contador = Math.floor(instante / 1000 / paso);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(contador));
  const h = crypto.createHmac('sha1', base32Decode(secreto)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

/** Compara en tiempo constante contra el intervalo actual y ±1 */
function verificar(secreto, entrada, ventana = 1) {
  const limpio = String(entrada || '').replace(/\D/g, '');
  if (limpio.length !== 6) return false;
  let ok = false;
  for (let i = -ventana; i <= ventana; i++) {
    const esperado = codigo(secreto, Date.now() + i * 30000);
    if (crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(limpio))) ok = true;
  }
  return ok;
}

function urlOtpauth(secreto, cuenta, emisor = 'AgroConnecta') {
  return `otpauth://totp/${encodeURIComponent(emisor)}:${encodeURIComponent(cuenta)}`
    + `?secret=${secreto}&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { nuevoSecreto, codigo, verificar, urlOtpauth, base32Encode, base32Decode };
