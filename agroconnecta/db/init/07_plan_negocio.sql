-- ============================================================
--  AgroConnecta — 07_plan_negocio.sql   (v3.0: plan de negocio)
--
--  Lleva a la base de datos lo que dice el plan de negocio:
--   • Comisión por venta: 4 % productor · 8 % acopiador (+ IVA de la comisión)
--   • IVA por categoría (0 % productos agrícolas / 16 % general)
--   • Pago en custodia: se libera 48 h después de confirmar la entrega
--   • SPEI como forma de pago y costo real de cada pasarela
--   • Flete con transportistas aliados: banderazo + $/km (PostGIS) + margen $60
--   • Membresía Premium $199/mes (1er mes gratis con código de alianza)
--   • Productor Verificado con documentos (INE, domicilio, parcela)
--   • Parcelas con superficie/cultivo y alerta de volumen anormal
--   • Perfil Acopiador y filtro «Directo del productor»
--   • Publicidad local ($800/mes), mediación de disputas, 2FA (TOTP)
--   • Indicadores del plan, finanzas del mes y Reporte AgroConfianza
--
--  En una instalación nueva corre solo; en una existente lo aplica
--  ./iniciar.sh UNA vez (queda anotado en la tabla agro.migracion).
-- ============================================================
\set ON_ERROR_STOP on
BEGIN;
SET ROLE agro_owner;
SET search_path = agro, public;

CREATE TABLE IF NOT EXISTS migracion (
    nombre      VARCHAR(80) PRIMARY KEY,
    aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ════════════════════════════════════════════════════════════
--  1. PARÁMETROS DEL NEGOCIO (los cambia el administrador)
-- ════════════════════════════════════════════════════════════
CREATE TABLE parametro (
    clave        VARCHAR(40) PRIMARY KEY,
    valor        NUMERIC(14,4),
    texto        VARCHAR(200),
    descripcion  VARCHAR(300) NOT NULL,
    grupo        VARCHAR(30)  NOT NULL DEFAULT 'GENERAL',
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO parametro(clave, valor, texto, descripcion, grupo) VALUES
 ('comision_productor', 0.04,   NULL, 'Comisión por venta concretada (productor)', 'COMISIONES'),
 ('comision_acopiador', 0.08,   NULL, 'Comisión por venta concretada (perfil Acopiador)', 'COMISIONES'),
 ('iva_general',        0.16,   NULL, 'IVA que se cobra sobre la comisión y servicios de la plataforma', 'COMISIONES'),
 ('membresia_precio',   199,    NULL, 'Membresía Premium por mes (MXN, antes de IVA)', 'PREMIUM'),
 ('membresia_dias',     30,     NULL, 'Días que dura cada mes de membresía', 'PREMIUM'),
 ('codigo_alianza',     NULL,   'ALIANZA-TAB-2026', 'Código que da el primer mes Premium gratis (productores que llegan por la alianza)', 'PREMIUM'),
 ('flete_banderazo',    100,    NULL, 'Flete: cargo base del transportista aliado (MXN)', 'LOGISTICA'),
 ('flete_tarifa_km',    10,     NULL, 'Flete: tarifa por kilómetro de ruta (MXN/km)', 'LOGISTICA'),
 ('flete_factor_ruta',  1.30,   NULL, 'Factor de ruta: km por carretera ≈ distancia en línea recta × factor', 'LOGISTICA'),
 ('flete_margen',       60,     NULL, 'Margen de la plataforma por gestionar cada flete (MXN)', 'LOGISTICA'),
 ('custodia_horas',     48,     NULL, 'Horas para liberar el pago después de confirmar la entrega', 'CUSTODIA'),
 ('autoconfirmar_dias', 7,      NULL, 'Días tras la entrega para darla por recibida si el comprador no confirma', 'CUSTODIA'),
 ('publicidad_precio',  800,    NULL, 'Cuota mensual por anunciante local (MXN)', 'PUBLICIDAD'),
 ('tarjeta_pct',        0.036,  NULL, 'Pasarela tarjeta (Stripe MX): porcentaje', 'PASARELA'),
 ('tarjeta_fijo',       3,      NULL, 'Pasarela tarjeta (Stripe MX): cargo fijo (MXN)', 'PASARELA'),
 ('mp_pct',             0.0349, NULL, 'Pasarela Mercado Pago: porcentaje', 'PASARELA'),
 ('mp_fijo',            0,      NULL, 'Pasarela Mercado Pago: cargo fijo (MXN)', 'PASARELA'),
 ('spei_fijo',          7,      NULL, 'SPEI (Stripe MX): cargo fijo por transferencia (MXN)', 'PASARELA'),
 ('clabe_plataforma',   NULL,   '646180000000000000', 'CLABE de cobro (DEMO del piloto, no es una cuenta real)', 'PASARELA'),
 ('costos_fijos_mes',   6408,   NULL, 'Costos fijos mensuales Fase 1 (plan financiero)', 'FINANZAS'),
 ('alerta_factor',      1.20,   NULL, 'Alerta de parcela: volumen publicado > producción anual esperada × factor', 'VERIFICACION');

CREATE FUNCTION fn_param(p_clave text) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = agro, public AS
$$ SELECT valor FROM parametro WHERE clave = p_clave $$;
CREATE FUNCTION fn_param_texto(p_clave text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = agro, public AS
$$ SELECT texto FROM parametro WHERE clave = p_clave $$;

-- ════════════════════════════════════════════════════════════
--  2. COLUMNAS NUEVAS EN TABLAS EXISTENTES
-- ════════════════════════════════════════════════════════════
-- IVA: tasa por categoría (0 % art. 2-A LIVA para agrícolas sin industrializar,
-- tractores para implementos y equipos de riego) y opcional por producto
ALTER TABLE categoria ADD COLUMN tasa_iva NUMERIC(4,3) NOT NULL DEFAULT 0.16 CHECK (tasa_iva IN (0, 0.16));
ALTER TABLE producto  ADD COLUMN tasa_iva NUMERIC(4,3) CHECK (tasa_iva IN (0, 0.16));      -- NULL = la de su categoría

UPDATE categoria SET tasa_iva = 0 WHERE tipo = 'CULTIVO' OR nombre ILIKE '%riego%';

-- Usuario: aviso de privacidad y verificación en dos pasos
ALTER TABLE usuario
    ADD COLUMN acepto_privacidad_en TIMESTAMPTZ,
    ADD COLUMN version_aviso        VARCHAR(20),
    ADD COLUMN totp_secreto_cifrado BYTEA,          -- AES-256-GCM (lo cifra la API)
    ADD COLUMN totp_activo          BOOLEAN NOT NULL DEFAULT false;

-- Vendedor: perfil, verificación con documentos y Premium
ALTER TABLE vendedor
    ADD COLUMN perfil              VARCHAR(12) NOT NULL DEFAULT 'PRODUCTOR' CHECK (perfil IN ('PRODUCTOR','ACOPIADOR')),
    ADD COLUMN verificacion_estado VARCHAR(15) NOT NULL DEFAULT 'SIN_DOCUMENTOS'
               CHECK (verificacion_estado IN ('SIN_DOCUMENTOS','EN_REVISION','VERIFICADO','RECHAZADO')),
    ADD COLUMN verificacion_nota   VARCHAR(500),
    ADD COLUMN premium_hasta       TIMESTAMPTZ,
    ADD COLUMN promo_usada         BOOLEAN NOT NULL DEFAULT false;
UPDATE vendedor SET verificacion_estado = 'VERIFICADO' WHERE verificado;

-- Comprador: punto de entrega habitual (para cotizar el flete con PostGIS)
ALTER TABLE comprador ADD COLUMN geom geometry(Point, 4326);

-- Pedido: comisión, neto al vendedor, flete y custodia del pago
ALTER TABLE pedido
    ADD COLUMN comision_pct        NUMERIC(5,4)  NOT NULL DEFAULT 0,
    ADD COLUMN comision_monto      NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN iva_comision        NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN neto_vendedor       NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN margen_logistica    NUMERIC(10,2) NOT NULL DEFAULT 0,
    ADD COLUMN distancia_km        NUMERIC(8,1),
    ADD COLUMN destino_geom        geometry(Point, 4326),
    ADD COLUMN custodia_estado     VARCHAR(12) NOT NULL DEFAULT 'SIN_PAGO'
               CHECK (custodia_estado IN ('SIN_PAGO','RETENIDO','LIBERADO','REEMBOLSADO','NO_APLICA')),
    ADD COLUMN recepcion_confirmada_en TIMESTAMPTZ,
    ADD COLUMN recepcion_automatica    BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN liberar_despues_de      TIMESTAMPTZ,
    ADD COLUMN custodia_liberada_en    TIMESTAMPTZ;
CREATE INDEX idx_pedido_custodia ON pedido(custodia_estado) WHERE custodia_estado = 'RETENIDO';

-- Detalle: IVA de cada renglón según su tasa
ALTER TABLE detalle_pedido
    ADD COLUMN tasa_iva  NUMERIC(4,3)  NOT NULL DEFAULT 0.16,
    ADD COLUMN iva_monto NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Pago: SPEI y costo de la pasarela
ALTER TABLE pago DROP CONSTRAINT IF EXISTS pago_metodo_check;
ALTER TABLE pago ADD CONSTRAINT pago_metodo_check
    CHECK (metodo IN ('EFECTIVO','SIMULADO','STRIPE','MERCADOPAGO','FINANCIAMIENTO','SPEI'));
ALTER TABLE pago ADD COLUMN comision_pasarela NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Devolución / disputa (mediación)
ALTER TABLE devolucion ADD COLUMN tipo VARCHAR(12) NOT NULL DEFAULT 'DEVOLUCION' CHECK (tipo IN ('DEVOLUCION','DISPUTA'));

-- ════════════════════════════════════════════════════════════
--  3. TABLAS NUEVAS
-- ════════════════════════════════════════════════════════════
-- Rendimientos de referencia (t/ha/año, valores aproximados del sureste; el admin los ajusta)
CREATE TABLE cultivo_referencia (
    cultivo            VARCHAR(60) PRIMARY KEY,
    rendimiento_t_ha   NUMERIC(8,2) NOT NULL CHECK (rendimiento_t_ha > 0),
    fuente             VARCHAR(200) NOT NULL DEFAULT 'Referencia aproximada para el piloto; validar con SIAP/SADER'
);
INSERT INTO cultivo_referencia(cultivo, rendimiento_t_ha) VALUES
 ('Plátano', 30), ('Mango', 10), ('Cacao', 0.6), ('Chile habanero', 15), ('Caña de azúcar', 70),
 ('Maíz', 3), ('Tomate', 40), ('Papaya', 50), ('Limón', 15), ('Piña', 45), ('Naranja', 14),
 ('Sandía', 30), ('Frijol', 0.9), ('Arroz', 4.5), ('Coco', 8), ('Palma de aceite', 15), ('Pimienta', 2);

CREATE TABLE parcela (
    id_parcela          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_vendedor         UUID NOT NULL REFERENCES vendedor(id_vendedor),
    nombre              VARCHAR(120) NOT NULL,
    municipio           VARCHAR(120) NOT NULL,
    superficie_ha       NUMERIC(10,2) NOT NULL CHECK (superficie_ha > 0 AND superficie_ha <= 5000),
    cultivo             VARCHAR(60) NOT NULL REFERENCES cultivo_referencia(cultivo),
    tenencia            VARCHAR(12) NOT NULL DEFAULT 'PROPIA' CHECK (tenencia IN ('PROPIA','EJIDAL','ARRENDADA','COMUNAL')),
    geom                geometry(Point, 4326),
    estado              VARCHAR(10) NOT NULL DEFAULT 'ACTIVA' CHECK (estado IN ('ACTIVA','INACTIVA')),
    fecha_registro      TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_parcela_vendedor ON parcela(id_vendedor);
ALTER TABLE producto ADD COLUMN id_parcela UUID REFERENCES parcela(id_parcela);

-- Documentos de verificación (el archivo se guarda CIFRADO fuera de /uploads)
CREATE TABLE documento_verificacion (
    id_documento    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_vendedor     UUID NOT NULL REFERENCES vendedor(id_vendedor),
    tipo            VARCHAR(25) NOT NULL CHECK (tipo IN ('INE','COMPROBANTE_DOMICILIO','DOCUMENTO_PARCELA')),
    nombre_original VARCHAR(200),
    ruta            VARCHAR(300) NOT NULL,       -- archivo cifrado con AES-256-GCM
    sha256          CHAR(64) NOT NULL,           -- huella del archivo original
    mime            VARCHAR(60) NOT NULL,
    tamano_bytes    INTEGER NOT NULL,
    estado          VARCHAR(12) NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','ACEPTADO','RECHAZADO','REEMPLAZADO')),
    nota            VARCHAR(300),
    fecha_carga     TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_revision  TIMESTAMPTZ
);
CREATE INDEX idx_doc_vendedor ON documento_verificacion(id_vendedor, tipo);

-- Alertas para el administrador (volumen anormal por parcela, etc.)
CREATE TABLE alerta (
    id_alerta     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo          VARCHAR(20) NOT NULL CHECK (tipo IN ('VOLUMEN_PARCELA','DISPUTA','CUSTODIA','SEGURIDAD')),
    id_vendedor   UUID REFERENCES vendedor(id_vendedor),
    id_referencia UUID,
    detalle       TEXT NOT NULL,
    estado        VARCHAR(10) NOT NULL DEFAULT 'ABIERTA' CHECK (estado IN ('ABIERTA','REVISADA','DESCARTADA')),
    fecha         TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_cierre  TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_alerta_abierta ON alerta(tipo, id_referencia) WHERE estado = 'ABIERTA';

-- Membresía Premium
CREATE TABLE membresia (
    id_membresia      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    folio             BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 7001) UNIQUE,
    id_vendedor       UUID NOT NULL REFERENCES vendedor(id_vendedor),
    metodo            VARCHAR(12) NOT NULL CHECK (metodo IN ('SIMULADO','STRIPE','MERCADOPAGO','SPEI','PROMOCION')),
    monto             NUMERIC(10,2) NOT NULL DEFAULT 0,            -- antes de IVA
    iva               NUMERIC(10,2) NOT NULL DEFAULT 0,
    total             NUMERIC(10,2) NOT NULL DEFAULT 0,
    comision_pasarela NUMERIC(10,2) NOT NULL DEFAULT 0,
    estado            VARCHAR(10) NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','PAGADA','RECHAZADA','CANCELADA')),
    proveedor_ref     VARCHAR(200),
    referencia        VARCHAR(200),
    periodo_inicio    TIMESTAMPTZ,
    periodo_fin       TIMESTAMPTZ,
    hash_integridad   CHAR(64),
    fecha_creacion    TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_membresia_vendedor ON membresia(id_vendedor, fecha_creacion DESC);

-- Transportistas aliados
CREATE TABLE transportista (
    id_transportista UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre           VARCHAR(150) NOT NULL,
    telefono         VARCHAR(20),
    zona             VARCHAR(200) NOT NULL,
    vehiculo         VARCHAR(120),
    capacidad_ton    NUMERIC(6,1),
    estado           VARCHAR(10) NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO','INACTIVO')),
    fecha_registro   TIMESTAMPTZ NOT NULL DEFAULT now(),
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE envio ADD COLUMN id_transportista UUID REFERENCES transportista(id_transportista);

-- Publicidad local
CREATE TABLE anunciante (
    id_anunciante  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre         VARCHAR(150) NOT NULL,
    giro           VARCHAR(60)  NOT NULL DEFAULT 'Insumos agrícolas',
    contacto       VARCHAR(150),
    mensaje        VARCHAR(160) NOT NULL,
    url            VARCHAR(500),
    imagen_url     VARCHAR(500),
    ubicacion      VARCHAR(10) NOT NULL DEFAULT 'AMBOS' CHECK (ubicacion IN ('INICIO','CATALOGO','AMBOS')),
    cuota_mensual  NUMERIC(10,2) NOT NULL DEFAULT 800,
    fecha_inicio   DATE NOT NULL DEFAULT current_date,
    fecha_fin      DATE NOT NULL DEFAULT (current_date + 30),
    estado         VARCHAR(10) NOT NULL DEFAULT 'ACTIVO' CHECK (estado IN ('ACTIVO','PAUSADO')),
    impresiones    INTEGER NOT NULL DEFAULT 0,
    clics          INTEGER NOT NULL DEFAULT 0,
    fecha_actualizacion TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (fecha_fin >= fecha_inicio)
);

-- Mensajes de mediación de una devolución o disputa
CREATE TABLE devolucion_mensaje (
    id_mensaje    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_devolucion UUID NOT NULL REFERENCES devolucion(id_devolucion),
    id_usuario    UUID NOT NULL REFERENCES usuario(id_usuario),
    rol           VARCHAR(20) NOT NULL,
    mensaje       TEXT NOT NULL CHECK (length(mensaje) BETWEEN 1 AND 2000),
    fecha         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_devmsg ON devolucion_mensaje(id_devolucion, fecha);

-- Reporte AgroConfianza (para presentar en una caja popular o financiera rural)
CREATE TABLE reporte_agroconfianza (
    id_reporte    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    folio         BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 50001) UNIQUE,
    id_vendedor   UUID NOT NULL REFERENCES vendedor(id_vendedor),
    datos         JSONB NOT NULL,
    sha256        CHAR(64) NOT NULL,            -- huella de los datos del reporte
    generado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
    valido_hasta  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '90 days'
);

-- Latidos de la API (disponibilidad de la plataforma)
CREATE TABLE latido (
    instante TIMESTAMPTZ PRIMARY KEY
);

-- ════════════════════════════════════════════════════════════
--  4. INTEGRIDAD (HMAC) — el pedido ahora firma también comisión y neto
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION hash_pedido(p pedido) RETURNS char(64) LANGUAGE sql STABLE AS $$
    SELECT seguridad.hmac_integridad(concat_ws('|', p.id_pedido, p.folio, p.grupo_compra, p.id_comprador,
           p.id_vendedor, p.subtotal, p.impuestos_iva, p.costo_envio, p.total,
           to_char(p.fecha_pedido AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
           p.comision_pct, p.comision_monto, p.iva_comision, p.neto_vendedor, p.margen_logistica))
$$;
CREATE FUNCTION hash_membresia(m membresia) RETURNS char(64) LANGUAGE sql STABLE AS $$
    SELECT seguridad.hmac_integridad(concat_ws('|', m.id_membresia, m.folio, m.id_vendedor, m.metodo,
           m.monto, m.iva, m.total))
$$;
CREATE FUNCTION trg_membresia_hash() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN NEW.hash_integridad := hash_membresia(NEW); RETURN NEW; END $$;

-- ════════════════════════════════════════════════════════════
--  5. REGLAS DE USUARIOS, VENDEDORES Y REGISTRO
-- ════════════════════════════════════════════════════════════
-- Registro v3: perfil (productor/acopiador) y aceptación del aviso de privacidad
CREATE FUNCTION fn_registrar_usuario_v3(
    p_nombre text, p_apellido text, p_email text, p_password text, p_tipo text,
    p_telefono_cifrado bytea, p_nombre_negocio text, p_rfc_cifrado bytea, p_rfc_hash text,
    p_ubicacion text, p_lat double precision, p_lng double precision,
    p_direccion text, p_ciudad text, p_descripcion text,
    p_perfil text, p_version_aviso text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_id uuid;
BEGIN
    IF coalesce(p_version_aviso, '') = '' THEN
        RAISE EXCEPTION 'Debes aceptar el aviso de privacidad y los términos para registrarte' USING ERRCODE = '22023';
    END IF;
    IF p_tipo = 'VENDEDOR' AND coalesce(p_perfil, 'PRODUCTOR') NOT IN ('PRODUCTOR','ACOPIADOR') THEN
        RAISE EXCEPTION 'Perfil de vendedor inválido' USING ERRCODE = '22023';
    END IF;
    v_id := fn_registrar_usuario(p_nombre, p_apellido, p_email, p_password, p_tipo, p_telefono_cifrado,
                                 p_nombre_negocio, p_rfc_cifrado, p_rfc_hash, p_ubicacion, p_lat, p_lng,
                                 p_direccion, p_ciudad, p_descripcion);
    UPDATE usuario SET acepto_privacidad_en = now(), version_aviso = left(p_version_aviso, 20) WHERE id_usuario = v_id;
    IF p_tipo = 'VENDEDOR' THEN
        PERFORM set_config('agro.sistema_vendedor', 'on', true);
        UPDATE vendedor SET perfil = coalesce(p_perfil, 'PRODUCTOR') WHERE id_usuario = v_id;
        PERFORM set_config('agro.sistema_vendedor', 'off', true);
    ELSIF p_tipo = 'COMPRADOR' AND p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
        UPDATE comprador SET geom = ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326) WHERE id_usuario = v_id;
    END IF;
    RETURN v_id;
END $$;

-- Verificación: el vendedor no se auto-verifica, no cambia su perfil ni su Premium
CREATE OR REPLACE FUNCTION trg_vendedor_verificacion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_sistema boolean := coalesce(current_setting('agro.sistema_vendedor', true), 'off') = 'on';
BEGIN
    IF NEW.perfil IS DISTINCT FROM OLD.perfil AND NOT (es_admin() OR v_sistema) THEN
        RAISE EXCEPTION 'Solo un administrador cambia el perfil (productor/acopiador)' USING ERRCODE = '42501';
    END IF;
    IF (NEW.premium_hasta, NEW.promo_usada) IS DISTINCT FROM (OLD.premium_hasta, OLD.promo_usada)
       AND NOT (es_admin() OR v_sistema) THEN
        RAISE EXCEPTION 'La membresía solo cambia al pagarla' USING ERRCODE = '42501';
    END IF;
    IF NEW.verificacion_estado IS DISTINCT FROM OLD.verificacion_estado THEN
        IF NEW.verificacion_estado IN ('VERIFICADO','RECHAZADO') AND NOT es_admin() THEN
            RAISE EXCEPTION 'Solo un administrador verifica productores' USING ERRCODE = '42501';
        END IF;
        IF NEW.verificacion_estado IN ('EN_REVISION','SIN_DOCUMENTOS') AND NOT (es_admin() OR v_sistema) THEN
            RAISE EXCEPTION 'Estado de verificación inválido' USING ERRCODE = '42501';
        END IF;
        NEW.verificado := NEW.verificacion_estado = 'VERIFICADO';
    ELSIF NEW.verificado IS DISTINCT FROM OLD.verificado THEN
        IF NOT es_admin() THEN
            RAISE EXCEPTION 'Solo un administrador puede verificar vendedores' USING ERRCODE = '42501';
        END IF;
        NEW.verificacion_estado := CASE WHEN NEW.verificado THEN 'VERIFICADO' ELSE 'EN_REVISION' END;
    END IF;
    IF NEW.verificado IS DISTINCT FROM OLD.verificado THEN
        NEW.fecha_verificacion := CASE WHEN NEW.verificado THEN now() ELSE NULL END;
    END IF;
    RETURN NEW;
END $$;

-- El vendedor envía sus documentos a revisión
CREATE FUNCTION fn_verificacion_enviar() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_faltan text;
BEGIN
    IF app_role() <> 'VENDEDOR' THEN RAISE EXCEPTION 'Solo vendedores' USING ERRCODE = '42501'; END IF;
    SELECT string_agg(t, ', ') INTO v_faltan
      FROM unnest(ARRAY['INE','COMPROBANTE_DOMICILIO','DOCUMENTO_PARCELA']) t
     WHERE NOT EXISTS (SELECT 1 FROM documento_verificacion d WHERE d.id_vendedor = app_rol_id()
                         AND d.tipo = t AND d.estado IN ('PENDIENTE','ACEPTADO'));
    IF v_faltan IS NOT NULL THEN
        RAISE EXCEPTION 'Faltan documentos: %', replace(v_faltan, '_', ' ') USING ERRCODE = 'P0001';
    END IF;
    PERFORM set_config('agro.sistema_vendedor', 'on', true);
    UPDATE vendedor SET verificacion_estado = 'EN_REVISION', verificacion_nota = NULL
     WHERE id_vendedor = app_rol_id() AND verificacion_estado IN ('SIN_DOCUMENTOS','RECHAZADO');
    PERFORM set_config('agro.sistema_vendedor', 'off', true);
    RETURN (SELECT verificacion_estado FROM vendedor WHERE id_vendedor = app_rol_id());
END $$;

-- Un documento nuevo del mismo tipo reemplaza al anterior pendiente/rechazado
CREATE FUNCTION trg_documento_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    NEW.estado := 'PENDIENTE';
    NEW.fecha_carga := now();
    UPDATE documento_verificacion SET estado = 'REEMPLAZADO'
     WHERE id_vendedor = NEW.id_vendedor AND tipo = NEW.tipo AND estado IN ('PENDIENTE','RECHAZADO');
    RETURN NEW;
END $$;
CREATE TRIGGER documento_insert BEFORE INSERT ON documento_verificacion
    FOR EACH ROW EXECUTE FUNCTION trg_documento_insert();

-- Contacto oculto: solo después de un pedido formal con ese vendedor (o admin / el propio vendedor)
CREATE OR REPLACE FUNCTION fn_contacto_vendedor(p_id_vendedor uuid)
RETURNS TABLE(nombre text, email text, telefono_cifrado bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
#variable_conflict use_column
BEGIN
    IF app_user_id() IS NULL THEN
        RAISE EXCEPTION 'Inicia sesión para ver el contacto' USING ERRCODE = '42501';
    END IF;
    IF NOT (es_admin()
            OR (app_role() = 'VENDEDOR' AND app_rol_id() = p_id_vendedor)
            OR (app_role() = 'COMPRADOR' AND EXISTS (
                  SELECT 1 FROM pedido p WHERE p.id_vendedor = p_id_vendedor AND p.id_comprador = app_rol_id()
                     AND p.estado <> 'CANCELADO'))) THEN
        RAISE EXCEPTION 'El teléfono y la dirección se muestran después de hacer un pedido con este vendedor'
            USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
        SELECT (u.nombre || ' ' || u.apellido)::text, u.email::text, u.telefono_cifrado
        FROM vendedor v JOIN usuario u ON u.id_usuario = v.id_usuario
        WHERE v.id_vendedor = p_id_vendedor AND u.estado = 'ACTIVO';
END $$;

-- Terrenos: AgroConnecta solo conecta a las partes (la compraventa se formaliza ante notario),
-- así que el contacto del dueño se muestra a cualquier usuario con sesión
CREATE FUNCTION fn_contacto_terreno(p_id_terreno uuid)
RETURNS TABLE(nombre text, email text, telefono_cifrado bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
#variable_conflict use_column
BEGIN
    IF app_user_id() IS NULL THEN
        RAISE EXCEPTION 'Inicia sesión para ver el contacto' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
        SELECT (u.nombre || ' ' || u.apellido)::text, u.email::text, u.telefono_cifrado
        FROM terreno t JOIN vendedor v ON v.id_vendedor = t.id_vendedor JOIN usuario u ON u.id_usuario = v.id_usuario
        WHERE t.id_terreno = p_id_terreno AND t.estado <> 'INACTIVO' AND u.estado = 'ACTIVO';
END $$;

-- Desbloquear una cuenta bloqueada por intentos fallidos
CREATE FUNCTION fn_desbloquear_usuario(p_id_usuario uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    IF NOT es_admin() THEN RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501'; END IF;
    UPDATE usuario SET bloqueado_hasta = NULL, intentos_fallidos = 0 WHERE id_usuario = p_id_usuario;
END $$;

-- ─── Verificación en dos pasos (TOTP) ───
DROP FUNCTION fn_auth_login(text, text);
CREATE FUNCTION fn_auth_login(p_email text, p_password text)
RETURNS TABLE(resultado text, id_usuario uuid, nombre text, apellido text, email text,
              tipo_usuario text, id_rol uuid, totp_activo boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
#variable_conflict use_column
DECLARE
    u usuario%ROWTYPE;
BEGIN
    SELECT * INTO u FROM usuario WHERE usuario.email = lower(trim(p_email));
    IF NOT FOUND THEN
        PERFORM crypt(p_password, gen_salt('bf', 11));   -- mismo tiempo de respuesta (evita enumerar correos)
        RETURN QUERY SELECT 'CREDENCIALES'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, false;
        RETURN;
    END IF;
    IF u.bloqueado_hasta IS NOT NULL AND u.bloqueado_hasta > now() THEN
        RETURN QUERY SELECT 'BLOQUEADO'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, false;
        RETURN;
    END IF;
    IF crypt(p_password, u.password_hash) <> u.password_hash THEN
        UPDATE usuario SET
            intentos_fallidos = CASE WHEN u.intentos_fallidos + 1 >= 5 THEN 0 ELSE u.intentos_fallidos + 1 END,
            bloqueado_hasta   = CASE WHEN u.intentos_fallidos + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END
        WHERE usuario.id_usuario = u.id_usuario;
        RETURN QUERY SELECT 'CREDENCIALES'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, false;
        RETURN;
    END IF;
    IF u.estado <> 'ACTIVO' THEN
        RETURN QUERY SELECT u.estado::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid, false;
        RETURN;
    END IF;
    -- Con 2FA el último inicio se registra hasta validar el código
    UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL,
                       ultimo_login = CASE WHEN u.totp_activo THEN ultimo_login ELSE now() END
    WHERE usuario.id_usuario = u.id_usuario;
    RETURN QUERY SELECT 'OK'::text, u.id_usuario, u.nombre::text, u.apellido::text, u.email::text,
                        u.tipo_usuario::text, fn_id_rol(u.id_usuario, u.tipo_usuario), u.totp_activo;
END $$;

-- Código 2FA incorrecto: cuenta como intento fallido (5 → bloqueo 15 min)
CREATE FUNCTION fn_totp_fallo(p_id_usuario uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE u usuario%ROWTYPE;
BEGIN
    SELECT * INTO u FROM usuario WHERE id_usuario = p_id_usuario;
    UPDATE usuario SET
        intentos_fallidos = CASE WHEN u.intentos_fallidos + 1 >= 5 THEN 0 ELSE u.intentos_fallidos + 1 END,
        bloqueado_hasta   = CASE WHEN u.intentos_fallidos + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END
    WHERE id_usuario = p_id_usuario;
    RETURN u.intentos_fallidos + 1 >= 5;
END $$;
CREATE FUNCTION fn_totp_exito(p_id_usuario uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = agro, public AS $$
    UPDATE usuario SET intentos_fallidos = 0, ultimo_login = now() WHERE id_usuario = p_id_usuario;
$$;
-- Secreto cifrado (solo lo usa la API durante el inicio de sesión)
CREATE FUNCTION fn_totp_secreto(p_id_usuario uuid) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
    SELECT totp_secreto_cifrado FROM usuario WHERE id_usuario = p_id_usuario AND estado = 'ACTIVO'
$$;
CREATE FUNCTION fn_totp_configurar(p_secreto bytea, p_activar boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    IF app_user_id() IS NULL THEN RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501'; END IF;
    IF app_role() = 'COMPRADOR' THEN
        RAISE EXCEPTION 'La verificación en dos pasos es para administradores y vendedores' USING ERRCODE = '42501';
    END IF;
    UPDATE usuario SET totp_secreto_cifrado = p_secreto, totp_activo = p_activar AND p_secreto IS NOT NULL
     WHERE id_usuario = app_user_id();
END $$;

-- ════════════════════════════════════════════════════════════
--  6. PARCELAS Y ALERTA DE VOLUMEN
-- ════════════════════════════════════════════════════════════
-- Toneladas de un producto según su unidad (kg y toneladas; otras unidades no cuentan)
CREATE FUNCTION fn_a_toneladas(p_cantidad numeric, p_unidad text) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE lower(trim(p_unidad))
             WHEN 'kg' THEN p_cantidad / 1000 WHEN 'kilo' THEN p_cantidad / 1000 WHEN 'kilogramo' THEN p_cantidad / 1000
             WHEN 'tonelada' THEN p_cantidad WHEN 'ton' THEN p_cantidad WHEN 't' THEN p_cantidad
             ELSE NULL END
$$;

-- Si lo publicado + vendido en 12 meses supera la producción anual esperada × factor → alerta
CREATE FUNCTION fn_revisar_parcela(p_id_parcela uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE
    v_par      parcela%ROWTYPE;
    v_rend     numeric;
    v_esperado numeric;
    v_volumen  numeric;
BEGIN
    IF p_id_parcela IS NULL THEN RETURN; END IF;
    SELECT * INTO v_par FROM parcela WHERE id_parcela = p_id_parcela;
    IF NOT FOUND THEN RETURN; END IF;
    SELECT rendimiento_t_ha INTO v_rend FROM cultivo_referencia WHERE cultivo = v_par.cultivo;
    v_esperado := v_par.superficie_ha * v_rend * coalesce(fn_param('alerta_factor'), 1.2);
    SELECT coalesce(sum(fn_a_toneladas(p.stock, p.unidad_medida)), 0)
         + coalesce((SELECT sum(fn_a_toneladas(d.cantidad, pr.unidad_medida))
                       FROM detalle_pedido d JOIN pedido pe ON pe.id_pedido = d.id_pedido
                       JOIN producto pr ON pr.id_producto = d.id_producto
                      WHERE pr.id_parcela = p_id_parcela AND pe.estado NOT IN ('CANCELADO','DEVUELTO')
                        AND pe.fecha_pedido > now() - interval '365 days'), 0)
      INTO v_volumen
      FROM producto p WHERE p.id_parcela = p_id_parcela AND p.estado <> 'INACTIVO';
    IF v_volumen > v_esperado THEN
        INSERT INTO alerta(tipo, id_vendedor, id_referencia, detalle)
        VALUES ('VOLUMEN_PARCELA', v_par.id_vendedor, p_id_parcela,
                format('La parcela «%s» (%s ha de %s) publica %s t, pero produce ~%s t al año (%s t/ha). Revisar si hay intermediación.',
                       v_par.nombre, v_par.superficie_ha, v_par.cultivo, round(v_volumen, 1),
                       round(v_par.superficie_ha * v_rend, 1), v_rend))
        ON CONFLICT (tipo, id_referencia) WHERE estado = 'ABIERTA'
        DO UPDATE SET detalle = EXCLUDED.detalle, fecha = now();
    END IF;
END $$;

-- Reglas del producto: productores publican cultivos ligados a una parcela propia
CREATE FUNCTION trg_producto_parcela() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE
    v_tipo   text;
    v_perfil text;
BEGIN
    SELECT tipo INTO v_tipo FROM categoria WHERE id_categoria = NEW.id_categoria;
    SELECT perfil INTO v_perfil FROM vendedor WHERE id_vendedor = NEW.id_vendedor;
    IF NEW.id_parcela IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM parcela WHERE id_parcela = NEW.id_parcela AND id_vendedor = NEW.id_vendedor AND estado = 'ACTIVA') THEN
        RAISE EXCEPTION 'La parcela no existe o no es tuya' USING ERRCODE = 'P0001';
    END IF;
    IF v_tipo = 'CULTIVO' AND v_perfil = 'PRODUCTOR' AND NEW.id_parcela IS NULL
       AND NEW.estado <> 'INACTIVO' AND NOT es_admin() THEN
        RAISE EXCEPTION 'Indica de qué parcela sale este producto (Mi Tienda → Parcelas)' USING ERRCODE = 'P0001';
    END IF;
    IF v_tipo <> 'CULTIVO' THEN NEW.id_parcela := NULL; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER producto_b_parcela BEFORE INSERT OR UPDATE OF id_parcela, id_categoria, estado ON producto
    FOR EACH ROW EXECUTE FUNCTION trg_producto_parcela();

CREATE FUNCTION trg_producto_revisar_volumen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    PERFORM fn_revisar_parcela(NEW.id_parcela);
    RETURN NULL;
END $$;
CREATE TRIGGER producto_revisar_volumen AFTER INSERT OR UPDATE OF stock, id_parcela, unidad_medida ON producto
    FOR EACH ROW WHEN (NEW.id_parcela IS NOT NULL) EXECUTE FUNCTION trg_producto_revisar_volumen();

CREATE FUNCTION trg_parcela_revisar() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN PERFORM fn_revisar_parcela(NEW.id_parcela); RETURN NULL; END $$;
CREATE TRIGGER parcela_revisar AFTER UPDATE OF superficie_ha, cultivo ON parcela
    FOR EACH ROW EXECUTE FUNCTION trg_parcela_revisar();

-- ════════════════════════════════════════════════════════════
--  7. PEDIDOS: FLETE, IVA POR RENGLÓN, COMISIÓN Y NETO
-- ════════════════════════════════════════════════════════════
-- Cotización del flete (banderazo + $/km de ruta + margen de la plataforma)
CREATE FUNCTION fn_cotizar_flete(p_id_vendedor uuid, p_lat double precision, p_lng double precision)
RETURNS TABLE(distancia_km numeric, costo_transportista numeric, margen numeric, costo_envio numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
#variable_conflict use_column
DECLARE
    v_origen geometry;
    v_km     numeric;
    v_trans  numeric;
BEGIN
    SELECT geom INTO v_origen FROM vendedor WHERE id_vendedor = p_id_vendedor;
    IF v_origen IS NULL OR p_lat IS NULL OR p_lng IS NULL THEN
        v_km := 25;   -- sin ubicación: se asume un flete local
    ELSE
        v_km := round((ST_Distance(v_origen::geography, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography) / 1000
                       * fn_param('flete_factor_ruta'))::numeric, 1);
    END IF;
    v_trans := round(fn_param('flete_banderazo') + fn_param('flete_tarifa_km') * v_km, 0);
    RETURN QUERY SELECT v_km, v_trans, fn_param('flete_margen'), v_trans + fn_param('flete_margen');
END $$;

CREATE OR REPLACE FUNCTION trg_pedido_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE
    f record;
BEGIN
    NEW.estado        := 'PENDIENTE';
    NEW.subtotal      := 0;
    NEW.impuestos_iva := 0;
    NEW.comision_monto := 0;
    NEW.iva_comision  := 0;
    NEW.neto_vendedor := 0;
    NEW.custodia_estado := 'SIN_PAGO';
    NEW.recepcion_confirmada_en := NULL;
    NEW.liberar_despues_de := NULL;
    NEW.custodia_liberada_en := NULL;
    NEW.comision_pct  := CASE (SELECT perfil FROM vendedor WHERE id_vendedor = NEW.id_vendedor)
                            WHEN 'ACOPIADOR' THEN fn_param('comision_acopiador')
                            ELSE fn_param('comision_productor') END;
    IF NEW.modalidad_entrega = 'ENVIO' THEN
        -- El flete lo calcula la BD con PostGIS (el navegador no lo puede fijar)
        SELECT * INTO f FROM fn_cotizar_flete(NEW.id_vendedor, ST_Y(NEW.destino_geom), ST_X(NEW.destino_geom));
        NEW.distancia_km     := f.distancia_km;
        NEW.costo_envio      := f.costo_envio;
        NEW.margen_logistica := f.margen;
    ELSE
        NEW.distancia_km := NULL; NEW.costo_envio := 0; NEW.margen_logistica := 0; NEW.destino_geom := NULL;
    END IF;
    NEW.total         := NEW.costo_envio;
    NEW.fecha_pedido  := now();
    NEW.modificado_por := coalesce(NEW.modificado_por, app_user_id());
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trg_pedido_montos_inmutables() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.subtotal, NEW.impuestos_iva, NEW.costo_envio, NEW.total, NEW.id_comprador, NEW.id_vendedor,
        NEW.grupo_compra, NEW.fecha_pedido, NEW.comision_pct, NEW.comision_monto, NEW.iva_comision,
        NEW.neto_vendedor, NEW.margen_logistica, NEW.distancia_km)
       IS DISTINCT FROM
       (OLD.subtotal, OLD.impuestos_iva, OLD.costo_envio, OLD.total, OLD.id_comprador, OLD.id_vendedor,
        OLD.grupo_compra, OLD.fecha_pedido, OLD.comision_pct, OLD.comision_monto, OLD.iva_comision,
        OLD.neto_vendedor, OLD.margen_logistica, OLD.distancia_km)
       AND coalesce(current_setting('agro.recalculo', true), 'off') <> 'on' THEN
        RAISE EXCEPTION 'Los montos y participantes de un pedido no se pueden modificar' USING ERRCODE = '42501';
    END IF;
    -- La custodia solo la mueven las funciones del sistema
    IF (NEW.custodia_estado, NEW.recepcion_confirmada_en, NEW.liberar_despues_de, NEW.custodia_liberada_en)
       IS DISTINCT FROM (OLD.custodia_estado, OLD.recepcion_confirmada_en, OLD.liberar_despues_de, OLD.custodia_liberada_en)
       AND coalesce(current_setting('agro.custodia', true), 'off') <> 'on' THEN
        RAISE EXCEPTION 'La custodia del pago solo la cambia el sistema' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

-- Máquina de estados: se agrega EN_CAMINO → CANCELADO (disputa resuelta por el admin)
CREATE OR REPLACE FUNCTION trg_pedido_transicion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE
    v_rol text := app_role();
    v_ok  boolean;
BEGIN
    IF NEW.estado = OLD.estado THEN RETURN NEW; END IF;
    v_ok := CASE
        WHEN OLD.estado = 'PENDIENTE'  AND NEW.estado = 'CONFIRMADO' THEN v_rol IN ('VENDEDOR','ADMINISTRADOR')
        WHEN OLD.estado = 'PENDIENTE'  AND NEW.estado = 'CANCELADO'  THEN v_rol IN ('COMPRADOR','VENDEDOR','ADMINISTRADOR','SISTEMA')
        WHEN OLD.estado = 'CONFIRMADO' AND NEW.estado = 'EN_CAMINO'  THEN v_rol IN ('VENDEDOR','ADMINISTRADOR')
        WHEN OLD.estado = 'CONFIRMADO' AND NEW.estado = 'CANCELADO'  THEN v_rol IN ('VENDEDOR','ADMINISTRADOR')
        WHEN OLD.estado = 'EN_CAMINO'  AND NEW.estado = 'ENTREGADO'  THEN v_rol IN ('VENDEDOR','ADMINISTRADOR')
        WHEN OLD.estado = 'EN_CAMINO'  AND NEW.estado = 'CANCELADO'  THEN v_rol IN ('ADMINISTRADOR','SISTEMA')
        WHEN OLD.estado = 'ENTREGADO'  AND NEW.estado = 'DEVUELTO'   THEN v_rol IN ('ADMINISTRADOR','SISTEMA')
        ELSE false
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'No se puede pasar el pedido de % a % (rol %)', OLD.estado, NEW.estado, v_rol
            USING ERRCODE = 'P0001';
    END IF;
    IF NEW.estado = 'CONFIRMADO' AND EXISTS (
        SELECT 1 FROM (SELECT g.metodo, g.estado FROM pago g WHERE g.id_pedido = NEW.id_pedido
                       ORDER BY g.fecha_creacion DESC LIMIT 1) ult
         WHERE ult.metodo IN ('STRIPE','MERCADOPAGO','SIMULADO','SPEI') AND ult.estado <> 'APROBADO') THEN
        RAISE EXCEPTION 'El pago en línea de este pedido aún no está aprobado' USING ERRCODE = 'P0001';
    END IF;
    NEW.modificado_por := coalesce(app_user_id(), NEW.modificado_por);
    RETURN NEW;
END $$;

-- Efectos del cambio de estado: se agrega la custodia
CREATE OR REPLACE FUNCTION trg_pedido_efectos() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE
    v_envio       envio%ROWTYPE;
    v_nuevo_envio text;
    v_desc        text;
    v_usr_comp    uuid;
    v_usr_vend    uuid;
BEGIN
    IF NEW.estado = OLD.estado THEN RETURN NULL; END IF;

    SELECT * INTO v_envio FROM envio WHERE id_pedido = NEW.id_pedido;
    v_nuevo_envio := CASE NEW.estado
        WHEN 'CONFIRMADO' THEN 'PREPARANDO'
        WHEN 'EN_CAMINO'  THEN CASE WHEN NEW.modalidad_entrega = 'ENVIO' THEN 'EN_TRANSITO' ELSE 'LISTO_RECOLECCION' END
        WHEN 'ENTREGADO'  THEN 'ENTREGADO'
        WHEN 'CANCELADO'  THEN 'CANCELADO'
        WHEN 'DEVUELTO'   THEN 'DEVUELTO'
    END;
    v_desc := CASE NEW.estado
        WHEN 'CONFIRMADO' THEN 'El vendedor confirmó el pedido'
        WHEN 'EN_CAMINO'  THEN CASE WHEN NEW.modalidad_entrega = 'ENVIO' THEN 'Pedido en camino' ELSE 'Listo para recoger' END
        WHEN 'ENTREGADO'  THEN 'Pedido entregado · confirma de recibido para liberar el pago al vendedor'
        WHEN 'CANCELADO'  THEN 'Pedido cancelado'
        WHEN 'DEVUELTO'   THEN 'Devolución aprobada · pago reembolsado'
    END;
    IF v_envio.id_envio IS NOT NULL THEN
        UPDATE envio SET estado = v_nuevo_envio,
               fecha_entrega = CASE WHEN NEW.estado = 'ENTREGADO' THEN now() ELSE fecha_entrega END
        WHERE id_envio = v_envio.id_envio;
        INSERT INTO historial_envio(id_envio, estado_anterior, estado_nuevo, descripcion)
        VALUES (v_envio.id_envio, v_envio.estado, v_nuevo_envio, v_desc);
    END IF;

    IF NEW.estado IN ('CANCELADO', 'DEVUELTO') THEN
        UPDATE producto p SET stock = p.stock + d.cantidad, modificado_por = app_user_id()
        FROM detalle_pedido d
        WHERE d.id_pedido = NEW.id_pedido AND d.id_producto = p.id_producto;
        UPDATE pago SET estado = CASE WHEN estado = 'APROBADO' THEN 'REEMBOLSADO' ELSE 'CANCELADO' END
        WHERE id_pedido = NEW.id_pedido AND estado IN ('PENDIENTE', 'APROBADO');
        UPDATE financiamiento SET estado = 'CANCELADO'
        WHERE id_pedido = NEW.id_pedido AND estado = 'ACTIVO';
        PERFORM set_config('agro.custodia', 'on', true);
        UPDATE pedido SET custodia_estado = CASE WHEN custodia_estado = 'RETENIDO' THEN 'REEMBOLSADO'
                                                 WHEN custodia_estado = 'SIN_PAGO' THEN 'NO_APLICA'
                                                 ELSE custodia_estado END,
                          liberar_despues_de = NULL
         WHERE id_pedido = NEW.id_pedido;
        PERFORM set_config('agro.custodia', 'off', true);
    END IF;

    SELECT c.id_usuario INTO v_usr_comp FROM comprador c WHERE c.id_comprador = NEW.id_comprador;
    SELECT v.id_usuario INTO v_usr_vend FROM vendedor  v WHERE v.id_vendedor  = NEW.id_vendedor;

    IF NEW.estado = 'ENTREGADO' THEN
        UPDATE pago SET estado = 'APROBADO', fecha_pago = now(), referencia = coalesce(referencia, 'CONTRA-ENTREGA')
        WHERE id_pedido = NEW.id_pedido AND metodo = 'EFECTIVO' AND estado = 'PENDIENTE';
        PERFORM fn_score_sumar(v_usr_comp, 10, true);
        PERFORM fn_score_sumar(v_usr_vend, 10, true);
    ELSIF NEW.estado = 'DEVUELTO' THEN
        PERFORM fn_score_sumar(v_usr_vend, -15, false);
    END IF;
    RETURN NULL;
END $$;

-- Detalle: precio y TASA DE IVA reales de la BD
CREATE OR REPLACE FUNCTION trg_detalle_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE
    v_ped  pedido%ROWTYPE;
    v_prod producto%ROWTYPE;
    v_tasa numeric;
BEGIN
    SELECT * INTO v_ped FROM pedido WHERE id_pedido = NEW.id_pedido;
    IF v_ped.estado <> 'PENDIENTE' THEN
        RAISE EXCEPTION 'Solo se agregan productos a pedidos pendientes' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_prod FROM producto WHERE id_producto = NEW.id_producto FOR UPDATE;
    IF NOT FOUND OR v_prod.estado <> 'ACTIVO' THEN
        RAISE EXCEPTION 'El producto % no está disponible', coalesce(v_prod.nombre, NEW.id_producto::text)
            USING ERRCODE = 'P0002';
    END IF;
    IF v_prod.id_vendedor <> v_ped.id_vendedor THEN
        RAISE EXCEPTION 'El producto no pertenece al vendedor del pedido' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM vendedor WHERE id_vendedor = v_prod.id_vendedor AND verificado) THEN
        RAISE EXCEPTION 'El vendedor de "%" aún no está verificado', v_prod.nombre USING ERRCODE = 'P0001';
    END IF;
    IF v_prod.stock < NEW.cantidad THEN
        RAISE EXCEPTION 'Stock insuficiente para "%": disponible %', v_prod.nombre, v_prod.stock
            USING ERRCODE = 'P0003';
    END IF;
    SELECT coalesce(v_prod.tasa_iva, c.tasa_iva) INTO v_tasa FROM categoria c WHERE c.id_categoria = v_prod.id_categoria;

    NEW.precio_unitario := v_prod.precio;
    NEW.nombre_producto := v_prod.nombre;
    NEW.subtotal        := round(NEW.cantidad * v_prod.precio, 2);
    NEW.tasa_iva        := v_tasa;
    NEW.iva_monto       := round(NEW.subtotal * v_tasa, 2);
    NEW.hash_integridad := hash_detalle(NEW);
    UPDATE producto SET stock = stock - NEW.cantidad WHERE id_producto = NEW.id_producto;
    RETURN NEW;
END $$;

-- Recalcula subtotal, IVA (por renglón), total, comisión e IVA de la comisión, y neto del vendedor
CREATE OR REPLACE FUNCTION trg_detalle_recalcular() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE
    v_sub numeric(14,2);
    v_iva numeric(14,2);
BEGIN
    SELECT coalesce(sum(subtotal), 0), coalesce(sum(iva_monto), 0) INTO v_sub, v_iva
      FROM detalle_pedido WHERE id_pedido = NEW.id_pedido;
    PERFORM set_config('agro.recalculo', 'on', true);
    UPDATE pedido SET subtotal       = v_sub,
                      impuestos_iva  = v_iva,
                      total          = v_sub + v_iva + costo_envio,
                      comision_monto = round(v_sub * comision_pct, 2),
                      iva_comision   = round(round(v_sub * comision_pct, 2) * fn_param('iva_general'), 2),
                      neto_vendedor  = v_sub + v_iva - round(v_sub * comision_pct, 2)
                                       - round(round(v_sub * comision_pct, 2) * fn_param('iva_general'), 2)
    WHERE id_pedido = NEW.id_pedido;
    PERFORM set_config('agro.recalculo', 'off', true);
    RETURN NULL;
END $$;

-- ════════════════════════════════════════════════════════════
--  8. PAGOS: costo de pasarela, SPEI y paso a custodia
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION fn_costo_pasarela(p_metodo text, p_monto numeric) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
    SELECT round(CASE p_metodo
        WHEN 'STRIPE'      THEN (p_monto * fn_param('tarjeta_pct') + fn_param('tarjeta_fijo')) * (1 + fn_param('iva_general'))
        WHEN 'SIMULADO'    THEN (p_monto * fn_param('tarjeta_pct') + fn_param('tarjeta_fijo')) * (1 + fn_param('iva_general'))
        WHEN 'MERCADOPAGO' THEN (p_monto * fn_param('mp_pct') + fn_param('mp_fijo')) * (1 + fn_param('iva_general'))
        WHEN 'SPEI'        THEN fn_param('spei_fijo') * (1 + fn_param('iva_general'))
        ELSE 0 END, 2)
$$;

CREATE OR REPLACE FUNCTION trg_pago_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    SELECT total INTO NEW.monto FROM pedido WHERE id_pedido = NEW.id_pedido;
    IF NEW.monto IS NULL OR NEW.monto <= 0 THEN
        RAISE EXCEPTION 'El pedido no tiene productos' USING ERRCODE = 'P0001';
    END IF;
    NEW.estado    := 'PENDIENTE';
    NEW.moneda    := 'MXN';
    NEW.comision_pasarela := fn_costo_pasarela(NEW.metodo, NEW.monto);
    NEW.hash_integridad := hash_pago(NEW);
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trg_pago_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id_pedido, NEW.metodo, NEW.monto, NEW.moneda, NEW.hash_integridad, NEW.comision_pasarela)
       IS DISTINCT FROM (OLD.id_pedido, OLD.metodo, OLD.monto, OLD.moneda, OLD.hash_integridad, OLD.comision_pasarela) THEN
        RAISE EXCEPTION 'El monto y método de un pago no se pueden modificar' USING ERRCODE = '42501';
    END IF;
    IF NEW.estado = 'APROBADO' AND OLD.estado <> 'APROBADO' THEN
        NEW.fecha_pago := coalesce(NEW.fecha_pago, now());
    END IF;
    RETURN NEW;
END $$;

-- Pago en línea aprobado → el dinero queda RETENIDO (custodia); efectivo/financiamiento → no aplica
CREATE FUNCTION trg_pago_custodia() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    PERFORM set_config('agro.custodia', 'on', true);
    IF NEW.estado = 'APROBADO' AND OLD.estado <> 'APROBADO' AND NEW.metodo IN ('SIMULADO','STRIPE','MERCADOPAGO','SPEI') THEN
        UPDATE pedido SET custodia_estado = 'RETENIDO' WHERE id_pedido = NEW.id_pedido AND custodia_estado = 'SIN_PAGO';
    ELSIF NEW.estado = 'APROBADO' AND OLD.estado <> 'APROBADO' THEN
        UPDATE pedido SET custodia_estado = 'NO_APLICA' WHERE id_pedido = NEW.id_pedido AND custodia_estado = 'SIN_PAGO';
    END IF;
    PERFORM set_config('agro.custodia', 'off', true);
    RETURN NULL;
END $$;
CREATE TRIGGER pago_custodia AFTER UPDATE OF estado ON pago
    FOR EACH ROW EXECUTE FUNCTION trg_pago_custodia();

CREATE FUNCTION trg_pago_custodia_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    IF NEW.metodo IN ('EFECTIVO','FINANCIAMIENTO') THEN
        PERFORM set_config('agro.custodia', 'on', true);
        UPDATE pedido SET custodia_estado = 'NO_APLICA' WHERE id_pedido = NEW.id_pedido AND custodia_estado = 'SIN_PAGO';
        PERFORM set_config('agro.custodia', 'off', true);
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER pago_custodia_insert AFTER INSERT ON pago
    FOR EACH ROW EXECUTE FUNCTION trg_pago_custodia_insert();

-- ════════════════════════════════════════════════════════════
--  9. CUSTODIA: confirmación de recibido y liberación
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION fn_confirmar_recepcion(p_id_pedido uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_ped pedido%ROWTYPE;
BEGIN
    SELECT * INTO v_ped FROM pedido WHERE id_pedido = p_id_pedido FOR UPDATE;
    IF NOT FOUND OR app_role() <> 'COMPRADOR' OR v_ped.id_comprador <> app_rol_id() THEN
        RAISE EXCEPTION 'Pedido no encontrado' USING ERRCODE = '42501';
    END IF;
    IF v_ped.estado <> 'ENTREGADO' THEN
        RAISE EXCEPTION 'Confirma de recibido cuando el vendedor marque el pedido como entregado' USING ERRCODE = 'P0001';
    END IF;
    IF v_ped.recepcion_confirmada_en IS NOT NULL THEN RETURN v_ped.liberar_despues_de; END IF;
    PERFORM set_config('agro.custodia', 'on', true);
    UPDATE pedido SET recepcion_confirmada_en = now(),
                      liberar_despues_de = CASE WHEN custodia_estado = 'RETENIDO'
                                                THEN now() + make_interval(hours => fn_param('custodia_horas')::int) END
     WHERE id_pedido = p_id_pedido;
    PERFORM set_config('agro.custodia', 'off', true);
    INSERT INTO historial_envio(id_envio, estado_anterior, estado_nuevo, descripcion)
    SELECT e.id_envio, e.estado, e.estado, 'El comprador confirmó de recibido'
      FROM envio e WHERE e.id_pedido = p_id_pedido;
    RETURN (SELECT liberar_despues_de FROM pedido WHERE id_pedido = p_id_pedido);
END $$;

-- La ejecuta la API cada 10 minutos (contexto SISTEMA):
--  1) da por recibidos los pedidos entregados hace N días sin reclamo
--  2) libera los pagos cuyo plazo terminó y que no tienen devolución/disputa abierta
CREATE FUNCTION fn_procesar_custodia() RETURNS TABLE(autoconfirmados int, liberados int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_auto int; v_lib int;
BEGIN
    IF app_role() NOT IN ('SISTEMA','ADMINISTRADOR') THEN
        RAISE EXCEPTION 'Solo el sistema' USING ERRCODE = '42501';
    END IF;
    PERFORM set_config('agro.custodia', 'on', true);
    WITH x AS (
        UPDATE pedido p SET recepcion_confirmada_en = now(), recepcion_automatica = true,
               liberar_despues_de = CASE WHEN p.custodia_estado = 'RETENIDO'
                                         THEN now() + make_interval(hours => fn_param('custodia_horas')::int) END
          FROM envio e
         WHERE e.id_pedido = p.id_pedido AND p.estado = 'ENTREGADO' AND p.recepcion_confirmada_en IS NULL
           AND e.fecha_entrega < now() - make_interval(days => fn_param('autoconfirmar_dias')::int)
           AND NOT EXISTS (SELECT 1 FROM devolucion d WHERE d.id_pedido = p.id_pedido
                             AND d.estado IN ('SOLICITADA','EN_REVISION'))
        RETURNING p.id_pedido)
    SELECT count(*) INTO v_auto FROM x;
    WITH y AS (
        UPDATE pedido p SET custodia_estado = 'LIBERADO', custodia_liberada_en = now()
         WHERE p.custodia_estado = 'RETENIDO' AND p.estado = 'ENTREGADO'
           AND p.liberar_despues_de IS NOT NULL AND p.liberar_despues_de <= now()
           AND NOT EXISTS (SELECT 1 FROM devolucion d WHERE d.id_pedido = p.id_pedido
                             AND d.estado IN ('SOLICITADA','EN_REVISION'))
        RETURNING p.id_pedido)
    SELECT count(*) INTO v_lib FROM y;
    PERFORM set_config('agro.custodia', 'off', true);
    RETURN QUERY SELECT v_auto, v_lib;
END $$;

-- El administrador libera un pago antes de tiempo (p. ej. tras una mediación)
CREATE FUNCTION fn_liberar_custodia(p_id_pedido uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    IF NOT es_admin() THEN RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501'; END IF;
    PERFORM set_config('agro.custodia', 'on', true);
    UPDATE pedido SET custodia_estado = 'LIBERADO', custodia_liberada_en = now(),
                      recepcion_confirmada_en = coalesce(recepcion_confirmada_en, now())
     WHERE id_pedido = p_id_pedido AND custodia_estado = 'RETENIDO' AND estado = 'ENTREGADO';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Solo se libera un pago retenido de un pedido entregado' USING ERRCODE = 'P0001';
    END IF;
    PERFORM set_config('agro.custodia', 'off', true);
END $$;

-- ════════════════════════════════════════════════════════════
--  10. DEVOLUCIONES Y DISPUTAS (mediación)
-- ════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION trg_devolucion_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_ped pedido%ROWTYPE;
BEGIN
    SELECT * INTO v_ped FROM pedido WHERE id_pedido = NEW.id_pedido;
    IF NOT FOUND OR v_ped.id_comprador <> NEW.id_comprador THEN
        RAISE EXCEPTION 'El pedido no pertenece a este comprador' USING ERRCODE = '42501';
    END IF;
    IF NEW.tipo = 'DISPUTA' THEN
        IF v_ped.estado NOT IN ('EN_CAMINO', 'ENTREGADO') THEN
            RAISE EXCEPTION 'Abre una disputa cuando el pedido esté en camino o entregado' USING ERRCODE = 'P0001';
        END IF;
    ELSIF v_ped.estado <> 'ENTREGADO' THEN
        RAISE EXCEPTION 'Solo se pueden devolver pedidos entregados' USING ERRCODE = 'P0001';
    END IF;
    IF v_ped.custodia_estado = 'LIBERADO' THEN
        RAISE EXCEPTION 'El pago ya se liberó al vendedor; el plazo para reclamar terminó' USING ERRCODE = 'P0001';
    END IF;
    NEW.estado := 'SOLICITADA';
    NEW.fecha_solicitud := now();
    RETURN NEW;
END $$;

CREATE FUNCTION trg_devolucion_alerta() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    INSERT INTO alerta(tipo, id_vendedor, id_referencia, detalle)
    SELECT 'DISPUTA', p.id_vendedor, NEW.id_devolucion,
           format('%s del pedido #%s: %s', initcap(lower(NEW.tipo)), p.folio, left(NEW.motivo, 200))
      FROM pedido p WHERE p.id_pedido = NEW.id_pedido
    ON CONFLICT DO NOTHING;
    RETURN NULL;
END $$;
CREATE TRIGGER devolucion_alerta AFTER INSERT ON devolucion
    FOR EACH ROW EXECUTE FUNCTION trg_devolucion_alerta();

CREATE OR REPLACE FUNCTION trg_devolucion_aprobada() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    IF NEW.estado = 'APROBADA' AND OLD.estado <> 'APROBADA' THEN
        UPDATE pedido SET estado = 'DEVUELTO'  WHERE id_pedido = NEW.id_pedido AND estado = 'ENTREGADO';
        UPDATE pedido SET estado = 'CANCELADO' WHERE id_pedido = NEW.id_pedido AND estado = 'EN_CAMINO';
    END IF;
    IF NEW.estado IN ('APROBADA','RECHAZADA','RESUELTA') AND OLD.estado NOT IN ('APROBADA','RECHAZADA','RESUELTA') THEN
        UPDATE alerta SET estado = 'REVISADA', fecha_cierre = now()
         WHERE tipo = 'DISPUTA' AND id_referencia = NEW.id_devolucion AND estado = 'ABIERTA';
    END IF;
    RETURN NULL;
END $$;

CREATE FUNCTION trg_devmsg_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    NEW.id_usuario := app_user_id();
    NEW.rol := app_role();
    NEW.fecha := now();
    IF EXISTS (SELECT 1 FROM devolucion WHERE id_devolucion = NEW.id_devolucion
                AND estado IN ('APROBADA','RECHAZADA','RESUELTA')) THEN
        RAISE EXCEPTION 'El caso ya está cerrado' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER devmsg_insert BEFORE INSERT ON devolucion_mensaje
    FOR EACH ROW EXECUTE FUNCTION trg_devmsg_insert();

-- ════════════════════════════════════════════════════════════
--  11. MEMBRESÍA PREMIUM
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION trg_membresia_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    NEW.estado := 'PENDIENTE';
    NEW.fecha_creacion := now();
    NEW.periodo_inicio := NULL;
    NEW.periodo_fin := NULL;
    IF NEW.metodo = 'PROMOCION' THEN
        IF coalesce(current_setting('agro.promo_ok', true), 'off') <> 'on' THEN
            RAISE EXCEPTION 'Usa el código de alianza para el mes gratis' USING ERRCODE = '42501';
        END IF;
        NEW.monto := 0; NEW.iva := 0; NEW.total := 0; NEW.comision_pasarela := 0;
    ELSE
        NEW.monto := fn_param('membresia_precio');
        NEW.iva   := round(NEW.monto * fn_param('iva_general'), 2);
        NEW.total := NEW.monto + NEW.iva;
        NEW.comision_pasarela := fn_costo_pasarela(NEW.metodo, NEW.total);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER membresia_a_insert BEFORE INSERT ON membresia
    FOR EACH ROW EXECUTE FUNCTION trg_membresia_insert();
CREATE TRIGGER membresia_b_hash BEFORE INSERT ON membresia
    FOR EACH ROW EXECUTE FUNCTION trg_membresia_hash();

CREATE FUNCTION trg_membresia_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_hasta timestamptz;
BEGIN
    IF (NEW.id_vendedor, NEW.metodo, NEW.monto, NEW.iva, NEW.total, NEW.hash_integridad)
       IS DISTINCT FROM (OLD.id_vendedor, OLD.metodo, OLD.monto, OLD.iva, OLD.total, OLD.hash_integridad) THEN
        RAISE EXCEPTION 'El monto de la membresía no se puede modificar' USING ERRCODE = '42501';
    END IF;
    IF NEW.estado = 'PAGADA' AND OLD.estado <> 'PAGADA' THEN
        SELECT premium_hasta INTO v_hasta FROM vendedor WHERE id_vendedor = NEW.id_vendedor;
        NEW.periodo_inicio := greatest(now(), coalesce(v_hasta, now()));
        NEW.periodo_fin    := NEW.periodo_inicio + make_interval(days => fn_param('membresia_dias')::int);
        PERFORM set_config('agro.sistema_vendedor', 'on', true);
        UPDATE vendedor SET premium_hasta = NEW.periodo_fin,
                            promo_usada = promo_usada OR NEW.metodo = 'PROMOCION'
         WHERE id_vendedor = NEW.id_vendedor;
        PERFORM set_config('agro.sistema_vendedor', 'off', true);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER membresia_update BEFORE UPDATE ON membresia
    FOR EACH ROW EXECUTE FUNCTION trg_membresia_update();

-- Mes gratis con el código de alianza (una sola vez por vendedor)
CREATE FUNCTION fn_membresia_promocion(p_codigo text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_id uuid; v_usada boolean;
BEGIN
    IF app_role() <> 'VENDEDOR' THEN RAISE EXCEPTION 'Solo vendedores' USING ERRCODE = '42501'; END IF;
    IF upper(trim(coalesce(p_codigo, ''))) <> upper(fn_param_texto('codigo_alianza')) THEN
        RAISE EXCEPTION 'Código de alianza incorrecto' USING ERRCODE = 'P0001';
    END IF;
    SELECT promo_usada INTO v_usada FROM vendedor WHERE id_vendedor = app_rol_id();
    IF v_usada THEN RAISE EXCEPTION 'Ya usaste tu mes gratis' USING ERRCODE = 'P0001'; END IF;
    PERFORM set_config('agro.promo_ok', 'on', true);
    INSERT INTO membresia(id_vendedor, metodo) VALUES (app_rol_id(), 'PROMOCION') RETURNING id_membresia INTO v_id;
    PERFORM set_config('agro.promo_ok', 'off', true);
    UPDATE membresia SET estado = 'PAGADA', referencia = 'ALIANZA' WHERE id_membresia = v_id;
    RETURN v_id;
END $$;

-- ════════════════════════════════════════════════════════════
--  12. PUBLICIDAD, LATIDOS, REPORTE E INDICADORES
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION fn_anuncio_evento(p_id uuid, p_tipo text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = agro, public AS $$
    UPDATE anunciante SET impresiones = impresiones + CASE WHEN p_tipo = 'IMPRESION' THEN 1 ELSE 0 END,
                          clics       = clics       + CASE WHEN p_tipo = 'CLIC' THEN 1 ELSE 0 END
     WHERE id_anunciante = p_id AND estado = 'ACTIVO';
$$;

CREATE FUNCTION fn_latido() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = agro, public AS $$
    INSERT INTO latido(instante) VALUES (date_trunc('minute', now()) - make_interval(mins => extract(minute FROM now())::int % 5))
    ON CONFLICT DO NOTHING;
$$;

-- Datos del Reporte AgroConfianza de un vendedor (historial de ventas para crédito formal)
CREATE FUNCTION fn_reporte_datos(p_id_vendedor uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v jsonb;
BEGIN
    IF NOT (es_admin() OR (app_role() = 'VENDEDOR' AND app_rol_id() = p_id_vendedor)) THEN
        RAISE EXCEPTION 'Sin permiso' USING ERRCODE = '42501';
    END IF;
    SELECT jsonb_build_object(
        'vendedor', jsonb_build_object(
            'negocio', ve.nombre_negocio, 'responsable', u.nombre || ' ' || u.apellido, 'perfil', ve.perfil,
            'ubicacion', ve.ubicacion, 'verificacion', ve.verificacion_estado,
            'verificado_desde', ve.fecha_verificacion, 'miembro_desde', u.fecha_registro),
        'score', jsonb_build_object('puntos', coalesce(s.puntos, 0), 'nivel', coalesce(s.nivel, 'BRONCE'),
                                    'transacciones', coalesce(s.total_transacciones, 0)),
        'resumen', (SELECT jsonb_build_object(
                'pedidos_entregados', count(*) FILTER (WHERE p.estado = 'ENTREGADO'),
                'pedidos_cancelados', count(*) FILTER (WHERE p.estado = 'CANCELADO'),
                'devoluciones', count(*) FILTER (WHERE p.estado = 'DEVUELTO'),
                'ventas_12m', coalesce(sum(p.subtotal + p.impuestos_iva) FILTER (WHERE p.estado = 'ENTREGADO'
                                       AND p.fecha_pedido > now() - interval '12 months'), 0),
                'neto_recibido_12m', coalesce(sum(p.neto_vendedor) FILTER (WHERE p.estado = 'ENTREGADO'
                                       AND p.fecha_pedido > now() - interval '12 months'), 0),
                'compradores_distintos', count(DISTINCT p.id_comprador) FILTER (WHERE p.estado = 'ENTREGADO'))
              FROM pedido p WHERE p.id_vendedor = p_id_vendedor),
        'calificaciones', (SELECT jsonb_build_object('promedio', coalesce(round(avg(puntuacion), 2), 0), 'total', count(*))
                             FROM calificacion WHERE id_vendedor = p_id_vendedor),
        'meses', (SELECT coalesce(jsonb_agg(m ORDER BY m->>'mes'), '[]'::jsonb) FROM (
                    SELECT jsonb_build_object('mes', to_char(date_trunc('month', p.fecha_pedido), 'YYYY-MM'),
                                              'pedidos', count(*), 'ventas', sum(p.subtotal + p.impuestos_iva),
                                              'neto', sum(p.neto_vendedor)) AS m
                      FROM pedido p WHERE p.id_vendedor = p_id_vendedor AND p.estado = 'ENTREGADO'
                       AND p.fecha_pedido > now() - interval '12 months'
                     GROUP BY date_trunc('month', p.fecha_pedido)) q),
        'parcelas', (SELECT coalesce(jsonb_agg(jsonb_build_object('nombre', nombre, 'municipio', municipio,
                                     'superficie_ha', superficie_ha, 'cultivo', cultivo, 'tenencia', tenencia)), '[]'::jsonb)
                       FROM parcela WHERE id_vendedor = p_id_vendedor AND estado = 'ACTIVA'),
        'generado', now())
      INTO v
      FROM vendedor ve JOIN usuario u ON u.id_usuario = ve.id_usuario
      LEFT JOIN score_agroconfianza s ON s.id_usuario = ve.id_usuario
     WHERE ve.id_vendedor = p_id_vendedor;
    RETURN v;
END $$;

-- Verificación pública de un reporte (la usa la caja popular con el folio y la huella)
CREATE FUNCTION fn_verificar_reporte(p_folio bigint)
RETURNS TABLE(folio bigint, negocio text, generado_en timestamptz, valido_hasta timestamptz, sha256 text, vigente boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
    SELECT r.folio, r.datos #>> '{vendedor,negocio}', r.generado_en, r.valido_hasta, r.sha256::text, r.valido_hasta > now()
      FROM reporte_agroconfianza r WHERE r.folio = p_folio
$$;

-- Indicadores del plan de negocio (diapositiva «Indicadores para dar seguimiento»)
CREATE FUNCTION fn_indicadores()
RETURNS TABLE(clave text, indicador text, que_mide text, valor numeric, meta numeric, unidad text, cumple boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
#variable_conflict use_column
DECLARE
    v_verif numeric; v_ventas numeric; v_precio numeric; v_precio_ant numeric; v_directo numeric;
    v_premium numeric; v_recompra numeric; v_disp numeric; v_desde timestamptz;
BEGIN
    IF NOT es_admin() THEN RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501'; END IF;

    SELECT count(DISTINCT ve.id_vendedor) INTO v_verif
      FROM vendedor ve JOIN pedido p ON p.id_vendedor = ve.id_vendedor JOIN envio e ON e.id_pedido = p.id_pedido
     WHERE ve.verificado AND ve.perfil = 'PRODUCTOR' AND p.estado = 'ENTREGADO' AND e.fecha_entrega > now() - interval '30 days';

    SELECT count(*) INTO v_ventas FROM pedido p JOIN envio e ON e.id_pedido = p.id_pedido
     WHERE p.estado = 'ENTREGADO' AND e.fecha_entrega > now() - interval '30 days';

    SELECT round(100 * sum(p.neto_vendedor) / nullif(sum(p.subtotal + p.impuestos_iva), 0), 1) INTO v_precio
      FROM pedido p JOIN vendedor ve ON ve.id_vendedor = p.id_vendedor
     WHERE p.estado = 'ENTREGADO' AND ve.perfil = 'PRODUCTOR' AND p.fecha_pedido > now() - interval '90 days';
    SELECT round(100 * sum(p.neto_vendedor) / nullif(sum(p.subtotal + p.impuestos_iva), 0), 1) INTO v_precio_ant
      FROM pedido p JOIN vendedor ve ON ve.id_vendedor = p.id_vendedor
     WHERE p.estado = 'ENTREGADO' AND ve.perfil = 'PRODUCTOR'
       AND p.fecha_pedido BETWEEN now() - interval '180 days' AND now() - interval '90 days';

    SELECT round(100.0 * count(*) FILTER (WHERE ve.perfil = 'PRODUCTOR') / nullif(count(*), 0), 1) INTO v_directo
      FROM pedido p JOIN vendedor ve ON ve.id_vendedor = p.id_vendedor
     WHERE p.estado = 'ENTREGADO' AND p.fecha_pedido > now() - interval '30 days';

    SELECT round(100.0 * count(*) FILTER (WHERE premium_hasta > now()) / nullif(count(*), 0), 1) INTO v_premium
      FROM vendedor ve JOIN usuario u ON u.id_usuario = ve.id_usuario WHERE u.estado = 'ACTIVO';

    SELECT round(100.0 * count(*) FILTER (WHERE n >= 2) / nullif(count(*), 0), 1) INTO v_recompra
      FROM (SELECT id_comprador, count(DISTINCT grupo_compra) AS n FROM pedido
             WHERE estado NOT IN ('CANCELADO') AND fecha_pedido > now() - interval '60 days'
             GROUP BY id_comprador) x;

    SELECT min(instante) INTO v_desde FROM latido;
    IF v_desde IS NOT NULL THEN
        SELECT round(least(100, 100.0 * count(*) / greatest(1, floor(extract(epoch FROM (now() - v_desde)) / 300) + 1)), 2)
          INTO v_disp FROM latido;
    END IF;

    RETURN QUERY VALUES
      ('verificados', 'Productores verificados activos', 'Con insignia y al menos una venta en 30 días', v_verif, 120::numeric, 'productores', v_verif >= 120),
      ('ventas', 'Ventas concretadas por mes', 'Pedidos entregados en los últimos 30 días', v_ventas, 150::numeric, 'ventas', v_ventas >= 150),
      ('precio', 'Precio que recibe el productor', 'Neto del productor ÷ precio final (90 días)', v_precio, v_precio_ant, '%',
          v_precio IS NOT NULL AND (v_precio_ant IS NULL OR v_precio >= v_precio_ant)),
      ('directo', 'Ventas «Directo del productor»', 'Ventas sin acopiador ÷ ventas totales (30 días)', v_directo, 70::numeric, '%', coalesce(v_directo, 0) >= 70),
      ('premium', 'Conversión a Premium', 'Vendedores Premium ÷ vendedores registrados', v_premium, 12::numeric, '%', coalesce(v_premium, 0) >= 12),
      ('recompra', 'Recompra de compradores', 'Compradores que repiten en 60 días', v_recompra, 40::numeric, '%', coalesce(v_recompra, 0) >= 40),
      ('disponibilidad', 'Disponibilidad de la plataforma', 'Tiempo en línea (latidos cada 5 min)', v_disp, 99.5::numeric, '%', coalesce(v_disp, 0) >= 99.5);
END $$;

-- Finanzas de un periodo con el modelo de ingresos del plan (antes de IVA)
CREATE FUNCTION fn_finanzas(p_desde date, p_hasta date)
RETURNS TABLE(concepto text, monto numeric, tipo text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
#variable_conflict use_column
DECLARE
    v_dias numeric := greatest(1, p_hasta - p_desde + 1);
    v_com numeric; v_log numeric; v_mem numeric; v_pub numeric; v_pas numeric; v_fijos numeric;
BEGIN
    IF NOT es_admin() THEN RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501'; END IF;
    SELECT coalesce(sum(p.comision_monto), 0), coalesce(sum(p.margen_logistica), 0) INTO v_com, v_log
      FROM pedido p JOIN envio e ON e.id_pedido = p.id_pedido
     WHERE p.estado = 'ENTREGADO' AND e.fecha_entrega::date BETWEEN p_desde AND p_hasta;
    SELECT coalesce(sum(m.monto), 0) INTO v_mem FROM membresia m
     WHERE m.estado = 'PAGADA' AND m.periodo_inicio::date BETWEEN p_desde AND p_hasta;
    SELECT coalesce(sum(a.cuota_mensual * (least(a.fecha_fin, p_hasta) - greatest(a.fecha_inicio, p_desde) + 1) / 30.0), 0)
      INTO v_pub FROM anunciante a
     WHERE a.fecha_inicio <= p_hasta AND a.fecha_fin >= p_desde;
    SELECT coalesce(sum(g.comision_pasarela), 0) INTO v_pas FROM pago g
     WHERE g.estado IN ('APROBADO','REEMBOLSADO') AND g.fecha_pago::date BETWEEN p_desde AND p_hasta;
    v_pas := v_pas + coalesce((SELECT sum(comision_pasarela) FROM membresia
                                WHERE estado = 'PAGADA' AND periodo_inicio::date BETWEEN p_desde AND p_hasta), 0);
    v_fijos := round(fn_param('costos_fijos_mes') * v_dias / 30.0, 2);
    RETURN QUERY VALUES
      ('Comisiones por venta', round(v_com, 2), 'INGRESO'),
      ('Margen de logística', round(v_log, 2), 'INGRESO'),
      ('Membresías Premium', round(v_mem, 2), 'INGRESO'),
      ('Publicidad local', round(v_pub, 2), 'INGRESO'),
      ('Costo de pasarelas', -round(v_pas, 2), 'COSTO'),
      ('Costos fijos (prorrateo)', -v_fijos, 'COSTO'),
      ('Utilidad del periodo', round(v_com + v_log + v_mem + v_pub - v_pas - v_fijos, 2), 'RESULTADO');
END $$;

-- La verificación de integridad incluye las membresías
CREATE OR REPLACE FUNCTION fn_verificar_integridad()
RETURNS TABLE(elemento text, revisados bigint, alterados bigint, detalle text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
#variable_conflict use_column
DECLARE
    r       record;
    v_prev  char(64) := repeat('0', 64);
    v_total bigint := 0;
    v_mal   bigint := 0;
    v_primero text;
BEGIN
    IF NOT es_admin() THEN
        RAISE EXCEPTION 'Solo administradores' USING ERRCODE = '42501';
    END IF;
    FOR r IN SELECT * FROM log_cambios ORDER BY id_log LOOP
        v_total := v_total + 1;
        IF r.hash_anterior <> v_prev OR r.hash_actual <> fn_log_hash(r.hash_anterior, r.tabla_afectada, r.operacion,
              r.id_registro, r.datos_anteriores, r.datos_nuevos, r.usuario_app, r.fecha) THEN
            v_mal := v_mal + 1;
            v_primero := coalesce(v_primero, 'Registro #' || r.id_log);
        END IF;
        v_prev := r.hash_actual;
    END LOOP;
    RETURN QUERY SELECT 'Bitácora (cadena SHA-256)'::text, v_total, v_mal, coalesce(v_primero, 'Cadena íntegra');
    RETURN QUERY SELECT 'Pedidos (HMAC)'::text, count(*), count(*) FILTER (WHERE p.hash_integridad <> hash_pedido(p)),
                        NULL::text FROM pedido p;
    RETURN QUERY SELECT 'Detalle de pedidos (HMAC)'::text, count(*), count(*) FILTER (WHERE d.hash_integridad <> hash_detalle(d)),
                        NULL::text FROM detalle_pedido d;
    RETURN QUERY SELECT 'Pagos (HMAC)'::text, count(*), count(*) FILTER (WHERE g.hash_integridad <> hash_pago(g)),
                        NULL::text FROM pago g;
    RETURN QUERY SELECT 'Membresías (HMAC)'::text, count(*), count(*) FILTER (WHERE m.hash_integridad <> hash_membresia(m)),
                        NULL::text FROM membresia m;
END $$;

-- ════════════════════════════════════════════════════════════
--  13. DATOS EXISTENTES (actualización desde v2.1)
-- ════════════════════════════════════════════════════════════
ALTER TABLE detalle_pedido DISABLE TRIGGER detalle_inmutable;
UPDATE detalle_pedido SET tasa_iva = 0.16, iva_monto = round(subtotal * 0.16, 2);   -- pedidos viejos: se cobraron al 16 %
ALTER TABLE detalle_pedido ENABLE TRIGGER detalle_inmutable;

SELECT set_config('agro.recalculo', 'on', true), set_config('agro.custodia', 'on', true);
UPDATE pedido p SET comision_pct   = fn_param('comision_productor'),
                    comision_monto = round(p.subtotal * fn_param('comision_productor'), 2),
                    iva_comision   = round(round(p.subtotal * fn_param('comision_productor'), 2) * 0.16, 2),
                    neto_vendedor  = p.subtotal + p.impuestos_iva - round(p.subtotal * fn_param('comision_productor'), 2)
                                     - round(round(p.subtotal * fn_param('comision_productor'), 2) * 0.16, 2),
                    margen_logistica = CASE WHEN p.modalidad_entrega = 'ENVIO' THEN least(p.costo_envio, fn_param('flete_margen')) ELSE 0 END,
                    custodia_estado = CASE
                        WHEN p.estado IN ('CANCELADO','DEVUELTO') THEN
                             CASE WHEN EXISTS (SELECT 1 FROM pago g WHERE g.id_pedido = p.id_pedido AND g.estado = 'REEMBOLSADO')
                                  THEN 'REEMBOLSADO' ELSE 'NO_APLICA' END
                        WHEN EXISTS (SELECT 1 FROM pago g WHERE g.id_pedido = p.id_pedido AND g.metodo IN ('EFECTIVO','FINANCIAMIENTO'))
                             THEN 'NO_APLICA'
                        WHEN EXISTS (SELECT 1 FROM pago g WHERE g.id_pedido = p.id_pedido AND g.estado = 'APROBADO')
                             THEN CASE WHEN p.estado = 'ENTREGADO' THEN 'LIBERADO' ELSE 'RETENIDO' END
                        ELSE 'SIN_PAGO' END,
                    custodia_liberada_en = NULL;
SELECT set_config('agro.recalculo', 'off', true), set_config('agro.custodia', 'off', true);

-- ════════════════════════════════════════════════════════════
--  14. VISTAS PÚBLICAS (solo productores VERIFICADOS aparecen en el catálogo)
-- ════════════════════════════════════════════════════════════
DROP VIEW IF EXISTS v_vendedor_publico CASCADE;     -- arrastra v_producto_catalogo y v_terreno_catalogo

CREATE VIEW v_vendedor_publico WITH (security_barrier) AS
SELECT v.id_vendedor, v.id_usuario, v.nombre_negocio, v.verificado, v.ubicacion, v.descripcion,
       ST_Y(v.geom) AS lat, ST_X(v.geom) AS lng,
       coalesce(c.promedio, 0)::float8 AS rating,
       coalesce(c.total, 0)::int        AS total_calificaciones,
       coalesce(e.ventas, 0)::int       AS ventas,
       s.nivel AS score_nivel, s.puntos AS score_puntos,
       u.fecha_registro AS miembro_desde,
       u.nombre || ' ' || left(u.apellido, 1) || '.' AS responsable,
       v.perfil, (v.premium_hasta IS NOT NULL AND v.premium_hasta > now()) AS premium,
       v.verificacion_estado,
       (SELECT coalesce(sum(superficie_ha), 0) FROM parcela pa WHERE pa.id_vendedor = v.id_vendedor AND pa.estado = 'ACTIVA')::float8 AS superficie_ha,
       (SELECT string_agg(DISTINCT cultivo, ', ') FROM parcela pa WHERE pa.id_vendedor = v.id_vendedor AND pa.estado = 'ACTIVA') AS cultivos
FROM vendedor v
JOIN usuario u ON u.id_usuario = v.id_usuario AND u.estado = 'ACTIVO'
LEFT JOIN LATERAL (SELECT round(avg(puntuacion), 1) AS promedio, count(*) AS total
                   FROM calificacion WHERE id_vendedor = v.id_vendedor) c ON true
LEFT JOIN LATERAL (SELECT count(*) AS ventas FROM pedido
                   WHERE id_vendedor = v.id_vendedor AND estado = 'ENTREGADO') e ON true
LEFT JOIN score_agroconfianza s ON s.id_usuario = v.id_usuario;

CREATE VIEW v_producto_catalogo WITH (security_barrier) AS
SELECT p.id_producto, p.id_vendedor, p.id_categoria, p.nombre, p.descripcion, p.precio, p.stock,
       p.unidad_medida, p.moneda, p.estado, p.tags, p.fecha_publicacion,
       coalesce(p.ubicacion, vp.ubicacion)          AS ubicacion,
       coalesce(ST_Y(p.geom), vp.lat)               AS lat,
       coalesce(ST_X(p.geom), vp.lng)               AS lng,
       c.nombre AS categoria, c.tipo AS categoria_tipo,
       (SELECT i.url FROM producto_imagen i WHERE i.id_producto = p.id_producto
        ORDER BY i.es_principal DESC, i.orden LIMIT 1) AS imagen,
       vp.nombre_negocio AS vendedor_nombre, vp.verificado AS vendedor_verificado,
       vp.ubicacion AS vendedor_ubicacion, vp.rating AS vendedor_rating,
       vp.ventas AS vendedor_ventas, vp.total_calificaciones AS vendedor_calificaciones,
       vp.perfil AS vendedor_perfil, vp.premium AS vendedor_premium,
       coalesce(p.tasa_iva, c.tasa_iva)::float8 AS tasa_iva,
       p.id_parcela, pa.nombre AS parcela_nombre, pa.cultivo AS parcela_cultivo, pa.superficie_ha AS parcela_ha
FROM producto p
JOIN categoria c ON c.id_categoria = p.id_categoria
JOIN v_vendedor_publico vp ON vp.id_vendedor = p.id_vendedor AND vp.verificado
LEFT JOIN parcela pa ON pa.id_parcela = p.id_parcela
WHERE p.estado <> 'INACTIVO';

CREATE VIEW v_terreno_catalogo WITH (security_barrier) AS
SELECT t.id_terreno, t.id_vendedor, t.titulo, t.descripcion, t.superficie_ha, t.ubicacion,
       ST_Y(t.geom) AS lat, ST_X(t.geom) AS lng, t.geom,
       t.precio, t.moneda, t.tipo_operacion, t.estado, t.tags, t.fecha_publicacion,
       (SELECT i.url FROM terreno_imagen i WHERE i.id_terreno = t.id_terreno
        ORDER BY i.es_principal DESC, i.orden LIMIT 1) AS imagen,
       vp.nombre_negocio AS vendedor_nombre, vp.verificado AS vendedor_verificado,
       vp.rating AS vendedor_rating, vp.perfil AS vendedor_perfil, vp.premium AS vendedor_premium
FROM terreno t
JOIN v_vendedor_publico vp ON vp.id_vendedor = t.id_vendedor AND vp.verificado
WHERE t.estado <> 'INACTIVO';

CREATE VIEW v_anuncio_activo WITH (security_barrier) AS
SELECT id_anunciante, nombre, giro, mensaje, url, imagen_url, ubicacion
  FROM anunciante
 WHERE estado = 'ACTIVO' AND current_date BETWEEN fecha_inicio AND fecha_fin;

-- ════════════════════════════════════════════════════════════
--  15. TRIGGERS GENERALES EN TABLAS NUEVAS
-- ════════════════════════════════════════════════════════════
DO $$
DECLARE t record; n text;
BEGIN
    FOR t IN SELECT * FROM (VALUES
        ('parametro','clave'), ('parcela','id_parcela'), ('documento_verificacion','id_documento'),
        ('alerta','id_alerta'), ('membresia','id_membresia'), ('transportista','id_transportista'),
        ('anunciante','id_anunciante'), ('devolucion_mensaje','id_mensaje'),
        ('reporte_agroconfianza','id_reporte'), ('cultivo_referencia','cultivo')) AS x(tabla, pk)
    LOOP
        EXECUTE format('CREATE TRIGGER z_auditoria AFTER INSERT OR UPDATE OR DELETE ON %I
                        FOR EACH ROW EXECUTE FUNCTION trg_auditoria(%L)', t.tabla, t.pk);
    END LOOP;
    FOREACH n IN ARRAY ARRAY['parametro','parcela','membresia','transportista','anunciante'] LOOP
        EXECUTE format('CREATE TRIGGER a_fecha_actualizacion BEFORE UPDATE ON %I
                        FOR EACH ROW EXECUTE FUNCTION trg_fecha_actualizacion()', n);
    END LOOP;
END $$;
-- Los documentos y el aviso de privacidad no se guardan en la bitácora en claro
CREATE OR REPLACE FUNCTION trg_auditoria() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE
    v_ocultar text[] := ARRAY['password_hash','telefono_cifrado','rfc_cifrado','rfc_hash','geom','poligono',
                              'totp_secreto_cifrado','destino_geom','ruta','datos'];
    v_ruido   text[] := ARRAY['fecha_actualizacion','ultimo_login','intentos_fallidos','bloqueado_hasta',
                              'impresiones','clics'];
    v_old  jsonb;
    v_new  jsonb;
    v_id   text;
    v_prev char(64);
    v_fecha timestamptz := date_trunc('milliseconds', clock_timestamp());
BEGIN
    IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD) - v_ocultar; END IF;
    IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW) - v_ocultar; END IF;
    IF TG_OP = 'UPDATE' AND (v_old - v_ruido) = (v_new - v_ruido) THEN
        RETURN NULL;
    END IF;
    v_id := coalesce(v_new, v_old) ->> TG_ARGV[0];
    PERFORM pg_advisory_xact_lock(770077);
    SELECT hash_actual INTO v_prev FROM log_cambios ORDER BY id_log DESC LIMIT 1;
    v_prev := coalesce(v_prev, repeat('0', 64));
    INSERT INTO log_cambios(tabla_afectada, operacion, id_registro, datos_anteriores, datos_nuevos,
                            usuario_app, rol_app, usuario_bd, fecha, hash_anterior, hash_actual)
    VALUES (TG_TABLE_NAME, TG_OP, v_id, v_old, v_new, app_user_id(), app_role(), session_user, v_fecha, v_prev,
            fn_log_hash(v_prev, TG_TABLE_NAME, TG_OP, v_id, v_old, v_new, app_user_id(), v_fecha));
    RETURN NULL;
END $$;

-- ════════════════════════════════════════════════════════════
--  16. ROW LEVEL SECURITY DE LAS TABLAS NUEVAS
-- ════════════════════════════════════════════════════════════
ALTER TABLE parametro              ENABLE ROW LEVEL SECURITY;
ALTER TABLE cultivo_referencia     ENABLE ROW LEVEL SECURITY;
ALTER TABLE parcela                ENABLE ROW LEVEL SECURITY;
ALTER TABLE documento_verificacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerta                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE membresia              ENABLE ROW LEVEL SECURITY;
ALTER TABLE transportista          ENABLE ROW LEVEL SECURITY;
ALTER TABLE anunciante             ENABLE ROW LEVEL SECURITY;
ALTER TABLE devolucion_mensaje     ENABLE ROW LEVEL SECURITY;
ALTER TABLE reporte_agroconfianza  ENABLE ROW LEVEL SECURITY;
ALTER TABLE latido                 ENABLE ROW LEVEL SECURITY;

CREATE POLICY parametro_ver ON parametro FOR SELECT TO agro_app USING (true);
CREATE POLICY parametro_admin ON parametro FOR UPDATE TO agro_app USING (es_admin()) WITH CHECK (es_admin());

CREATE POLICY cultivo_ver ON cultivo_referencia FOR SELECT TO agro_app USING (true);
CREATE POLICY cultivo_admin_ins ON cultivo_referencia FOR INSERT TO agro_app WITH CHECK (es_admin());
CREATE POLICY cultivo_admin_upd ON cultivo_referencia FOR UPDATE TO agro_app USING (es_admin());

-- Las parcelas se ven en el perfil público (superficie/cultivo); se editan solo por su dueño
CREATE POLICY parcela_ver ON parcela FOR SELECT TO agro_app USING (true);
CREATE POLICY parcela_crear ON parcela FOR INSERT TO agro_app
    WITH CHECK ((app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id()) OR es_admin());
CREATE POLICY parcela_editar ON parcela FOR UPDATE TO agro_app
    USING ((app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id()) OR es_admin())
    WITH CHECK ((app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id()) OR es_admin());

-- Documentos: solo el dueño y el administrador que revisa
CREATE POLICY doc_ver ON documento_verificacion FOR SELECT TO agro_app
    USING ((app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id()) OR es_admin());
CREATE POLICY doc_crear ON documento_verificacion FOR INSERT TO agro_app
    WITH CHECK (app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id());
CREATE POLICY doc_admin ON documento_verificacion FOR UPDATE TO agro_app USING (es_admin()) WITH CHECK (es_admin());

CREATE POLICY alerta_admin ON alerta FOR SELECT TO agro_app
    USING (es_admin() OR (app_role() = 'VENDEDOR' AND tipo = 'VOLUMEN_PARCELA' AND id_vendedor = app_rol_id()));
CREATE POLICY alerta_admin_upd ON alerta FOR UPDATE TO agro_app USING (es_admin());

CREATE POLICY membresia_ver ON membresia FOR SELECT TO agro_app
    USING ((app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id()) OR es_admin());
CREATE POLICY membresia_crear ON membresia FOR INSERT TO agro_app
    WITH CHECK (app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id());
CREATE POLICY membresia_sistema ON membresia FOR UPDATE TO agro_app USING (es_admin()) WITH CHECK (es_admin());

CREATE POLICY transportista_ver ON transportista FOR SELECT TO agro_app
    USING (estado = 'ACTIVO' AND app_role() IN ('VENDEDOR','ADMINISTRADOR','COMPRADOR') OR es_admin());
CREATE POLICY transportista_admin_ins ON transportista FOR INSERT TO agro_app WITH CHECK (es_admin());
CREATE POLICY transportista_admin_upd ON transportista FOR UPDATE TO agro_app USING (es_admin());

CREATE POLICY anunciante_admin ON anunciante FOR SELECT TO agro_app USING (es_admin() OR (estado = 'ACTIVO'));
CREATE POLICY anunciante_admin_ins ON anunciante FOR INSERT TO agro_app WITH CHECK (es_admin());
CREATE POLICY anunciante_admin_upd ON anunciante FOR UPDATE TO agro_app USING (es_admin());

CREATE POLICY devmsg_ver ON devolucion_mensaje FOR SELECT TO agro_app
    USING (EXISTS (SELECT 1 FROM devolucion d WHERE d.id_devolucion = devolucion_mensaje.id_devolucion));
CREATE POLICY devmsg_crear ON devolucion_mensaje FOR INSERT TO agro_app
    WITH CHECK (EXISTS (SELECT 1 FROM devolucion d WHERE d.id_devolucion = devolucion_mensaje.id_devolucion));

CREATE POLICY reporte_ver ON reporte_agroconfianza FOR SELECT TO agro_app
    USING ((app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id()) OR es_admin());
CREATE POLICY reporte_crear ON reporte_agroconfianza FOR INSERT TO agro_app
    WITH CHECK (app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id());

INSERT INTO migracion(nombre) VALUES ('07_plan_negocio.sql') ON CONFLICT DO NOTHING;
RESET ROLE;

-- ════════════════════════════════════════════════════════════
--  17. PERMISOS (por columna; los montos los fija la BD)
-- ════════════════════════════════════════════════════════════
GRANT SELECT (bloqueado_hasta, intentos_fallidos, acepto_privacidad_en, version_aviso, totp_activo)
      ON agro.usuario TO agro_app;
GRANT UPDATE (tasa_iva) ON agro.categoria TO agro_app;
GRANT INSERT (tasa_iva) ON agro.categoria TO agro_app;
GRANT INSERT (tasa_iva, id_parcela) ON agro.producto TO agro_app;
GRANT UPDATE (tasa_iva, id_parcela) ON agro.producto TO agro_app;
GRANT UPDATE (perfil, verificacion_estado, verificacion_nota) ON agro.vendedor TO agro_app;
GRANT UPDATE (geom) ON agro.comprador TO agro_app;
GRANT INSERT (destino_geom) ON agro.pedido TO agro_app;
GRANT UPDATE (id_transportista) ON agro.envio TO agro_app;
GRANT INSERT (tipo) ON agro.devolucion TO agro_app;

GRANT SELECT ON agro.parametro, agro.cultivo_referencia, agro.parcela, agro.documento_verificacion, agro.alerta,
                agro.membresia, agro.transportista, agro.anunciante, agro.devolucion_mensaje,
                agro.reporte_agroconfianza, agro.migracion TO agro_app;
GRANT UPDATE (valor, texto) ON agro.parametro TO agro_app;
GRANT UPDATE (rendimiento_t_ha, fuente) ON agro.cultivo_referencia TO agro_app;
GRANT INSERT (cultivo, rendimiento_t_ha, fuente) ON agro.cultivo_referencia TO agro_app;
GRANT INSERT (id_vendedor, nombre, municipio, superficie_ha, cultivo, tenencia, geom) ON agro.parcela TO agro_app;
GRANT UPDATE (nombre, municipio, superficie_ha, cultivo, tenencia, geom, estado) ON agro.parcela TO agro_app;
GRANT INSERT (id_vendedor, tipo, nombre_original, ruta, sha256, mime, tamano_bytes) ON agro.documento_verificacion TO agro_app;
GRANT UPDATE (estado, nota, fecha_revision) ON agro.documento_verificacion TO agro_app;
GRANT UPDATE (estado, fecha_cierre) ON agro.alerta TO agro_app;
GRANT INSERT (id_vendedor, metodo, proveedor_ref) ON agro.membresia TO agro_app;
GRANT UPDATE (estado, proveedor_ref, referencia) ON agro.membresia TO agro_app;
GRANT INSERT (nombre, telefono, zona, vehiculo, capacidad_ton) ON agro.transportista TO agro_app;
GRANT UPDATE (nombre, telefono, zona, vehiculo, capacidad_ton, estado) ON agro.transportista TO agro_app;
GRANT INSERT (nombre, giro, contacto, mensaje, url, imagen_url, ubicacion, cuota_mensual, fecha_inicio, fecha_fin)
      ON agro.anunciante TO agro_app;
GRANT UPDATE (nombre, giro, contacto, mensaje, url, imagen_url, ubicacion, cuota_mensual, fecha_inicio, fecha_fin, estado)
      ON agro.anunciante TO agro_app;
GRANT INSERT (id_devolucion, mensaje) ON agro.devolucion_mensaje TO agro_app;
GRANT INSERT (id_vendedor, datos, sha256) ON agro.reporte_agroconfianza TO agro_app;

GRANT SELECT ON agro.v_vendedor_publico, agro.v_producto_catalogo, agro.v_terreno_catalogo, agro.v_anuncio_activo
      TO agro_app, agro_lectura;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA agro FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    agro.app_user_id(), agro.app_role(), agro.app_rol_id(), agro.es_admin(),
    agro.fn_usuario_display(uuid), agro.fn_comprador_display(uuid), agro.fn_contacto_vendedor(uuid),
    agro.fn_contacto_terreno(uuid),
    agro.fn_registrar_usuario(text, text, text, text, text, bytea, text, bytea, text, text,
                              double precision, double precision, text, text, text),
    agro.fn_registrar_usuario_v3(text, text, text, text, text, bytea, text, bytea, text, text,
                                 double precision, double precision, text, text, text, text, text),
    agro.fn_id_rol(uuid, text), agro.fn_auth_login(text, text),
    agro.fn_sesion_crear(uuid, text, text, text, timestamptz), agro.fn_sesion_validar(text),
    agro.fn_sesion_cerrar(text), agro.fn_cambiar_password(text, text),
    agro.fn_verificar_integridad(), agro.fn_perfil_comprador(uuid),
    agro.fn_param(text), agro.fn_param_texto(text), agro.fn_cotizar_flete(uuid, double precision, double precision),
    agro.fn_costo_pasarela(text, numeric), agro.fn_a_toneladas(numeric, text),
    agro.fn_verificacion_enviar(), agro.fn_desbloquear_usuario(uuid),
    agro.fn_totp_fallo(uuid), agro.fn_totp_exito(uuid), agro.fn_totp_secreto(uuid), agro.fn_totp_configurar(bytea, boolean),
    agro.fn_confirmar_recepcion(uuid), agro.fn_procesar_custodia(), agro.fn_liberar_custodia(uuid),
    agro.fn_membresia_promocion(text), agro.fn_anuncio_evento(uuid, text), agro.fn_latido(),
    agro.fn_reporte_datos(uuid), agro.fn_verificar_reporte(bigint),
    agro.fn_indicadores(), agro.fn_finanzas(date, date), agro.fn_revisar_parcela(uuid)
TO agro_app;
GRANT EXECUTE ON FUNCTION agro.fn_usuario_display(uuid), agro.fn_comprador_display(uuid),
                          agro.app_user_id(), agro.app_role(), agro.app_rol_id(), agro.es_admin()
TO agro_lectura;

COMMIT;
