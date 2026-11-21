/**
 * AgroConnecta — Cliente de la API (compartido por todas las páginas)
 *  • API.get/post/put/upload → fetch a /api con el token de sesión
 *  • Sesión en localStorage: 'agro_token' (JWT) y 'agro_session' (perfil)
 *  • Utilidades: esc() contra XSS, formato de dinero/fechas, toast, modal
 */
(function () {
  const TOKEN_KEY = 'agro_token';
  const SESSION_KEY = 'agro_session';

  function getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; } }
  function getSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; } }
  function setSession(session, token) {
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session)); else localStorage.removeItem(SESSION_KEY);
      if (token !== undefined) { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); }
    } catch (_) { /* almacenamiento no disponible */ }
  }
  function clearSession() { setSession(null, null); }

  async function request(method, path, body, opts = {}) {
    const headers = {};
    const token = getToken();
    if (token && !opts.sinToken) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

    let res;
    try {
      res = await fetch('/api' + path, { method, headers, body: payload });
    } catch (_) {
      throw new Error('No hay conexión con el servidor. Revisa que estés en la misma red.');
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* sin cuerpo */ }
    if (res.status === 401 && token && !opts.sinToken) {
      clearSession();
      window.dispatchEvent(new Event('agro_session_expired'));
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const API = {
    get: (p) => request('GET', p),
    post: (p, b, o) => request('POST', p, b ?? {}, o),
    put: (p, b) => request('PUT', p, b ?? {}),
    upload: (p, formData) => request('POST', p, formData),
    getToken, getSession, setSession, clearSession,
    isLogged: () => !!getToken() && !!getSession(),
    role: () => (getSession() || {}).tipo_usuario || null,

    async logout() {
      try { await request('POST', '/auth/logout'); } catch (_) { /* ignorar */ }
      clearSession();
      window.location.href = 'login.html';
    },

    /** Exige sesión (y opcionalmente un rol); si no, manda al login */
    requireLogin(roles) {
      const s = getSession();
      if (!s || !getToken()) {
        window.location.href = 'login.html?volver=' + encodeURIComponent(location.pathname.split('/').pop() + location.search);
        return null;
      }
      if (roles && !roles.includes(s.tipo_usuario)) return false;
      return s;
    },
  };

  // ── Utilidades de presentación ──
  const esc = (v) => String(v ?? '').replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
  const signo = n => (Number(n) < 0 ? '−$' : '$');
  const money = (n, dec = 2) => signo(n) + Math.abs(Number(n || 0)).toLocaleString('es-MX', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const money0 = (n) => signo(n) + Math.abs(Number(n || 0)).toLocaleString('es-MX', { maximumFractionDigits: 2 });
  const fecha = (d, larga = true) => d ? new Date(d).toLocaleDateString('es-MX', larga ? { day: '2-digit', month: 'long', year: 'numeric' } : { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const fechaHora = (d) => d ? new Date(d).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const FALLBACK_IMG = 'img/sin-imagen.svg';
  const img = (url) => esc(url || FALLBACK_IMG);

  function stars(n, size = 'w-4 h-4') {
    const v = Number(n) || 0;
    return Array.from({ length: 5 }, (_, i) =>
      `<svg class="${size} ${i < Math.round(v) ? 'text-[#f59e0b]' : 'text-gray-200'}" fill="currentColor" viewBox="0 0 24 24"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.382-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>`
    ).join('');
  }

  function toast(msg, tipo = 'ok') {
    let t = document.getElementById('agro-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'agro-toast';
      t.className = 'agro-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.dataset.tipo = tipo;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 3200);
  }

  /** Modal genérico: modal.open(html) / modal.close() */
  const modal = {
    open(html, { ancho = 'max-w-lg' } = {}) {
      modal.close();
      const ov = document.createElement('div');
      ov.id = 'agro-modal';
      ov.className = 'fixed inset-0 bg-black/50 z-[60] flex items-start sm:items-center justify-center p-3 sm:p-4 overflow-y-auto';
      ov.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full ${ancho} my-6 relative">${html}</div>`;
      ov.addEventListener('click', e => { if (e.target === ov) modal.close(); });
      document.body.appendChild(ov);
      document.body.style.overflow = 'hidden';
      return ov;
    },
    close() {
      const ov = document.getElementById('agro-modal');
      if (ov) ov.remove();
      document.body.style.overflow = '';
    },
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') modal.close(); });

  const ESTADO_PEDIDO = {
    PENDIENTE: { c: 'bg-yellow-100 text-yellow-700', l: 'Pendiente' },
    CONFIRMADO: { c: 'bg-blue-100 text-blue-700', l: 'Confirmado' },
    EN_CAMINO: { c: 'bg-indigo-100 text-indigo-700', l: 'En camino' },
    ENTREGADO: { c: 'bg-green-100 text-green-700', l: 'Entregado' },
    CANCELADO: { c: 'bg-red-100 text-red-700', l: 'Cancelado' },
    DEVUELTO: { c: 'bg-gray-100 text-gray-600', l: 'Devuelto' },
  };
  const ESTADO_PAGO = {
    PENDIENTE: 'bg-yellow-50 text-yellow-700', APROBADO: 'bg-green-50 text-green-700', RECHAZADO: 'bg-red-50 text-red-700',
    CANCELADO: 'bg-gray-100 text-gray-500', REEMBOLSADO: 'bg-purple-50 text-purple-700',
  };
  const METODO = { SIMULADO: 'Tarjeta de prueba', EFECTIVO: 'Efectivo contra entrega', FINANCIAMIENTO: 'Financiamiento', STRIPE: 'Stripe', MERCADOPAGO: 'Mercado Pago', SPEI: 'Transferencia SPEI', PROMOCION: 'Promoción alianza' };
  // Custodia del pago: el dinero se retiene hasta que el comprador confirma de recibido (+48 h)
  const CUSTODIA = {
    SIN_PAGO: { c: 'bg-gray-100 text-gray-500', l: 'Sin pago' },
    RETENIDO: { c: 'bg-amber-50 text-amber-700', l: 'Pago en custodia' },
    LIBERADO: { c: 'bg-green-50 text-green-700', l: 'Pago liberado' },
    REEMBOLSADO: { c: 'bg-purple-50 text-purple-700', l: 'Reembolsado' },
    NO_APLICA: { c: 'bg-gray-100 text-gray-500', l: 'Pago directo' },
  };
  const badge = (txt, cls) => `<span class="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide ${cls}">${esc(txt)}</span>`;

  /** Selector de estrellas: UI.starPicker(el, valorInicial, onChange) */
  function starPicker(el, valor = 0, onChange) {
    const etiquetas = ['Elige', 'Malo', 'Regular', 'Bueno', 'Muy bueno', 'Excelente'];
    let actual = valor;
    el.innerHTML = `<div class="flex items-center gap-1" role="radiogroup" aria-label="Calificación">${[1, 2, 3, 4, 5].map(n =>
      `<button type="button" data-n="${n}" role="radio" aria-label="${n} estrella${n > 1 ? 's' : ''}" class="text-5xl leading-none transition-transform hover:scale-110">★</button>`).join('')}
      <span class="ml-3 text-sm font-semibold text-[#0B2319] w-24"></span></div>`;
    const grupo = el.firstElementChild;
    const botones = [...grupo.querySelectorAll('button')];
    const texto = grupo.querySelector('span');
    function pintar(v) {   // solo cambia colores: no redibuja los botones
      botones.forEach(b => {
        const on = +b.dataset.n <= v;
        b.classList.toggle('text-[#f59e0b]', on);
        b.classList.toggle('text-gray-200', !on);
        b.setAttribute('aria-checked', String(+b.dataset.n === actual));
      });
      texto.textContent = etiquetas[v];
    }
    botones.forEach(b => {
      b.addEventListener('click', () => { actual = +b.dataset.n; pintar(actual); if (onChange) onChange(actual); });
      b.addEventListener('mouseenter', () => pintar(+b.dataset.n));
    });
    grupo.addEventListener('mouseleave', () => pintar(actual));
    pintar(actual);
    return { get valor() { return actual; } };
  }

  /** Insignias de confianza de un vendedor/producto (verificado, directo/acopiador, premium) */
  function insignias(o, { chico = false } = {}) {
    const t = chico ? 'text-[9px] px-1.5 py-0.5' : 'text-[10px] px-2 py-0.5';
    const out = [];
    const verif = o.vendedor_verificado ?? o.verificado;
    const perfil = o.vendedor_perfil ?? o.perfil;
    const premium = o.vendedor_premium ?? o.premium;
    if (verif) out.push(`<span title="Identidad, domicilio y parcela revisados por AgroConnecta" class="${t} rounded-full font-bold bg-[#2E6B42] text-white inline-flex items-center gap-1">✓ Verificado</span>`);
    if (perfil === 'ACOPIADOR') out.push(`<span title="Compra a varios productores y revende" class="${t} rounded-full font-bold bg-orange-100 text-orange-700">Acopiador</span>`);
    else if (perfil === 'PRODUCTOR') out.push(`<span title="Vende lo que produce en su parcela" class="${t} rounded-full font-bold bg-[#E8F5EE] text-[#2E6B42]">Directo del productor</span>`);
    if (premium) out.push(`<span class="${t} rounded-full font-bold bg-[#F59E0B] text-[#0B2319]">★ Premium</span>`);
    return out.join(' ');
  }

  /** Descarga / abre un archivo protegido de la API (PDF, documento) usando el token */
  async function abrirArchivo(path, { descargar = null } = {}) {
    const ventana = descargar ? null : window.open('', '_blank');
    try {
      const res = await fetch('/api' + path, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) { let m = `Error ${res.status}`; try { m = (await res.json()).error || m; } catch (_) { /* binario */ } throw new Error(m); }
      const url = URL.createObjectURL(await res.blob());
      if (descargar) { const a = document.createElement('a'); a.href = url; a.download = descargar; a.click(); }
      else if (ventana) ventana.location.href = url;
      else location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { if (ventana) ventana.close(); toast(e.message, 'error'); }
  }

  /** Banners de publicidad local (anunciantes de insumos agrícolas) */
  async function anuncios(el, ubicacion = 'INICIO') {
    if (!el) return;
    try {
      const lista = await API.get('/publicidad?ubicacion=' + ubicacion);
      if (!lista.length) { el.innerHTML = ''; return; }
      el.innerHTML = `<div class="grid ${lista.length > 1 ? 'md:grid-cols-2' : ''} gap-4">${lista.slice(0, 2).map((a, i) => `
        <a ${i ? 'data-extra' : ''} ${a.url ? `href="${esc(a.url)}" target="_blank" rel="noopener sponsored"` : 'href="#" onclick="return false"'} data-anuncio="${esc(a.id_anunciante)}"
           class="${i ? 'hidden md:block' : 'block'} relative rounded-2xl overflow-hidden border border-gray-100 bg-white hover:shadow-md transition-shadow">
          ${a.imagen_url ? `<img src="${esc(a.imagen_url)}" alt="${esc(a.nombre)}: ${esc(a.mensaje)}" class="w-full h-auto block" loading="lazy">`
            : `<div class="p-5"><p class="font-bold text-[#0B2319]">${esc(a.nombre)}</p><p class="text-sm text-gray-500">${esc(a.mensaje)}</p></div>`}
          <span class="absolute top-2 right-2 text-[9px] font-bold uppercase tracking-wide bg-white/85 text-gray-500 px-2 py-0.5 rounded-full">Publicidad</span>
        </a>`).join('')}</div>`;
      el.querySelectorAll('[data-anuncio]').forEach(a => a.addEventListener('click', () => {
        fetch('/api/publicidad/' + a.dataset.anuncio + '/clic', { method: 'POST' }).catch(() => {});
      }));
    } catch (_) { el.innerHTML = ''; }
  }

  /** Instrucciones de pago SPEI (CLABE + referencia). En el piloto se puede simular el depósito. */
  function pagoSpei(p, { titulo = '', simular = null, volver = 'Pedidos.html' } = {}) {
    modal.open(`
      <div class="p-6 border-b border-gray-100">
        <p class="text-xs text-gray-400 uppercase tracking-wider font-semibold">Transferencia SPEI ${esc(titulo)}</p>
        <p class="text-3xl font-bold text-[#2E6B42] mt-1">${money(p.total)}</p>
      </div>
      <div class="p-6 space-y-3 text-sm">
        <div class="rounded-2xl bg-[#F3F9F6] border border-[#d7ebdf] p-4 space-y-2">
          <div><p class="text-[11px] text-gray-500">CLABE</p><p class="font-mono font-bold text-lg text-[#0B2319] tracking-wider">${esc(p.clabe)}</p></div>
          <div class="grid grid-cols-2 gap-2">
            <div><p class="text-[11px] text-gray-500">Referencia</p><p class="font-mono font-bold text-[#0B2319]">${esc(p.referencia)}</p></div>
            <div><p class="text-[11px] text-gray-500">Banco</p><p class="font-semibold text-[#0B2319] text-xs">${esc(p.banco)}</p></div>
          </div>
          <div><p class="text-[11px] text-gray-500">Beneficiario</p><p class="font-semibold text-[#0B2319]">${esc(p.beneficiario)}</p></div>
        </div>
        <p class="text-xs text-gray-500">${esc(p.nota)} El dinero queda <b>en custodia</b> hasta que confirmes que recibiste tu pedido.</p>
        ${p.simulable && simular ? `<button id="btn-spei-sim" class="w-full bg-[#2E6B42] text-white py-3 rounded-xl font-semibold">Simular depósito (prueba piloto)</button>` : ''}
        <a href="${esc(volver)}" class="block text-center text-sm text-gray-500">Pagar después</a>
      </div>`, { ancho: 'max-w-sm' });
    const b = document.getElementById('btn-spei-sim');
    if (b) b.onclick = async () => {
      b.disabled = true; b.textContent = 'Procesando…';
      try { await simular(); modal.close(); toast('✓ Depósito SPEI recibido'); setTimeout(() => { location.href = volver; }, 900); }
      catch (e) { toast(e.message, 'error'); b.disabled = false; b.textContent = 'Simular depósito'; }
    };
  }

  window.API = API;
  window.UI = { pagoSpei, starPicker, esc, money, money0, fecha, fechaHora, img, stars, toast, modal, badge, insignias, abrirArchivo, anuncios,
    ESTADO_PEDIDO, ESTADO_PAGO, METODO, CUSTODIA, FALLBACK_IMG };
})();
