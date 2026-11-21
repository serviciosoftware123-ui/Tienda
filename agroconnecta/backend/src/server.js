'use strict';
// ============================================================
//  AgroConnecta API — servidor principal
//  Node.js + Express + PostgreSQL 16 / PostGIS
// ============================================================
const os = require('os');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const db = require('./config/db');
const { cargarSesion } = require('./middleware/auth');
const { HttpError, pgErrorToHttp, ah } = require('./utils/http');
const pagosSvc = require('./services/pagos');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', /^\d+$/.test(env.TRUST_PROXY) ? parseInt(env.TRUST_PROXY, 10) : env.TRUST_PROXY);

// ── Cabeceras de seguridad (sin forzar HTTPS en la red local) ──
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", 'blob:', 'https://www.openstreetmap.org'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      ...(env.HTTPS ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  strictTransportSecurity: env.HTTPS ? { maxAge: 15552000 } : false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
}));

// CORS solo si se configura (por defecto la página y la API comparten origen)
const origenes = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (origenes.length) app.use(cors({ origin: origenes, credentials: false }));

// Webhook de Stripe necesita el cuerpo crudo (antes de express.json)
app.post('/api/pagos/stripe/webhook', express.raw({ type: 'application/json' }),
  ah(require('./routes/pagos').stripeWebhook));

app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, espera un momento.' } }));
app.use('/api', cargarSesion);

// ── Rutas ──
app.get('/api/health', ah(async (_req, res) => {
  await db.pool.query('SELECT 1');
  res.json({ status: 'ok', db: 'postgresql', ts: new Date() });
}));
app.get('/api/config', ah(async (req, res) => {
  const p = await db.one(req.ctx,
    `SELECT fn_param('comision_productor')::float8 AS comision_productor, fn_param('comision_acopiador')::float8 AS comision_acopiador,
            fn_param('membresia_precio')::float8 AS membresia_precio, fn_param('custodia_horas')::int AS custodia_horas,
            fn_param('autoconfirmar_dias')::int AS autoconfirmar_dias, fn_param('flete_banderazo')::float8 AS flete_banderazo,
            fn_param('flete_tarifa_km')::float8 AS flete_tarifa_km, fn_param('flete_margen')::float8 AS flete_margen`);
  res.json({
    nombre: 'AgroConnecta Sureste', version: '3.0.0', metodos_pago: pagosSvc.metodosDisponibles(),
    iva: 0.16, max_imagen_mb: env.MAX_IMAGE_MB, max_doc_mb: env.MAX_DOC_MB, version_aviso: env.VERSION_AVISO,
    pago_simulado: env.PAGO_SIMULADO, ...p,
  });
}));
app.get('/api/stats', ah(async (req, res) => res.json(await db.one(req.ctx, 'SELECT * FROM v_estadisticas_publicas'))));

app.use('/api/auth', require('./routes/auth').router);
app.use('/api/categorias', require('./routes/categorias'));
app.use('/api/productos', require('./routes/productos'));
app.use('/api/imagenes', require('./routes/imagenes'));
app.use('/api/terrenos', require('./routes/terrenos'));
app.use('/api/pedidos', require('./routes/pedidos'));
app.use('/api/pagos', require('./routes/pagos').router);
const postventa = require('./routes/postventa');
app.use('/api/calificaciones', postventa.calificaciones);
app.use('/api/devoluciones', postventa.devoluciones);
app.use('/api/financiamiento', postventa.financiamiento);
app.use('/api/score', postventa.score);
app.use('/api/tienda', require('./routes/tienda'));
app.use('/api/perfiles', require('./routes/perfiles'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/parcelas', require('./routes/parcelas'));
app.use('/api/verificacion', require('./routes/verificacion'));
app.use('/api/membresias', require('./routes/membresias'));
app.use('/api/publicidad', require('./routes/publicidad'));
app.use('/api/transportistas', require('./routes/transportistas'));
app.use('/api/reportes', require('./routes/reportes'));
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Ruta no encontrada')));

// ── Archivos: imágenes subidas y (opcional) la página web ──
app.use('/uploads', express.static(env.UPLOAD_DIR, {
  maxAge: '30d', immutable: true, index: false, dotfiles: 'deny',
  setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));
if (env.FRONTEND_DIR) {
  app.use(express.static(env.FRONTEND_DIR, { index: 'Agro_Conneccta-Pagina.html', extensions: ['html'] }));
}

// ── Manejo de errores ──
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const http = err instanceof HttpError ? err : pgErrorToHttp(err);
  if (http) return res.status(http.status).json({ error: http.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err.type === 'StripeInvalidRequestError' || err.type === 'StripeAuthenticationError') {
    return res.status(502).json({ error: `Stripe: ${err.message}` });
  }
  console.error(`💥 ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

function ipsLocales() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
}

// ── Tareas periódicas: custodia de pagos (cada 10 min) y latido de disponibilidad (cada 5 min) ──
async function tareaCustodia() {
  try {
    const r = await db.one(db.SISTEMA, 'SELECT * FROM fn_procesar_custodia()');
    if (r && (r.autoconfirmados || r.liberados)) console.log(`💰 Custodia: ${r.autoconfirmados} autoconfirmados, ${r.liberados} pagos liberados`);
  } catch (e) { console.warn('Custodia:', e.message); }
}
async function tareaLatido() {
  try { await db.q(db.SISTEMA, 'SELECT fn_latido()'); } catch (e) { console.warn('Latido:', e.message); }
}
function iniciarTareas() {
  tareaLatido(); tareaCustodia();
  setInterval(tareaLatido, 5 * 60 * 1000).unref();
  setInterval(tareaCustodia, 10 * 60 * 1000).unref();
}

async function start() {
  await db.waitForDb();
  // Si la carga de datos falla, la API arranca de todos modos y deja el error en el log
  if (env.SEED_ON_START) {
    try { await require('./scripts/seed').seed(); }
    catch (e) { console.error('⚠️  No se pudieron cargar los datos de prueba:', e.message); }
  }
  if (env.DESCARGAR_IMAGENES_SEED) {
    require('./scripts/localizar-imagenes').localizar().catch(e => console.warn('Fotos de ejemplo:', e.message));
  }
  if (env.TAREAS_PERIODICAS) iniciarTareas();
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`🚀 AgroConnecta API escuchando en el puerto ${env.PORT}`);
    console.log(`   Página pública: ${env.PUBLIC_URL}`);
    for (const ip of ipsLocales()) console.log(`   En esta red:    http://${ip}:${env.PORT}`);
    console.log(`   Pagos: ${pagosSvc.metodosDisponibles().map(m => m.id).join(', ')}`);
  });
  const cerrar = sig => {
    console.log(`\n${sig} recibido, cerrando…`);
    server.close(() => db.pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => cerrar('SIGTERM'));
  process.on('SIGINT', () => cerrar('SIGINT'));
}

if (require.main === module) {
  start().catch(err => { console.error('❌ No se pudo iniciar:', err); process.exit(1); });
}

module.exports = app;
