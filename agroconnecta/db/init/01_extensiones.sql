-- ============================================================
--  AgroConnecta — 01_extensiones.sql
--  PostgreSQL 16 + PostGIS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS postgis;     -- geometría / ubicaciones (terrenos, vendedores)
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- bcrypt, SHA-256, HMAC, bytes aleatorios
CREATE EXTENSION IF NOT EXISTS citext;      -- email sin distinguir mayúsculas
CREATE EXTENSION IF NOT EXISTS unaccent;    -- búsqueda sin acentos ("platano" encuentra "Plátano")

CREATE SCHEMA IF NOT EXISTS agro AUTHORIZATION agro_owner;
-- Esquema privado para secretos: solo el dueño lo puede leer
CREATE SCHEMA IF NOT EXISTS seguridad AUTHORIZATION agro_owner;
REVOKE ALL ON SCHEMA seguridad FROM PUBLIC;

-- Las extensiones están en "public"; el dueño necesita usarlas
GRANT USAGE ON SCHEMA public TO agro_owner, agro_app, agro_lectura;
