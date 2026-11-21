-- ============================================================
--  AgroConnecta — 06_perfiles.sql   (v2.1: perfiles públicos)
--  Idempotente: se puede ejecutar varias veces sin dañar datos.
--  En una instalación nueva corre solo; en una existente lo aplica
--  ./iniciar.sh (o: docker compose exec db psql -U agro_admin -d agroconnecta
--                     -f /docker-entrypoint-initdb.d/06_perfiles.sql)
-- ============================================================
SET ROLE agro_owner;
SET search_path = agro, public;

-- Registro de actualizaciones aplicadas (iniciar.sh no repite las ya aplicadas)
CREATE TABLE IF NOT EXISTS migracion (
    nombre      VARCHAR(80) PRIMARY KEY,
    aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Perfil del vendedor: se agrega "miembro_desde" (columna nueva al final)
CREATE OR REPLACE VIEW v_vendedor_publico WITH (security_barrier) AS
SELECT v.id_vendedor, v.id_usuario, v.nombre_negocio, v.verificado, v.ubicacion, v.descripcion,
       ST_Y(v.geom) AS lat, ST_X(v.geom) AS lng,
       coalesce(c.promedio, 0)::float8 AS rating,
       coalesce(c.total, 0)::int        AS total_calificaciones,
       coalesce(e.ventas, 0)::int       AS ventas,
       s.nivel AS score_nivel, s.puntos AS score_puntos,
       u.fecha_registro AS miembro_desde,
       u.nombre || ' ' || left(u.apellido, 1) || '.' AS responsable
FROM vendedor v
JOIN usuario u ON u.id_usuario = v.id_usuario AND u.estado = 'ACTIVO'
LEFT JOIN LATERAL (SELECT round(avg(puntuacion), 1) AS promedio, count(*) AS total
                   FROM calificacion WHERE id_vendedor = v.id_vendedor) c ON true
LEFT JOIN LATERAL (SELECT count(*) AS ventas FROM pedido
                   WHERE id_vendedor = v.id_vendedor AND estado = 'ENTREGADO') e ON true
LEFT JOIN score_agroconfianza s ON s.id_usuario = v.id_usuario;

-- Reseñas públicas: se agrega id_comprador para enlazar al perfil del comprador
CREATE OR REPLACE VIEW v_calificacion_publica WITH (security_barrier) AS
SELECT c.id_calificacion, c.id_vendedor, c.puntuacion, c.comentario, c.fecha,
       v.nombre_negocio AS vendedor_nombre,
       fn_comprador_display(c.id_comprador) AS comprador,
       (SELECT string_agg(d.nombre_producto, ', ') FROM detalle_pedido d WHERE d.id_pedido = c.id_pedido) AS productos,
       c.id_comprador
FROM calificacion c JOIN vendedor v ON v.id_vendedor = c.id_vendedor;

-- Perfil del comprador (solo para usuarios con sesión; sin datos personales)
CREATE OR REPLACE FUNCTION fn_perfil_comprador(p_id_comprador uuid)
RETURNS TABLE(id_comprador uuid, nombre text, ciudad text, miembro_desde timestamptz, puntos int, nivel text,
              transacciones int, compras_entregadas int, compras_canceladas int, resenas_escritas int,
              devoluciones int, vendedores_distintos int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = agro, public AS $$
#variable_conflict use_column
BEGIN
    IF app_user_id() IS NULL THEN
        RAISE EXCEPTION 'Inicia sesión para ver perfiles de compradores' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT c.id_comprador, (u.nombre || ' ' || left(u.apellido, 1) || '.')::text,
           -- solo el municipio/ciudad, nunca la dirección
           split_part(coalesce(c.ciudad, ''), ',', 1)::text,
           u.fecha_registro, coalesce(s.puntos, 0), coalesce(s.nivel, 'BRONCE')::text, coalesce(s.total_transacciones, 0),
           (SELECT count(*) FROM pedido p WHERE p.id_comprador = c.id_comprador AND p.estado = 'ENTREGADO')::int,
           (SELECT count(*) FROM pedido p WHERE p.id_comprador = c.id_comprador AND p.estado = 'CANCELADO')::int,
           (SELECT count(*) FROM calificacion k WHERE k.id_comprador = c.id_comprador)::int,
           (SELECT count(*) FROM devolucion d WHERE d.id_comprador = c.id_comprador AND d.estado = 'APROBADA')::int,
           (SELECT count(DISTINCT p.id_vendedor) FROM pedido p WHERE p.id_comprador = c.id_comprador AND p.estado = 'ENTREGADO')::int
    FROM comprador c
    JOIN usuario u ON u.id_usuario = c.id_usuario AND u.estado = 'ACTIVO'
    LEFT JOIN score_agroconfianza s ON s.id_usuario = c.id_usuario
    WHERE c.id_comprador = p_id_comprador;
END $$;

INSERT INTO migracion(nombre) VALUES ('06_perfiles.sql') ON CONFLICT DO NOTHING;

RESET ROLE;

REVOKE EXECUTE ON FUNCTION agro.fn_perfil_comprador(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agro.fn_perfil_comprador(uuid) TO agro_app;
GRANT SELECT ON agro.v_vendedor_publico, agro.v_calificacion_publica TO agro_app, agro_lectura;
