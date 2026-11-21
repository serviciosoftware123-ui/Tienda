/**
 * AgroConnecta v3.0 — Administración: módulos del plan de negocio
 *  Indicadores y finanzas · Verificaciones (documentos cifrados) · Alertas ·
 *  Custodia y SPEI · Publicidad · Transportistas · Membresías · Parámetros
 */
window.AdminPlan = (function () {
  const $ = id => document.getElementById(id);
  const esc = v => UI.esc(v);
  const card = (inner, extra = '') => `<div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 ${extra}">${inner}</div>`;
  const hoy = () => new Date().toISOString().slice(0, 10);
  const inicioMes = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); };

  // ── Indicadores del plan y finanzas ──
  async function indicadores() {
    const box = $('tab-plan');
    box.innerHTML = '<p class="text-gray-400 text-sm">Cargando…</p>';
    let k, par;
    try { [k, par] = await Promise.all([API.get('/admin/indicadores'), API.get('/admin/parametros')]); } catch (e) { box.innerHTML = esc(e.message); return; }
    const P = Object.fromEntries(par.map(p => [p.clave, p.valor]));
    // Modelo por venta con los parámetros vigentes (pedido promedio $3,000, 70 % SPEI / 30 % tarjeta, 30 % con flete)
    const ticket = 3000, iva = P.iva_general;
    const tarjeta = (ticket * P.tarjeta_pct + P.tarjeta_fijo) * (1 + iva);
    const spei = P.spei_fijo * (1 + iva);
    const pasarela = 0.3 * tarjeta + 0.7 * spei;
    const comision = ticket * P.comision_productor;
    const margen = comision - pasarela + 0.3 * P.flete_margen;
    const premiumNeto = P.membresia_precio - (P.membresia_precio * (1 + iva) * P.tarjeta_pct + P.tarjeta_fijo) * (1 + iva);
    const equilibrio = (P.costos_fijos_mes - 5 * premiumNeto - 2 * P.publicidad_precio) / margen;
    const fmtV = (x, u) => x === null || x === undefined ? '—' : u === '%' ? `${Number(x).toFixed(1)} %` : Number(x).toLocaleString('es-MX');
    box.innerHTML = `
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">${k.map(x => card(`
        <p class="text-xs text-gray-400">${esc(x.indicador)}</p>
        <p class="text-3xl font-bold ${x.cumple ? 'text-[#2E6B42]' : 'text-[#0B2319]'} mt-1">${fmtV(x.valor, x.unidad)}</p>
        <p class="text-[11px] text-gray-400">${esc(x.que_mide)}</p>
        <div class="flex items-center justify-between mt-2"><span class="text-[11px] text-gray-500">Meta: ${x.clave === 'precio' ? 'subir cada trimestre' + (x.meta ? ` (antes ${fmtV(x.meta, '%')})` : '') : fmtV(x.meta, x.unidad) + (x.clave === 'disponibilidad' ? '' : ' a 12 meses')}</span>
          ${UI.badge(x.cumple ? 'En meta' : 'En camino', x.cumple ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500')}</div>`)).join('')}</div>
      <div class="grid lg:grid-cols-5 gap-6">
        <div class="lg:col-span-3">${card(`
          <div class="flex items-center justify-between gap-3 flex-wrap mb-4"><p class="font-bold text-[#0B2319]">Finanzas reales del periodo</p>
            <div class="flex gap-2 items-center text-xs"><input type="date" id="f-desde" class="agro-input !py-1.5 !w-auto" value="${inicioMes()}">
              <span>→</span><input type="date" id="f-hasta" class="agro-input !py-1.5 !w-auto" value="${hoy()}">
              <button class="btn-borde !py-1.5 text-xs" onclick="AdminPlan.finanzas()">Ver</button></div></div>
          <div id="finanzas"></div>`)}</div>
        <div class="lg:col-span-2">${card(`
          <p class="font-bold text-[#0B2319] mb-1">Modelo por venta (parámetros vigentes)</p>
          <p class="text-[11px] text-gray-400 mb-3">Pedido promedio de $3,000 · 70 % SPEI y 30 % tarjeta · 30 % usa flete</p>
          <div class="text-sm space-y-1">
            <div class="flex justify-between"><span>Comisión ${(P.comision_productor * 100).toFixed(0)} %</span><b>${UI.money(comision)}</b></div>
            <div class="flex justify-between text-gray-500"><span>Pasarela (tarjeta ${UI.money(tarjeta)} · SPEI ${UI.money(spei)})</span><span>−${UI.money(pasarela)}</span></div>
            <div class="flex justify-between text-gray-500"><span>Logística (${UI.money0(P.flete_margen)} × 30 %)</span><span>+${UI.money(0.3 * P.flete_margen)}</span></div>
            <div class="flex justify-between border-t border-gray-100 pt-1 font-bold"><span>Margen por venta</span><span>${UI.money(margen)}</span></div>
            <div class="flex justify-between text-gray-500"><span>Premium neto de pasarela</span><span>${UI.money(premiumNeto)}</span></div>
            <div class="flex justify-between text-gray-500"><span>Costos fijos al mes</span><span>${UI.money0(P.costos_fijos_mes)}</span></div>
          </div>
          <div class="mt-4 rounded-xl bg-[#F3F9F6] p-4"><p class="text-xs text-gray-500">Punto de equilibrio (5 Premium + 2 anunciantes)</p>
            <p class="text-3xl font-bold text-[#2E6B42]">${Math.ceil(equilibrio)} ventas/mes</p>
            <p class="text-[11px] text-gray-400">(${UI.money0(P.costos_fijos_mes)} − 5 × ${UI.money(premiumNeto)} − 2 × ${UI.money0(P.publicidad_precio)}) ÷ ${UI.money(margen)} = ${equilibrio.toFixed(1)}</p></div>`)}</div>
      </div>`;
    finanzas();
  }

  async function finanzas() {
    const box = $('finanzas');
    try {
      const r = await API.get(`/admin/finanzas?desde=${$('f-desde').value}&hasta=${$('f-hasta').value}`);
      box.innerHTML = `<div class="text-sm space-y-1.5">${r.filas.map(f => `
        <div class="flex justify-between ${f.tipo === 'RESULTADO' ? 'border-t border-gray-100 pt-2 font-bold text-base' : f.tipo === 'COSTO' ? 'text-gray-500' : ''}">
          <span>${esc(f.concepto)}</span><span class="${f.tipo === 'RESULTADO' ? (f.monto >= 0 ? 'text-[#2E6B42]' : 'text-red-600') : ''}">${UI.money(f.monto)}</span></div>`).join('')}</div>
        <p class="text-[11px] text-gray-400 mt-3">${r.pedidos.ventas} ventas entregadas · ticket promedio ${UI.money(r.pedidos.ticket_promedio)} · ${r.pedidos.con_flete} con flete. Cifras antes de IVA.</p>`;
    } catch (e) { box.textContent = e.message; }
  }

  // ── Verificaciones ──
  async function verificaciones(estado = 'EN_REVISION') {
    const box = $('tab-verificaciones');
    let vs;
    try { vs = await API.get('/verificacion/pendientes?estado=' + estado); } catch (e) { box.innerHTML = esc(e.message); return; }
    const TIPO = { INE: 'INE', COMPROBANTE_DOMICILIO: 'Comprobante de domicilio', DOCUMENTO_PARCELA: 'Documento de la parcela' };
    const ED = { PENDIENTE: 'bg-blue-50 text-blue-700', ACEPTADO: 'bg-green-50 text-green-700', RECHAZADO: 'bg-red-50 text-red-600' };
    box.innerHTML = `
      <div class="flex flex-wrap gap-2 mb-4">${['EN_REVISION', 'SIN_DOCUMENTOS', 'RECHAZADO', 'VERIFICADO', 'TODOS'].map(e =>
        `<button onclick="AdminPlan.verificaciones('${e}')" class="px-3 py-1.5 rounded-full text-xs font-semibold border ${e === estado ? 'bg-[#2E6B42] text-white border-[#2E6B42]' : 'bg-white border-gray-200 text-gray-600'}">${e.replace('_', ' ')}</button>`).join('')}</div>
      <p class="text-xs text-gray-500 mb-4">Revisa que el nombre del INE coincida con el responsable, que el domicilio sea reciente y que el documento ligue a la persona con su parcela (escritura, certificado parcelario, constancia ejidal o carta de la asociación). Sin la insignia, sus productos no se muestran.</p>
      <div class="space-y-4">${vs.length ? vs.map(v => card(`
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div><p class="font-bold text-[#0B2319]">${esc(v.nombre_negocio)} ${UI.badge(v.perfil, v.perfil === 'ACOPIADOR' ? 'bg-orange-100 text-orange-700' : 'bg-[#E8F5EE] text-[#2E6B42]')}</p>
            <p class="text-xs text-gray-400">${esc(v.responsable)} · ${esc(v.email)} · ${esc(v.ubicacion || '')} · registro ${UI.fecha(v.fecha_registro, false)}</p>
            <p class="text-xs text-gray-500 mt-1">${v.parcelas} parcela(s) · ${v.hectareas} ha</p></div>
          ${UI.badge(v.verificacion_estado.replace('_', ' '), v.verificacion_estado === 'VERIFICADO' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700')}</div>
        <div class="grid sm:grid-cols-3 gap-3 mt-4">${['INE', 'COMPROBANTE_DOMICILIO', 'DOCUMENTO_PARCELA'].map(t => { const d = v.documentos.find(x => x.tipo === t); return `
          <div class="border border-gray-100 rounded-xl p-3 text-xs">
            <p class="font-semibold text-[#0B2319]">${TIPO[t]}</p>
            ${d ? `<p class="text-gray-400 mt-0.5">${esc(d.mime === 'application/pdf' ? 'PDF' : 'Imagen')} · ${(d.tamano_bytes / 1024).toFixed(0)} KB · ${UI.badge(d.estado, ED[d.estado])}</p>
              <div class="flex gap-2 mt-2 flex-wrap"><button class="btn-borde !py-1 !px-2 text-[11px]" onclick="UI.abrirArchivo('/verificacion/documentos/${d.id_documento}/archivo')">Ver</button>
              <button class="text-[11px] text-[#2E6B42] font-semibold" onclick="AdminPlan.documento('${d.id_documento}','ACEPTADO','${estado}')">Aceptar</button>
              <button class="text-[11px] text-red-500 font-semibold" onclick="AdminPlan.documento('${d.id_documento}','RECHAZADO','${estado}')">Rechazar</button></div>`
              : '<p class="text-gray-400 mt-1">No lo ha subido</p>'}</div>`; }).join('')}</div>
        <div class="flex gap-2 mt-4 flex-wrap">
          ${v.verificacion_estado !== 'VERIFICADO' ? `<button class="btn-verde !py-2 text-xs" onclick="AdminPlan.decidir('${v.id_vendedor}','VERIFICADO','${estado}')">✓ Otorgar insignia Productor Verificado</button>` : ''}
          <button class="btn-borde !py-2 text-xs text-red-500" onclick="AdminPlan.decidir('${v.id_vendedor}','RECHAZADO','${estado}')">Rechazar con nota</button>
          <button class="btn-borde !py-2 text-xs" onclick="AdminPlan.perfil('${v.id_vendedor}','${v.perfil === 'PRODUCTOR' ? 'ACOPIADOR' : 'PRODUCTOR'}','${estado}')">Cambiar a ${v.perfil === 'PRODUCTOR' ? 'Acopiador (8 %)' : 'Productor (4 %)'}</button>
        </div>`)).join('') : '<p class="text-center text-gray-400 py-16">Nada pendiente en esta lista.</p>'}</div>`;
  }
  async function documento(id, estado, lista) {
    const nota = estado === 'RECHAZADO' ? prompt('¿Por qué se rechaza? (el vendedor lo verá)') : undefined;
    if (estado === 'RECHAZADO' && !nota) return;
    try { await API.put('/verificacion/documentos/' + id, { estado, nota }); verificaciones(lista); } catch (e) { UI.toast(e.message, 'error'); }
  }
  async function decidir(id, estado, lista) {
    const nota = estado === 'RECHAZADO' ? prompt('Motivo del rechazo (el vendedor lo verá):') : 'Documentos revisados';
    if (!nota) return;
    try { await API.put('/verificacion/vendedores/' + id, { estado, nota }); UI.toast(estado === 'VERIFICADO' ? 'Insignia otorgada' : 'Verificación rechazada'); verificaciones(lista); }
    catch (e) { UI.toast(e.message, 'error'); }
  }
  async function perfil(id, p, lista) {
    if (!confirm(`¿Cambiar el perfil a ${p}? Afecta la comisión de sus próximos pedidos.`)) return;
    try { await API.put('/verificacion/vendedores/' + id, { perfil: p }); verificaciones(lista); } catch (e) { UI.toast(e.message, 'error'); }
  }

  // ── Alertas ──
  async function alertas(estado = 'ABIERTA') {
    const box = $('tab-alertas');
    let a;
    try { a = await API.get('/admin/alertas?estado=' + estado); } catch (e) { box.innerHTML = esc(e.message); return; }
    const T = { VOLUMEN_PARCELA: ['🌾 Volumen vs. parcela', 'bg-amber-50 text-amber-700'], DISPUTA: ['⚖ Devolución / disputa', 'bg-purple-50 text-purple-700'],
      CUSTODIA: ['🔒 Custodia', 'bg-blue-50 text-blue-700'], SEGURIDAD: ['🛡 Seguridad', 'bg-red-50 text-red-600'] };
    box.innerHTML = `<div class="flex gap-2 mb-4">${['ABIERTA', 'REVISADA', 'DESCARTADA', 'TODAS'].map(e =>
        `<button onclick="AdminPlan.alertas('${e}')" class="px-3 py-1.5 rounded-full text-xs font-semibold border ${e === estado ? 'bg-[#2E6B42] text-white border-[#2E6B42]' : 'bg-white border-gray-200 text-gray-600'}">${e}</button>`).join('')}</div>
      <div class="space-y-3">${a.length ? a.map(x => card(`<div class="flex items-start justify-between gap-3 flex-wrap">
        <div><p>${UI.badge((T[x.tipo] || [x.tipo])[0], (T[x.tipo] || [, ''])[1])} <span class="text-xs text-gray-400 ml-1">${UI.fechaHora(x.fecha)} · ${esc(x.nombre_negocio || '')}</span></p>
          <p class="text-sm text-[#0B2319] mt-2">${esc(x.detalle)}</p></div>
        ${x.estado === 'ABIERTA' ? `<div class="flex gap-2">${x.tipo === 'DISPUTA' ? `<button class="btn-borde !py-1.5 text-xs" onclick="setTab('devoluciones')">Ir al caso</button>` : ''}
          <button class="btn-verde !py-1.5 text-xs" onclick="AdminPlan.cerrarAlerta('${x.id_alerta}','REVISADA')">Revisada</button>
          <button class="btn-borde !py-1.5 text-xs" onclick="AdminPlan.cerrarAlerta('${x.id_alerta}','DESCARTADA')">Descartar</button></div>` : UI.badge(x.estado, 'bg-gray-100 text-gray-500')}</div>`)).join('')
        : '<p class="text-center text-gray-400 py-16">Sin alertas.</p>'}</div>`;
  }
  async function cerrarAlerta(id, estado) {
    try { await API.put('/admin/alertas/' + id, { estado }); alertas(); cargarStats(); } catch (e) { UI.toast(e.message, 'error'); }
  }

  // ── Custodia y SPEI ──
  async function custodia() {
    const box = $('tab-custodia');
    let ret, spei;
    try { [ret, spei] = await Promise.all([API.get('/admin/custodia?estado=RETENIDO'), API.get('/admin/spei')]); } catch (e) { box.innerHTML = esc(e.message); return; }
    box.innerHTML = `
      ${card(`<div class="flex items-center justify-between gap-3 flex-wrap mb-3"><div><p class="font-bold text-[#0B2319]">Depósitos SPEI por confirmar</p>
        <p class="text-xs text-gray-400">En producción los confirma el aviso del banco/STP; en el piloto los confirmas aquí con la clave de rastreo.</p></div></div>
        ${spei.length ? spei.map(s => `<div class="flex items-center justify-between gap-3 flex-wrap border-t border-gray-50 py-2 text-sm">
          <span><b>${esc(s.referencia)}</b> · ${esc(s.pedidos)} · ${esc(s.comprador)} · ${UI.fechaHora(s.fecha)}</span>
          <span class="flex items-center gap-2"><b>${UI.money(s.total)}</b><button class="btn-verde !py-1.5 text-xs" onclick="AdminPlan.confirmarSpei('${s.grupo_compra}')">Confirmar depósito</button></span></div>`).join('')
          : '<p class="text-sm text-gray-400">No hay depósitos pendientes.</p>'}`, 'mb-6')}
      ${card(`<div class="flex items-center justify-between gap-3 flex-wrap mb-3"><div><p class="font-bold text-[#0B2319]">Pagos retenidos en custodia (${ret.length})</p>
        <p class="text-xs text-gray-400">Se liberan solos 48 h después de la confirmación de recibido (o 7 días después de la entrega). La API lo revisa cada 10 minutos.</p></div>
        <button class="btn-borde !py-2 text-xs" onclick="AdminPlan.procesar()">Procesar ahora</button></div>
        <div class="overflow-x-auto"><table class="w-full text-sm min-w-[720px]"><thead class="text-xs text-gray-500 uppercase"><tr>
          <th class="text-left py-2">Pedido</th><th class="text-left">Vendedor</th><th class="text-right">Total</th><th class="text-right">Neto vendedor</th><th class="text-left pl-4">Estado</th><th></th></tr></thead>
        <tbody>${ret.length ? ret.map(p => `<tr class="border-t border-gray-50"><td class="py-2">#${p.folio}<p class="text-[11px] text-gray-400">${esc(p.comprador)}</p></td>
          <td>${esc(p.vendedor)}</td><td class="text-right">${UI.money(p.total)}</td><td class="text-right font-semibold">${UI.money(p.neto_vendedor)}</td>
          <td class="pl-4 text-xs">${esc(p.estado)}${p.liberar_despues_de ? `<br><span class="text-gray-400">libera ${UI.fechaHora(p.liberar_despues_de)}</span>` : ''}
            ${p.devolucion_estado ? `<br>${UI.badge('Reclamo ' + p.devolucion_estado, 'bg-purple-50 text-purple-700')}` : ''}</td>
          <td class="text-right">${p.estado === 'ENTREGADO' && !p.devolucion_estado ? `<button class="btn-borde !py-1 text-xs" onclick="AdminPlan.liberar('${p.id_pedido}')">Liberar ya</button>` : ''}</td></tr>`).join('')
          : '<tr><td colspan="6" class="py-6 text-center text-gray-400">No hay pagos retenidos.</td></tr>'}</tbody></table></div>`)}`;
  }
  async function confirmarSpei(grupo) {
    const clave = prompt('Clave de rastreo SPEI (opcional):') ?? null;
    if (clave === null) return;
    try { await API.post(`/admin/spei/${grupo}/confirmar`, { clave_rastreo: clave || undefined }); UI.toast('Depósito confirmado: el pago queda en custodia'); custodia(); cargarStats(); }
    catch (e) { UI.toast(e.message, 'error'); }
  }
  async function liberar(id) {
    if (!confirm('¿Liberar el pago al vendedor antes del plazo?')) return;
    try { await API.post(`/admin/custodia/${id}/liberar`); UI.toast('Pago liberado'); custodia(); cargarStats(); } catch (e) { UI.toast(e.message, 'error'); }
  }
  async function procesar() {
    try { const r = await API.post('/admin/custodia/procesar'); UI.toast(`${r.autoconfirmados} autoconfirmados · ${r.liberados} liberados`); custodia(); cargarStats(); }
    catch (e) { UI.toast(e.message, 'error'); }
  }

  // ── Publicidad ──
  let anuncios = [];
  async function publicidad() {
    const box = $('tab-publicidad');
    try { anuncios = await API.get('/publicidad/admin'); } catch (e) { box.innerHTML = esc(e.message); return; }
    box.innerHTML = `<div class="flex items-center justify-between mb-4"><p class="text-sm text-gray-500">Espacios para proveedores de insumos agrícolas (semillas, fertilizantes, maquinaria) · cuota sugerida $800/mes.</p>
        <button class="btn-verde" onclick="AdminPlan.formAnuncio()">＋ Anunciante</button></div>
      <div class="grid md:grid-cols-2 gap-4">${anuncios.map(a => card(`
        ${a.imagen_url ? `<img src="${esc(a.imagen_url)}" alt="" class="w-full rounded-xl border border-gray-100 mb-3">` : ''}
        <div class="flex items-start justify-between gap-2"><div><p class="font-bold text-[#0B2319]">${esc(a.nombre)} <span class="text-xs text-gray-400 font-normal">· ${esc(a.giro)}</span></p>
          <p class="text-xs text-gray-500">${esc(a.mensaje)}</p></div>${UI.badge(a.vigente ? 'Vigente' : a.estado === 'PAUSADO' ? 'Pausado' : 'Fuera de fechas', a.vigente ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500')}</div>
        <p class="text-xs text-gray-500 mt-2">${UI.money0(a.cuota_mensual)}/mes · ${UI.fecha(a.fecha_inicio)} → ${UI.fecha(a.fecha_fin)} · ${esc(a.ubicacion)}</p>
        <p class="text-xs text-gray-500">👁 ${a.impresiones} impresiones · 🖱 ${a.clics} clics · CTR ${a.ctr} %</p>
        <div class="flex gap-2 mt-3"><button class="btn-borde !py-1.5 text-xs" onclick="AdminPlan.formAnuncio('${a.id_anunciante}')">Editar</button>
          <button class="btn-borde !py-1.5 text-xs" onclick="AdminPlan.estadoAnuncio('${a.id_anunciante}','${a.estado === 'ACTIVO' ? 'PAUSADO' : 'ACTIVO'}')">${a.estado === 'ACTIVO' ? 'Pausar' : 'Activar'}</button></div>`)).join('')
        || '<p class="text-gray-400">Sin anunciantes.</p>'}</div>`;
  }
  function formAnuncio(id) {
    const a = id ? anuncios.find(x => x.id_anunciante === id) : {};
    UI.modal.open(`<form class="p-6 space-y-3" id="f-anu"><h3 class="font-bold text-[#0B2319] text-lg">${id ? 'Editar' : 'Nuevo'} anunciante</h3>
      <div class="grid grid-cols-2 gap-3"><input id="an-n" class="agro-input" placeholder="Nombre" required value="${esc(a.nombre || '')}">
        <input id="an-g" class="agro-input" placeholder="Giro (semillas, fertilizantes…)" value="${esc(a.giro || '')}"></div>
      <input id="an-m" class="agro-input" placeholder="Mensaje (máx. 160)" maxlength="160" required value="${esc(a.mensaje || '')}">
      <input id="an-u" class="agro-input" placeholder="https://… (opcional)" value="${esc(a.url || '')}">
      <div class="flex gap-2"><input id="an-i" class="agro-input" placeholder="Imagen del banner (se sube abajo)" value="${esc(a.imagen_url || '')}">
        <label class="btn-borde !py-2 text-xs cursor-pointer whitespace-nowrap">Subir<input type="file" accept="image/*" class="hidden" onchange="AdminPlan.subirBanner(this)"></label></div>
      <div class="grid grid-cols-3 gap-3"><select id="an-ub" class="agro-input">${['AMBOS', 'INICIO', 'CATALOGO'].map(u => `<option ${a.ubicacion === u ? 'selected' : ''}>${u}</option>`).join('')}</select>
        <input id="an-fi" type="date" class="agro-input" value="${(a.fecha_inicio || hoy()).slice(0, 10)}"><input id="an-ff" type="date" class="agro-input" value="${(a.fecha_fin || '').slice(0, 10)}"></div>
      <input id="an-c" type="number" class="agro-input" placeholder="Cuota mensual (vacío = $800)" value="${a.cuota_mensual || ''}">
      <input id="an-ct" class="agro-input" placeholder="Contacto" value="${esc(a.contacto || '')}">
      <button class="btn-verde w-full">Guardar</button></form>`, { ancho: 'max-w-lg' });
    $('f-anu').onsubmit = async e => {
      e.preventDefault();
      const b = { nombre: $('an-n').value, giro: $('an-g').value, mensaje: $('an-m').value, url: $('an-u').value, imagen_url: $('an-i').value,
        ubicacion: $('an-ub').value, fecha_inicio: $('an-fi').value, fecha_fin: $('an-ff').value, cuota_mensual: $('an-c').value, contacto: $('an-ct').value };
      try { id ? await API.put('/publicidad/admin/' + id, b) : await API.post('/publicidad/admin', b); UI.modal.close(); publicidad(); cargarStats(); }
      catch (err) { UI.toast(err.message, 'error'); }
    };
  }
  async function subirBanner(input) {
    const fd = new FormData(); fd.append('imagen', input.files[0]);
    try { $('an-i').value = (await API.upload('/imagenes/subir', fd)).url; UI.toast('Imagen subida'); } catch (e) { UI.toast(e.message, 'error'); }
  }
  async function estadoAnuncio(id, estado) {
    try { await API.put('/publicidad/admin/' + id, { estado }); publicidad(); } catch (e) { UI.toast(e.message, 'error'); }
  }

  // ── Transportistas ──
  let trans = [];
  async function transportistas() {
    const box = $('tab-logistica');
    let tar;
    try { [trans, tar] = await Promise.all([API.get('/transportistas?todos=1'), API.get('/transportistas/tarifa')]); } catch (e) { box.innerHTML = esc(e.message); return; }
    box.innerHTML = `<div class="flex items-center justify-between gap-3 flex-wrap mb-4">
        <p class="text-sm text-gray-500">Flete = ${UI.money0(tar.banderazo)} de banderazo + ${UI.money0(tar.tarifa_km)}/km de ruta (línea recta × ${tar.factor_ruta}) + ${UI.money0(tar.margen)} de margen de la plataforma. Se cambia en Parámetros.</p>
        <button class="btn-verde" onclick="AdminPlan.formTrans()">＋ Transportista</button></div>
      <div class="grid md:grid-cols-3 gap-4">${trans.map(t => card(`<div class="flex justify-between"><p class="font-bold text-[#0B2319]">🚚 ${esc(t.nombre)}</p>${UI.badge(t.estado, t.estado === 'ACTIVO' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500')}</div>
        <p class="text-xs text-gray-500 mt-1">${esc(t.vehiculo || '')} ${t.capacidad_ton ? '· ' + t.capacidad_ton + ' t' : ''}</p>
        <p class="text-xs text-gray-500">📍 ${esc(t.zona)}</p><p class="text-xs text-gray-500">📞 ${esc(t.telefono || '—')} · ${t.envios} envíos</p>
        <div class="flex gap-2 mt-3"><button class="btn-borde !py-1.5 text-xs" onclick="AdminPlan.formTrans('${t.id_transportista}')">Editar</button>
        <button class="btn-borde !py-1.5 text-xs" onclick="AdminPlan.estadoTrans('${t.id_transportista}','${t.estado === 'ACTIVO' ? 'INACTIVO' : 'ACTIVO'}')">${t.estado === 'ACTIVO' ? 'Desactivar' : 'Activar'}</button></div>`)).join('')}</div>`;
  }
  function formTrans(id) {
    const t = id ? trans.find(x => x.id_transportista === id) : {};
    UI.modal.open(`<form class="p-6 space-y-3" id="f-tr"><h3 class="font-bold text-[#0B2319] text-lg">${id ? 'Editar' : 'Nuevo'} transportista aliado</h3>
      <input id="tr-n" class="agro-input" placeholder="Nombre" required value="${esc(t.nombre || '')}">
      <input id="tr-z" class="agro-input" placeholder="Municipios que cubre" required value="${esc(t.zona || '')}">
      <div class="grid grid-cols-2 gap-3"><input id="tr-v" class="agro-input" placeholder="Vehículo" value="${esc(t.vehiculo || '')}">
        <input id="tr-c" type="number" step="0.1" class="agro-input" placeholder="Capacidad (t)" value="${t.capacidad_ton || ''}"></div>
      <input id="tr-t" class="agro-input" placeholder="Teléfono" value="${esc(t.telefono || '')}">
      <button class="btn-verde w-full">Guardar</button></form>`, { ancho: 'max-w-md' });
    $('f-tr').onsubmit = async e => {
      e.preventDefault();
      const b = { nombre: $('tr-n').value, zona: $('tr-z').value, vehiculo: $('tr-v').value, capacidad_ton: $('tr-c').value, telefono: $('tr-t').value };
      try { id ? await API.put('/transportistas/' + id, b) : await API.post('/transportistas', b); UI.modal.close(); transportistas(); }
      catch (err) { UI.toast(err.message, 'error'); }
    };
  }
  async function estadoTrans(id, estado) {
    try { await API.put('/transportistas/' + id, { estado }); transportistas(); } catch (e) { UI.toast(e.message, 'error'); }
  }

  // ── Membresías ──
  async function membresias() {
    const box = $('tab-membresias');
    let m;
    try { m = await API.get('/membresias/todas'); } catch (e) { box.innerHTML = esc(e.message); return; }
    const pagadas = m.filter(x => x.estado === 'PAGADA');
    box.innerHTML = card(`<p class="font-bold text-[#0B2319] mb-1">Membresías Premium</p>
      <p class="text-xs text-gray-400 mb-3">${pagadas.length} pagadas · ingreso ${UI.money(pagadas.reduce((s, x) => s + Number(x.monto), 0))} antes de IVA · pasarela ${UI.money(pagadas.reduce((s, x) => s + Number(x.comision_pasarela), 0))}</p>
      <div class="overflow-x-auto"><table class="w-full text-sm min-w-[700px]"><thead class="text-xs text-gray-500 uppercase"><tr><th class="text-left py-2">Folio</th><th class="text-left">Vendedor</th>
        <th class="text-left">Método</th><th class="text-right">Total</th><th class="text-left pl-4">Estado</th><th class="text-left">Periodo</th></tr></thead>
      <tbody>${m.map(x => `<tr class="border-t border-gray-50"><td class="py-2">#${x.folio}</td><td>${esc(x.nombre_negocio)}</td><td>${esc(UI.METODO[x.metodo] || x.metodo)}</td>
        <td class="text-right">${UI.money(x.total)}</td><td class="pl-4">${UI.badge(x.estado, x.estado === 'PAGADA' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500')}</td>
        <td class="text-xs text-gray-400">${x.periodo_inicio ? UI.fecha(x.periodo_inicio) + ' → ' + UI.fecha(x.periodo_fin) : '—'}</td></tr>`).join('')}</tbody></table></div>`);
  }

  // ── Parámetros ──
  async function parametros() {
    const box = $('tab-parametros');
    let p, c;
    try { [p, c] = await Promise.all([API.get('/admin/parametros'), API.get('/parcelas/cultivos')]); } catch (e) { box.innerHTML = esc(e.message); return; }
    const grupos = [...new Set(p.map(x => x.grupo))];
    box.innerHTML = `<p class="text-sm text-gray-500 mb-4">Los porcentajes van como fracción (4 % = 0.04). Los cambios aplican a los pedidos nuevos; los pedidos existentes conservan sus montos (están firmados con HMAC).</p>
      <div class="grid lg:grid-cols-2 gap-4">${grupos.map(g => card(`<p class="font-bold text-[#0B2319] mb-3">${esc(g)}</p>${p.filter(x => x.grupo === g).map(x => `
        <div class="flex items-center gap-3 py-2 border-t border-gray-50"><div class="flex-1"><p class="text-sm text-[#0B2319]">${esc(x.descripcion)}</p><p class="text-[10px] text-gray-400 font-mono">${esc(x.clave)}</p></div>
          <input id="par-${x.clave}" class="agro-input !w-36 !py-1.5 text-sm text-right" value="${esc(x.valor !== null ? x.valor : x.texto)}">
          <button class="btn-borde !py-1.5 !px-3 text-xs" onclick="AdminPlan.guardarParam('${x.clave}', ${x.valor !== null})">OK</button></div>`).join('')}`)).join('')}
        ${card(`<p class="font-bold text-[#0B2319] mb-1">Rendimiento de referencia por cultivo (t/ha/año)</p>
          <p class="text-[11px] text-gray-400 mb-2">Se usa para la alerta de volumen: publicado > producción anual × factor.</p>
          ${c.map(x => `<div class="flex items-center gap-3 py-1.5 border-t border-gray-50"><span class="flex-1 text-sm">${esc(x.cultivo)}</span>
            <input id="cul-${esc(x.cultivo).replace(/\s/g, '_')}" class="agro-input !w-24 !py-1 text-sm text-right" value="${x.rendimiento_t_ha}">
            <button class="btn-borde !py-1 !px-3 text-xs" onclick="AdminPlan.guardarCultivo('${esc(x.cultivo)}')">OK</button></div>`).join('')}`)}</div>`;
  }
  async function guardarParam(clave, numerico) {
    const v = $('par-' + clave).value;
    try { await API.put('/admin/parametros/' + clave, numerico ? { valor: v } : { texto: v }); UI.toast('Parámetro actualizado'); }
    catch (e) { UI.toast(e.message, 'error'); }
  }
  async function guardarCultivo(cultivo) {
    try { await API.put('/admin/cultivos/' + encodeURIComponent(cultivo), { rendimiento_t_ha: $('cul-' + cultivo.replace(/\s/g, '_')).value }); UI.toast('Rendimiento actualizado'); }
    catch (e) { UI.toast(e.message, 'error'); }
  }

  async function desbloquear(id) {
    try { await API.put(`/admin/usuarios/${id}/desbloquear`); UI.toast('Cuenta desbloqueada'); cargarUsuarios(); } catch (e) { UI.toast(e.message, 'error'); }
  }

  // ── Mediación (el admin participa como mediador) ──
  async function mediacion(idDev) {
    let d;
    try { d = await API.get(`/devoluciones/${idDev}/mensajes`); } catch (e) { return UI.toast(e.message, 'error'); }
    const cerrado = ['APROBADA', 'RECHAZADA', 'RESUELTA'].includes(d.estado);
    UI.modal.open(`<div class="p-6 border-b border-gray-100"><p class="text-xs text-gray-400">${d.tipo === 'DISPUTA' ? 'Disputa' : 'Devolución'} · pedido #${d.folio} · ${esc(d.estado)}</p>
        <h3 class="font-bold text-[#0B2319] text-lg">Mediación</h3><p class="text-xs text-gray-500 mt-1">${esc(d.motivo)}</p></div>
      <div class="p-6 space-y-3 max-h-[50vh] overflow-y-auto">${d.mensajes.map(m => `<div class="flex ${m.mio ? 'justify-end' : ''}">
        <div class="max-w-[80%] rounded-2xl px-4 py-2 text-sm ${m.mio ? 'bg-[#2E6B42] text-white' : 'bg-gray-100 text-[#0B2319]'}">
        <p class="text-[10px] opacity-70 font-semibold">${esc(m.autor)} · ${esc(m.rol)}</p><p class="whitespace-pre-line">${esc(m.mensaje)}</p>
        <p class="text-[10px] opacity-60 text-right">${UI.fechaHora(m.fecha)}</p></div></div>`).join('') || '<p class="text-sm text-gray-400 text-center">Sin mensajes.</p>'}</div>
      ${cerrado ? '' : `<form class="p-6 pt-0 flex gap-2" id="f-med"><input id="med-msg" class="agro-input" placeholder="Mensaje como mediador…" required maxlength="2000"><button class="btn-verde">Enviar</button></form>`}`, { ancho: 'max-w-lg' });
    const f = $('f-med');
    if (f) f.onsubmit = async e => { e.preventDefault(); try { await API.post(`/devoluciones/${idDev}/mensajes`, { mensaje: $('med-msg').value }); mediacion(idDev); } catch (err) { UI.toast(err.message, 'error'); } };
  }

  return { indicadores, finanzas, verificaciones, documento, decidir, perfil, alertas, cerrarAlerta, custodia, confirmarSpei, liberar, procesar,
    publicidad, formAnuncio, subirBanner, estadoAnuncio, transportistas, formTrans, estadoTrans, membresias, parametros, guardarParam, guardarCultivo,
    desbloquear, mediacion };
})();
