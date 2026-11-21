#!/usr/bin/env bash
# ============================================================
#  AgroConnecta — arranque para la prueba piloto (macOS / Linux)
#  1. Crea .env con contraseñas aleatorias (solo la primera vez)
#  2. Detecta tu IP en la red Wi-Fi para que tus compañeros entren desde el celular
#  3. Construye y levanta los contenedores
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker no está corriendo. Abre Docker Desktop y vuelve a intentar."; exit 1
fi

# ── IP local (Wi-Fi en Mac = en0; si no, en1; en Linux hostname -I) ──
IP=""
if command -v ipconfig >/dev/null 2>&1; then
  IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
  [ -z "$IP" ] && IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
fi
[ -z "$IP" ] && IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[ -z "$IP" ] && IP="localhost"

PUERTO="${WEB_PORT:-8080}"

if [ ! -f .env ]; then
  echo "🔐 Generando .env con llaves aleatorias…"
  rnd() { openssl rand -hex "$1"; }
  cat > .env <<EOF
DB_ADMIN_USER=agro_admin
DB_ADMIN_PASSWORD=$(rnd 16)
DB_APP_PASSWORD=$(rnd 16)
DB_READONLY_PASSWORD=$(rnd 16)
JWT_SECRET=$(rnd 48)
DATA_ENCRYPTION_KEY=$(rnd 32)
PUBLIC_URL=http://${IP}:${PUERTO}
WEB_PORT=${PUERTO}
SEED_ADMIN_EMAIL=admin@agroconnecta.mx
SEED_ADMIN_PASSWORD=AgroAdmin#2026
SEED_DEMO_PASSWORD=Demo#2026
PAGO_SIMULADO=true
VERSION_AVISO=2026-11
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
MP_ACCESS_TOKEN=
EOF
  echo "   Guarda bien el archivo .env: sin él no se pueden descifrar teléfonos ni RFC."
else
  # Si cambiaste de red, actualiza la URL pública
  if grep -q '^PUBLIC_URL=http://[0-9.]*:' .env && [ "$IP" != "localhost" ]; then
    sed -i.bak "s#^PUBLIC_URL=http://[0-9.]*:[0-9]*#PUBLIC_URL=http://${IP}:${PUERTO}#" .env && rm -f .env.bak
  fi
fi

echo "🐳 Construyendo imágenes (la primera vez tarda unos minutos)…"
docker compose build

# 1) Primero solo la base de datos
docker compose up -d db
echo -n "⏳ Esperando a PostgreSQL"
for _ in $(seq 1 60); do
  if docker compose exec -T db sh -c 'pg_isready -q -h 127.0.0.1 -U "$POSTGRES_USER" -d agroconnecta' >/dev/null 2>&1; then break; fi
  echo -n "."; sleep 2
done
echo

# 2) Actualizaciones de la base (scripts 06 en adelante) ANTES de arrancar la API.
#    Cada script queda anotado en agro.migracion y NO se vuelve a aplicar.
echo "🗄  Revisando actualizaciones de la base de datos…"
docker compose exec -T db sh -c 'for f in /docker-entrypoint-initdb.d/0[6-9]*.sql /docker-entrypoint-initdb.d/[1-9][0-9]*.sql; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  ya=$(psql -tAq -U "$POSTGRES_USER" -d agroconnecta -c "SELECT 1 FROM agro.migracion WHERE nombre = '"'"'$n'"'"'" 2>/dev/null || true)
  if [ "$ya" = "1" ]; then echo "   · $n (ya aplicado)"; continue; fi
  psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d agroconnecta -f "$f" && echo "   ✔ $n aplicado"
done'

# 3) API y página web
echo "🚀 Levantando la API y la página…"
if ! docker compose up -d; then
  echo "❌ La API no arrancó. Últimas líneas de su registro:"
  docker compose logs api --tail 40
  echo "Copia ese texto para revisar el error."
  exit 1
fi

echo -n "⏳ Esperando a que la página responda"
for _ in $(seq 1 60); do
  if curl -fs "http://localhost:${PUERTO}/api/health" >/dev/null 2>&1; then break; fi
  echo -n "."; sleep 2
done
echo

URL="http://${IP}:${PUERTO}"
echo "============================================================"
echo "✅ AgroConnecta está corriendo"
echo "   En esta Mac:            http://localhost:${PUERTO}"
echo "   Celulares (misma Wi-Fi): ${URL}"
echo "------------------------------------------------------------"
echo "   Admin:      admin@agroconnecta.mx / AgroAdmin#2026"
echo "   Productores: platanos@ (Premium) · campodulce@ · maquiagro@agroconnecta.mx / Demo#2026"
echo "   Acopiador:   acopio@agroconnecta.mx · En revisión: huerta@agroconnecta.mx / Demo#2026"
echo "   Compradores: comprador1@ · comprador2@agroconnecta.mx / Demo#2026"
echo "   Tarjeta de prueba: 4242 4242 4242 4242 · SPEI: botón «Simular depósito»"
echo "   Código de alianza (mes Premium gratis): ALIANZA-TAB-2026"
echo "============================================================"
if command -v qrencode >/dev/null 2>&1; then
  qrencode -t ANSIUTF8 "$URL"
else
  echo "Tip: instala 'qrencode' (brew install qrencode) para mostrar un código QR aquí."
fi
