/**
 * AgroConnecta – Capa de datos del frontend (v2, conectada a la API)
 *
 * Antes este archivo tenía datos simulados (mock). Ahora todas las
 * funciones consultan al backend (Node.js + PostgreSQL/PostGIS):
 *
 *   AGRO_DB.buscarProductos({ q, categoria, vendedor, orden })  → GET /api/productos
 *   AGRO_DB.getProducto(id)                                     → GET /api/productos/:id
 *   AGRO_DB.getCategorias()                                     → GET /api/categorias
 *   AGRO_DB.buscarTerrenos({ q, operacion, lat, lng, radio_km })→ GET /api/terrenos
 *   AGRO_DB.getTerreno(id)                                      → GET /api/terrenos/:id
 *   AGRO_DB.getStats()                                          → GET /api/stats
 *
 * El CARRITO vive en el navegador (localStorage 'agro_cart'). Al pagar se
 * convierte en PEDIDO(s) en la base; el precio SIEMPRE lo pone el servidor.
 */
window.AGRO_DB = (function () {
  const CART_KEY = 'agro_cart';
  const qs = (o) => Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  // ── Catálogo ──────────────────────────────────────────────
  const buscarProductos = (f = {}) => API.get('/productos?' + qs({ limit: 60, ...f }));
  const getProducto = (id) => API.get('/productos/' + encodeURIComponent(id));
  const getCategorias = () => API.get('/categorias');
  const buscarTerrenos = (f = {}) => API.get('/terrenos?' + qs({ limit: 60, ...f }));
  const getTerreno = (id) => API.get('/terrenos/' + encodeURIComponent(id));
  const getStats = () => API.get('/stats');
  let _config = null;
  const getConfig = async () => (_config = _config || await API.get('/config'));

  // ── Carrito (localStorage) ────────────────────────────────
  function getCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch (_) { return []; }
  }
  function saveCart(cart) {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (_) { /* sin almacenamiento */ }
    window.dispatchEvent(new Event('agro_cart_updated'));
  }
  const snapshot = (p) => ({
    nombre: p.nombre, precio: p.precio, imagen: p.imagen, categoria: p.categoria, unidad: p.unidad,
    stock: p.stock, ubicacion: p.ubicacion, vendedor_nombre: p.vendedor_nombre, id_vendedor: p.id_vendedor, estado: p.estado,
    tasa_iva: p.tasa_iva, vendedor_perfil: p.vendedor_perfil, vendedor_verificado: p.vendedor_verificado,
  });
  function addToCart(producto, qty) {
    const cart = getCart();
    const it = cart.find(i => i.id === producto.id);
    if (it) { it.qty = Math.min((it.qty || 0) + qty, producto.stock); it.snap = snapshot(producto); }
    else cart.push({ id: producto.id, qty: Math.min(qty, producto.stock), snap: snapshot(producto) });
    saveCart(cart);
  }
  function setQty(id, qty) {
    const cart = getCart();
    const it = cart.find(i => i.id === id);
    if (!it) return;
    it.qty = Math.max(1, Math.min(qty, (it.snap && it.snap.stock) || qty));
    saveCart(cart);
  }
  const removeFromCart = (id) => saveCart(getCart().filter(i => i.id !== id));
  const clearCart = () => saveCart([]);
  const getCartCount = () => getCart().reduce((s, i) => s + 1, 0);

  /** Actualiza precios/stock con la base y quita lo que ya no está disponible */
  async function refreshCart() {
    const cart = getCart();
    if (!cart.length) return { items: [], quitados: [] };
    const actuales = await API.post('/productos/lote', { ids: cart.map(i => i.id) });
    const mapa = new Map(actuales.map(p => [p.id, p]));
    const quitados = [];
    const nuevo = [];
    for (const it of cart) {
      const p = mapa.get(it.id);
      if (!p || p.estado !== 'ACTIVO' || p.stock <= 0) { quitados.push(it.snap ? it.snap.nombre : 'Producto'); continue; }
      nuevo.push({ id: it.id, qty: Math.min(it.qty, p.stock), snap: snapshot(p) });
    }
    saveCart(nuevo);
    return { items: nuevo.map(i => ({ id: i.id, qty: i.qty, ...i.snap })), quitados };
  }

  return {
    buscarProductos, getProducto, getCategorias, buscarTerrenos, getTerreno, getStats, getConfig,
    getCart, addToCart, setQty, removeFromCart, clearCart, getCartCount, refreshCart,
    getSession: () => API.getSession(),
  };
})();
