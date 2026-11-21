'use strict';
// ============================================================
//  Prueba de punta a punta de AgroConnecta v3.0
//  Uso:  API_URL=http://localhost:8080 npm run test:e2e
//  Crea usuarios nuevos (no toca los de demostración) y recorre el plan de negocio:
//  registro con aviso de privacidad → parcela → verificación con documentos →
//  compra (IVA 0 %/16 %, flete por km, comisión 4 %/8 %) → pago en custodia →
//  confirmación de recibido → liberación → devolución/disputa con mediación →
//  Premium → Reporte AgroConfianza → 2FA → publicidad → indicadores → seguridad.
// ============================================================
const totp = require('../utils/totp');

const BASE = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN = { email: process.env.ADMIN_EMAIL || 'admin@agroconnecta.mx', password: process.env.ADMIN_PASSWORD || 'AgroAdmin#2026' };
const DEMO = process.env.DEMO_PASSWORD || 'Demo#2026';
const sufijo = Date.now().toString(36);
let ok = 0, fallos = 0;

function check(cond, msg) {
  if (cond) { ok++; console.log(`  ✅ ${msg}`); } else { fallos++; console.log(`  ❌ ${msg}`); }
}
const cerca = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) < tol;

async function api(method, path, { token, body, form, crudo } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + '/api' + path, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  if (crudo) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  let data = null;
  try { data = await res.json(); } catch (_) { /* vacío */ }
  return { status: res.status, data };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

(async () => {
  console.log(`\n🧪 Prueba E2E v3.0 contra ${BASE}\n`);
  const cfg = (await api('GET', '/config')).data;
  check(cfg.version === '3.0.0' && cfg.comision_productor === 0.04 && cfg.comision_acopiador === 0.08,
    `Parámetros del plan: comisión ${cfg.comision_productor * 100} % / ${cfg.comision_acopiador * 100} %`);

  console.log('\n1) Registro con aviso de privacidad');
  const sinAviso = await api('POST', '/auth/register', { body: {
    nombre: 'X', apellido: 'Y', email: `sa.${sufijo}@prueba.mx`, password: 'Clave1234', tipo_usuario: 'COMPRADOR' } });
  check(sinAviso.status === 400, 'Sin aceptar el aviso de privacidad no hay registro');
  const vend = await api('POST', '/auth/register', { body: {
    nombre: 'Prueba', apellido: 'Vendedor', email: `vend.${sufijo}@prueba.mx`, password: 'Clave1234', acepto_aviso: true,
    tipo_usuario: 'VENDEDOR', perfil: 'PRODUCTOR', nombre_negocio: `Huerta ${sufijo}`, telefono: '9931234567',
    ubicacion: 'Nacajuca, Tabasco', lat: 18.17, lng: -93.02 } });
  check(vend.status === 201 && vend.data.session.perfil === 'PRODUCTOR' && !vend.data.session.verificado
    && vend.data.session.aviso.version, 'Productor registrado: sin verificar y con aviso aceptado');
  const comp = await api('POST', '/auth/register', { body: {
    nombre: 'Prueba', apellido: 'Comprador', email: `comp.${sufijo}@prueba.mx`, password: 'Clave1234', acepto_aviso: true,
    tipo_usuario: 'COMPRADOR', municipio: 'Centro (Villahermosa)' } });
  check(comp.status === 201 && comp.data.session.lat, 'Comprador registrado con su punto de entrega (PostGIS)');
  const dup = await api('POST', '/auth/register', { body: {
    nombre: 'X', apellido: 'Y', email: `comp.${sufijo}@prueba.mx`, password: 'Clave1234', tipo_usuario: 'COMPRADOR', acepto_aviso: true } });
  check(dup.status === 409, 'Correo duplicado rechazado (409)');
  const adminFalso = await api('POST', '/auth/register', { body: {
    nombre: 'X', apellido: 'Y', email: `adm.${sufijo}@prueba.mx`, password: 'Clave1234', tipo_usuario: 'ADMINISTRADOR', acepto_aviso: true } });
  check(adminFalso.status === 400, 'No se puede auto-registrar como administrador');
  check((await api('POST', '/auth/login', { body: { email: `comp.${sufijo}@prueba.mx`, password: 'incorrecta1' } })).status === 401,
    'Contraseña incorrecta rechazada');
  const adm = await api('POST', '/auth/login', { body: ADMIN });
  check(adm.status === 200, 'Login del administrador');
  let TV = vend.data.token; const TC = comp.data.token, TA = adm.data.token;

  console.log('\n2) Parcela y producto (candado «parcela y venta coherentes»)');
  const cats = (await api('GET', '/categorias')).data;
  const hort = cats.find(c => c.nombre === 'Hortalizas');
  const herr = cats.find(c => c.nombre === 'Herramientas de Campo');
  check(hort && hort.tasa_iva === 0 && herr && herr.tasa_iva === 0.16, 'IVA por categoría: Hortalizas 0 % · Herramientas 16 %');
  const fd = new FormData();
  fd.append('imagen', new Blob([PNG], { type: 'image/png' }), 'foto.png');
  const up = await api('POST', '/imagenes/subir', { token: TV, form: fd });
  check(up.status === 201 && /^\/uploads\/img\/[0-9a-f]{64}\.png$/.test(up.data.url), 'Imagen guardada con nombre SHA-256');
  const fdMala = new FormData();
  fdMala.append('imagen', new Blob([Buffer.from('<?php echo 1; ?>')], { type: 'image/png' }), 'x.png');
  check((await api('POST', '/imagenes/subir', { token: TV, form: fdMala })).status === 400, 'Archivo disfrazado de imagen rechazado');
  check((await api('POST', '/imagenes/desde-url', { token: TV, body: { url: 'http://127.0.0.1:5432/x.png' } })).status === 400,
    'Link a red interna bloqueado (anti-SSRF)');
  const base = { nombre: `Tomate saladette ${sufijo}`, descripcion: 'Prueba E2E', precio: 25, stock: 100, unidad_medida: 'kg',
    id_categoria: hort.id_categoria, imagenes: [up.data.url], tags: 'tomate,prueba' };
  const sinParcela = await api('POST', '/productos', { token: TV, body: base });
  check(sinParcela.status === 400 && /parcela/i.test(sinParcela.data.error), 'Un productor no publica cultivos sin parcela');
  const par = await api('POST', '/parcelas', { token: TV, body: { nombre: 'Parcela 1', municipio: 'Nacajuca', superficie_ha: 1, cultivo: 'Tomate', tenencia: 'EJIDAL' } });
  check(par.status === 201, 'Parcela registrada (1 ha de tomate, ejidal)');
  const prod = await api('POST', '/productos', { token: TV, body: { ...base, id_parcela: par.data.id } });
  check(prod.status === 201, 'Producto publicado y ligado a la parcela');
  const idProd = prod.data.id;
  const herram = await api('POST', '/productos', { token: TV, body: {
    nombre: `Azadón ${sufijo}`, precio: 200, stock: 10, unidad_medida: 'pieza', id_categoria: herr.id_categoria } });
  check(herram.status === 201, 'Herramienta publicada (16 % de IVA, no requiere parcela)');
  check((await api('GET', `/productos/${idProd}`)).status === 404, 'Sin verificación su producto NO aparece en el catálogo');
  check((await api('GET', `/productos/${idProd}`, { token: TV })).status === 200, 'El dueño sí ve su producto');
  const compraNoVerif = await api('POST', '/pedidos', { token: TC, body: {
    items: [{ id_producto: idProd, cantidad: 1 }], modalidad_entrega: 'RECOLECCION', metodo_pago: 'EFECTIVO' } });
  check(compraNoVerif.status === 400, 'No se puede comprar a un vendedor sin verificar');

  console.log('\n3) Productor Verificado con documentos cifrados');
  check((await api('POST', '/verificacion/enviar', { token: TV })).status === 400, 'No se envía a revisión sin los 3 documentos');
  for (const [tipo, buf, mime, nombre] of [['INE', PNG, 'image/png', 'ine.png'], ['COMPROBANTE_DOMICILIO', PDF, 'application/pdf', 'cfe.pdf'],
    ['DOCUMENTO_PARCELA', PDF, 'application/pdf', 'ejidal.pdf']]) {
    const f = new FormData();
    f.append('tipo', tipo);
    f.append('archivo', new Blob([buf], { type: mime }), nombre);
    const r = await api('POST', '/verificacion/documentos', { token: TV, form: f });
    check(r.status === 201 && r.data.sha256.length === 64, `${tipo} cargado (huella SHA-256)`);
  }
  const fx = new FormData();
  fx.append('tipo', 'INE'); fx.append('archivo', new Blob([Buffer.from('MZ\x90\x00 programa')]), 'ine.exe');
  check((await api('POST', '/verificacion/documentos', { token: TV, form: fx })).status === 400, 'Documento con formato no permitido rechazado');
  const env = await api('POST', '/verificacion/enviar', { token: TV });
  check(env.status === 200 && env.data.estado === 'EN_REVISION', 'Documentos enviados a revisión');
  const pend = (await api('GET', '/verificacion/pendientes', { token: TA })).data;
  const mio = pend.find(v => v.nombre_negocio === `Huerta ${sufijo}`);
  check(mio && mio.documentos.length === 3, 'El admin ve al productor en revisión con sus 3 documentos');
  const ine = mio.documentos.find(d => d.tipo === 'INE');
  const arch = await api('GET', `/verificacion/documentos/${ine.id_documento}/archivo`, { token: TA, crudo: true });
  check(arch.status === 200 && arch.buf.equals(PNG) && arch.headers.get('x-integridad-sha256') === 'ok',
    'El admin abre el INE (se descifra al vuelo y la huella coincide)');
  check((await api('GET', `/verificacion/documentos/${ine.id_documento}/archivo`, { token: TC, crudo: true })).status === 403,
    'Un comprador NO puede abrir documentos');
  const rech = await api('PUT', `/verificacion/vendedores/${mio.id_vendedor}`, { token: TA, body: { estado: 'RECHAZADO' } });
  check(rech.status === 400, 'Rechazar exige escribir el motivo');
  const verif = await api('PUT', `/verificacion/vendedores/${mio.id_vendedor}`, { token: TA, body: { estado: 'VERIFICADO', nota: 'Documentos en orden' } });
  check(verif.status === 200 && verif.data.verificado, 'Admin otorga la insignia Productor Verificado');
  const det = await api('GET', `/productos/${idProd}`);
  check(det.status === 200 && det.data.imagen === up.data.url && det.data.lat && det.data.parcela_cultivo === 'Tomate',
    'Ya aparece en el catálogo (con imagen, ubicación y parcela)');
  check((await api('POST', '/productos', { token: TC, body: { nombre: 'x' } })).status === 403, 'Un comprador no puede publicar');

  console.log('\n4) Compra: IVA por renglón, flete por km y comisión');
  const items = [{ id_producto: idProd, cantidad: 4, precio_unitario: 0.01 }, { id_producto: herram.data.id, cantidad: 1 }];
  const cot = await api('POST', '/pedidos/cotizar', { token: TC, body: { items, modalidad_entrega: 'ENVIO', municipio: 'Centro (Villahermosa)' } });
  const fl = cot.data.vendedores[0].flete;
  check(cot.status === 200 && fl.distancia_km > 15 && fl.distancia_km < 40, `Distancia Nacajuca → Villahermosa por PostGIS: ${fl.distancia_km} km de ruta`);
  check(fl.costo_envio === Math.round(cfg.flete_banderazo + cfg.flete_tarifa_km * fl.distancia_km) + cfg.flete_margen,
    `Flete = $${cfg.flete_banderazo} + $${cfg.flete_tarifa_km}/km + $${cfg.flete_margen} de margen = $${fl.costo_envio}`);
  check(cerca(cot.data.iva, 32), 'IVA: tomate 0 % + azadón 16 % ($200 → $32)');
  const compra = await api('POST', '/pedidos', { token: TC, body: {
    items, modalidad_entrega: 'ENVIO', direccion_entrega: 'Av. Prueba 1, Villahermosa', municipio: 'Centro (Villahermosa)', metodo_pago: 'SIMULADO' } });
  const esperado = 100 + 200 + 32 + fl.costo_envio;
  check(compra.status === 201 && cerca(compra.data.total, esperado) && cerca(compra.data.total, cot.data.total),
    `Total de la BD = $${esperado} = cotización (se ignoró el precio falso del navegador)`);
  const ped = compra.data.pedidos[0];
  const vistaV = (await api('GET', `/pedidos/${ped.id_pedido}`, { token: TV })).data;
  check(cerca(vistaV.comision_monto, 12) && cerca(vistaV.iva_comision, 1.92) && cerca(vistaV.neto_vendedor, 300 + 32 - 12 - 1.92),
    `Vendedor ve comisión 4 % = $12 + IVA $1.92 → neto $${vistaV.neto_vendedor}`);
  const vistaC = (await api('GET', `/pedidos/${ped.id_pedido}`, { token: TC })).data;
  check(vistaC.comision_monto === undefined && vistaC.custodia_estado === 'SIN_PAGO', 'El comprador no ve la comisión interna');
  check((await api('PUT', `/pedidos/${ped.id_pedido}/estado`, { token: TV, body: { estado: 'CONFIRMADO' } })).status === 400,
    'El vendedor no puede confirmar sin pago aprobado');
  const rz = await api('POST', '/pagos/simulado/confirmar', { token: TC, body: { grupo: compra.data.grupo, tarjeta: '4000 0000 0000 0002' } });
  check(rz.data.estado === 'RECHAZADO', 'Tarjeta de rechazo → pago rechazado');
  check((await api('POST', `/pedidos/grupo/${compra.data.grupo}/pagar`, { token: TC, body: { metodo_pago: 'SIMULADO' } })).status === 200, 'Reintento de pago');
  const apr = await api('POST', '/pagos/simulado/confirmar', { token: TC, body: { grupo: compra.data.grupo, tarjeta: '4242 4242 4242 4242' } });
  check(apr.data.estado === 'APROBADO', 'Tarjeta 4242 → pago aprobado');
  const trasPago = (await api('GET', `/pedidos/${ped.id_pedido}`, { token: TC })).data;
  check(trasPago.custodia_estado === 'RETENIDO', 'El dinero queda RETENIDO en custodia');
  check(cerca(trasPago.pago.monto, esperado) || trasPago.pagos.some(g => g.estado === 'APROBADO'), 'Pago registrado por el total');
  check((await api('GET', `/productos/${idProd}`)).data.stock === 96, 'Stock descontado (100 → 96)');

  console.log('\n5) Seguimiento, transportista aliado y confirmación de recibido');
  const otroVend = await api('POST', '/auth/login', { body: { email: 'campodulce@agroconnecta.mx', password: DEMO } });
  check(otroVend.status === 200 && (await api('GET', `/pedidos/${ped.id_pedido}`, { token: otroVend.data.token })).status === 404,
    'Otro vendedor NO puede ver el pedido (RLS)');
  check((await api('PUT', `/pedidos/${ped.id_pedido}/estado`, { token: TC, body: { estado: 'ENTREGADO' } })).status === 400,
    'El comprador no puede marcarlo como entregado');
  const trans = (await api('GET', '/transportistas', { token: TV })).data;
  check(trans.length >= 1, `${trans.length} transportistas aliados disponibles`);
  for (const e of ['CONFIRMADO', 'EN_CAMINO']) {
    check((await api('PUT', `/pedidos/${ped.id_pedido}/estado`, { token: TV, body: { estado: e } })).status === 200, `Vendedor → ${e}`);
  }
  const asig = await api('PUT', `/pedidos/${ped.id_pedido}/envio`, { token: TV, body: { id_transportista: trans[0].id_transportista, numero_guia: 'AC-1' } });
  check(asig.status === 200, `Envío asignado a «${trans[0].nombre}»`);
  check((await api('POST', `/pedidos/${ped.id_pedido}/recibido`, { token: TC })).status === 400, 'No se confirma de recibido antes de la entrega');
  check((await api('PUT', `/pedidos/${ped.id_pedido}/estado`, { token: TV, body: { estado: 'ENTREGADO' } })).status === 200, 'Vendedor → ENTREGADO');
  const rec = await api('POST', `/pedidos/${ped.id_pedido}/recibido`, { token: TC });
  const horas = (new Date(rec.data.liberar_despues_de) - Date.now()) / 36e5;
  check(rec.status === 200 && horas > 47.5 && horas <= 48, `Comprador confirma de recibido → el pago se libera en ${horas.toFixed(1)} h`);
  const proc = (await api('POST', '/admin/custodia/procesar', { token: TA })).data;
  const sigue = (await api('GET', `/pedidos/${ped.id_pedido}`, { token: TC })).data;
  check(proc && sigue.custodia_estado === 'RETENIDO', 'Antes de 48 h el pago sigue retenido');
  check(sigue.envio.transportista_aliado === trans[0].nombre && sigue.envio.historial.length >= 5,
    `Historial con ${sigue.envio.historial.length} movimientos y transportista aliado`);

  console.log('\n6) Calificación, perfiles y contacto oculto');
  check((await api('POST', '/calificaciones', { token: TC, body: { id_pedido: ped.id_pedido, puntuacion: 5, comentario: 'Excelente' } })).status === 201,
    'Comprador califica 5★');
  check((await api('POST', '/calificaciones', { token: TC, body: { id_pedido: ped.id_pedido, puntuacion: 1 } })).status === 409,
    'No se puede calificar dos veces');
  const me = (await api('GET', '/auth/me', { token: TV })).data;
  check(me.score.puntos === 20, `Score del vendedor = ${me.score.puntos} (10 por venta + 10 por 5★)`);
  const idVend = det.data.id_vendedor;
  const pv = await api('GET', `/perfiles/vendedor/${idVend}`);
  check(pv.status === 200 && pv.data.resumen.total === 1 && pv.data.parcelas.length === 1, 'Perfil público con la reseña y la parcela');
  check(!pv.data.contacto && pv.data.contacto_oculto, 'Sin sesión no se ve el contacto');
  const comp2 = await api('POST', '/auth/login', { body: { email: 'comprador2@agroconnecta.mx', password: DEMO } });
  const pv2 = await api('GET', `/perfiles/vendedor/${idVend}`, { token: comp2.data.token });
  check(!pv2.data.contacto && /pedido/.test(pv2.data.contacto_oculto), 'Con sesión pero sin pedido: el teléfono sigue oculto');
  const pv3 = await api('GET', `/perfiles/vendedor/${idVend}`, { token: TC });
  check(pv3.data.contacto && pv3.data.contacto.telefono === '9931234567', 'Después de un pedido formal: teléfono visible (descifrado AES-256)');
  const idComp = pv.data.resenas[0].id_comprador;
  check((await api('GET', `/perfiles/comprador/${idComp}`)).status === 401, 'El perfil del comprador requiere sesión');

  console.log('\n7) Devolución con mediación → reembolso desde custodia');
  const dev = await api('POST', '/devoluciones', { token: TC, body: { id_pedido: ped.id_pedido, motivo: 'Llegó dañado', tipo: 'DEVOLUCION' } });
  check(dev.status === 201, 'Comprador solicita devolución (el pago sigue retenido)');
  check((await api('POST', `/devoluciones/${dev.data.id_devolucion}/mensajes`, { token: TC, body: { mensaje: 'Adjunto fotos' } })).status === 201,
    'Comprador escribe en la mediación');
  check((await api('POST', `/devoluciones/${dev.data.id_devolucion}/mensajes`, { token: TV, body: { mensaje: 'Lo reviso' } })).status === 201,
    'Vendedor responde');
  check((await api('POST', `/devoluciones/${dev.data.id_devolucion}/mensajes`, { token: otroVend.data.token, body: { mensaje: 'x' } })).status >= 400,
    'Un tercero no puede escribir en el caso');
  const hilo = (await api('GET', `/devoluciones/${dev.data.id_devolucion}/mensajes`, { token: TA })).data;
  check(hilo.mensajes.length === 2, 'El admin lee la conversación completa');
  const alertasD = (await api('GET', '/admin/alertas', { token: TA })).data;
  check(alertasD.some(a => a.tipo === 'DISPUTA' && a.id_referencia === dev.data.id_devolucion), 'La devolución genera una alerta para el admin');
  check((await api('PUT', `/devoluciones/${dev.data.id_devolucion}/estado`, { token: TC, body: { estado: 'APROBADA' } })).status === 403,
    'El comprador no puede aprobarla');
  check((await api('PUT', `/devoluciones/${dev.data.id_devolucion}/estado`, { token: TA, body: { estado: 'APROBADA', resolucion: 'Reembolso' } })).status === 200,
    'Admin aprueba la devolución');
  const dped2 = (await api('GET', `/pedidos/${ped.id_pedido}`, { token: TC })).data;
  check(dped2.estado === 'DEVUELTO' && dped2.pago.estado === 'REEMBOLSADO' && dped2.custodia_estado === 'REEMBOLSADO',
    'Pedido DEVUELTO · pago y custodia REEMBOLSADOS');
  check((await api('GET', `/productos/${idProd}`)).data.stock === 100, 'Stock regresó a 100');

  console.log('\n8) SPEI → custodia → liberación al vendedor');
  const spei = await api('POST', '/pedidos', { token: TC, body: {
    items: [{ id_producto: idProd, cantidad: 10 }], modalidad_entrega: 'RECOLECCION', metodo_pago: 'SPEI' } });
  check(spei.status === 201 && spei.data.pago.tipo === 'SPEI' && /^\d{18}$/.test(spei.data.pago.clabe) && spei.data.pago.referencia,
    `SPEI: CLABE ${spei.data.pago.clabe} · referencia ${spei.data.pago.referencia}`);
  const pendSpei = (await api('GET', '/admin/spei', { token: TA })).data;
  check(pendSpei.some(s => s.grupo_compra === spei.data.grupo), 'El admin ve el depósito SPEI por confirmar');
  const dep = await api('POST', '/pagos/spei/simular', { token: TC, body: { grupo: spei.data.grupo } });
  check(dep.data.estado === 'APROBADO', 'Depósito SPEI recibido (simulado) → aprobado');
  const ps = spei.data.pedidos[0];
  const gp = (await api('GET', `/pedidos/${ps.id_pedido}`, { token: TA })).data;
  check(gp.pago.metodo === 'SPEI' && gp.custodia_estado === 'RETENIDO', 'Pago SPEI en custodia');
  for (const e of ['CONFIRMADO', 'EN_CAMINO', 'ENTREGADO']) await api('PUT', `/pedidos/${ps.id_pedido}/estado`, { token: TV, body: { estado: e } });
  await api('POST', `/pedidos/${ps.id_pedido}/recibido`, { token: TC });
  check((await api('POST', `/admin/custodia/${ps.id_pedido}/liberar`, { token: TA })).status === 200, 'Admin libera el pago al vendedor');
  const liq = (await api('GET', '/tienda/liquidaciones', { token: TV })).data;
  const fila = liq.pedidos.find(p => p.id_pedido === ps.id_pedido);
  check(fila && fila.custodia_estado === 'LIBERADO' && cerca(fila.neto_vendedor, 250 - 10 - 1.6) && liq.totales.liberado >= fila.neto_vendedor,
    `Liquidación: venta $250 → neto liberado $${fila && fila.neto_vendedor}`);
  check((await api('POST', '/devoluciones', { token: TC, body: { id_pedido: ps.id_pedido, motivo: 'tarde' } })).status === 400,
    'Ya liberado el pago, el plazo para reclamar terminó');

  console.log('\n9) Acopiador (8 %) y «Directo del productor»');
  const todos = (await api('GET', '/productos?limit=100')).data;
  const directos = (await api('GET', '/productos?directo=1&limit=100')).data;
  const acop = todos.find(p => p.vendedor_perfil === 'ACOPIADOR');
  check(acop && !directos.some(p => p.vendedor_perfil === 'ACOPIADOR') && directos.length < todos.length,
    `Filtro «Directo del productor» oculta ${todos.length - directos.length} productos de acopiador`);
  const ca = await api('POST', '/pedidos', { token: TC, body: {
    items: [{ id_producto: acop.id, cantidad: 100 }], modalidad_entrega: 'RECOLECCION', metodo_pago: 'EFECTIVO' } });
  const pa = (await api('GET', `/pedidos/${ca.data.pedidos[0].id_pedido}`, { token: TA })).data;
  check(pa.comision_pct === 0.08 && cerca(pa.comision_monto, acop.precio * 100 * 0.08) && pa.custodia_estado === 'NO_APLICA',
    `Acopiador paga 8 % ($${pa.comision_monto}); en efectivo no hay custodia`);
  await api('PUT', `/pedidos/${ca.data.pedidos[0].id_pedido}/estado`, { token: TC, body: { estado: 'CANCELADO' } });

  console.log('\n10) Alerta de volumen por parcela');
  await api('POST', '/productos', { token: TV, body: { ...base, nombre: `Tomate bola ${sufijo}`, stock: 50000, id_parcela: par.data.id } });
  const alertas = (await api('GET', '/admin/alertas', { token: TA })).data;
  check(alertas.some(a => a.tipo === 'VOLUMEN_PARCELA' && a.id_referencia === par.data.id),
    '1 ha de tomate publicando 50 t → alerta para revisión');
  const mis = (await api('GET', '/parcelas', { token: TV })).data;
  check(mis[0].en_revision && mis[0].publicado_t > mis[0].produccion_anual_t, 'El productor ve su parcela «en revisión»');

  console.log('\n11) Membresía Premium y Reporte AgroConfianza');
  const mem0 = (await api('GET', '/membresias', { token: TV })).data;
  check(!mem0.activa && mem0.precio === 199 && cerca(mem0.total, 230.84), 'Premium: $199 + IVA = $230.84 al mes');
  check((await api('POST', '/reportes', { token: TV })).status === 403, 'Sin Premium no hay Reporte AgroConfianza');
  check((await api('GET', '/tienda/estadisticas-premium', { token: TV })).status === 403, 'Sin Premium no hay estadísticas avanzadas');
  check((await api('POST', '/membresias/promocion', { token: TV, body: { codigo: 'NO-EXISTE' } })).status === 400, 'Código de alianza incorrecto rechazado');
  const m1 = await api('POST', '/membresias', { token: TV, body: { metodo: 'SIMULADO' } });
  check(m1.status === 201 && m1.data.pago.tipo === 'SIMULADO', 'Cobro de membresía iniciado');
  const m1ok = await api('POST', `/membresias/${m1.data.membresia.id_membresia}/simulado`, { token: TV, body: { tarjeta: '4242424242424242' } });
  const dias = (new Date(m1ok.data.periodo_fin) - Date.now()) / 864e5;
  check(m1ok.data.estado === 'PAGADA' && dias > 29.9 && dias <= 30, 'Membresía pagada: Premium por 30 días');
  const promo = await api('POST', '/membresias/promocion', { token: TV, body: { codigo: 'ALIANZA-TAB-2026' } });
  const mem1 = (await api('GET', '/membresias', { token: TV })).data;
  const dias2 = (new Date(mem1.premium_hasta) - Date.now()) / 864e5;
  check(promo.status === 201 && dias2 > 59.9, `Mes gratis de alianza se suma: Premium por ${dias2.toFixed(0)} días`);
  check((await api('POST', '/membresias/promocion', { token: TV, body: { codigo: 'ALIANZA-TAB-2026' } })).status === 400, 'El mes gratis solo se usa una vez');
  const lista = (await api('GET', '/productos?limit=100')).data;
  check(lista.findIndex(p => p.vendedor_premium) === 0, 'Los productos Premium aparecen primero en el catálogo');
  const est = await api('GET', '/tienda/estadisticas-premium', { token: TV });
  check(est.status === 200 && est.data.meses.length >= 1, 'Estadísticas avanzadas disponibles');
  const rep = await api('POST', '/reportes', { token: TV });
  check(rep.status === 201 && rep.data.folio && rep.data.sha256.length === 64, `Reporte AgroConfianza folio ${rep.data.folio}`);
  const pdf = await api('GET', `/reportes/${rep.data.folio}/pdf`, { token: TV, crudo: true });
  check(pdf.status === 200 && pdf.buf.subarray(0, 5).toString() === '%PDF-' && pdf.buf.length > 3000, `PDF generado (${(pdf.buf.length / 1024).toFixed(1)} KB)`);
  const verRep = await api('GET', `/reportes/verificar/${rep.data.folio}`);
  check(verRep.status === 200 && verRep.data.sha256 === rep.data.sha256 && verRep.data.vigente, 'La caja popular verifica el folio y la huella sin iniciar sesión');
  check((await api('GET', `/reportes/${rep.data.folio}/pdf`, { token: otroVend.data.token, crudo: true })).status === 404, 'Otro vendedor no puede bajar el reporte');

  console.log('\n12) Verificación en dos pasos (TOTP)');
  const ini = await api('POST', '/auth/2fa/iniciar', { token: TV });
  check(ini.status === 200 && ini.data.qr.startsWith('data:image/png') && ini.data.otpauth.startsWith('otpauth://totp/'), 'QR para Google Authenticator generado');
  check((await api('POST', '/auth/2fa/activar', { token: TV, body: { codigo: '000000' } })).status === 400, 'Código incorrecto no activa 2FA');
  check((await api('POST', '/auth/2fa/activar', { token: TV, body: { codigo: totp.codigo(ini.data.secreto) } })).status === 200, '2FA activada');
  const l1 = await api('POST', '/auth/login', { body: { email: `vend.${sufijo}@prueba.mx`, password: 'Clave1234' } });
  check(l1.status === 200 && l1.data.requiere_2fa && !l1.data.token, 'La contraseña sola ya no basta: se pide el código');
  check((await api('POST', '/auth/login/2fa', { body: { token_2fa: l1.data.token_2fa, codigo: '123456' } })).status === 401, 'Código 2FA incorrecto rechazado');
  const l2 = await api('POST', '/auth/login/2fa', { body: { token_2fa: l1.data.token_2fa, codigo: totp.codigo(ini.data.secreto) } });
  check(l2.status === 200 && l2.data.token && l2.data.session.totp_activo, 'Con el código correcto entra');
  TV = l2.data.token;
  check((await api('POST', '/auth/2fa/iniciar', { token: TC })).status === 403, 'Los compradores no usan 2FA (es para admin y vendedores)');

  console.log('\n13) Publicidad local, indicadores y finanzas');
  const ads = (await api('GET', '/publicidad?ubicacion=CATALOGO')).data;
  check(ads.length >= 1, `${ads.length} anuncio(s) local(es) vigentes`);
  await api('POST', `/publicidad/${ads[0].id_anunciante}/clic`);
  const adm2 = (await api('GET', '/publicidad/admin', { token: TA })).data.find(a => a.id_anunciante === ads[0].id_anunciante);
  check(adm2.impresiones >= 1 && adm2.clics >= 1, `Impresiones ${adm2.impresiones} · clics ${adm2.clics}`);
  const kpi = (await api('GET', '/admin/indicadores', { token: TA })).data;
  check(kpi.length === 7 && kpi.find(k => k.clave === 'ventas').meta === 150, '7 indicadores del plan con sus metas (150 ventas/mes, 70 % directo…)');
  const fin0 = (await api('GET', '/admin/finanzas', { token: TA })).data;
  check(fin0.filas.some(f => f.concepto === 'Comisiones por venta' && f.monto >= 10) && fin0.filas.some(f => f.tipo === 'RESULTADO'),
    `Finanzas del mes: comisiones $${fin0.filas[0].monto}, utilidad $${fin0.filas.find(f => f.tipo === 'RESULTADO').monto}`);
  const par0 = (await api('GET', '/admin/parametros', { token: TA })).data;
  check(par0.length >= 20, `${par0.length} parámetros editables (comisiones, flete, custodia, pasarelas)`);
  check((await api('PUT', '/admin/parametros/comision_productor', { token: TA, body: { valor: 4 } })).status === 400, 'Porcentaje mal capturado (4 en vez de 0.04) rechazado');
  check((await api('GET', '/admin/indicadores', { token: TV })).status === 403, 'Solo el admin ve los indicadores');

  console.log('\n14) Financiamiento, efectivo y cancelación');
  const fin = await api('POST', '/pedidos', { token: TC, body: {
    items: [{ id_producto: idProd, cantidad: 10 }], modalidad_entrega: 'RECOLECCION', metodo_pago: 'FINANCIAMIENTO', num_plazos: 6 } });
  const dfin = (await api('GET', `/pedidos/${fin.data.pedidos[0].id_pedido}`, { token: TC })).data;
  check(dfin.financiamiento && dfin.financiamiento.num_plazos === 6 && dfin.pago.estado === 'APROBADO' && dfin.custodia_estado === 'NO_APLICA',
    `Plan: 6 pagos de $${dfin.financiamiento && dfin.financiamiento.monto_plazo}`);
  const efe = await api('POST', '/pedidos', { token: TC, body: {
    items: [{ id_producto: idProd, cantidad: 1 }], modalidad_entrega: 'RECOLECCION', metodo_pago: 'EFECTIVO' } });
  check((await api('PUT', `/pedidos/${efe.data.pedidos[0].id_pedido}/estado`, { token: TC, body: { estado: 'CANCELADO' } })).status === 200,
    'Comprador cancela su pedido pendiente');

  console.log('\n15) Terrenos con PostGIS');
  const tcerca = (await api('GET', '/terrenos?lat=17.99&lng=-92.93&radio_km=60')).data;
  check(Array.isArray(tcerca) && tcerca.every(t => t.distancia_km <= 60), `Terrenos a ≤60 km de Villahermosa: ${tcerca.length}`);
  const ter = await api('POST', '/terrenos', { token: TV, body: {
    titulo: `Parcela prueba ${sufijo}`, superficie_ha: 3.5, ubicacion: 'Nacajuca, Tabasco', lat: 18.17, lng: -93.02,
    precio: 12000, tipo_operacion: 'ARRENDAMIENTO' } });
  check(ter.status === 201, 'Vendedor publica un terreno');
  const tdet = (await api('GET', `/terrenos/${ter.data.id}`, { token: comp2.data.token })).data;
  check(tdet.contacto && tdet.contacto.telefono === '9931234567', 'Terrenos: contacto visible con sesión (la plataforma solo conecta)');
  check(!(await api('GET', `/terrenos/${ter.data.id}`)).data.contacto, 'Contacto oculto sin sesión');

  console.log('\n16) Sesiones, bloqueo y auditoría');
  const users = (await api('GET', `/admin/usuarios?q=comp.${sufijo}`, { token: TA })).data;
  await api('PUT', `/admin/usuarios/${users[0].id_usuario}/estado`, { token: TA, body: { estado: 'SUSPENDIDO' } });
  check((await api('GET', '/auth/me', { token: TC })).status === 401, 'Al suspender al usuario su token deja de funcionar');
  await api('PUT', `/admin/usuarios/${users[0].id_usuario}/estado`, { token: TA, body: { estado: 'ACTIVO' } });
  for (let i = 0; i < 5; i++) await api('POST', '/auth/login', { body: { email: `comp.${sufijo}@prueba.mx`, password: 'mala12345' } });
  check((await api('POST', '/auth/login', { body: { email: `comp.${sufijo}@prueba.mx`, password: 'Clave1234' } })).status === 429,
    '5 intentos fallidos → cuenta bloqueada 15 min');
  check((await api('PUT', `/admin/usuarios/${users[0].id_usuario}/desbloquear`, { token: TA })).status === 200
    && (await api('POST', '/auth/login', { body: { email: `comp.${sufijo}@prueba.mx`, password: 'Clave1234' } })).status === 200,
    'El admin la desbloquea');
  await api('POST', '/auth/logout', { token: TV });
  check((await api('GET', '/auth/me', { token: TV })).status === 401, 'Logout invalida el token en la BD');
  const integ = (await api('GET', '/admin/integridad', { token: TA })).data;
  check(Array.isArray(integ) && integ.length === 5 && integ.every(r => Number(r.alterados) === 0),
    `Integridad: ${integ.map(r => `${r.elemento} ${r.revisados}/${r.alterados} alt.`).join(' · ')}`);
  check((await api('GET', '/admin/integridad', { token: otroVend.data.token })).status === 403, 'Solo el admin consulta la integridad');

  console.log(`\n${fallos ? '⚠️' : '🎉'}  ${ok} pruebas correctas, ${fallos} con error\n`);
  process.exit(fallos ? 1 : 0);
})().catch(err => { console.error('Error en la prueba:', err); process.exit(1); });
