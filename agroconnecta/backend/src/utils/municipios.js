'use strict';
// Municipios del piloto (Tabasco) y principales del sureste, con coordenadas [lat, lng].
// Se usan para cotizar el flete con PostGIS cuando el comprador elige su municipio de entrega.
// (La misma lista vive en frontend/js/municipios.js)
const MUNICIPIOS = {
  'Balancán': [17.8013, -91.5361], 'Cárdenas': [18.0042, -93.3783], 'Centla': [18.5389, -92.6366],
  'Centro (Villahermosa)': [17.9869, -92.9303], 'Comalcalco': [18.2767, -93.2063], 'Cunduacán': [18.0667, -93.1667],
  'Emiliano Zapata': [17.7406, -91.7664], 'Huimanguillo': [17.8325, -93.3897], 'Jalapa': [17.7208, -92.8125],
  'Jalpa de Méndez': [18.1767, -93.0628], 'Jonuta': [18.0897, -92.1386], 'Macuspana': [17.7583, -92.5961],
  'Nacajuca': [18.1694, -93.0172], 'Paraíso': [18.3997, -93.2094], 'Tacotalpa': [17.5953, -92.8261],
  'Teapa': [17.5490, -92.9520], 'Tenosique': [17.4742, -91.4236],
  // Sureste
  'Escárcega, Campeche': [18.6097, -90.7375], 'Campeche, Campeche': [19.8454, -90.5237],
  'Palenque, Chiapas': [17.5092, -91.9822], 'Tuxtla Gutiérrez, Chiapas': [16.7516, -93.1161],
  'Mérida, Yucatán': [20.9674, -89.5926], 'Tizimín, Yucatán': [21.1428, -88.1647],
};

function coordenadas(nombre) {
  const c = MUNICIPIOS[String(nombre || '').trim()];
  return c ? { lat: c[0], lng: c[1] } : null;
}

module.exports = { MUNICIPIOS, coordenadas };
