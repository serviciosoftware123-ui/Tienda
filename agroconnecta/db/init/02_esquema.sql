-- ============================================================
--  AgroConnecta — 02_esquema.sql
--  Tablas del marketplace (migración Oracle 4.1 → PostgreSQL 16)
--
--  Equivalencias aplicadas:
--    RAW(16) + SYS_GUID()   → UUID + gen_random_uuid()
--    VARCHAR2 / CLOB        → VARCHAR / TEXT
--    NUMBER(p,s)            → NUMERIC(p,s)
--    TIMESTAMP SYSTIMESTAMP → TIMESTAMPTZ now()
--    MDSYS.SDO_GEOMETRY     → PostGIS geometry(Point, 4326)
--    NUMBER(1) 0/1          → BOOLEAN
--  Regla de negocio: SOFT DELETE (nunca DELETE; se cambia "estado").
-- ============================================================
SET ROLE agro_owner;
SET search_path = agro, public;

-- ─── Usuarios y perfiles ─────────────────────────────────────
CREATE TABLE usuario (
    id_usuario          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre              VARCHAR(100) NOT NULL,
    apellido            VARCHAR(100) NOT NULL,
    email               CITEXT       NOT NULL UNIQUE,
    password_hash       TEXT         NOT NULL,            -- bcrypt (pgcrypto crypt/gen_salt('bf'))
    telefono_cifrado    BYTEA,                            -- AES-256-GCM (cifrado en la API)
    tipo_usuario        VARCHAR(20)  NOT NULL
                        CHECK (tipo_usuario IN ('COMPRADOR','VENDEDOR','ADMINISTRADOR')),
    estado              VARCHAR(20)  NOT NULL DEFAULT 'ACTIVO'
                        CHECK (estado IN ('ACTIVO','INACTIVO','SUSPENDIDO')),
    intentos_fallidos   SMALLINT     NOT NULL DEFAULT 0,
    bloqueado_hasta     TIMESTAMPTZ,
    ultimo_login        TIMESTAMPTZ,
    fecha_registro      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    fecha_actualizacion TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT chk_email_formato CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

CREATE TABLE comprador (
    id_comprador        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_usuario          UUID NOT NULL UNIQUE REFERENCES usuario(id_usuario),
    direccion           VARCHAR(300),
    ciudad              VARCHAR(120),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vendedor (
    id_vendedor         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_usuario          UUID NOT NULL UNIQUE REFERENCES usuario(id_usuario),
    nombre_negocio      VARCHAR(200) NOT NULL,
    rfc_cifrado         BYTEA,                          -- AES-256-GCM
    rfc_hash            CHAR(64) UNIQUE,                -- HMAC-SHA256 (índice ciego para evitar RFC duplicados)
    descripcion         TEXT,
    ubicacion           VARCHAR(300),                   -- texto: "Cárdenas, Tabasco"
    geom                geometry(Point, 4326),          -- PostGIS
    verificado          BOOLEAN NOT NULL DEFAULT false,
    fecha_verificacion  TIMESTAMPTZ,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE administrador (
    id_admin            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_usuario          UUID NOT NULL UNIQUE REFERENCES usuario(id_usuario),
    nivel_acceso        VARCHAR(20) NOT NULL DEFAULT 'TOTAL'
                        CHECK (nivel_acceso IN ('BASICO','TOTAL')),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sesiones: se guarda SOLO el hash SHA-256 del token, nunca el token
CREATE TABLE sesion (
    id_sesion       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_usuario      UUID NOT NULL REFERENCES usuario(id_usuario),
    token_hash      CHAR(64) NOT NULL UNIQUE,
    ip_address      VARCHAR(64),
    user_agent      VARCHAR(500),
    fecha_inicio    TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_expira    TIMESTAMPTZ NOT NULL,
    ultimo_uso      TIMESTAMPTZ NOT NULL DEFAULT now(),
    activa          BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX idx_sesion_usuario ON sesion(id_usuario) WHERE activa;

CREATE TABLE score_agroconfianza (
    id_usuario          UUID PRIMARY KEY REFERENCES usuario(id_usuario),
    puntos              INTEGER NOT NULL DEFAULT 0,
    nivel               VARCHAR(10) NOT NULL DEFAULT 'BRONCE'
                        CHECK (nivel IN ('BRONCE','PLATA','ORO','PLATINO')),
    total_transacciones INTEGER NOT NULL DEFAULT 0,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Catálogo ────────────────────────────────────────────────
CREATE TABLE categoria (
    id_categoria        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre              VARCHAR(100) NOT NULL UNIQUE,
    tipo                VARCHAR(20)  NOT NULL
                        CHECK (tipo IN ('MAQUINARIA','CULTIVO','EQUIPO','TERRENO')),
    id_categoria_padre  UUID REFERENCES categoria(id_categoria),
    estado              VARCHAR(20) NOT NULL DEFAULT 'ACTIVO'
                        CHECK (estado IN ('ACTIVO','INACTIVO')),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE producto (
    id_producto         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_vendedor         UUID NOT NULL REFERENCES vendedor(id_vendedor),
    id_categoria        UUID NOT NULL REFERENCES categoria(id_categoria),
    nombre              VARCHAR(200) NOT NULL,
    descripcion         TEXT,
    precio              NUMERIC(12,2) NOT NULL CHECK (precio > 0),
    stock               NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (stock >= 0),
    unidad_medida       VARCHAR(30)  NOT NULL,
    moneda              CHAR(3)      NOT NULL DEFAULT 'MXN',
    estado              VARCHAR(20)  NOT NULL DEFAULT 'ACTIVO'
                        CHECK (estado IN ('ACTIVO','INACTIVO','AGOTADO')),
    ubicacion           VARCHAR(300),
    geom                geometry(Point, 4326),
    tags                TEXT[] NOT NULL DEFAULT '{}',
    fecha_publicacion   TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now(),
    modificado_por      UUID REFERENCES usuario(id_usuario)
);
CREATE INDEX idx_producto_vendedor  ON producto(id_vendedor);
CREATE INDEX idx_producto_categoria ON producto(id_categoria);
CREATE INDEX idx_producto_estado    ON producto(estado);
CREATE INDEX idx_producto_geom      ON producto USING GIST (geom);

CREATE TABLE producto_imagen (
    id_imagen       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_producto     UUID NOT NULL REFERENCES producto(id_producto),
    url             VARCHAR(500) NOT NULL,
    url_origen      VARCHAR(1000),                -- link pegado por el vendedor (se descarga al servidor)
    sha256          CHAR(64),                     -- huella del archivo (integridad / duplicados)
    origen          VARCHAR(10) NOT NULL DEFAULT 'SUBIDA' CHECK (origen IN ('SUBIDA','URL','SEED')),
    es_principal    BOOLEAN NOT NULL DEFAULT false,
    orden           SMALLINT NOT NULL DEFAULT 1,
    fecha_creacion  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_prodimg_producto ON producto_imagen(id_producto);
CREATE UNIQUE INDEX uq_prodimg_principal ON producto_imagen(id_producto) WHERE es_principal;

CREATE TABLE terreno (
    id_terreno          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_vendedor         UUID NOT NULL REFERENCES vendedor(id_vendedor),
    titulo              VARCHAR(300) NOT NULL,
    descripcion         TEXT,
    superficie_ha       NUMERIC(10,2) NOT NULL CHECK (superficie_ha > 0),
    ubicacion           VARCHAR(300) NOT NULL,
    geom                geometry(Point, 4326) NOT NULL,     -- PostGIS (antes SDO_GEOMETRY)
    poligono            geometry(Polygon, 4326),            -- opcional: contorno del terreno
    precio              NUMERIC(14,2) NOT NULL CHECK (precio > 0),
    moneda              CHAR(3) NOT NULL DEFAULT 'MXN',
    tipo_operacion      VARCHAR(20) NOT NULL CHECK (tipo_operacion IN ('VENTA','ARRENDAMIENTO')),
    estado              VARCHAR(20) NOT NULL DEFAULT 'DISPONIBLE'
                        CHECK (estado IN ('DISPONIBLE','VENDIDO','ARRENDADO','INACTIVO')),
    tags                TEXT[] NOT NULL DEFAULT '{}',
    fecha_publicacion   TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now(),
    modificado_por      UUID REFERENCES usuario(id_usuario)
);
CREATE INDEX idx_terreno_geom     ON terreno USING GIST (geom);
CREATE INDEX idx_terreno_vendedor ON terreno(id_vendedor);

CREATE TABLE terreno_imagen (
    id_imagen       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_terreno      UUID NOT NULL REFERENCES terreno(id_terreno),
    url             VARCHAR(500) NOT NULL,
    url_origen      VARCHAR(1000),
    sha256          CHAR(64),
    origen          VARCHAR(10) NOT NULL DEFAULT 'SUBIDA' CHECK (origen IN ('SUBIDA','URL','SEED')),
    es_principal    BOOLEAN NOT NULL DEFAULT false,
    orden           SMALLINT NOT NULL DEFAULT 1,
    fecha_creacion  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_terrimg_principal ON terreno_imagen(id_terreno) WHERE es_principal;

-- ─── Pedidos (un pedido por vendedor; varios pedidos = un "grupo de compra") ─
CREATE TABLE pedido (
    id_pedido           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    folio               BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 1001) UNIQUE,
    grupo_compra        UUID NOT NULL,                  -- todos los pedidos de un mismo checkout
    id_comprador        UUID NOT NULL REFERENCES comprador(id_comprador),
    id_vendedor         UUID NOT NULL REFERENCES vendedor(id_vendedor),
    subtotal            NUMERIC(14,2) NOT NULL DEFAULT 0,
    impuestos_iva       NUMERIC(14,2) NOT NULL DEFAULT 0,
    costo_envio         NUMERIC(10,2) NOT NULL DEFAULT 0,
    total               NUMERIC(14,2) NOT NULL DEFAULT 0,
    estado              VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE'
                        CHECK (estado IN ('PENDIENTE','CONFIRMADO','EN_CAMINO','ENTREGADO','CANCELADO','DEVUELTO')),
    modalidad_entrega   VARCHAR(20) NOT NULL CHECK (modalidad_entrega IN ('ENVIO','RECOLECCION')),
    direccion_entrega   VARCHAR(300),
    notas               VARCHAR(500),
    hash_integridad     CHAR(64),                       -- HMAC-SHA256 de los montos
    fecha_pedido        TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now(),
    modificado_por      UUID REFERENCES usuario(id_usuario)
);
CREATE INDEX idx_pedido_comprador ON pedido(id_comprador, fecha_pedido DESC);
CREATE INDEX idx_pedido_vendedor  ON pedido(id_vendedor,  fecha_pedido DESC);
CREATE INDEX idx_pedido_grupo     ON pedido(grupo_compra);

CREATE TABLE detalle_pedido (
    id_detalle          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_pedido           UUID NOT NULL REFERENCES pedido(id_pedido),
    id_producto         UUID NOT NULL REFERENCES producto(id_producto),
    nombre_producto     VARCHAR(200),                   -- copia histórica
    cantidad            NUMERIC(12,2) NOT NULL CHECK (cantidad > 0),
    precio_unitario     NUMERIC(12,2) NOT NULL CHECK (precio_unitario > 0),  -- lo fija el trigger con el precio real
    subtotal            NUMERIC(14,2) NOT NULL,
    hash_integridad     CHAR(64)
);
CREATE INDEX idx_detalle_pedido ON detalle_pedido(id_pedido);

CREATE TABLE envio (
    id_envio            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_pedido           UUID NOT NULL UNIQUE REFERENCES pedido(id_pedido),
    modalidad           VARCHAR(20) NOT NULL CHECK (modalidad IN ('ENVIO','RECOLECCION')),
    estado              VARCHAR(25) NOT NULL DEFAULT 'PREPARANDO'
                        CHECK (estado IN ('PREPARANDO','EN_TRANSITO','LISTO_RECOLECCION','ENTREGADO','CANCELADO','DEVUELTO')),
    transportista       VARCHAR(120),
    numero_guia         VARCHAR(120),
    fecha_estimada      DATE,
    fecha_entrega       TIMESTAMPTZ,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE historial_envio (
    id_historial    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_envio        UUID NOT NULL REFERENCES envio(id_envio),
    estado_anterior VARCHAR(25),
    estado_nuevo    VARCHAR(25) NOT NULL,
    descripcion     VARCHAR(300),
    fecha_cambio    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_historial_envio ON historial_envio(id_envio, fecha_cambio);

CREATE TABLE pago (
    id_pago             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_pedido           UUID NOT NULL REFERENCES pedido(id_pedido),
    metodo              VARCHAR(20) NOT NULL
                        CHECK (metodo IN ('EFECTIVO','SIMULADO','STRIPE','MERCADOPAGO','FINANCIAMIENTO')),
    monto               NUMERIC(14,2) NOT NULL DEFAULT 0,
    moneda              CHAR(3) NOT NULL DEFAULT 'MXN',
    estado              VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE'
                        CHECK (estado IN ('PENDIENTE','APROBADO','RECHAZADO','CANCELADO','REEMBOLSADO')),
    proveedor_ref       VARCHAR(200),                   -- id de sesión Stripe / preferencia MP
    referencia          VARCHAR(200),                   -- id del cobro confirmado
    fecha_pago          TIMESTAMPTZ,
    hash_integridad     CHAR(64),
    fecha_creacion      TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pago_pedido ON pago(id_pedido);
CREATE INDEX idx_pago_ref    ON pago(proveedor_ref);

CREATE TABLE calificacion (
    id_calificacion UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_pedido       UUID NOT NULL UNIQUE REFERENCES pedido(id_pedido),   -- una por pedido
    id_comprador    UUID NOT NULL REFERENCES comprador(id_comprador),
    id_vendedor     UUID NOT NULL REFERENCES vendedor(id_vendedor),
    puntuacion      SMALLINT NOT NULL CHECK (puntuacion BETWEEN 1 AND 5),
    comentario      TEXT,
    fecha           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_calificacion_vendedor ON calificacion(id_vendedor, fecha DESC);

CREATE TABLE devolucion (
    id_devolucion       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_pedido           UUID NOT NULL UNIQUE REFERENCES pedido(id_pedido),
    id_comprador        UUID NOT NULL REFERENCES comprador(id_comprador),
    motivo              TEXT NOT NULL,
    evidencia_url       VARCHAR(500),
    estado              VARCHAR(20) NOT NULL DEFAULT 'SOLICITADA'
                        CHECK (estado IN ('SOLICITADA','EN_REVISION','APROBADA','RECHAZADA','RESUELTA')),
    resolucion          TEXT,
    id_admin            UUID REFERENCES administrador(id_admin),
    fecha_solicitud     TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_resolucion    TIMESTAMPTZ,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE financiamiento (
    id_financiamiento   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_comprador        UUID NOT NULL REFERENCES comprador(id_comprador),
    id_pedido           UUID NOT NULL UNIQUE REFERENCES pedido(id_pedido),
    monto_total         NUMERIC(14,2) NOT NULL CHECK (monto_total > 0),
    num_plazos          SMALLINT NOT NULL CHECK (num_plazos BETWEEN 1 AND 36),
    tasa_mensual        NUMERIC(5,4) NOT NULL DEFAULT 0.0150,     -- 1.5 % mensual (simple)
    monto_plazo         NUMERIC(14,2) NOT NULL DEFAULT 0,
    plazos_pagados      SMALLINT NOT NULL DEFAULT 0,
    estado              VARCHAR(20) NOT NULL DEFAULT 'ACTIVO'
                        CHECK (estado IN ('ACTIVO','PAGADO','VENCIDO','CANCELADO')),
    fecha_inicio        TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Auditoría con cadena de hashes (tipo blockchain) ─────────
CREATE TABLE log_cambios (
    id_log          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tabla_afectada  VARCHAR(60) NOT NULL,
    operacion       VARCHAR(10) NOT NULL CHECK (operacion IN ('INSERT','UPDATE','DELETE')),
    id_registro     TEXT,
    datos_anteriores JSONB,
    datos_nuevos     JSONB,
    usuario_app     UUID,                 -- quién lo hizo en la página (app.user_id)
    rol_app         VARCHAR(20),
    usuario_bd      TEXT NOT NULL DEFAULT current_user,
    fecha           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    hash_anterior   CHAR(64) NOT NULL,
    hash_actual     CHAR(64) NOT NULL
);
CREATE INDEX idx_log_tabla ON log_cambios(tabla_afectada, fecha DESC);

-- ─── Secretos (solo legibles por agro_owner) ──────────────────
CREATE TABLE seguridad.clave (
    nombre  VARCHAR(40) PRIMARY KEY,
    valor   BYTEA NOT NULL,
    creada  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Clave HMAC aleatoria de 256 bits para los hashes de integridad
INSERT INTO seguridad.clave(nombre, valor) VALUES ('integridad', gen_random_bytes(32));

RESET ROLE;
