'use strict';
// ============================================================
//  Reporte AgroConfianza (beneficio Premium)
//  AgroConnecta NO presta dinero: el reporte resume el historial de ventas
//  del productor y él decide compartirlo con una caja popular o financiera rural.
//   POST /api/reportes                    → genera un reporte (folio + huella SHA-256)
//   GET  /api/reportes                    → mis reportes
//   GET  /api/reportes/:folio/pdf         → PDF del reporte (dueño o admin)
//   GET  /api/reportes/verificar/:folio   → verificación PÚBLICA (la usa la institución financiera)
// ============================================================
const express = require('express');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const env = require('../config/env');
const db = require('../config/db');
const { HttpError, ah } = require('../utils/http');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
const VERDE = '#2E6B42', OSCURO = '#0B2319', GRIS = '#5b6b62';
const $ = n => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fecha = d => new Date(d).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City' });
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function folioDe(v) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 1e12) throw new HttpError(400, 'Folio inválido');
  return n;
}

router.post('/', requireRole('VENDEDOR'), ah(async (req, res) => {
  const r = await db.tx(req.ctx, async c => {
    const v = (await c.query('SELECT premium_hasta > now() AS premium, verificado FROM vendedor WHERE id_vendedor = $1', [req.ctx.rol_id])).rows[0];
    if (!v || !v.premium) throw new HttpError(403, 'El Reporte AgroConfianza es un beneficio Premium');
    if (!v.verificado) throw new HttpError(403, 'Primero obtén la insignia de Productor Verificado');
    const datos = (await c.query('SELECT fn_reporte_datos($1) AS d', [req.ctx.rol_id])).rows[0].d;
    const sha = crypto.createHash('sha256').update(JSON.stringify(datos)).digest('hex');
    return (await c.query(
      `INSERT INTO reporte_agroconfianza(id_vendedor, datos, sha256) VALUES ($1,$2,$3)
       RETURNING folio, sha256, generado_en, valido_hasta`, [req.ctx.rol_id, datos, sha])).rows[0];
  });
  res.status(201).json(r);
}));

router.get('/', requireRole('VENDEDOR'), ah(async (req, res) => {
  res.json(await db.q(req.ctx,
    `SELECT folio, sha256, generado_en, valido_hasta, valido_hasta > now() AS vigente
       FROM reporte_agroconfianza WHERE id_vendedor = $1 ORDER BY generado_en DESC LIMIT 20`, [req.ctx.rol_id]));
}));

router.get('/verificar/:folio', ah(async (req, res) => {
  const r = await db.one(db.ANON, 'SELECT * FROM fn_verificar_reporte($1)', [folioDe(req.params.folio)]);
  if (!r) throw new HttpError(404, 'No existe un reporte con ese folio');
  res.json(r);
}));

router.get('/:folio/pdf', requireRole('VENDEDOR', 'ADMINISTRADOR'), ah(async (req, res) => {
  const r = await db.one(req.ctx,
    'SELECT folio, datos, sha256, generado_en, valido_hasta FROM reporte_agroconfianza WHERE folio = $1', [folioDe(req.params.folio)]);
  if (!r) throw new HttpError(404, 'Reporte no encontrado');
  const urlVerificar = `${env.PUBLIC_URL}/Reporte.html?folio=${r.folio}`;
  const qr = await QRCode.toBuffer(urlVerificar, { margin: 0, width: 220 });

  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="AgroConfianza-${r.folio}.pdf"`,
            'Cache-Control': 'no-store, private' });
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: { Title: `Reporte AgroConfianza ${r.folio}`, Author: 'AgroConnecta Sureste' } });
  doc.pipe(res);
  const d = r.datos;
  const W = doc.page.width - 100;

  // Encabezado
  doc.rect(0, 0, doc.page.width, 96).fill(OSCURO);
  doc.fillColor('#4FB877').font('Helvetica-Bold').fontSize(10).text('AGROCONNECTA SURESTE', 50, 28);
  doc.fillColor('white').fontSize(22).text('Reporte AgroConfianza', 50, 44);
  doc.font('Helvetica').fontSize(9).fillColor('#cfe3d6')
     .text(`Folio ${r.folio}  ·  Emitido el ${fecha(r.generado_en)}  ·  Vigente hasta el ${fecha(r.valido_hasta)}`, 50, 74);
  doc.image(qr, doc.page.width - 50 - 62, 17, { width: 62 });

  doc.moveDown(3).fillColor(GRIS).fontSize(9).text(
    'Resumen del historial de ventas registrado en AgroConnecta, con trazabilidad y bitácora de auditoría. '
    + 'AgroConnecta no otorga el crédito: el productor decide compartir este reporte con la institución financiera de su elección.',
    50, 112, { width: W });

  const seccion = (titulo, y) => {
    doc.fillColor(VERDE).font('Helvetica-Bold').fontSize(12).text(titulo, 50, y);
    doc.moveTo(50, doc.y + 2).lineTo(50 + W, doc.y + 2).strokeColor('#d9e6dd').lineWidth(1).stroke();
    doc.moveDown(0.6);
  };
  const fila = (k, v) => {
    const y = doc.y;
    doc.font('Helvetica').fontSize(10).fillColor(GRIS).text(k, 50, y, { width: 190 });
    doc.font('Helvetica-Bold').fillColor(OSCURO).text(String(v ?? '—'), 245, y, { width: W - 195 });
    doc.moveDown(0.35);
  };

  seccion('Productor', 150);
  fila('Negocio', d.vendedor.negocio);
  fila('Responsable', d.vendedor.responsable);
  fila('Perfil', d.vendedor.perfil === 'PRODUCTOR' ? 'Productor (venta directa)' : 'Acopiador');
  fila('Ubicación', d.vendedor.ubicacion);
  fila('Identidad', d.vendedor.verificacion === 'VERIFICADO'
    ? `Productor Verificado desde ${fecha(d.vendedor.verificado_desde)} (INE, domicilio y parcela)` : d.vendedor.verificacion);
  fila('En la plataforma desde', fecha(d.vendedor.miembro_desde));

  doc.moveDown(0.6);
  seccion('Reputación', doc.y);
  fila('Score AgroConfianza', `${d.score.puntos} puntos · nivel ${d.score.nivel}`);
  fila('Calificación de compradores', `${Number(d.calificaciones.promedio).toFixed(1)} de 5 (${d.calificaciones.total} reseñas)`);
  fila('Pedidos entregados', d.resumen.pedidos_entregados);
  fila('Compradores distintos', d.resumen.compradores_distintos);
  fila('Cancelados / devueltos', `${d.resumen.pedidos_cancelados} / ${d.resumen.devoluciones}`);

  doc.moveDown(0.6);
  seccion('Ventas de los últimos 12 meses', doc.y);
  fila('Ventas totales (precio final)', $(d.resumen.ventas_12m));
  fila('Neto recibido por el productor', $(d.resumen.neto_recibido_12m));
  doc.moveDown(0.3);
  const y0 = doc.y;
  const cols = [50, 170, 260, 390];
  doc.rect(50, y0, W, 18).fill('#eef5f0');
  doc.fillColor(OSCURO).font('Helvetica-Bold').fontSize(9);
  ['Mes', 'Pedidos', 'Ventas', 'Neto productor'].forEach((t, i) => doc.text(t, cols[i] + 6, y0 + 5));
  let y = y0 + 20;
  doc.font('Helvetica').fontSize(9);
  if (!d.meses.length) { doc.fillColor(GRIS).text('Sin ventas entregadas en el periodo.', 56, y); y += 16; }
  for (const m of d.meses) {
    const [a, mm] = m.mes.split('-');
    doc.fillColor(OSCURO).text(`${MESES[+mm - 1]} ${a}`, cols[0] + 6, y).text(String(m.pedidos), cols[1] + 6, y)
       .text($(m.ventas), cols[2] + 6, y).text($(m.neto), cols[3] + 6, y);
    y += 15;
  }
  doc.y = y + 6;

  if (d.parcelas.length) {
    seccion('Parcelas registradas', doc.y);
    for (const p of d.parcelas) fila(p.nombre, `${p.superficie_ha} ha de ${p.cultivo} · ${p.municipio} · tenencia ${String(p.tenencia).toLowerCase()}`);
  }

  // Pie: huella e instrucciones de verificación
  const pie = doc.page.height - 110;
  doc.rect(50, pie, W, 62).fillAndStroke('#f6faf7', '#d9e6dd');
  doc.fillColor(OSCURO).font('Helvetica-Bold').fontSize(9).text('Cómo verificar este reporte', 60, pie + 8);
  doc.font('Helvetica').fillColor(GRIS).fontSize(8)
     .text(`Escanee el código QR o entre a ${urlVerificar}. La huella SHA-256 debe coincidir con:`, 60, pie + 21, { width: W - 20 })
     .font('Courier').fillColor(OSCURO).text(r.sha256, 60, pie + 42, { width: W - 20 });
  doc.end();
}));

module.exports = router;
