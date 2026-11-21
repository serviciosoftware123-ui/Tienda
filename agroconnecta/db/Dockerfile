# PostgreSQL 16 + PostGIS 3 (multi-arquitectura: Mac Intel, Mac Apple Silicon y Linux)
FROM postgres:16-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-postgis-3 \
 && rm -rf /var/lib/apt/lists/*

# Scripts que crean roles, esquema, triggers, RLS y permisos (solo la primera vez, con el volumen vacío)
COPY init/ /docker-entrypoint-initdb.d/
RUN chmod +x /docker-entrypoint-initdb.d/*.sh

# Las conexiones por red usan contraseña con hash SCRAM-SHA-256 (valor por defecto de PostgreSQL 16)
