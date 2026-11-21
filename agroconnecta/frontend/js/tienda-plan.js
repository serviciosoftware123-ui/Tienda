/**
 * AgroConnecta v3.0 — Mi Tienda: módulos del plan de negocio
 *  • Verificación (INE, comprobante de domicilio, documento de la parcela → insignia)
 *  • Parcelas (superficie y cultivo; alerta si lo publicado no cuadra)
 *  • Liquidaciones (comisión 4 %/8 %, IVA de la comisión, neto y custodia del pago)
 *  • Premium ($199 + IVA/mes): estadísticas avanzadas y Reporte AgroConfianza
 * Usa las variables globales de Tienda.html: categorias, negocio, cargarNegocio, setTab.
 */
window.Plan = (function () {
  const $ = id => document.getElementById(id);
  const esc = v => UI.esc(v);
  let parcelasCache = null;
  const TENENCIA = { PROPIA: 'Propia', EJIDAL: 'Ejidal', ARRENDADA: 'Arrendada', COMUNAL: 'Comunal' };
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  // ── Aviso arriba de la tienda ──
  function avisoVerificacion(n) {
    const box = $('aviso-verificacion');
    if (!box) return;
    const e = n.verificacion_estado;
    if (e === 'VERIFICADO') {
      box.innerHTML = `<div class="flex flex-wrap items-center gap-2 mb-6 text-xs">${UI.insignias(n)}
        <span class="text-gray-400">Comisión por venta: ${n.perfil === 'ACOPIADOR' ? '8' : '4'} % + IVA · solo cuando vendes</span></div>`;
      return;
    }
    const txt = {
      SIN_DOCUMENTOS: ['Tus productos aún NO se muestran en el catálogo', 'Sube tu INE, comprobante de domicilio y un documento de tu parcela para obtener la insignia Productor Verificado.', 'Subir documentos'],
      EN_REVISION: ['Documentos en revisión', 'Un administrador está revisando tus documentos. Al aprobarlos, tus productos aparecerán en el catálogo.', 'Ver estado'],
      RECHAZADO: ['Verificación rechazada', n.verificacion_nota || 'Revisa la nota del administrador y vuelve a subir tus documentos.', 'Corregir documentos'],
    }[e] || ['', '', ''];
    box.innerHTML = `<div class="mb-6 rounded-2xl border ${e === 'EN_REVISION' ? 'bg-blue-50 border-blue-100 text-blue-800' : 'bg-amber-50 border-amber-200 text-amber-800'} p-4 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
      <div><p class="font-bold">${txt[0]}</p><p class="text-sm opacity-90">${esc(txt[1])}</p></div>
      <button class="btn-verde whitespace-nowrap" onclick="setTab('verificacion')">${txt[2]}</button></div>`;
  }

  // ── Campo «Parcela de origen» en el formulario de producto ──
  async function campoParcela(seleccion) {
    const box = $('campo-parcela');
    if (!box) return;
    const cat = categorias.find(c => c.id_categoria === $('p-cat').value);
    const esCultivo = cat && cat.tipo === 'CULTIVO';
    box.classList.toggle('invisible', !esCultivo);
    if (!parcelasCache) { try { parcelasCache = await API.get('/parcelas'); } catch (_) { parcelasCache = []; } }
    const activas = parcelasCache.filter(p => p.estado === 'ACTIVA');
    const sel = $('p-parcela');
    const actual = seleccion !== undefined ? seleccion : sel.value;
    sel.innerHTML = (negocio.perfil === 'ACOPIADOR' ? '<option value="">(Acopiador: sin parcela)</option>' : '<option value="">Elige la parcela…</option>')
      + activas.map(p => `<option value="${esc(p.id_parcela)}" ${p.id_parcela === actual ? 'selected' : ''}>${esc(p.nombre)} · ${esc(p.superficie_ha)} ha de ${esc(p.cultivo)}</option>`).join('');
    sel.required = esCultivo && negocio.perfil === 'PRODUCTOR';
    if (esCultivo && negocio.perfil === 'PRODUCTOR' && !activas.length) {
      sel.innerHTML = '<option value="">Primero registra una parcela</option>';
    }
  }

  // ── Parcelas ──
  async function parcelas() {
    const box = $('tab-parcelas');
    box.innerHTML = '<p class="text-gray-400 text-sm">Cargando…</p>';
    try { parcelasCache = await API.get('/parcelas'); } catch (e) { box.innerHTML = esc(e.message); return; }
    const lista = parcelasCache;
    box.innerHTML = `
      <div class="flex items-start justify-between gap-4 flex-wrap mb-5">
        <p class="text-sm text-gray-500 max-w-2xl">Registra la superficie y el cultivo de cada parcela. Cada producto agrícola se liga a su parcela:
          si publicas mucho más de lo que tu parcela puede producir en un año, el sistema la marca para revisión (candado contra intermediarios).</p>
        <button class="btn-verde" onclick="Plan.formParcela()">＋ Parcela</button></div>
      <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">${lista.length ? lista.map(p => {
        const pct = p.produccion_anual_t ? Math.min(100, Math.round(100 * p.publicado_t / (p.produccion_anual_t * 1.2))) : 0;
        return `<div class="bg-white rounded-2xl border ${p.en_revision ? 'border-amber-300' : 'border-gray-100'} shadow-sm p-5 ${p.estado === 'INACTIVA' ? 'opacity-60' : ''}">
          <div class="flex items-start justify-between gap-2"><div>
            <p class="font-bold text-[#0B2319]">${esc(p.nombre)}</p>
            <p class="text-xs text-gray-400">📍 ${esc(p.municipio)} · ${esc(TENENCIA[p.tenencia] || p.tenencia)}</p></div>
            ${p.en_revision ? UI.badge('En revisión', 'bg-amber-50 text-amber-700') : UI.badge(p.estado, p.estado === 'ACTIVA' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500')}</div>
          <p class="text-2xl font-bold text-[#2E6B42] mt-3">${esc(p.superficie_ha)} ha <span class="text-sm font-semibold text-[#0B2319]">de ${esc(p.cultivo)}</span></p>
          <p class="text-[11px] text-gray-400">Producción esperada ≈ ${esc(p.produccion_anual_t)} t/año (${esc(p.rendimiento_t_ha)} t/ha)</p>
          <div class="mt-3"><div class="h-2 rounded-full bg-gray-100 overflow-hidden"><div class="h-full ${pct >= 100 ? 'bg-amber-500' : 'bg-[#4fb877]'}" style="width:${pct}%"></div></div>
            <p class="text-[11px] text-gray-500 mt-1">Publicado: ${esc(p.publicado_t)} t en ${p.productos} producto(s)</p></div>
          <div class="flex gap-2 mt-4">
            <button class="btn-borde !py-1.5 text-xs" onclick="Plan.formParcela('${p.id_parcela}')">Editar</button>
            <button class="btn-borde !py-1.5 text-xs" onclick="Plan.estadoParcela('${p.id_parcela}','${p.estado === 'ACTIVA' ? 'INACTIVA' : 'ACTIVA'}')">${p.estado === 'ACTIVA' ? 'Desactivar' : 'Activar'}</button></div>
        </div>`;
      }).join('') : `<div class="col-span-full text-center py-14 bg-white rounded-2xl border border-gray-100">
          <p class="font-semibold text-[#0B2319]">Aún no registras parcelas</p>
          <p class="text-sm text-gray-400 mb-4">${negocio.perfil === 'ACOPIADOR' ? 'Como acopiador no las necesitas para publicar.' : 'Las necesitas para publicar cultivos.'}</p>
          <button class="btn-verde" onclick="Plan.formParcela()">Registrar mi primera parcela</button></div>`}</div>`;
  }

  async function formParcela(id) {
    const p = id ? parcelasCache.find(x => x.id_parcela === id) : null;
    const cultivos = await API.get('/parcelas/cultivos');
    const mun = (p && p.municipio) || Object.keys(MUNICIPIOS).find(m => negocio.ubicacion && negocio.ubicacion.startsWith(m.replace(' (Villahermosa)', ''))) || 'Centro (Villahermosa)';
    UI.modal.open(`<div class="p-6 border-b border-gray-100 flex justify-between"><h3 class="font-bold text-[#0B2319] text-lg">${p ? 'Editar' : 'Nueva'} parcela</h3>
        <button onclick="UI.modal.close()" class="text-gray-400">✕</button></div>
      <form class="p-6 space-y-4" id="f-parcela">
        <div><label class="agro-label">Nombre</label><input id="pa-nombre" class="agro-input" required maxlength="120" value="${esc(p ? p.nombre : '')}" placeholder="Ej. Rancho La Esperanza"></div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="agro-label">Municipio</label><select id="pa-mun" class="agro-input">${opcionesMunicipios(MUNICIPIOS[mun] ? mun : 'Centro (Villahermosa)')}</select></div>
          <div><label class="agro-label">Superficie (ha)</label><input id="pa-sup" type="number" min="0.01" step="0.01" class="agro-input" required value="${p ? p.superficie_ha : ''}"></div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="agro-label">Cultivo</label><select id="pa-cultivo" class="agro-input">${cultivos.map(c =>
            `<option ${p && p.cultivo === c.cultivo ? 'selected' : ''} value="${esc(c.cultivo)}">${esc(c.cultivo)} (${c.rendimiento_t_ha} t/ha)</option>`).join('')}</select></div>
          <div><label class="agro-label">Tenencia</label><select id="pa-ten" class="agro-input">${Object.entries(TENENCIA).map(([k, v]) =>
            `<option value="${k}" ${p && p.tenencia === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        </div>
        <p class="text-[11px] text-gray-400">Rendimientos de referencia aproximados para el sureste; el administrador los ajusta con datos del SIAP.</p>
        <button class="btn-verde w-full">Guardar parcela</button></form>`, { ancho: 'max-w-md' });
    $('f-parcela').onsubmit = async e => {
      e.preventDefault();
      const body = { nombre: $('pa-nombre').value, municipio: $('pa-mun').value.replace(' (Villahermosa)', ''),
        superficie_ha: $('pa-sup').value, cultivo: $('pa-cultivo').value, tenencia: $('pa-ten').value,
        lat: MUNICIPIOS[$('pa-mun').value][0], lng: MUNICIPIOS[$('pa-mun').value][1] };
      try {
        if (p) await API.put('/parcelas/' + p.id_parcela, body); else await API.post('/parcelas', body);
        UI.modal.close(); UI.toast('Parcela guardada'); parcelasCache = null; parcelas();
      } catch (err) { UI.toast(err.message, 'error'); }
    };
  }

  async function estadoParcela(id, estado) {
    try { await API.put(`/parcelas/${id}/estado`, { estado }); parcelasCache = null; parcelas(); }
    catch (e) { UI.toast(e.message, 'error'); }
  }

  // ── Liquidaciones ──
  async function liquidaciones() {
    const box = $('tab-liquidaciones');
    box.innerHTML = '<p class="text-gray-400 text-sm">Cargando…</p>';
    let r;
    try { r = await API.get('/tienda/liquidaciones'); } catch (e) { box.innerHTML = esc(e.message); return; }
    const t = r.totales;
    const tarjeta = (l, v, x, c = 'text-[#0B2319]') => `<div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-5"><p class="text-xs text-gray-400">${l}</p>
      <p class="text-2xl font-bold ${c}">${UI.money(v)}</p><p class="text-[11px] text-gray-400">${x}</p></div>`;
    box.innerHTML = `
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        ${tarjeta('En custodia', t.retenido, 'Se libera 48 h después de que el comprador confirma', 'text-amber-600')}
        ${tarjeta('Liberado a ti', t.liberado, 'Pagos en línea ya entregados', 'text-[#2E6B42]')}
        ${tarjeta('Comisiones + IVA', t.comisiones, 'De ventas entregadas')}
        ${tarjeta('Comisión por pagar', t.comision_por_pagar, 'Ventas en efectivo (cobraste tú)', t.comision_por_pagar ? 'text-orange-600' : 'text-[#0B2319]')}
      </div>
      <div class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-x-auto">
        <table class="w-full text-sm min-w-[760px]"><thead class="bg-[#F8F7F2] text-xs text-gray-500 uppercase"><tr>
          <th class="text-left p-3">Pedido</th><th class="text-left p-3">Comprador</th><th class="text-right p-3">Venta + IVA</th>
          <th class="text-right p-3">Comisión</th><th class="text-right p-3">IVA com.</th><th class="text-right p-3">Neto</th><th class="text-left p-3">Pago</th></tr></thead>
        <tbody>${r.pedidos.length ? r.pedidos.map(p => { const c = UI.CUSTODIA[p.custodia_estado] || {}; return `<tr class="border-t border-gray-50">
          <td class="p-3"><a class="font-semibold text-[#2E6B42] hover:underline" href="Seguimiento.html?pedido=${p.id_pedido}">#${p.folio}</a>
            <p class="text-[11px] text-gray-400">${UI.fecha(p.fecha_pedido, false)} · ${esc(p.estado)}</p></td>
          <td class="p-3 text-xs">${esc(p.comprador)}</td>
          <td class="p-3 text-right">${UI.money(Number(p.subtotal) + Number(p.impuestos_iva))}</td>
          <td class="p-3 text-right text-gray-500">−${UI.money(p.comision_monto)} <span class="text-[10px]">(${Math.round(p.comision_pct * 100)} %)</span></td>
          <td class="p-3 text-right text-gray-500">−${UI.money(p.iva_comision)}</td>
          <td class="p-3 text-right font-bold">${UI.money(p.neto_vendedor)}</td>
          <td class="p-3">${UI.badge(c.l || p.custodia_estado, c.c || '')}
            ${p.custodia_estado === 'RETENIDO' && p.liberar_despues_de ? `<p class="text-[10px] text-gray-400 mt-0.5">libera ${UI.fechaHora(p.liberar_despues_de)}</p>` : ''}
            <p class="text-[10px] text-gray-400">${esc(UI.METODO[p.pago_metodo] || '')}</p></td></tr>`; }).join('')
          : '<tr><td colspan="7" class="p-8 text-center text-gray-400">Aún no tienes ventas.</td></tr>'}</tbody></table></div>
      <p class="text-[11px] text-gray-400 mt-3">El IVA de la comisión es acreditable en tu declaración. El flete lo cobra el transportista aliado y no forma parte de tu venta.</p>`;
  }

  // ── Premium ──
  async function premium() {
    const box = $('tab-premium');
    box.innerHTML = '<p class="text-gray-400 text-sm">Cargando…</p>';
    let m;
    try { m = await API.get('/membresias'); } catch (e) { box.innerHTML = esc(e.message); return; }
    const beneficios = [
      ['🏆', 'Posición destacada', 'Tus productos aparecen primero en el catálogo, con la insignia ★ Premium.'],
      ['📊', 'Estadísticas avanzadas', 'Ventas por mes, productos estrella y clientes que te recompran.'],
      ['🏦', 'Reporte AgroConfianza', 'PDF con folio y huella para presentar en una caja popular o financiera rural.'],
      ['🔐', 'Verificación en dos pasos', 'Protege tu cuenta con un código en tu celular.'],
    ];
    box.innerHTML = `
      <div class="grid lg:grid-cols-5 gap-6">
        <div class="lg:col-span-2 rounded-3xl p-6 text-white bg-gradient-to-br from-[#0B2319] to-[#2E6B42] shadow-sm">
          <p class="text-xs uppercase tracking-widest text-[#4fb877] font-bold">Membresía Premium</p>
          <p class="text-5xl font-bold mt-2">${UI.money0(m.precio)}<span class="text-base font-normal opacity-70"> + IVA / mes</span></p>
          <p class="text-sm opacity-70">Total ${UI.money(m.total)} cada ${m.dias} días · sin plazo forzoso</p>
          <div class="mt-5 rounded-2xl bg-white/10 p-4">
            ${m.activa ? `<p class="font-bold">★ Premium activo</p><p class="text-sm opacity-80">Vigente hasta el ${UI.fecha(m.premium_hasta)}</p>`
              : `<p class="font-bold">Aún no eres Premium</p><p class="text-sm opacity-80">Registrarte y vender sigue siendo gratis.</p>`}
          </div>
          <div class="mt-5 space-y-2">
            <p class="text-xs opacity-70">${m.activa ? 'Agregar otro mes' : 'Activar'} con:</p>
            ${m.metodos.map(x => `<button onclick="Plan.pagarPremium('${x.id}')" class="w-full text-left bg-white text-[#0B2319] rounded-xl px-4 py-2.5 text-sm font-semibold hover:bg-[#F3F9F6]">${esc(x.nombre)}</button>`).join('')}
          </div>
          ${m.promo_usada ? '' : `<form class="mt-5 flex gap-2" onsubmit="Plan.promo(event)"><input id="codigo-alianza" class="agro-input !bg-white/10 !text-white !border-white/20 placeholder-white/40" placeholder="Código de alianza" maxlength="40">
            <button class="bg-[#F59E0B] text-[#0B2319] rounded-xl px-4 text-sm font-bold whitespace-nowrap">Mes gratis</button></form>
            <p class="text-[11px] opacity-60 mt-1">¿Llegaste por tu asociación de productores? Tu primer mes es gratis.</p>`}
        </div>
        <div class="lg:col-span-3 space-y-4">
          <div class="grid sm:grid-cols-2 gap-3">${beneficios.map(b => `<div class="bg-white rounded-2xl border border-gray-100 p-4">
            <p class="text-2xl">${b[0]}</p><p class="font-bold text-[#0B2319] mt-1">${b[1]}</p><p class="text-xs text-gray-500">${b[2]}</p></div>`).join('')}</div>
          <div id="premium-extra"></div>
        </div>
      </div>
      <div class="mt-6 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <p class="font-bold text-[#0B2319] mb-3">Historial de pagos de membresía</p>
        ${m.historial.length ? `<div class="overflow-x-auto"><table class="w-full text-sm min-w-[560px]"><tbody>${m.historial.map(h => `<tr class="border-t border-gray-50">
          <td class="py-2">#${h.folio}</td><td>${esc(UI.METODO[h.metodo] || h.metodo)}</td><td>${UI.money(h.total)}</td>
          <td>${UI.badge(h.estado, h.estado === 'PAGADA' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500')}</td>
          <td class="text-xs text-gray-400">${h.periodo_inicio ? UI.fecha(h.periodo_inicio) + ' → ' + UI.fecha(h.periodo_fin) : UI.fecha(h.fecha_creacion)}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="text-sm text-gray-400">Sin pagos todavía.</p>'}
      </div>`;
    if (m.activa) premiumExtra();
  }

  async function premiumExtra() {
    const box = $('premium-extra');
    let est, reps;
    try { [est, reps] = await Promise.all([API.get('/tienda/estadisticas-premium'), API.get('/reportes')]); } catch (e) { box.innerHTML = esc(e.message); return; }
    const max = Math.max(1, ...est.meses.map(x => x.ventas));
    box.innerHTML = `
      <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div class="flex items-center justify-between mb-3"><p class="font-bold text-[#0B2319]">Ventas entregadas por mes</p>
          <p class="text-xs text-gray-400">${est.clientes.compradores} compradores · ${est.clientes.recurrentes} repiten · ${est.calificaciones.rating} ★</p></div>
        ${est.meses.length ? `<div class="flex items-end gap-2 h-36">${est.meses.map(x => { const [a, mm] = x.mes.split('-'); return `
          <div class="flex-1 flex flex-col items-center justify-end h-full" title="${UI.money(x.ventas)} · ${x.pedidos} pedidos">
            <p class="text-[9px] text-gray-500 mb-1">${UI.money0(x.ventas)}</p>
            <div class="w-full rounded-t-lg bg-[#4fb877]" style="height:${Math.max(4, 100 * x.ventas / max)}%"></div>
            <p class="text-[10px] text-gray-400 mt-1">${MESES[+mm - 1]} ${a.slice(2)}</p></div>`; }).join('')}</div>`
          : '<p class="text-sm text-gray-400">Aún sin ventas entregadas.</p>'}
        ${est.productos.length ? `<p class="text-xs font-semibold text-gray-500 uppercase mt-5 mb-2">Productos estrella</p>
          ${est.productos.slice(0, 5).map(p => `<div class="flex justify-between text-sm py-1 border-t border-gray-50"><span>${esc(p.nombre)}</span><span class="font-semibold">${UI.money0(p.ventas)}</span></div>`).join('')}` : ''}
      </div>
      <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <div class="flex items-center justify-between gap-3 flex-wrap"><div><p class="font-bold text-[#0B2319]">Reporte AgroConfianza</p>
          <p class="text-xs text-gray-500">Historial de ventas verificable para pedir crédito formal. AgroConnecta no otorga el crédito: tú decides con quién compartirlo.</p></div>
          <button class="btn-verde" onclick="Plan.generarReporte()">Generar reporte</button></div>
        ${reps.length ? `<div class="mt-3 space-y-2">${reps.map(r => `<div class="flex items-center justify-between text-sm border-t border-gray-50 pt-2">
          <span>Folio <b>${r.folio}</b> · ${UI.fecha(r.generado_en)} ${r.vigente ? '' : '<span class="text-xs text-gray-400">(vencido)</span>'}</span>
          <span class="flex gap-2"><button class="btn-borde !py-1 text-xs" onclick="UI.abrirArchivo('/reportes/${r.folio}/pdf')">Ver PDF</button>
          <a class="btn-borde !py-1 text-xs" target="_blank" href="Reporte.html?folio=${r.folio}">Verificación</a></span></div>`).join('')}</div>` : ''}
      </div>`;
  }

  async function generarReporte() {
    try { const r = await API.post('/reportes'); UI.toast(`Reporte folio ${r.folio} generado`); UI.abrirArchivo(`/reportes/${r.folio}/pdf`); premiumExtra(); }
    catch (e) { UI.toast(e.message, 'error'); }
  }

  async function pagarPremium(metodo) {
    try {
      const r = await API.post('/membresias', { metodo });
      const p = r.pago;
      if (p.tipo === 'REDIRECT') { location.href = p.url; return; }
      if (p.tipo === 'SPEI') {
        UI.pagoSpei(p, { titulo: '· Membresía Premium', volver: 'Tienda.html?tab=premium',
          simular: () => API.post(`/membresias/${r.membresia.id_membresia}/spei`) });
        return;
      }
      UI.modal.open(`<form class="p-6 space-y-3" id="f-mem">
          <p class="text-xs text-gray-400 uppercase font-semibold">Membresía Premium · pago de prueba</p>
          <p class="text-3xl font-bold text-[#2E6B42]">${UI.money(r.membresia.total)}</p>
          <p class="text-xs text-gray-500">${UI.money(r.membresia.monto)} + IVA ${UI.money(r.membresia.iva)}</p>
          <input id="mem-num" class="agro-input" value="4242 4242 4242 4242" inputmode="numeric" maxlength="19">
          <button class="btn-verde w-full">Pagar</button></form>`, { ancho: 'max-w-sm' });
      $('f-mem').onsubmit = async e => {
        e.preventDefault();
        try {
          const x = await API.post(`/membresias/${r.membresia.id_membresia}/simulado`, { tarjeta: $('mem-num').value });
          UI.modal.close();
          UI.toast(x.estado === 'PAGADA' ? '★ ¡Ya eres Premium!' : 'Pago rechazado', x.estado === 'PAGADA' ? 'ok' : 'error');
          await cargarNegocio(); premium();
        } catch (err) { UI.toast(err.message, 'error'); }
      };
    } catch (e) { UI.toast(e.message, 'error'); }
  }

  async function promo(e) {
    e.preventDefault();
    try { const r = await API.post('/membresias/promocion', { codigo: $('codigo-alianza').value }); UI.toast(r.message); await cargarNegocio(); premium(); }
    catch (err) { UI.toast(err.message, 'error'); }
  }

  async function regresoDePago() {
    const q = new URLSearchParams(location.search);
    try {
      if (q.get('pago') === 'stripe' && q.get('session_id')) {
        const r = await API.post('/membresias/stripe/confirmar', { session_id: q.get('session_id') });
        UI.toast(r.estado === 'PAGADA' ? '★ Membresía pagada con Stripe' : 'El pago sigue pendiente');
      } else if (q.get('pago') === 'mercadopago' && (q.get('payment_id') || q.get('collection_id'))) {
        const r = await API.post('/membresias/mercadopago/confirmar', { payment_id: q.get('payment_id') || q.get('collection_id') });
        UI.toast(r.estado === 'PAGADA' ? '★ Membresía pagada con Mercado Pago' : 'Mercado Pago: ' + r.estado);
      } else return;
      history.replaceState(null, '', 'Tienda.html?tab=premium');
      await cargarNegocio(); premium();
    } catch (e) { UI.toast(e.message, 'error'); }
  }

  // ── Verificación ──
  async function verificacion() {
    const box = $('tab-verificacion');
    let v;
    try { v = await API.get('/verificacion'); } catch (e) { box.innerHTML = esc(e.message); return; }
    const doc = t => v.documentos.find(d => d.tipo === t);
    const est = { PENDIENTE: ['Por revisar', 'bg-blue-50 text-blue-700'], ACEPTADO: ['Aceptado', 'bg-green-50 text-green-700'], RECHAZADO: ['Rechazado', 'bg-red-50 text-red-600'] };
    const completo = Object.keys(v.tipos).every(t => doc(t) && doc(t).estado !== 'RECHAZADO');
    const ayuda = { INE: 'Credencial para votar por ambos lados (foto o PDF).', COMPROBANTE_DOMICILIO: 'Recibo de luz, agua o constancia, no mayor a 3 meses.',
      DOCUMENTO_PARCELA: 'Lo que te liga a tu parcela: escritura, certificado parcelario, constancia ejidal o carta de tu asociación.' };
    box.innerHTML = `
      <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <div class="flex items-center justify-between gap-3 flex-wrap mb-2"><h3 class="font-bold text-[#0B2319] text-lg">Insignia «Productor Verificado»</h3>
          ${UI.badge({ SIN_DOCUMENTOS: 'Sin documentos', EN_REVISION: 'En revisión', VERIFICADO: '✓ Verificado', RECHAZADO: 'Rechazado' }[v.verificacion_estado],
            v.verificado ? 'bg-green-50 text-green-700' : v.verificacion_estado === 'RECHAZADO' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700')}</div>
        <p class="text-sm text-gray-500">Sin la insignia tus productos y terrenos no se muestran. Tus documentos se guardan <b>cifrados</b> (AES-256) y solo los ve el administrador que revisa.</p>
        ${v.verificacion_nota ? `<p class="mt-3 text-sm rounded-xl p-3 ${v.verificacion_estado === 'RECHAZADO' ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-600'}">Nota del administrador: ${esc(v.verificacion_nota)}</p>` : ''}
        <div class="mt-5 space-y-3">${Object.entries(v.tipos).map(([t, nombre]) => { const d = doc(t); const e = d ? est[d.estado] : null; return `
          <div class="border border-gray-100 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
            <div><p class="font-semibold text-[#0B2319]">${esc(nombre)} ${e ? UI.badge(e[0], e[1]) : ''}</p>
              <p class="text-xs text-gray-400">${d ? `${esc(d.nombre_original || '')} · ${(d.tamano_bytes / 1024).toFixed(0)} KB · huella ${esc(d.sha256.slice(0, 12))}…` : esc(ayuda[t])}</p>
              ${d && d.nota ? `<p class="text-xs text-red-600 mt-1">${esc(d.nota)}</p>` : ''}</div>
            ${v.verificado && d && d.estado === 'ACEPTADO' ? '' : `<label class="btn-borde !py-2 text-xs cursor-pointer whitespace-nowrap">${d ? 'Reemplazar' : 'Subir'} archivo
              <input type="file" accept="image/jpeg,image/png,application/pdf" class="hidden" onchange="Plan.subirDoc('${t}', this)"></label>`}
          </div>`; }).join('')}</div>
        ${['SIN_DOCUMENTOS', 'RECHAZADO'].includes(v.verificacion_estado) ? `<button class="btn-verde w-full mt-5" ${completo ? '' : 'disabled'} onclick="Plan.enviarVerificacion()">Enviar a revisión</button>
          ${completo ? '' : '<p class="text-[11px] text-gray-400 text-center mt-2">Sube los tres documentos para enviarlos.</p>'}` : ''}
      </div>`;
  }

  async function subirDoc(tipo, input) {
    const f = input.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('tipo', tipo); fd.append('archivo', f);
    try { await API.upload('/verificacion/documentos', fd); UI.toast('Documento cargado'); verificacion(); }
    catch (e) { UI.toast(e.message, 'error'); }
  }

  async function enviarVerificacion() {
    try { const r = await API.post('/verificacion/enviar'); UI.toast(r.message); await cargarNegocio(); verificacion(); }
    catch (e) { UI.toast(e.message, 'error'); }
  }

  return { avisoVerificacion, campoParcela, parcelas, formParcela, estadoParcela, liquidaciones, premium, pagarPremium, promo,
    generarReporte, regresoDePago, verificacion, subirDoc, enviarVerificacion };
})();
