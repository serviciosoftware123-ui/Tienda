#!/bin/bash
# ============================================================
#  AgroConnecta — 00_roles.sh
#  Se ejecuta UNA sola vez, cuando el volumen de PostgreSQL está vacío.
#
#  Modelo de roles (principio de mínimo privilegio):
#    • POSTGRES_USER (agro_admin)  → el ÚNICO usuario que administra todo
#                                    (superusuario del contenedor).
#    • agro_owner   (NOLOGIN)      → dueño del esquema "agro" y de todos los
#                                    objetos. Nadie inicia sesión con él.
#    • agro_app     (LOGIN)        → usuario con el que se conecta la API.
#                                    Solo SELECT/INSERT/UPDATE donde se le
#                                    permite, sin DELETE, sin DDL y sujeto a
#                                    Row Level Security (RLS).
#    • agro_lectura (LOGIN)        → solo lectura de vistas (reportes/BI).
# ============================================================
set -euo pipefail

: "${APP_DB_PASSWORD:?Falta APP_DB_PASSWORD}"
: "${READONLY_DB_PASSWORD:?Falta READONLY_DB_PASSWORD}"

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_pass="$APP_DB_PASSWORD" \
     -v ro_pass="$READONLY_DB_PASSWORD" \
     -v db_name="$POSTGRES_DB" <<'EOSQL'
-- Contraseñas guardadas con SCRAM-SHA-256 (hash, nunca en texto plano)
SET password_encryption = 'scram-sha-256';

CREATE ROLE agro_owner NOLOGIN;
CREATE ROLE agro_app     LOGIN PASSWORD :'app_pass' CONNECTION LIMIT 40;
CREATE ROLE agro_lectura LOGIN PASSWORD :'ro_pass'  CONNECTION LIMIT 5;

-- Nadie (PUBLIC) puede crear objetos ni conectarse por defecto
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db_name" TO agro_app, agro_lectura;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Tiempo máximo por consulta / transacción inactiva para el usuario de la app
ALTER ROLE agro_app SET statement_timeout = '15s';
ALTER ROLE agro_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE agro_app     SET search_path = agro, public;
ALTER ROLE agro_lectura SET search_path = agro, public;
EOSQL

echo "✅ Roles de AgroConnecta creados"
