-- ============================================================
--  AgroConnecta — 03_funciones_triggers.sql
--  Contexto de sesión, autenticación con hashes, reglas de negocio,
--  integridad (HMAC-SHA256) y auditoría encadenada (SHA-256).
-- ============================================================
SET ROLE agro_owner;
SET search_path = agro, public;

-- ════════════════════════════════════════════════════════════
--  1. CONTEXTO DE LA PETICIÓN
--  La API, en cada petición, hace dentro de su transacción:
--    SELECT set_config('app.user_id', '<uuid>', true),
--           set_config('app.role',    'VENDEDOR', true),
--           set_config('app.rol_id',  '<id_vendedor>', true);
--  Las políticas RLS y los triggers leen estos valores.
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('app.role', true), ''), 'ANON') $$;

CREATE FUNCTION app_rol_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.rol_id', true), '')::uuid $$;

CREATE FUNCTION es_admin() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app_role() IN ('ADMINISTRADOR', 'SISTEMA') $$;

-- ════════════════════════════════════════════════════════════
--  2. HASHES DE INTEGRIDAD (HMAC-SHA256 con clave secreta)
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION seguridad.hmac_integridad(p_texto text) RETURNS char(64)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = seguridad, public AS $$
    SELECT encode(hmac(convert_to(p_texto, 'UTF8'),
                       (SELECT valor FROM seguridad.clave WHERE nombre = 'integridad'),
                       'sha256'), 'hex')
$$;
REVOKE ALL ON FUNCTION seguridad.hmac_integridad(text) FROM PUBLIC;

CREATE FUNCTION hash_pedido(p pedido) RETURNS char(64) LANGUAGE sql STABLE AS $$
    SELECT seguridad.hmac_integridad(concat_ws('|', p.id_pedido, p.folio, p.grupo_compra, p.id_comprador,
           p.id_vendedor, p.subtotal, p.impuestos_iva, p.costo_envio, p.total,
           to_char(p.fecha_pedido AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')))
$$;
CREATE FUNCTION hash_detalle(d detalle_pedido) RETURNS char(64) LANGUAGE sql STABLE AS $$
    SELECT seguridad.hmac_integridad(concat_ws('|', d.id_detalle, d.id_pedido, d.id_producto,
           d.cantidad, d.precio_unitario, d.subtotal))
$$;
CREATE FUNCTION hash_pago(g pago) RETURNS char(64) LANGUAGE sql STABLE AS $$
    SELECT seguridad.hmac_integridad(concat_ws('|', g.id_pago, g.id_pedido, g.metodo, g.monto, g.moneda))
$$;

-- ════════════════════════════════════════════════════════════
--  3. UTILIDADES GENERALES
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION trg_fecha_actualizacion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.fecha_actualizacion := now();
    RETURN NEW;
END $$;

-- Nombre público "Juan P." (para mostrar compradores sin exponer datos)
CREATE FUNCTION fn_usuario_display(p_id_usuario uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
    SELECT u.nombre || ' ' || left(u.apellido, 1) || '.' FROM usuario u WHERE u.id_usuario = p_id_usuario
$$;
CREATE FUNCTION fn_comprador_display(p_id_comprador uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
    SELECT fn_usuario_display(c.id_usuario) FROM comprador c WHERE c.id_comprador = p_id_comprador
$$;

-- Contacto del vendedor (solo usuarios con sesión). El teléfono va cifrado;
-- la API lo descifra con su clave AES.
CREATE FUNCTION fn_contacto_vendedor(p_id_vendedor uuid)
RETURNS TABLE(nombre text, email text, telefono_cifrado bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
#variable_conflict use_column
BEGIN
    IF app_user_id() IS NULL THEN
        RAISE EXCEPTION 'Inicia sesión para ver el contacto' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
        SELECT (u.nombre || ' ' || u.apellido)::text, u.email::text, u.telefono_cifrado
        FROM vendedor v JOIN usuario u ON u.id_usuario = v.id_usuario
        WHERE v.id_vendedor = p_id_vendedor AND u.estado = 'ACTIVO';
END $$;

-- ════════════════════════════════════════════════════════════
--  4. SCORE AGROCONFIANZA
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION fn_score_sumar(p_id_usuario uuid, p_puntos integer, p_transaccion boolean DEFAULT false)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = agro, public AS $$
    INSERT INTO score_agroconfianza(id_usuario, puntos, total_transacciones)
    VALUES (p_id_usuario, GREATEST(0, p_puntos), CASE WHEN p_transaccion THEN 1 ELSE 0 END)
    ON CONFLICT (id_usuario) DO UPDATE
       SET puntos = GREATEST(0, score_agroconfianza.puntos + p_puntos),
           total_transacciones = score_agroconfianza.total_transacciones
                                 + CASE WHEN p_transaccion THEN 1 ELSE 0 END;
$$;

CREATE FUNCTION trg_score_nivel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.nivel := CASE WHEN NEW.puntos >= 700 THEN 'PLATINO'
                      WHEN NEW.puntos >= 300 THEN 'ORO'
                      WHEN NEW.puntos >= 100 THEN 'PLATA'
                      ELSE 'BRONCE' END;
    NEW.fecha_actualizacion := now();
    RETURN NEW;
END $$;
CREATE TRIGGER score_nivel BEFORE INSERT OR UPDATE ON score_agroconfianza
    FOR EACH ROW EXECUTE FUNCTION trg_score_nivel();

-- ════════════════════════════════════════════════════════════
--  5. AUTENTICACIÓN (contraseñas con bcrypt dentro de la BD)
--  La API nunca puede leer la columna password_hash: solo llama
--  a estas funciones SECURITY DEFINER.
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION fn_registrar_usuario(
    p_nombre text, p_apellido text, p_email text, p_password text, p_tipo text,
    p_telefono_cifrado bytea DEFAULT NULL,
    p_nombre_negocio text DEFAULT NULL, p_rfc_cifrado bytea DEFAULT NULL, p_rfc_hash text DEFAULT NULL,
    p_ubicacion text DEFAULT NULL, p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL,
    p_direccion text DEFAULT NULL, p_ciudad text DEFAULT NULL, p_descripcion text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE
    v_id uuid;
    v_geom geometry;
BEGIN
    IF p_tipo NOT IN ('COMPRADOR', 'VENDEDOR', 'ADMINISTRADOR') THEN
        RAISE EXCEPTION 'Tipo de usuario inválido' USING ERRCODE = '22023';
    END IF;
    IF p_tipo = 'ADMINISTRADOR' AND NOT es_admin() THEN
        RAISE EXCEPTION 'Solo un administrador puede crear administradores' USING ERRCODE = '42501';
    END IF;
    IF length(coalesce(p_password, '')) < 8 THEN
        RAISE EXCEPTION 'La contraseña debe tener al menos 8 caracteres' USING ERRCODE = '22023';
    END IF;
    IF p_tipo = 'VENDEDOR' AND coalesce(trim(p_nombre_negocio), '') = '' THEN
        RAISE EXCEPTION 'El nombre del negocio es obligatorio para vendedores' USING ERRCODE = '22023';
    END IF;

    INSERT INTO usuario(nombre, apellido, email, password_hash, telefono_cifrado, tipo_usuario)
    VALUES (trim(p_nombre), trim(p_apellido), lower(trim(p_email)),
            crypt(p_password, gen_salt('bf', 11)),       -- bcrypt, costo 11
            p_telefono_cifrado, p_tipo)
    RETURNING id_usuario INTO v_id;

    IF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
        v_geom := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
    END IF;

    IF p_tipo = 'COMPRADOR' THEN
        INSERT INTO comprador(id_usuario, direccion, ciudad) VALUES (v_id, p_direccion, p_ciudad);
    ELSIF p_tipo = 'VENDEDOR' THEN
        INSERT INTO vendedor(id_usuario, nombre_negocio, rfc_cifrado, rfc_hash, ubicacion, geom, descripcion)
        VALUES (v_id, trim(p_nombre_negocio), p_rfc_cifrado, p_rfc_hash, p_ubicacion, v_geom, p_descripcion);
    ELSE
        INSERT INTO administrador(id_usuario) VALUES (v_id);
    END IF;

    INSERT INTO score_agroconfianza(id_usuario) VALUES (v_id);
    RETURN v_id;
END $$;

-- id del perfil (id_comprador / id_vendedor / id_admin)
CREATE FUNCTION fn_id_rol(p_id_usuario uuid, p_tipo text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
    SELECT CASE p_tipo
        WHEN 'COMPRADOR'     THEN (SELECT id_comprador FROM comprador     WHERE id_usuario = p_id_usuario)
        WHEN 'VENDEDOR'      THEN (SELECT id_vendedor  FROM vendedor      WHERE id_usuario = p_id_usuario)
        WHEN 'ADMINISTRADOR' THEN (SELECT id_admin     FROM administrador WHERE id_usuario = p_id_usuario)
    END
$$;

-- Login: compara bcrypt, bloquea 15 min tras 5 intentos fallidos
CREATE FUNCTION fn_auth_login(p_email text, p_password text)
RETURNS TABLE(resultado text, id_usuario uuid, nombre text, apellido text, email text,
              tipo_usuario text, id_rol uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
#variable_conflict use_column
DECLARE
    u usuario%ROWTYPE;
BEGIN
    SELECT * INTO u FROM usuario WHERE usuario.email = lower(trim(p_email));
    IF NOT FOUND THEN
        PERFORM crypt(p_password, gen_salt('bf', 11));   -- mismo tiempo de respuesta (evita enumerar correos)
        RETURN QUERY SELECT 'CREDENCIALES'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid;
        RETURN;
    END IF;

    IF u.bloqueado_hasta IS NOT NULL AND u.bloqueado_hasta > now() THEN
        RETURN QUERY SELECT 'BLOQUEADO'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid;
        RETURN;
    END IF;

    IF crypt(p_password, u.password_hash) <> u.password_hash THEN
        UPDATE usuario SET
            intentos_fallidos = CASE WHEN u.intentos_fallidos + 1 >= 5 THEN 0 ELSE u.intentos_fallidos + 1 END,
            bloqueado_hasta   = CASE WHEN u.intentos_fallidos + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END
        WHERE usuario.id_usuario = u.id_usuario;
        RETURN QUERY SELECT 'CREDENCIALES'::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid;
        RETURN;
    END IF;

    IF u.estado <> 'ACTIVO' THEN
        RETURN QUERY SELECT u.estado::text, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::uuid;
        RETURN;
    END IF;

    UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL, ultimo_login = now()
    WHERE usuario.id_usuario = u.id_usuario;

    RETURN QUERY SELECT 'OK'::text, u.id_usuario, u.nombre::text, u.apellido::text, u.email::text,
                        u.tipo_usuario::text, fn_id_rol(u.id_usuario, u.tipo_usuario);
END $$;

CREATE FUNCTION fn_sesion_crear(p_id_usuario uuid, p_token_hash text, p_ip text, p_ua text, p_expira timestamptz)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = agro, public AS $$
    INSERT INTO sesion(id_usuario, token_hash, ip_address, user_agent, fecha_expira)
    VALUES (p_id_usuario, p_token_hash, left(p_ip, 64), left(p_ua, 500), p_expira);
$$;

-- Valida el hash del token en CADA petición (permite cerrar sesión / suspender al instante)
CREATE FUNCTION fn_sesion_validar(p_token_hash text)
RETURNS TABLE(id_usuario uuid, tipo_usuario text, id_rol uuid, nombre text, apellido text, email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
#variable_conflict use_column
BEGIN
    UPDATE sesion s SET ultimo_uso = now()
    WHERE s.token_hash = p_token_hash AND s.activa AND s.ultimo_uso < now() - interval '1 minute';

    RETURN QUERY
        SELECT u.id_usuario, u.tipo_usuario::text, fn_id_rol(u.id_usuario, u.tipo_usuario),
               u.nombre::text, u.apellido::text, u.email::text
        FROM sesion s JOIN usuario u ON u.id_usuario = s.id_usuario
        WHERE s.token_hash = p_token_hash AND s.activa AND s.fecha_expira > now() AND u.estado = 'ACTIVO';
END $$;

CREATE FUNCTION fn_sesion_cerrar(p_token_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = agro, public AS $$
    UPDATE sesion SET activa = false WHERE token_hash = p_token_hash;
$$;

CREATE FUNCTION fn_cambiar_password(p_actual text, p_nueva text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_hash text;
BEGIN
    IF app_user_id() IS NULL THEN RAISE EXCEPTION 'Sin sesión' USING ERRCODE = '42501'; END IF;
    IF length(coalesce(p_nueva, '')) < 8 THEN
        RAISE EXCEPTION 'La contraseña debe tener al menos 8 caracteres' USING ERRCODE = '22023';
    END IF;
    SELECT password_hash INTO v_hash FROM usuario WHERE id_usuario = app_user_id();
    IF crypt(p_actual, v_hash) <> v_hash THEN RETURN false; END IF;
    UPDATE usuario SET password_hash = crypt(p_nueva, gen_salt('bf', 11)) WHERE id_usuario = app_user_id();
    -- cierra las demás sesiones
    UPDATE sesion SET activa = false WHERE id_usuario = app_user_id();
    RETURN true;
END $$;

-- ════════════════════════════════════════════════════════════
--  6. REGLAS DE USUARIOS Y VENDEDORES
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION trg_usuario_guardas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.tipo_usuario <> OLD.tipo_usuario THEN
        RAISE EXCEPTION 'El tipo de usuario no se puede cambiar' USING ERRCODE = '42501';
    END IF;
    IF NEW.estado <> OLD.estado AND NOT es_admin() THEN
        RAISE EXCEPTION 'Solo un administrador cambia el estado de un usuario' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER usuario_guardas BEFORE UPDATE ON usuario
    FOR EACH ROW EXECUTE FUNCTION trg_usuario_guardas();

-- Si se suspende/desactiva un usuario, se cierran todas sus sesiones
CREATE FUNCTION trg_usuario_cerrar_sesiones() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    IF NEW.estado <> 'ACTIVO' AND OLD.estado = 'ACTIVO' THEN
        UPDATE sesion SET activa = false WHERE id_usuario = NEW.id_usuario AND activa;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER usuario_cerrar_sesiones AFTER UPDATE OF estado ON usuario
    FOR EACH ROW EXECUTE FUNCTION trg_usuario_cerrar_sesiones();

CREATE FUNCTION trg_vendedor_verificacion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.verificado IS DISTINCT FROM OLD.verificado THEN
        IF NOT es_admin() THEN
            RAISE EXCEPTION 'Solo un administrador puede verificar vendedores' USING ERRCODE = '42501';
        END IF;
        NEW.fecha_verificacion := CASE WHEN NEW.verificado THEN now() ELSE NULL END;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER vendedor_verificacion BEFORE UPDATE ON vendedor
    FOR EACH ROW EXECUTE FUNCTION trg_vendedor_verificacion();

-- ════════════════════════════════════════════════════════════
--  7. PRODUCTOS: estado automático según stock
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION trg_producto_estado_stock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.stock = 0 AND NEW.estado = 'ACTIVO' THEN
        NEW.estado := 'AGOTADO';
    ELSIF TG_OP = 'UPDATE' AND NEW.stock > 0 AND OLD.estado = 'AGOTADO' AND NEW.estado = 'AGOTADO'
          AND NEW.stock <> OLD.stock THEN
        NEW.estado := 'ACTIVO';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER producto_estado_stock BEFORE INSERT OR UPDATE ON producto
    FOR EACH ROW EXECUTE FUNCTION trg_producto_estado_stock();

-- Al marcar una imagen como principal se desmarca la anterior
CREATE FUNCTION trg_imagen_principal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    IF NEW.es_principal THEN
        IF TG_TABLE_NAME = 'producto_imagen' THEN
            UPDATE producto_imagen SET es_principal = false
            WHERE id_producto = NEW.id_producto AND id_imagen <> NEW.id_imagen AND es_principal;
        ELSE
            UPDATE terreno_imagen SET es_principal = false
            WHERE id_terreno = NEW.id_terreno AND id_imagen <> NEW.id_imagen AND es_principal;
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER producto_imagen_principal BEFORE INSERT OR UPDATE OF es_principal ON producto_imagen
    FOR EACH ROW EXECUTE FUNCTION trg_imagen_principal();
CREATE TRIGGER terreno_imagen_principal BEFORE INSERT OR UPDATE OF es_principal ON terreno_imagen
    FOR EACH ROW EXECUTE FUNCTION trg_imagen_principal();

-- ════════════════════════════════════════════════════════════
--  8. PEDIDOS
-- ════════════════════════════════════════════════════════════
-- 8.1 Alta del pedido: el servidor fija estado y montos (el cliente no puede)
CREATE FUNCTION trg_pedido_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.estado        := 'PENDIENTE';
    NEW.subtotal      := 0;
    NEW.impuestos_iva := 0;
    NEW.costo_envio   := CASE WHEN NEW.modalidad_entrega = 'ENVIO' THEN coalesce(NEW.costo_envio, 0) ELSE 0 END;
    NEW.total         := NEW.costo_envio;
    NEW.fecha_pedido  := now();
    NEW.modificado_por := coalesce(NEW.modificado_por, app_user_id());
    RETURN NEW;
END $$;
CREATE TRIGGER pedido_a_insert BEFORE INSERT ON pedido
    FOR EACH ROW EXECUTE FUNCTION trg_pedido_insert();

CREATE FUNCTION trg_pedido_hash() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    NEW.hash_integridad := hash_pedido(NEW);
    RETURN NEW;
END $$;

-- 8.2 Crear el registro de envío al crear el pedido
CREATE FUNCTION trg_pedido_crear_envio() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_envio uuid;
BEGIN
    INSERT INTO envio(id_pedido, modalidad, estado, fecha_estimada)
    VALUES (NEW.id_pedido, NEW.modalidad_entrega, 'PREPARANDO', (now() + interval '3 days')::date)
    RETURNING id_envio INTO v_envio;
    INSERT INTO historial_envio(id_envio, estado_anterior, estado_nuevo, descripcion)
    VALUES (v_envio, NULL, 'PREPARANDO', 'Pedido recibido');
    RETURN NULL;
END $$;
CREATE TRIGGER pedido_crear_envio AFTER INSERT ON pedido
    FOR EACH ROW EXECUTE FUNCTION trg_pedido_crear_envio();

-- 8.3 Montos inmutables (solo los recalcula el propio sistema)
CREATE FUNCTION trg_pedido_montos_inmutables() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.subtotal, NEW.impuestos_iva, NEW.costo_envio, NEW.total, NEW.id_comprador, NEW.id_vendedor,
        NEW.grupo_compra, NEW.fecha_pedido)
       IS DISTINCT FROM
       (OLD.subtotal, OLD.impuestos_iva, OLD.costo_envio, OLD.total, OLD.id_comprador, OLD.id_vendedor,
        OLD.grupo_compra, OLD.fecha_pedido)
       AND coalesce(current_setting('agro.recalculo', true), 'off') <> 'on' THEN
        RAISE EXCEPTION 'Los montos y participantes de un pedido no se pueden modificar' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER pedido_a_montos_inmutables BEFORE UPDATE ON pedido
    FOR EACH ROW EXECUTE FUNCTION trg_pedido_montos_inmutables();

-- 8.4 Máquina de estados del pedido (quién puede mover a qué estado)
CREATE FUNCTION trg_pedido_transicion() RETURNS trigger
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
        WHEN OLD.estado = 'ENTREGADO'  AND NEW.estado = 'DEVUELTO'   THEN v_rol IN ('ADMINISTRADOR','SISTEMA')
        ELSE false
    END;
    IF NOT v_ok THEN
        RAISE EXCEPTION 'No se puede pasar el pedido de % a % (rol %)', OLD.estado, NEW.estado, v_rol
            USING ERRCODE = 'P0001';
    END IF;

    -- No se confirma un pedido con pago en línea sin aprobar
    IF NEW.estado = 'CONFIRMADO' AND EXISTS (
        SELECT 1 FROM (SELECT g.metodo, g.estado FROM pago g WHERE g.id_pedido = NEW.id_pedido
                       ORDER BY g.fecha_creacion DESC LIMIT 1) ult
         WHERE ult.metodo IN ('STRIPE','MERCADOPAGO','SIMULADO') AND ult.estado <> 'APROBADO') THEN
        RAISE EXCEPTION 'El pago en línea de este pedido aún no está aprobado' USING ERRCODE = 'P0001';
    END IF;

    NEW.modificado_por := coalesce(app_user_id(), NEW.modificado_por);
    RETURN NEW;
END $$;
CREATE TRIGGER pedido_b_transicion BEFORE UPDATE OF estado ON pedido
    FOR EACH ROW EXECUTE FUNCTION trg_pedido_transicion();

CREATE TRIGGER pedido_c_hash BEFORE INSERT OR UPDATE ON pedido
    FOR EACH ROW EXECUTE FUNCTION trg_pedido_hash();

-- 8.5 Efectos del cambio de estado: envío, historial, stock, pagos y score
CREATE FUNCTION trg_pedido_efectos() RETURNS trigger
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
        WHEN 'ENTREGADO'  THEN 'Pedido entregado'
        WHEN 'CANCELADO'  THEN 'Pedido cancelado'
        WHEN 'DEVUELTO'   THEN 'Devolución aprobada'
    END;

    IF v_envio.id_envio IS NOT NULL THEN
        UPDATE envio SET estado = v_nuevo_envio,
               fecha_entrega = CASE WHEN NEW.estado = 'ENTREGADO' THEN now() ELSE fecha_entrega END
        WHERE id_envio = v_envio.id_envio;
        INSERT INTO historial_envio(id_envio, estado_anterior, estado_nuevo, descripcion)
        VALUES (v_envio.id_envio, v_envio.estado, v_nuevo_envio, v_desc);
    END IF;

    -- Cancelación o devolución: regresar stock, reembolsar / cancelar pago y financiamiento
    IF NEW.estado IN ('CANCELADO', 'DEVUELTO') THEN
        UPDATE producto p SET stock = p.stock + d.cantidad, modificado_por = app_user_id()
        FROM detalle_pedido d
        WHERE d.id_pedido = NEW.id_pedido AND d.id_producto = p.id_producto;

        UPDATE pago SET estado = CASE WHEN estado = 'APROBADO' THEN 'REEMBOLSADO' ELSE 'CANCELADO' END
        WHERE id_pedido = NEW.id_pedido AND estado IN ('PENDIENTE', 'APROBADO');

        UPDATE financiamiento SET estado = 'CANCELADO'
        WHERE id_pedido = NEW.id_pedido AND estado = 'ACTIVO';
    END IF;

    SELECT c.id_usuario INTO v_usr_comp FROM comprador c WHERE c.id_comprador = NEW.id_comprador;
    SELECT v.id_usuario INTO v_usr_vend FROM vendedor  v WHERE v.id_vendedor  = NEW.id_vendedor;

    IF NEW.estado = 'ENTREGADO' THEN
        -- Pago contra entrega: se aprueba al entregar
        UPDATE pago SET estado = 'APROBADO', fecha_pago = now(), referencia = coalesce(referencia, 'CONTRA-ENTREGA')
        WHERE id_pedido = NEW.id_pedido AND metodo = 'EFECTIVO' AND estado = 'PENDIENTE';
        PERFORM fn_score_sumar(v_usr_comp, 10, true);
        PERFORM fn_score_sumar(v_usr_vend, 10, true);
    ELSIF NEW.estado = 'DEVUELTO' THEN
        PERFORM fn_score_sumar(v_usr_vend, -15, false);
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER pedido_efectos AFTER UPDATE OF estado ON pedido
    FOR EACH ROW EXECUTE FUNCTION trg_pedido_efectos();

-- 8.6 Detalle: precio real de la BD, validación y descuento de stock
CREATE FUNCTION trg_detalle_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE
    v_ped  pedido%ROWTYPE;
    v_prod producto%ROWTYPE;
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
    IF v_prod.stock < NEW.cantidad THEN
        RAISE EXCEPTION 'Stock insuficiente para "%": disponible %', v_prod.nombre, v_prod.stock
            USING ERRCODE = 'P0003';
    END IF;

    NEW.precio_unitario := v_prod.precio;                     -- nunca el precio que manda el navegador
    NEW.nombre_producto := v_prod.nombre;
    NEW.subtotal        := round(NEW.cantidad * v_prod.precio, 2);
    NEW.hash_integridad := hash_detalle(NEW);

    UPDATE producto SET stock = stock - NEW.cantidad WHERE id_producto = NEW.id_producto;
    RETURN NEW;
END $$;
CREATE TRIGGER detalle_insert BEFORE INSERT ON detalle_pedido
    FOR EACH ROW EXECUTE FUNCTION trg_detalle_insert();

CREATE FUNCTION trg_detalle_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'El detalle de un pedido no se puede modificar ni borrar' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER detalle_inmutable BEFORE UPDATE OR DELETE ON detalle_pedido
    FOR EACH ROW EXECUTE FUNCTION trg_detalle_inmutable();

-- Recalcula subtotal, IVA (16 %) y total del pedido
CREATE FUNCTION trg_detalle_recalcular() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_sub numeric(14,2);
BEGIN
    SELECT coalesce(sum(subtotal), 0) INTO v_sub FROM detalle_pedido WHERE id_pedido = NEW.id_pedido;
    PERFORM set_config('agro.recalculo', 'on', true);
    UPDATE pedido SET subtotal      = v_sub,
                      impuestos_iva = round(v_sub * 0.16, 2),
                      total         = v_sub + round(v_sub * 0.16, 2) + costo_envio
    WHERE id_pedido = NEW.id_pedido;
    PERFORM set_config('agro.recalculo', 'off', true);
    RETURN NULL;
END $$;
CREATE TRIGGER detalle_recalcular AFTER INSERT ON detalle_pedido
    FOR EACH ROW EXECUTE FUNCTION trg_detalle_recalcular();

-- ════════════════════════════════════════════════════════════
--  9. PAGOS
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION trg_pago_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    SELECT total INTO NEW.monto FROM pedido WHERE id_pedido = NEW.id_pedido;
    IF NEW.monto IS NULL OR NEW.monto <= 0 THEN
        RAISE EXCEPTION 'El pedido no tiene productos' USING ERRCODE = 'P0001';
    END IF;
    NEW.estado    := 'PENDIENTE';
    NEW.moneda    := 'MXN';
    NEW.hash_integridad := hash_pago(NEW);
    RETURN NEW;
END $$;
CREATE TRIGGER pago_insert BEFORE INSERT ON pago
    FOR EACH ROW EXECUTE FUNCTION trg_pago_insert();

CREATE FUNCTION trg_pago_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id_pedido, NEW.metodo, NEW.monto, NEW.moneda, NEW.hash_integridad)
       IS DISTINCT FROM (OLD.id_pedido, OLD.metodo, OLD.monto, OLD.moneda, OLD.hash_integridad) THEN
        RAISE EXCEPTION 'El monto y método de un pago no se pueden modificar' USING ERRCODE = '42501';
    END IF;
    IF NEW.estado = 'APROBADO' AND OLD.estado <> 'APROBADO' THEN
        NEW.fecha_pago := coalesce(NEW.fecha_pago, now());
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER pago_update BEFORE UPDATE ON pago
    FOR EACH ROW EXECUTE FUNCTION trg_pago_update();

-- ════════════════════════════════════════════════════════════
--  10. CALIFICACIONES, DEVOLUCIONES Y FINANCIAMIENTO
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION trg_calificacion_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_ped pedido%ROWTYPE;
BEGIN
    SELECT * INTO v_ped FROM pedido WHERE id_pedido = NEW.id_pedido;
    IF NOT FOUND OR v_ped.id_comprador <> NEW.id_comprador THEN
        RAISE EXCEPTION 'El pedido no pertenece a este comprador' USING ERRCODE = '42501';
    END IF;
    IF v_ped.estado <> 'ENTREGADO' THEN
        RAISE EXCEPTION 'Solo puedes calificar pedidos entregados' USING ERRCODE = 'P0001';
    END IF;
    NEW.id_vendedor := v_ped.id_vendedor;
    NEW.fecha := now();
    RETURN NEW;
END $$;
CREATE TRIGGER calificacion_insert BEFORE INSERT ON calificacion
    FOR EACH ROW EXECUTE FUNCTION trg_calificacion_insert();

CREATE FUNCTION trg_calificacion_score() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    PERFORM fn_score_sumar((SELECT id_usuario FROM vendedor WHERE id_vendedor = NEW.id_vendedor),
                           (NEW.puntuacion - 3) * 5, false);
    PERFORM fn_score_sumar((SELECT id_usuario FROM comprador WHERE id_comprador = NEW.id_comprador), 2, false);
    RETURN NULL;
END $$;
CREATE TRIGGER calificacion_score AFTER INSERT ON calificacion
    FOR EACH ROW EXECUTE FUNCTION trg_calificacion_score();

CREATE FUNCTION trg_devolucion_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_ped pedido%ROWTYPE;
BEGIN
    SELECT * INTO v_ped FROM pedido WHERE id_pedido = NEW.id_pedido;
    IF NOT FOUND OR v_ped.id_comprador <> NEW.id_comprador THEN
        RAISE EXCEPTION 'El pedido no pertenece a este comprador' USING ERRCODE = '42501';
    END IF;
    IF v_ped.estado <> 'ENTREGADO' THEN
        RAISE EXCEPTION 'Solo se pueden devolver pedidos entregados' USING ERRCODE = 'P0001';
    END IF;
    NEW.estado := 'SOLICITADA';
    NEW.fecha_solicitud := now();
    RETURN NEW;
END $$;
CREATE TRIGGER devolucion_insert BEFORE INSERT ON devolucion
    FOR EACH ROW EXECUTE FUNCTION trg_devolucion_insert();

CREATE FUNCTION trg_devolucion_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.estado <> OLD.estado AND NEW.estado IN ('APROBADA', 'RECHAZADA', 'RESUELTA') THEN
        NEW.fecha_resolucion := now();
        IF app_role() = 'ADMINISTRADOR' THEN NEW.id_admin := app_rol_id(); END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER devolucion_update BEFORE UPDATE ON devolucion
    FOR EACH ROW EXECUTE FUNCTION trg_devolucion_update();

CREATE FUNCTION trg_devolucion_aprobada() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
BEGIN
    IF NEW.estado = 'APROBADA' AND OLD.estado <> 'APROBADA' THEN
        UPDATE pedido SET estado = 'DEVUELTO' WHERE id_pedido = NEW.id_pedido AND estado = 'ENTREGADO';
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER devolucion_aprobada AFTER UPDATE OF estado ON devolucion
    FOR EACH ROW EXECUTE FUNCTION trg_devolucion_aprobada();

CREATE FUNCTION trg_financiamiento_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE v_ped pedido%ROWTYPE;
BEGIN
    SELECT * INTO v_ped FROM pedido WHERE id_pedido = NEW.id_pedido;
    IF NOT FOUND OR v_ped.id_comprador <> NEW.id_comprador THEN
        RAISE EXCEPTION 'El pedido no pertenece a este comprador' USING ERRCODE = '42501';
    END IF;
    NEW.monto_total  := v_ped.total;
    NEW.tasa_mensual := 0.0150;
    NEW.monto_plazo  := round(v_ped.total * (1 + NEW.tasa_mensual * NEW.num_plazos) / NEW.num_plazos, 2);
    NEW.estado       := 'ACTIVO';
    RETURN NEW;
END $$;
CREATE TRIGGER financiamiento_insert BEFORE INSERT ON financiamiento
    FOR EACH ROW EXECUTE FUNCTION trg_financiamiento_insert();

-- ════════════════════════════════════════════════════════════
--  11. AUDITORÍA ENCADENADA (cada registro guarda el hash del anterior)
--  hash_actual = SHA-256(hash_anterior | tabla | operación | id | datos | usuario | fecha)
--  Si alguien altera o borra un registro del log, la cadena se rompe.
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION fn_log_hash(p_prev text, p_tabla text, p_op text, p_id text,
                            p_old jsonb, p_new jsonb, p_usuario uuid, p_fecha timestamptz)
RETURNS char(64) LANGUAGE sql IMMUTABLE AS $$
    SELECT encode(digest(concat_ws('|', p_prev, p_tabla, p_op, coalesce(p_id, ''),
                  coalesce(p_old::text, ''), coalesce(p_new::text, ''), coalesce(p_usuario::text, ''),
                  to_char(p_fecha AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'sha256'), 'hex')
$$;

CREATE FUNCTION trg_auditoria() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = agro, public AS $$
DECLARE
    v_ocultar text[] := ARRAY['password_hash','telefono_cifrado','rfc_cifrado','rfc_hash','geom','poligono'];
    v_ruido   text[] := ARRAY['fecha_actualizacion','ultimo_login','intentos_fallidos','bloqueado_hasta'];
    v_old  jsonb;
    v_new  jsonb;
    v_id   text;
    v_prev char(64);
    v_fecha timestamptz := date_trunc('milliseconds', clock_timestamp());
BEGIN
    IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD) - v_ocultar; END IF;
    IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW) - v_ocultar; END IF;
    IF TG_OP = 'UPDATE' AND (v_old - v_ruido) = (v_new - v_ruido) THEN
        RETURN NULL;   -- cambio sin importancia (p. ej. solo último login)
    END IF;
    v_id := coalesce(v_new, v_old) ->> TG_ARGV[0];

    PERFORM pg_advisory_xact_lock(770077);   -- la cadena se escribe en orden
    SELECT hash_actual INTO v_prev FROM log_cambios ORDER BY id_log DESC LIMIT 1;
    v_prev := coalesce(v_prev, repeat('0', 64));

    INSERT INTO log_cambios(tabla_afectada, operacion, id_registro, datos_anteriores, datos_nuevos,
                            usuario_app, rol_app, usuario_bd, fecha, hash_anterior, hash_actual)
    VALUES (TG_TABLE_NAME, TG_OP, v_id, v_old, v_new, app_user_id(), app_role(), session_user, v_fecha, v_prev,
            fn_log_hash(v_prev, TG_TABLE_NAME, TG_OP, v_id, v_old, v_new, app_user_id(), v_fecha));
    RETURN NULL;
END $$;

DO $$
DECLARE t record;
BEGIN
    FOR t IN SELECT * FROM (VALUES
        ('usuario','id_usuario'), ('comprador','id_comprador'), ('vendedor','id_vendedor'),
        ('administrador','id_admin'), ('categoria','id_categoria'), ('producto','id_producto'),
        ('producto_imagen','id_imagen'), ('terreno','id_terreno'), ('terreno_imagen','id_imagen'),
        ('pedido','id_pedido'), ('detalle_pedido','id_detalle'), ('envio','id_envio'),
        ('pago','id_pago'), ('calificacion','id_calificacion'), ('devolucion','id_devolucion'),
        ('financiamiento','id_financiamiento')) AS x(tabla, pk)
    LOOP
        EXECUTE format('CREATE TRIGGER z_auditoria AFTER INSERT OR UPDATE OR DELETE ON %I
                        FOR EACH ROW EXECUTE FUNCTION trg_auditoria(%L)', t.tabla, t.pk);
    END LOOP;
END $$;

-- El log no se puede modificar ni borrar
CREATE FUNCTION trg_log_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'La bitácora de auditoría es de solo escritura' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER log_inmutable BEFORE UPDATE OR DELETE ON log_cambios
    FOR EACH ROW EXECUTE FUNCTION trg_log_inmutable();
CREATE TRIGGER log_no_truncate BEFORE TRUNCATE ON log_cambios
    FOR EACH STATEMENT EXECUTE FUNCTION trg_log_inmutable();

-- fecha_actualizacion automática
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['usuario','comprador','vendedor','administrador','categoria','producto',
                             'terreno','pedido','envio','pago','devolucion','financiamiento']
    LOOP
        EXECUTE format('CREATE TRIGGER a_fecha_actualizacion BEFORE UPDATE ON %I
                        FOR EACH ROW EXECUTE FUNCTION trg_fecha_actualizacion()', t);
    END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════
--  12. VERIFICACIÓN DE INTEGRIDAD (la usa el panel de Administración)
-- ════════════════════════════════════════════════════════════
CREATE FUNCTION fn_verificar_integridad()
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
END $$;

-- ════════════════════════════════════════════════════════════
--  13. VISTAS PÚBLICAS (exponen solo lo necesario)
-- ════════════════════════════════════════════════════════════
CREATE VIEW v_vendedor_publico WITH (security_barrier) AS
SELECT v.id_vendedor, v.id_usuario, v.nombre_negocio, v.verificado, v.ubicacion, v.descripcion,
       ST_Y(v.geom) AS lat, ST_X(v.geom) AS lng,
       coalesce(c.promedio, 0)::float8 AS rating,
       coalesce(c.total, 0)::int        AS total_calificaciones,
       coalesce(e.ventas, 0)::int       AS ventas,
       s.nivel AS score_nivel, s.puntos AS score_puntos
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
       vp.ventas AS vendedor_ventas, vp.total_calificaciones AS vendedor_calificaciones
FROM producto p
JOIN categoria c ON c.id_categoria = p.id_categoria
JOIN v_vendedor_publico vp ON vp.id_vendedor = p.id_vendedor
WHERE p.estado <> 'INACTIVO';

CREATE VIEW v_terreno_catalogo WITH (security_barrier) AS
SELECT t.id_terreno, t.id_vendedor, t.titulo, t.descripcion, t.superficie_ha, t.ubicacion,
       ST_Y(t.geom) AS lat, ST_X(t.geom) AS lng, t.geom,
       t.precio, t.moneda, t.tipo_operacion, t.estado, t.tags, t.fecha_publicacion,
       (SELECT i.url FROM terreno_imagen i WHERE i.id_terreno = t.id_terreno
        ORDER BY i.es_principal DESC, i.orden LIMIT 1) AS imagen,
       vp.nombre_negocio AS vendedor_nombre, vp.verificado AS vendedor_verificado,
       vp.rating AS vendedor_rating
FROM terreno t
JOIN v_vendedor_publico vp ON vp.id_vendedor = t.id_vendedor
WHERE t.estado <> 'INACTIVO';

CREATE VIEW v_calificacion_publica WITH (security_barrier) AS
SELECT c.id_calificacion, c.id_vendedor, c.puntuacion, c.comentario, c.fecha,
       v.nombre_negocio AS vendedor_nombre,
       fn_comprador_display(c.id_comprador) AS comprador,
       (SELECT string_agg(d.nombre_producto, ', ') FROM detalle_pedido d WHERE d.id_pedido = c.id_pedido) AS productos
FROM calificacion c JOIN vendedor v ON v.id_vendedor = c.id_vendedor;

-- Estadísticas públicas de la página de inicio
CREATE VIEW v_estadisticas_publicas AS
SELECT (SELECT count(*) FROM producto WHERE estado = 'ACTIVO')           AS productos,
       (SELECT count(*) FROM terreno  WHERE estado = 'DISPONIBLE')       AS terrenos,
       (SELECT count(*) FROM pedido)                                     AS pedidos,
       (SELECT count(*) FROM vendedor v JOIN usuario u USING (id_usuario)
         WHERE u.estado = 'ACTIVO')                                      AS vendedores;

RESET ROLE;
