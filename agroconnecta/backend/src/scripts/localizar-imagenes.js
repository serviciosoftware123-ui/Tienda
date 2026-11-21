'use strict';
// ============================================================
//  Descarga al servidor las fotos originales de los datos de ejemplo.
//  Mientras no haya internet se muestran las imágenes locales de /img/seed.
//  Se ejecuta en segundo plano al arrancar la API (o con: npm run imagenes).
// ============================================================
const db = require('../config/db');
const { descargarDesdeUrl } = require('../services/imagenes');

async function localizar({ silencioso = false } = {}) {
  const log = (...a) => { if (!silencioso) console.log(...a); };
  let ok = 0, fallo = 0;
  for (const tabla of ['producto_imagen', 'terreno_imagen']) {
    const rows = await db.q(db.SISTEMA,
      `SELECT id_imagen, url_origen FROM ${tabla} WHERE origen = 'SEED' AND url LIKE '/img/seed/%' AND url_origen IS NOT NULL`);
    for (const r of rows) {
      try {
        const img = await descargarDesdeUrl(r.url_origen);
        await db.q(db.SISTEMA, `UPDATE ${tabla} SET url = $2, sha256 = $3 WHERE id_imagen = $1`, [r.id_imagen, img.url, img.sha256]);
        ok++;
      } catch (_) {
        fallo++;
      }
    }
  }
  if (ok || fallo) log(`🖼  Fotos de ejemplo: ${ok} descargadas, ${fallo} sin conexión (se usan las imágenes locales)`);
  return { ok, fallo };
}

module.exports = { localizar };

if (require.main === module) {
  db.waitForDb().then(() => localizar()).then(() => db.pool.end()).catch(err => { console.error(err.message); process.exit(1); });
}
