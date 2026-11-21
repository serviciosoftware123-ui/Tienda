/**
 * AgroConnecta - Barra Lateral Dinámica v4
 *  • Menú según el rol de la sesión (comprador / vendedor / admin)
 *  • Adaptable a celular: barra superior + menú deslizable
 *  • "Mi cuenta": editar datos y cambiar contraseña
 *  • Refresca la sesión con GET /api/auth/me (score, nombre, etc.)
 */
(function () {
  const I = {
    inicio: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z',
    catalogo: 'M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z',
    terrenos: 'M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0zM15 11a3 3 0 11-6 0 3 3 0 016 0z',
    pedidos: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    tienda: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    carrito: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z',
    perfil: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
    calificaciones: 'M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.382-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z',
    administracion: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  };

  const NAV_ITEMS = [
    { id: 'inicio', label: 'Inicio', href: 'Agro_Conneccta-Pagina.html' },
    { id: 'catalogo', label: 'Catálogo', href: 'Catalogo.html' },
    { id: 'terrenos', label: 'Terrenos', href: 'Terrenos.html' },
    { id: 'pedidos', label: 'Pedidos', href: 'Pedidos.html', roles: ['COMPRADOR', 'VENDEDOR', 'ADMINISTRADOR'] },
    { id: 'tienda', label: 'Mi Tienda', href: 'Tienda.html', roles: ['VENDEDOR'] },
    { id: 'carrito', label: 'Carrito', href: 'Carrito.html', badge: true, roles: ['ANON', 'COMPRADOR'] },
    { id: 'calificaciones', label: 'Calificaciones', href: 'Calificaciones.html' },
    { id: 'perfil', label: 'Mi perfil', href: 'Perfil.html', roles: ['COMPRADOR', 'VENDEDOR'] },
    { id: 'administracion', label: 'Administración', href: 'Administracion.html', roles: ['ADMINISTRADOR'] },
  ];
  const NIVEL = { BRONCE: '🥉 Bronce', PLATA: '🥈 Plata', ORO: '🥇 Oro', PLATINO: '💎 Platino' };

  const esc = (v) => (window.UI ? UI.esc(v) : String(v ?? ''));
  const svg = (d, c = 'w-5 h-5') => `<svg class="${c} flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${d}"/></svg>`;
  const session = () => (window.API ? API.getSession() : null);
  const cartCount = () => (window.AGRO_DB ? AGRO_DB.getCartCount() : 0);

  function navItem(item, active, role) {
    if (item.roles && !item.roles.includes(role)) return '';
    const isActive = item.id === active;
    const n = item.badge ? cartCount() : 0;
    return `
      <a href="${item.href}" class="flex items-center justify-between p-3 rounded-xl transition-all ${isActive ? 'bg-[#4fb877] text-white' : 'text-gray-300 hover:bg-white/10'}">
        <div class="flex items-center gap-3">${svg(I[item.id])}<span>${item.label}</span></div>
        <div class="flex items-center gap-1">
          ${n > 0 ? `<span data-cart-badge class="bg-[#f59e0b] text-[#0B2319] text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center">${n}</span>` : ''}
          ${isActive ? svg('M9 5l7 7-7 7', 'w-4 h-4') : ''}
        </div>
      </a>`;
  }

  function userFooter(s) {
    if (!s) {
      return `<div class="mt-4 pt-4 border-t border-white/10 space-y-2">
        <a href="login.html" class="flex items-center justify-center gap-2 p-2.5 rounded-xl bg-[#4fb877] text-[#0B2319] font-semibold text-sm hover:bg-[#3ea866]">Iniciar sesión</a>
        <a href="login.html?registro=1" class="block text-center text-xs text-gray-400 hover:text-white">¿Nuevo? Crea tu cuenta</a>
      </div>`;
    }
    const ini = s.initials || ((s.nombre || '?')[0] + (s.apellido || ' ')[0]).toUpperCase();
    const rol = s.tipo_usuario === 'ADMINISTRADOR' ? '🛡 Admin' : s.tipo_usuario === 'VENDEDOR' ? '🏪 Vendedor' : '🛒 Comprador';
    const nivel = s.score && s.tipo_usuario !== 'ADMINISTRADOR' ? NIVEL[s.score.nivel] || s.score.nivel : '';
    return `
      <div class="mt-4 pt-4 border-t border-white/10">
        <div class="flex items-center justify-between px-1 mb-2">
          <span class="text-[10px] font-bold uppercase tracking-wider text-[#4fb877]">${rol}</span>
          ${nivel ? `<span title="Score AgroConfianza: ${esc(s.score.puntos)} puntos" class="text-[10px] text-gray-400">${nivel}</span>` : ''}
        </div>
        <div class="flex items-center gap-3 px-1">
          <button onclick="agroMiCuenta()" title="Mi cuenta" class="w-8 h-8 rounded-full bg-[#4fb877] flex items-center justify-center text-white text-xs font-bold flex-shrink-0">${esc(ini)}</button>
          <a href="${s.tipo_usuario === 'ADMINISTRADOR' ? '#' : 'Perfil.html'}" ${s.tipo_usuario === 'ADMINISTRADOR' ? 'onclick="agroMiCuenta();return false;"' : ''} class="flex-1 min-w-0 text-left">
            <p class="text-white text-sm font-semibold truncate leading-tight">${esc(s.nombre)} ${esc(s.apellido || '')}</p>
            <p class="text-gray-500 text-xs truncate">${esc(s.nombre_negocio || s.email || '')}</p>
          </a>
          <a href="#" onclick="agroLogout(); return false;" title="Cerrar sesión" class="text-gray-500 hover:text-red-400 transition-colors">
            ${svg('M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1', 'w-4 h-4')}
          </a>
        </div>
      </div>`;
  }

  const LOGO = `<div class="bg-[#4fb877] p-1.5 rounded-lg">${svg('M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9', 'w-6 h-6 text-white')}</div>`;

  function build(active, s) {
    const role = s ? s.tipo_usuario : 'ANON';
    const n = cartCount();
    const verCarrito = role === 'ANON' || role === 'COMPRADOR';
    return `
      <header id="agro-topbar" class="md:hidden fixed top-0 inset-x-0 h-14 bg-[#0B2319] text-white flex items-center justify-between px-4 z-40 shadow">
        <button onclick="agroMenu(true)" aria-label="Abrir menú" class="p-2 -ml-2">${svg('M4 6h16M4 12h16M4 18h16', 'w-6 h-6')}</button>
        <a href="Agro_Conneccta-Pagina.html" class="flex items-center gap-2">${LOGO}<span class="font-bold">AgroConnecta</span></a>
        ${verCarrito ? `<a href="Carrito.html" class="relative p-2 -mr-2" aria-label="Carrito">${svg(I.carrito, 'w-6 h-6')}
          ${n ? `<span data-cart-badge class="absolute top-0 right-0 bg-[#f59e0b] text-[#0B2319] text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center">${n}</span>` : ''}</a>` : '<span class="w-8"></span>'}
      </header>
      <div id="agro-drawer-bg" onclick="agroMenu(false)" class="hidden md:hidden fixed inset-0 bg-black/50 z-40"></div>
      <aside id="agro-aside" class="w-64 bg-[#0B2319] text-gray-300 flex flex-col p-4 fixed md:sticky top-0 left-0 h-screen z-50 -translate-x-full md:translate-x-0 transition-transform duration-200 flex-shrink-0">
        <div class="flex items-center justify-between mb-8 px-2">
          <a href="Agro_Conneccta-Pagina.html" class="flex items-center gap-2">${LOGO}
            <div><h1 class="font-bold text-white leading-none">AgroConnecta</h1>
            <span class="text-xs text-gray-500 uppercase tracking-widest">Sureste</span></div></a>
          <button onclick="agroMenu(false)" class="md:hidden text-gray-400 p-1" aria-label="Cerrar menú">${svg('M6 18L18 6M6 6l12 12')}</button>
        </div>
        <nav class="flex-1 space-y-1 overflow-y-auto">${NAV_ITEMS.map(i => navItem(i, active, role)).join('')}</nav>
        ${userFooter(s)}
        <div class="mt-3 text-center text-[10px] text-gray-500 space-x-2">
          <a href="Privacidad.html" class="hover:text-white">Aviso de privacidad</a><span>·</span><a href="Terminos.html" class="hover:text-white">Términos</a>
        </div>
      </aside>`;
  }

  window.agroMenu = function (abrir) {
    const a = document.getElementById('agro-aside');
    const bg = document.getElementById('agro-drawer-bg');
    if (!a) return;
    a.classList.toggle('-translate-x-full', !abrir);
    bg.classList.toggle('hidden', !abrir);
  };

  window.agroLogout = function () { API.logout(); };

  window.agroMiCuenta = function () {
    const s = session();
    if (!s) return;
    const comprador = s.tipo_usuario === 'COMPRADOR';
    UI.modal.open(`
      <div class="p-6 border-b border-gray-100 flex items-center justify-between">
        <h3 class="font-bold text-[#0B2319] text-lg">Mi cuenta</h3>
        <button onclick="UI.modal.close()" class="text-gray-400">✕</button>
      </div>
      <div class="p-6 space-y-4 text-sm">
        <div class="bg-[#F3F9F6] rounded-xl p-4 flex items-center justify-between">
          <div><p class="text-xs text-gray-500">Score AgroConfianza</p>
            <p class="font-bold text-[#0B2319] text-lg">${NIVEL[(s.score || {}).nivel] || 'Bronce'} · ${esc((s.score || {}).puntos || 0)} pts</p></div>
          <p class="text-xs text-gray-500 text-right">${esc((s.score || {}).transacciones || 0)} transacciones<br>completadas</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="block"><span class="text-xs text-gray-500">Nombre</span><input id="mc-nombre" class="agro-input" value="${esc(s.nombre)}"></label>
          <label class="block"><span class="text-xs text-gray-500">Apellido</span><input id="mc-apellido" class="agro-input" value="${esc(s.apellido)}"></label>
        </div>
        <label class="block"><span class="text-xs text-gray-500">Teléfono (se guarda cifrado)</span><input id="mc-tel" class="agro-input" value="${esc(s.telefono || '')}" inputmode="tel"></label>
        ${comprador ? `
        <label class="block"><span class="text-xs text-gray-500">Dirección de entrega</span><input id="mc-dir" class="agro-input" value="${esc(s.direccion || '')}"></label>
        <label class="block"><span class="text-xs text-gray-500">Ciudad / municipio</span><input id="mc-ciudad" class="agro-input" value="${esc(s.ciudad || '')}"></label>` : ''}
        <button onclick="agroGuardarCuenta()" class="w-full bg-[#2E6B42] text-white py-2.5 rounded-xl font-semibold">Guardar datos</button>
        <details class="pt-2"><summary class="cursor-pointer text-[#2E6B42] font-semibold">Cambiar contraseña</summary>
          <div class="space-y-3 mt-3">
            <input id="mc-pa" type="password" class="agro-input" placeholder="Contraseña actual">
            <input id="mc-pn" type="password" class="agro-input" placeholder="Nueva (mín. 8, letras y números)">
            <button onclick="agroCambiarPass()" class="w-full border border-gray-200 py-2.5 rounded-xl font-semibold">Actualizar contraseña</button>
          </div>
        </details>
        ${comprador ? '' : `
        <details class="pt-2" ${s.totp_activo ? '' : 'open'}><summary class="cursor-pointer text-[#2E6B42] font-semibold">Verificación en dos pasos ${s.totp_activo ? '<span class="ml-1 text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full">ACTIVA</span>' : '<span class="ml-1 text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">RECOMENDADA</span>'}</summary>
          <div id="mc-2fa" class="mt-3 space-y-3">
            ${s.totp_activo
              ? `<p class="text-xs text-gray-500">Al iniciar sesión te pediremos el código de 6 dígitos de tu app (Google Authenticator, Authy…).</p>
                 <input id="mc-2fa-cod" class="agro-input" inputmode="numeric" maxlength="6" placeholder="Código actual para desactivar">
                 <button onclick="agro2fa('desactivar')" class="w-full border border-gray-200 py-2.5 rounded-xl font-semibold text-red-600">Desactivar</button>`
              : `<p class="text-xs text-gray-500">Protege tu cuenta: además de la contraseña se pedirá un código que cambia cada 30 segundos en tu celular.</p>
                 <button onclick="agro2fa('iniciar')" class="w-full bg-[#0B2319] text-white py-2.5 rounded-xl font-semibold">Configurar con mi celular</button>`}
          </div>
        </details>`}
        <p class="text-[11px] text-gray-400">Correo: ${esc(s.email)} · Cuenta desde ${UI.fecha(s.fecha_registro)}
          ${s.aviso && s.aviso.version ? `<br>Aceptaste el <a href="Privacidad.html" class="underline">aviso de privacidad</a> (versión ${esc(s.aviso.version)})` : ''}</p>
      </div>`, { ancho: 'max-w-md' });
  };

  window.agro2fa = async function (accion) {
    const box = document.getElementById('mc-2fa');
    try {
      if (accion === 'iniciar') {
        const r = await API.post('/auth/2fa/iniciar');
        box.innerHTML = `
          <ol class="text-xs text-gray-600 list-decimal pl-4 space-y-1">
            <li>Abre Google Authenticator (o Authy) y toca <b>+</b>.</li><li>Escanea este código QR.</li><li>Escribe el código de 6 dígitos que aparece.</li></ol>
          <img src="${esc(r.qr)}" alt="Código QR para la verificación en dos pasos" class="mx-auto w-44 h-44 rounded-xl border border-gray-100">
          <p class="text-[10px] text-gray-400 text-center break-all">¿No puedes escanear? Clave: <b>${esc(r.secreto)}</b></p>
          <input id="mc-2fa-cod" class="agro-input text-center tracking-[.4em] text-lg" inputmode="numeric" maxlength="6" placeholder="000000">
          <button onclick="agro2fa('activar')" class="w-full bg-[#2E6B42] text-white py-2.5 rounded-xl font-semibold">Activar</button>`;
        return;
      }
      const codigo = (document.getElementById('mc-2fa-cod') || {}).value || '';
      await API.post('/auth/2fa/' + accion, { codigo });
      API.setSession(await API.get('/auth/me'));
      UI.toast(accion === 'activar' ? 'Verificación en dos pasos activada' : 'Verificación en dos pasos desactivada');
      agroMiCuenta();
    } catch (e) { UI.toast(e.message, 'error'); }
  };

  window.agroGuardarCuenta = async function () {
    const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : undefined; };
    try {
      const s = await API.put('/auth/perfil', { nombre: v('mc-nombre'), apellido: v('mc-apellido'), telefono: v('mc-tel'),
        direccion: v('mc-dir'), ciudad: v('mc-ciudad') });
      API.setSession(s);
      UI.modal.close(); UI.toast('Datos actualizados'); init();
    } catch (e) { UI.toast(e.message, 'error'); }
  };

  window.agroCambiarPass = async function () {
    try {
      await API.put('/auth/password', { actual: document.getElementById('mc-pa').value, nueva: document.getElementById('mc-pn').value });
      UI.toast('Contraseña actualizada. Inicia sesión de nuevo.');
      setTimeout(() => { API.clearSession(); location.href = 'login.html'; }, 1200);
    } catch (e) { UI.toast(e.message, 'error'); }
  };

  let activo = '';
  function render() {
    const el = document.getElementById('agro-sidebar');
    const html = build(activo, session());
    if (el) el.innerHTML = html;
  }

  function init() {
    const root = document.getElementById('sidebar-root');
    if (root) {
      activo = root.dataset.page || '';
      const wrap = document.createElement('div');
      wrap.id = 'agro-sidebar';
      wrap.className = 'contents';
      root.replaceWith(wrap);
    }
    render();
  }

  // Refresca la sesión desde el servidor (score, nombre, estado)
  async function refrescar() {
    if (!window.API || !API.getToken()) return;
    try { API.setSession(await API.get('/auth/me')); render(); } catch (_) { render(); }
  }

  window.addEventListener('agro_cart_updated', render);
  window.addEventListener('agro_session_expired', () => { render(); if (window.UI) UI.toast('Tu sesión terminó. Inicia sesión de nuevo.', 'error'); });
  window.agroSidebarRefresh = render;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { init(); refrescar(); });
  else { init(); refrescar(); }
})();
