# AgroConnecta Sureste v3.0

Marketplace agrícola del sureste mexicano: productores (**vendedores**) publican productos y terrenos, **compradores** compran y pagan, y un **administrador** supervisa la plataforma.

**Stack:** HTML + Tailwind CSS + JavaScript · Node.js 22 + Express · PostgreSQL 16 + PostGIS · Nginx · Docker Compose · Kubernetes

---

## 1. Arranque rápido (prueba piloto en tu Mac)

Requisitos: **Docker Desktop** abierto. No necesitas instalar Node ni PostgreSQL.

```bash
cd agroconnecta
./iniciar.sh
```

El script:
1. Crea `.env` con contraseñas y llaves aleatorias (solo la primera vez). **Guárdalo**: sin él no se descifran teléfonos, RFC ni documentos de verificación.
2. Detecta tu IP en la Wi-Fi y la pone en `PUBLIC_URL`.
3. Construye las 3 imágenes y levanta los contenedores. La primera vez tarda de 3 a 6 minutos.
4. Muestra la dirección para los celulares, por ejemplo `http://192.168.1.50:8080`.

### Que tus compañeros entren desde su celular o laptop
- Todos deben estar en **la misma red Wi-Fi** que tu Mac.
- Abren en el navegador la dirección que mostró el script.
- Si macOS pregunta "¿Permitir conexiones entrantes a Docker?", acepta. Si no carga, revisa *Ajustes del Sistema → Red → Firewall*.
- Las redes de la universidad a veces bloquean la comunicación entre dispositivos (aislamiento de clientes). En ese caso usa el hotspot de tu celular o un router propio.

### Cuentas de prueba (se crean solas)
| Rol | Correo | Contraseña |
|---|---|---|
| Administrador | admin@agroconnecta.mx | AgroAdmin#2026 |
| Vendedor | platanos@agroconnecta.mx · campodulce@agroconnecta.mx · maquiagro@agroconnecta.mx | Demo#2026 |
| Acopiador (comisión 8 %) | acopio@agroconnecta.mx | Demo#2026 |
| Vendedor en revisión (sus productos no se ven) | huerta@agroconnecta.mx | Demo#2026 |
| Comprador | comprador1@agroconnecta.mx · comprador2@agroconnecta.mx | Demo#2026 |

Código de alianza (primer mes Premium gratis): `ALIANZA-TAB-2026`.

Tus compañeros pueden crear sus propias cuentas de **comprador** o **vendedor** desde *Crear cuenta*.

### Novedades v3.0 (plan de negocio integrado)
- **Productor Verificado estricto:** el vendedor sube INE, constancia y comprobante (cifrados con AES-256-GCM); sin aprobación sus productos no se publican.
- **Productor / acopiador** con comisión de **4 % / 8 %**, filtro *Directo del productor* y **liquidación** (comisión, IVA de comisión y neto).
- **IVA por categoría** (0 % para productos del campo, riego y tractores agrícolas; 16 % general).
- **Pago protegido:** el pago queda retenido y se libera 48 h después de que el comprador confirma *Ya lo recibí* (autoconfirmación a los 7 días de la entrega).
- **SPEI** con referencia y CLABE (simulado en el piloto), además de tarjeta, Stripe, Mercado Pago, efectivo y financiamiento.
- **Flete por distancia** con PostGIS: $100 + $10/km + $60 de margen; transportistas aliados.
- **Parcelas** con alerta cuando lo vendido supera superficie × rendimiento × 1.2.
- **Premium** $199/mes (primer mes gratis con código), **publicidad local**, **Reporte AgroConfianza** en PDF con QR, **mediación de disputas**, **2FA (TOTP)**, **panel de indicadores** y **parámetros** editables.
- Aviso de privacidad y términos (`Privacidad.html`, `Terminos.html`).

Si ya tenías la v2.x corriendo, solo vuelve a ejecutar `./iniciar.sh`: aplica `db/init/06_perfiles.sql` y `07_plan_negocio.sql` una sola vez sin borrar tus datos.

**Tarjeta de prueba:** `4242 4242 4242 4242` (aprobada) · `4000 0000 0000 0002` (rechazada).

### Comandos útiles
```bash
docker compose ps                 # estado de los contenedores
docker compose logs -f api        # ver la API en vivo
docker compose down               # detener (los datos se conservan)
docker compose down -v            # BORRAR todo (base de datos e imágenes subidas) y empezar de cero
docker compose exec db psql -U agro_admin -d agroconnecta     # entrar a la base como administrador
```
Para conectarte con pgAdmin o DBeaver usa `localhost:5432`, base `agroconnecta`, usuario `agro_admin` y la contraseña `DB_ADMIN_PASSWORD` de tu `.env`. Ese puerto solo es visible desde tu Mac.

### Verificar que todo funciona (125 pruebas automáticas)
```bash
docker compose exec -e API_URL=http://localhost:3000 api node src/scripts/prueba-e2e.js
```

---

## 2. Pagos de prueba

| Método | Requiere | Cómo funciona |
|---|---|---|
| **SPEI** (simulado) | Nada | Referencia y CLABE; en el piloto el depósito se simula con un botón. |
| Tarjeta de prueba (simulada) | Nada | Formulario dentro de la página. Siempre disponible. |
| Efectivo contra entrega | Nada | El pago se aprueba cuando el vendedor marca el pedido como entregado. |
| Financiamiento AgroConnecta | Nada | De 3 a 12 pagos, 1.5 % mensual. El admin registra los abonos. |
| **Stripe** (modo prueba) | `STRIPE_SECRET_KEY=sk_test_...` | Redirige a Stripe Checkout y regresa a *Pedidos*. |
| **Mercado Pago** (modo prueba) | `MP_ACCESS_TOKEN=TEST-...` | Checkout Pro con tarjetas de prueba de Mercado Pago. |

Para activar Stripe o Mercado Pago, pega la llave en `.env` y ejecuta `docker compose up -d`. El servidor siempre **vuelve a consultar al proveedor** y compara el monto cobrado con el total guardado en la base antes de aprobar.

---

## 3. Kubernetes (Docker Desktop)

1. Docker Desktop → *Settings → Kubernetes → Enable Kubernetes*.
2. Construye las imágenes (Docker Desktop las comparte con su Kubernetes):
   ```bash
   docker compose build
   ```
3. Crea el namespace, el secreto (desde tu `.env`) y aplica todo:
   ```bash
   kubectl apply -f k8s/00-namespace.yaml
   kubectl -n agroconnecta create secret generic agroconnecta-secretos --from-env-file=.env
   kubectl apply -k k8s/
   kubectl -n agroconnecta get pods -w
   ```
4. Abre `http://localhost:30080`.

Incluye: StatefulSet de PostgreSQL con volumen persistente, API con 2 réplicas y autoescalado (HPA de 2 a 5 réplicas), Nginx con 2 réplicas, Ingress con TLS opcional, NetworkPolicies (la base solo acepta conexiones de la API) y contenedores sin root.

---

## 4. Pasar a internet con dominio (cuando lo compres)

**Opción A. VPS sencillo** (DigitalOcean, Hostinger VPS, AWS Lightsail; de 2 GB de RAM en adelante):
1. Instala Docker en el VPS y copia esta carpeta.
2. En `.env` pon `PUBLIC_URL=https://tudominio.com`.
3. Apunta el registro DNS **A** del dominio a la IP del VPS.
4. Pon delante un proxy con HTTPS automático, por ejemplo **Caddy**: `tudominio.com { reverse_proxy localhost:8080 }`.
5. Con HTTPS ya funcionan el `auto_return` y los webhooks de Mercado Pago (`/api/pagos/mercadopago/webhook`) y Stripe (`/api/pagos/stripe/webhook`).

**Opción B. Kubernetes administrado** (DigitalOcean DOKS, GKE, EKS, AKS): sube las imágenes a un registro (Docker Hub o GHCR), cambia `image:` en `k8s/`, ajusta el host del `06-ingress.yaml` y activa cert-manager.

---

## 5. Estructura

```
agroconnecta/
├── docker-compose.yml        ← db + api + web
├── iniciar.sh                ← arranque en Mac/Linux
├── .env.example
├── db/
│   ├── Dockerfile            ← postgres:16 + PostGIS (Intel y Apple Silicon)
│   └── init/                 ← se ejecutan la 1ª vez, en orden
│       ├── 00_roles.sh             roles: agro_admin, agro_owner, agro_app, agro_lectura
│       ├── 01_extensiones.sql      postgis, pgcrypto, citext, unaccent
│       ├── 02_esquema.sql          20 tablas
│       ├── 03_funciones_triggers.sql  login con bcrypt, reglas de negocio, HMAC, auditoría encadenada, vistas
│       ├── 04_seguridad_rls.sql    Row Level Security por tabla
│       ├── 05_permisos.sql         permisos por tabla y por columna
│       ├── 06_perfiles.sql         v2.1: perfiles públicos
│       └── 07_plan_negocio.sql     v3.0: plan de negocio (se aplica una vez)
├── backend/                  ← API REST Node.js + Express
│   └── src/
│       ├── server.js
│       ├── config/ (env, db)  middleware/ (auth)  utils/ (seguridad, http)
│       ├── services/ (imagenes, pagos)
│       ├── routes/ (auth, categorias, productos, imagenes, terrenos, pedidos, pagos, postventa, perfiles, tienda, admin)
│       └── scripts/ (seed, datos-seed, localizar-imagenes, prueba-e2e)
├── frontend/                 ← páginas HTML (mismos nombres que la versión 1)
│   ├── *.html  agro_data.js  Barra_Lateral.js
│   ├── js/ (api.js, municipios.js)  css/app.css  img/  vendor/ (fuentes, Leaflet)
│   ├── nginx.conf.template  Dockerfile
│   └── build/                ← solo para recompilar Tailwind (npm run css)
└── k8s/                      ← manifiestos de Kubernetes
```

---

## 6. Solución de problemas
- **Los celulares no abren la página:** confirma la IP con `ipconfig getifaddr en0` y que todos estén en la misma red. Prueba primero desde tu Mac con esa misma IP.
- **Cambiaste de red Wi-Fi:** vuelve a ejecutar `./iniciar.sh`; actualiza `PUBLIC_URL`.
- **Quiero empezar con la base limpia:** `docker compose down -v && ./iniciar.sh`.
- **Las fotos de ejemplo se ven como ilustraciones:** la API intenta descargar las fotos reales al arrancar. Si no había internet en ese momento, ejecuta `docker compose exec api npm run imagenes`.
- **Cambié clases de Tailwind en un HTML:** `cd frontend/build && npm install && npm run css`, y después `docker compose up -d --build web`.
