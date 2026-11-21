'use strict';
// ============================================================
//  Datos iniciales del piloto
//   • seed base: solo si la base está vacía (categorías, admin, vendedores, compradores)
//   • complemento v3.0: corre siempre y es idempotente (parcelas, acopiador,
//     productor en revisión, Premium, transportistas y anunciantes). Así una base
//     que venía de la v2.1 también recibe los datos nuevos.
//  node src/scripts/seed.js   ó   npm run seed
// ============================================================
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const db = require('../config/db');
const env = require('../config/env');
const { cifrar, indiceCiego, cifrarBuffer } = require('../utils/seguridad');
const { coordenadas } = require('../utils/municipios');
const datos = require('./datos-seed');

async function registrar(ctx, u, tipo, extra = {}) {
  const c = u.municipio ? coordenadas(u.municipio) : null;
  const { rows } = await db.tx(ctx, cx => cx.query(
    `SELECT fn_registrar_usuario_v3($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) AS id`,
    [u.nombre, u.apellido, u.email, extra.password, tipo, cifrar(u.telefono), u.nombre_negocio || null,
     cifrar(u.rfc), indiceCiego(u.rfc), u.ubicacion || null, u.lat ?? (c && c.lat) ?? null, u.lng ?? (c && c.lng) ?? null,
     u.direccion || null, u.ciudad || null, u.descripcion || null, tipo === 'VENDEDOR' ? (u.perfil || 'PRODUCTOR') : null,
     env.VERSION_AVISO]));
  return rows[0].id;
}

async function ctxVendedor(email) {
  // Contexto SISTEMA: la API no puede leer usuarios ajenos con su propio contexto (RLS)
  const { rows } = await db.tx(db.SISTEMA, c => c.query(
    `SELECT v.id_usuario, v.id_vendedor FROM vendedor v JOIN usuario u ON u.id_usuario = v.id_usuario WHERE u.email = $1`, [email]));
  if (!rows[0]) return null;
  return { user_id: rows[0].id_usuario, role: 'VENDEDOR', rol_id: rows[0].id_vendedor };
}

async function categorias() {
  const { rows } = await db.pool.query('SELECT id_categoria, nombre FROM agro.categoria');
  return Object.fromEntries(rows.map(r => [r.nombre, r.id_categoria]));
}

/** Crea las parcelas que falten y devuelve { slug: id_parcela } */
async function parcelas(ctx, lista) {
  const ids = {};
  await db.tx(ctx, async c => {
    for (const pa of lista || []) {
      const ya = (await c.query('SELECT id_parcela FROM parcela WHERE id_vendedor = $1 AND nombre = $2', [ctx.rol_id, pa.nombre])).rows[0];
      if (ya) { ids[pa.slug] = ya.id_parcela; continue; }
      const k = coordenadas(pa.municipio) || coordenadas(`${pa.municipio}`);
      const r = await c.query(
        `INSERT INTO parcela(id_vendedor, nombre, municipio, superficie_ha, cultivo, tenencia, geom)
         VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($8::float8,$7::float8),4326) END)
         RETURNING id_parcela`,
        [ctx.rol_id, pa.nombre, pa.municipio, pa.superficie, pa.cultivo, pa.tenencia || 'PROPIA', k ? k.lat : null, k ? k.lng : null]);
      ids[pa.slug] = r.rows[0].id_parcela;
    }
  });
  return ids;
}

async function productosYTerrenos(ctx, v, cats, idsParcela) {
  await db.tx(ctx, async c => {
    for (const p of v.productos) {
      const r = await c.query(
        `INSERT INTO producto(id_vendedor, id_categoria, nombre, descripcion, precio, stock, unidad_medida, ubicacion, geom, tags,
                              modificado_por, id_parcela, tasa_iva)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ST_SetSRID(ST_MakePoint($9::float8,$10::float8),4326), $11, $12, $13, $14) RETURNING id_producto`,
        [ctx.rol_id, cats[p.categoria], p.nombre, p.descripcion, p.precio, p.stock, p.unidad, p.ubicacion, p.lng, p.lat, p.tags,
         ctx.user_id, p.parcela ? idsParcela[p.parcela] : null, p.tasa_iva ?? null]);
      await c.query(
        `INSERT INTO producto_imagen(id_producto, url, url_origen, origen, es_principal, orden) VALUES ($1,$2,$3,'SEED',true,1)`,
        [r.rows[0].id_producto, `/img/seed/${p.slug}.jpg`, p.foto]);
    }
    for (const t of v.terrenos) {
      const r = await c.query(
        `INSERT INTO terreno(id_vendedor, titulo, descripcion, superficie_ha, ubicacion, geom, precio, tipo_operacion, tags, modificado_por)
         VALUES ($1,$2,$3,$4,$5, ST_SetSRID(ST_MakePoint($6::float8,$7::float8),4326), $8,$9,$10,$11) RETURNING id_terreno`,
        [ctx.rol_id, t.titulo, t.descripcion, t.superficie, t.ubicacion, t.lng, t.lat, t.precio, t.operacion, t.tags, ctx.user_id]);
      await c.query(
        `INSERT INTO terreno_imagen(id_terreno, url, url_origen, origen, es_principal, orden) VALUES ($1,$2,$3,'SEED',true,1)`,
        [r.rows[0].id_terreno, `/img/seed/${t.slug}.jpg`, t.foto]);
    }
  });
}

async function nuevoVendedor(v, cats, log) {
  const idUsuario = await registrar(db.ANON, v, 'VENDEDOR', { password: env.SEED_DEMO_PASSWORD });
  const idVendedor = (await db.pool.query(`SELECT agro.fn_id_rol($1,'VENDEDOR') AS id`, [idUsuario])).rows[0].id;
  const ctx = { user_id: idUsuario, role: 'VENDEDOR', rol_id: idVendedor };
  const ids = await parcelas(ctx, v.parcelas);
  await productosYTerrenos(ctx, v, cats, ids);
  log(`   ✔ ${v.nombre_negocio}: ${v.productos.length} productos, ${v.terrenos.length} terreno(s), ${(v.parcelas || []).length} parcela(s)`);
  return ctx;
}

// Documento PDF de demostración (para que el admin practique la revisión)
function pdfDemo(titulo, persona) {
  return new Promise(resolve => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 60 });
    const partes = [];
    doc.on('data', b => partes.push(b));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.fontSize(26).fillColor('#b91c1c').text('DOCUMENTO DE DEMOSTRACIÓN', { align: 'center' });
    doc.moveDown().fontSize(18).fillColor('#0B2319').text(titulo, { align: 'center' });
    doc.moveDown().fontSize(12).fillColor('#444')
       .text(`Titular ficticio: ${persona}`, { align: 'center' })
       .text('Generado por el seed de AgroConnecta para la prueba piloto. No es un documento oficial.', { align: 'center' });
    doc.end();
  });
}

async function documentosDemo(ctx, persona) {
  for (const [tipo, titulo] of [['INE', 'Credencial para votar (simulada)'], ['COMPROBANTE_DOMICILIO', 'Comprobante de domicilio (simulado)'],
    ['DOCUMENTO_PARCELA', 'Constancia ejidal de la parcela (simulada)']]) {
    const buf = await pdfDemo(titulo, persona);
    const nombre = `${crypto.randomBytes(16).toString('hex')}.bin`;
    const carpeta = path.join(env.DOCS_DIR, ctx.rol_id);
    await fs.mkdir(carpeta, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(carpeta, nombre), cifrarBuffer(buf), { mode: 0o600 });
    await db.q(ctx,
      `INSERT INTO documento_verificacion(id_vendedor, tipo, nombre_original, ruta, sha256, mime, tamano_bytes)
       VALUES ($1,$2,$3,$4,$5,'application/pdf',$6)`,
      [ctx.rol_id, tipo, `${tipo.toLowerCase()}-demo.pdf`, `${ctx.rol_id}/${nombre}`,
       crypto.createHash('sha256').update(buf).digest('hex'), buf.length]);
  }
  await db.q(ctx, 'SELECT fn_verificacion_enviar()');
}

// Candado para que, si arrancan varias réplicas de la API (Kubernetes), solo una cargue los datos
async function seed(opts = {}) {
  const lock = await db.pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(424242)');
    const base = await seedBase(opts);
    await complementoV3(opts);
    return base;
  } finally {
    await lock.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    lock.release();
  }
}

async function seedBase({ silencioso = false } = {}) {
  const log = (...a) => { if (!silencioso) console.log(...a); };
  const ya = await db.pool.query('SELECT count(*)::int AS n FROM agro.categoria');
  if (ya.rows[0].n > 0) { log('ℹ️  La base ya tiene datos; no se repite el seed base.'); return false; }

  log('🌱 Cargando datos iniciales…');
  await db.tx(db.SISTEMA, async c => {
    for (const k of datos.categorias) {
      await c.query('INSERT INTO categoria(nombre, tipo, tasa_iva) VALUES ($1,$2,$3)', [k.nombre, k.tipo, k.tasa_iva ?? 0.16]);
    }
  });
  const cats = await categorias();
  await registrar(db.SISTEMA, { nombre: 'Administrador', apellido: 'AgroConnecta', email: env.SEED_ADMIN_EMAIL, telefono: null },
    'ADMINISTRADOR', { password: env.SEED_ADMIN_PASSWORD });

  for (const v of datos.vendedores) await nuevoVendedor(v, cats, log);
  for (const c of datos.compradores) await registrar(db.ANON, c, 'COMPRADOR', { password: env.SEED_DEMO_PASSWORD });

  // Los productores de la demo quedan verificados por el admin (alianza con la asociación)
  await db.tx(db.SISTEMA, c => c.query(
    `UPDATE vendedor SET verificacion_estado = 'VERIFICADO', verificacion_nota = 'Verificado por la alianza (datos de demostración)'`));
  log('✅ Datos base cargados');
  log(`   Admin:       ${env.SEED_ADMIN_EMAIL} / (SEED_ADMIN_PASSWORD)`);
  log(`   Vendedores:  ${datos.vendedores.map(v => v.email).join(', ')}`);
  log(`   Compradores: ${datos.compradores.map(c => c.email).join(', ')}  (contraseña SEED_DEMO_PASSWORD)`);
  return true;
}

/** Datos del plan de negocio (v3.0). Idempotente: solo agrega lo que falta. */
async function complementoV3({ silencioso = false } = {}) {
  const log = (...a) => { if (!silencioso) console.log(...a); };
  const v3 = await db.pool.query(`SELECT to_regclass('agro.parcela') IS NOT NULL AS ok`);
  if (!v3.rows[0].ok) { log('⚠️  Falta aplicar db/init/07_plan_negocio.sql (ejecuta ./iniciar.sh)'); return; }
  const cats = await categorias();
  let cambios = 0;

  // 1. Tasas de IVA de las categorías de la demo (bases que venían de la v2.1)
  await db.tx(db.SISTEMA, async c => {
    for (const k of datos.categorias) {
      const r = await c.query('UPDATE categoria SET tasa_iva = $2 WHERE nombre = $1 AND tasa_iva <> $2', [k.nombre, k.tasa_iva ?? 0.16]);
      cambios += r.rowCount;
    }
  });

  // 2. Parcelas de los productores de la demo y liga de sus productos
  for (const v of datos.vendedores) {
    const ctx = await ctxVendedor(v.email);
    if (!ctx) continue;
    const ids = await parcelas(ctx, v.parcelas);
    await db.tx(db.SISTEMA, async c => {
      for (const p of v.productos) {
        if (p.parcela) {
          const r = await c.query(
            'UPDATE producto SET id_parcela = $3 WHERE id_vendedor = $1 AND nombre = $2 AND id_parcela IS NULL',
            [ctx.rol_id, p.nombre, ids[p.parcela]]);
          cambios += r.rowCount;
        }
        if (p.tasa_iva !== undefined) {
          await c.query('UPDATE producto SET tasa_iva = $3 WHERE id_vendedor = $1 AND nombre = $2 AND tasa_iva IS NULL',
            [ctx.rol_id, p.nombre, p.tasa_iva]);
        }
      }
    });
    // Premium: el primer productor usa su mes gratis de la alianza
    if (v.premium) {
      const m = await db.one(ctx, 'SELECT promo_usada FROM vendedor WHERE id_vendedor = $1', [ctx.rol_id]);
      if (!m.promo_usada) {
        const cod = await db.one(db.SISTEMA, `SELECT fn_param_texto('codigo_alianza') AS c`);
        await db.q(ctx, 'SELECT fn_membresia_promocion($1)', [cod.c]);
        cambios++;
        log(`   ⭐ ${v.nombre_negocio}: Premium activo (mes gratis por alianza)`);
      }
    }
  }

  // 3. Acopiador verificado (comisión 8 %)
  if (!(await ctxVendedor(datos.acopiador.email))) {
    const ctx = await nuevoVendedor(datos.acopiador, cats, log);
    await db.tx(db.SISTEMA, c => c.query(
      `UPDATE vendedor SET verificacion_estado = 'VERIFICADO', verificacion_nota = 'Perfil Acopiador (comisión 8 %)' WHERE id_vendedor = $1`,
      [ctx.rol_id]));
    cambios++;
  }

  // 4. Productor recién registrado con documentos en revisión
  if (!(await ctxVendedor(datos.enRevision.email))) {
    const ctx = await nuevoVendedor(datos.enRevision, cats, log);
    await documentosDemo(ctx, `${datos.enRevision.nombre} ${datos.enRevision.apellido}`);
    log('   📄 Huerta Los Ríos: documentos de demostración en revisión');
    cambios++;
  }

  // 5. Transportistas aliados y anunciantes
  await db.tx(db.SISTEMA, async c => {
    if (!(await c.query('SELECT 1 FROM transportista LIMIT 1')).rowCount) {
      for (const t of datos.transportistas) {
        await c.query('INSERT INTO transportista(nombre, telefono, zona, vehiculo, capacidad_ton) VALUES ($1,$2,$3,$4,$5)',
          [t.nombre, t.telefono, t.zona, t.vehiculo, t.capacidad_ton]);
      }
      cambios++;
    }
    if (!(await c.query('SELECT 1 FROM anunciante LIMIT 1')).rowCount) {
      for (const a of datos.anunciantes) {
        await c.query(
          `INSERT INTO anunciante(nombre, giro, contacto, mensaje, imagen_url, ubicacion, cuota_mensual, fecha_inicio, fecha_fin)
           VALUES ($1,$2,$3,$4,$5,$6, fn_param('publicidad_precio'), current_date, current_date + 90)`,
          [a.nombre, a.giro, a.contacto, a.mensaje, a.imagen_url, a.ubicacion]);
      }
      cambios++;
    }
  });

  // 6. Ubicación de entrega de los compradores de la demo (para cotizar el flete)
  await db.tx(db.SISTEMA, async c => {
    for (const k of datos.compradores) {
      const p = coordenadas(k.municipio);
      if (!p) continue;
      await c.query(
        `UPDATE comprador SET geom = ST_SetSRID(ST_MakePoint($2::float8, $3::float8), 4326)
          WHERE geom IS NULL AND id_usuario = (SELECT id_usuario FROM usuario WHERE email = $1)`, [k.email, p.lng, p.lat]);
    }
  });
  if (cambios) log(`✅ Complemento v3.0 aplicado (${cambios} cambio(s))`);
}

module.exports = { seed };

if (require.main === module) {
  db.waitForDb().then(() => seed()).then(() => db.pool.end()).catch(err => {
    console.error('❌ Error en el seed:', err.message);
    process.exit(1);
  });
}
