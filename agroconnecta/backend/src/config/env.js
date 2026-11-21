'use strict';
// Configuración central leída de variables de entorno (.env)
const path = require('path');
require('dotenv').config({ path: process.env.DOTENV_PATH || path.resolve(__dirname, '../../.env') });

function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3000', 10),

  // URL con la que los usuarios abren la página (se usa para regresar de Stripe / Mercado Pago)
  PUBLIC_URL: (process.env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, ''),

  DB: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'agroconnecta',
    user: process.env.DB_USER || 'agro_app',
    password: req('DB_PASSWORD'),
    max: parseInt(process.env.DB_POOL_MAX || '15', 10),
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  },

  JWT_SECRET: req('JWT_SECRET'),
  JWT_EXPIRES_HOURS: parseInt(process.env.JWT_EXPIRES_HOURS || '8', 10),

  // Clave AES-256 (64 caracteres hex) para cifrar teléfono y RFC
  DATA_ENCRYPTION_KEY: req('DATA_ENCRYPTION_KEY'),

  UPLOAD_DIR: path.resolve(process.env.UPLOAD_DIR || path.resolve(__dirname, '../../uploads')),
  // Documentos de verificación (INE, comprobantes): carpeta PRIVADA, nunca se sirve como estática
  DOCS_DIR: path.resolve(process.env.DOCS_DIR || path.resolve(__dirname, '../../privado')),
  MAX_DOC_MB: parseInt(process.env.MAX_DOC_MB || '8', 10),
  // Versión del aviso de privacidad / términos que acepta cada usuario al registrarse
  VERSION_AVISO: process.env.VERSION_AVISO || '2026-11',
  // Procesos periódicos (custodia de pagos y latidos); en Kubernetes basta con que corran en cada réplica
  TAREAS_PERIODICAS: process.env.TAREAS_PERIODICAS !== 'false',
  FRONTEND_DIR: process.env.FRONTEND_DIR ? path.resolve(process.env.FRONTEND_DIR) : null,
  MAX_IMAGE_MB: parseInt(process.env.MAX_IMAGE_MB || '5', 10),

  TRUST_PROXY: process.env.TRUST_PROXY || '1',
  HTTPS: process.env.HTTPS === 'true',

  SEED_ON_START: process.env.SEED_ON_START !== 'false',
  SEED_ADMIN_EMAIL: process.env.SEED_ADMIN_EMAIL || 'admin@agroconnecta.mx',
  SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD || 'AgroAdmin#2026',
  SEED_DEMO_PASSWORD: process.env.SEED_DEMO_PASSWORD || 'Demo#2026',
  DESCARGAR_IMAGENES_SEED: process.env.DESCARGAR_IMAGENES_SEED !== 'false',

  // Pagos de prueba
  PAGO_SIMULADO: process.env.PAGO_SIMULADO !== 'false',
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN || '',
  MP_WEBHOOK_SECRET: process.env.MP_WEBHOOK_SECRET || '',
};

if (!/^[0-9a-fA-F]{64}$/.test(env.DATA_ENCRYPTION_KEY)) {
  throw new Error('DATA_ENCRYPTION_KEY debe tener 64 caracteres hexadecimales (32 bytes)');
}
if (env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET debe tener al menos 32 caracteres');
}

module.exports = env;
