'use strict';
// ============================================================
//  Imágenes de productos y terrenos
//   • subir: archivo desde el celular / computadora (multipart)
//   • desde URL: el vendedor pega un link y el SERVIDOR descarga la
//     imagen y la guarda (no se depende del sitio original).
//  Seguridad: tipo real del archivo por "magic bytes", tamaño máximo,
//  nombre = SHA-256 del contenido, y bloqueo de IPs privadas (SSRF).
// ============================================================
const fs = require('fs/promises');
const path = require('path');
const dns = require('dns/promises');
const net = require('net');
const crypto = require('crypto');
const env = require('../config/env');
const { HttpError } = require('../utils/http');

const MAX_BYTES = env.MAX_IMAGE_MB * 1024 * 1024;
const DIR = path.join(env.UPLOAD_DIR, 'img');

function tipoReal(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.subarray(0, 6).toString('ascii') === 'GIF89a' || buf.subarray(0, 6).toString('ascii') === 'GIF87a') return 'gif';
  return null;
}

async function guardarBuffer(buf) {
  if (!buf || !buf.length) throw new HttpError(400, 'El archivo está vacío');
  if (buf.length > MAX_BYTES) throw new HttpError(413, `La imagen supera ${env.MAX_IMAGE_MB} MB`);
  const ext = tipoReal(buf);
  if (!ext) throw new HttpError(400, 'Formato no permitido. Usa JPG, PNG, WEBP o GIF');
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  await fs.mkdir(DIR, { recursive: true });
  const nombre = `${sha256}.${ext}`;
  const destino = path.join(DIR, nombre);
  try { await fs.access(destino); } catch { await fs.writeFile(destino, buf, { mode: 0o644 }); }
  return { url: `/uploads/img/${nombre}`, sha256, bytes: buf.length, tipo: ext };
}

// ── Protección SSRF: no permitir que el servidor descargue de la red interna ──
function ipPrivada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  if (s.startsWith('::ffff:')) return ipPrivada(s.slice(7));
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
}

async function validarHost(u) {
  if (!['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'El link debe empezar con http:// o https://');
  if (u.username || u.password) throw new HttpError(400, 'El link no puede incluir usuario o contraseña');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(x => x.address);
  if (!ips.length) throw new HttpError(400, 'No se encontró el sitio del link');
  if (ips.some(ipPrivada)) throw new HttpError(400, 'No se permiten links a redes privadas');
}

async function descargarDesdeUrl(urlTexto) {
  let u;
  try { u = new URL(String(urlTexto).trim()); } catch { throw new HttpError(400, 'El link no es válido'); }

  for (let salto = 0; salto < 4; salto++) {
    await validarHost(u);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    let res;
    try {
      res = await fetch(u, { redirect: 'manual', signal: ctrl.signal,
        headers: { 'User-Agent': 'AgroConnecta-ImageFetcher/2.0', Accept: 'image/*' } });
    } catch (e) {
      clearTimeout(t);
      throw new HttpError(400, 'No se pudo descargar la imagen del link (sin respuesta del sitio)');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      clearTimeout(t);
      u = new URL(res.headers.get('location'), u);
      continue;
    }
    if (!res.ok) { clearTimeout(t); throw new HttpError(400, `El sitio respondió ${res.status} al descargar la imagen`); }
    const largo = Number(res.headers.get('content-length') || 0);
    if (largo > MAX_BYTES) { clearTimeout(t); throw new HttpError(413, `La imagen supera ${env.MAX_IMAGE_MB} MB`); }

    // Lectura con límite de tamaño
    const partes = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { ctrl.abort(); clearTimeout(t); throw new HttpError(413, `La imagen supera ${env.MAX_IMAGE_MB} MB`); }
      partes.push(Buffer.from(value));
    }
    clearTimeout(t);
    const guardada = await guardarBuffer(Buffer.concat(partes));
    return { ...guardada, url_origen: String(urlTexto).trim().slice(0, 1000) };
  }
  throw new HttpError(400, 'El link redirige demasiadas veces');
}

/** Acepta tanto una imagen ya guardada (/uploads/...) como un link externo que se descarga. */
async function resolverImagen(entrada) {
  const url = String(entrada || '').trim();
  if (!url) return null;
  if (/^\/img\/seed\/[a-z0-9-]+\.jpg$/.test(url)) {           // imagen local de los datos de ejemplo
    return { url, sha256: null, origen: 'SEED', url_origen: null };
  }
  if (/^\/uploads\/img\/[0-9a-f]{64}\.(jpg|png|webp|gif)$/.test(url)) {
    const sha256 = url.split('/').pop().split('.')[0];
    try { await fs.access(path.join(DIR, url.split('/').pop())); } catch { throw new HttpError(400, 'La imagen subida ya no existe'); }
    return { url, sha256, origen: 'SUBIDA', url_origen: null };
  }
  const d = await descargarDesdeUrl(url);
  return { url: d.url, sha256: d.sha256, origen: 'URL', url_origen: d.url_origen };
}

module.exports = { guardarBuffer, descargarDesdeUrl, resolverImagen, MAX_BYTES };
