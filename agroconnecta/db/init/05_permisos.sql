-- ============================================================
--  AgroConnecta — 05_permisos.sql
--  Permisos mínimos por tabla y por COLUMNA para el usuario de la API.
--  • Sin DELETE (soft delete), salvo imágenes.
--  • La API nunca puede leer password_hash ni la tabla sesion.
--  • Los montos/precios no son columnas insertables: los fija la BD.
-- ============================================================
SET search_path = agro, public;

GRANT USAGE ON SCHEMA agro TO agro_app, agro_lectura;

-- Usuario: todo menos el hash de contraseña
GRANT SELECT (id_usuario, nombre, apellido, email, telefono_cifrado, tipo_usuario, estado,
              ultimo_login, fecha_registro, fecha_actualizacion) ON usuario TO agro_app;
GRANT UPDATE (nombre, apellido, email, telefono_cifrado, estado) ON usuario TO agro_app;

GRANT SELECT ON comprador TO agro_app;
GRANT UPDATE (direccion, ciudad) ON comprador TO agro_app;

GRANT SELECT ON vendedor TO agro_app;
GRANT UPDATE (nombre_negocio, rfc_cifrado, rfc_hash, descripcion, ubicacion, geom, verificado) ON vendedor TO agro_app;

GRANT SELECT ON administrador, score_agroconfianza, categoria TO agro_app;
GRANT INSERT (nombre, tipo, id_categoria_padre) ON categoria TO agro_app;
GRANT UPDATE (nombre, tipo, id_categoria_padre, estado) ON categoria TO agro_app;

GRANT SELECT ON producto TO agro_app;
GRANT INSERT (id_vendedor, id_categoria, nombre, descripcion, precio, stock, unidad_medida,
              estado, ubicacion, geom, tags, modificado_por) ON producto TO agro_app;
GRANT UPDATE (id_categoria, nombre, descripcion, precio, stock, unidad_medida,
              estado, ubicacion, geom, tags, modificado_por) ON producto TO agro_app;
GRANT SELECT, INSERT, DELETE ON producto_imagen TO agro_app;
GRANT UPDATE (es_principal, orden, url, sha256) ON producto_imagen TO agro_app;

GRANT SELECT ON terreno TO agro_app;
GRANT INSERT (id_vendedor, titulo, descripcion, superficie_ha, ubicacion, geom, poligono, precio,
              tipo_operacion, estado, tags, modificado_por) ON terreno TO agro_app;
GRANT UPDATE (titulo, descripcion, superficie_ha, ubicacion, geom, poligono, precio,
              tipo_operacion, estado, tags, modificado_por) ON terreno TO agro_app;
GRANT SELECT, INSERT, DELETE ON terreno_imagen TO agro_app;
GRANT UPDATE (es_principal, orden, url, sha256) ON terreno_imagen TO agro_app;

GRANT SELECT ON pedido TO agro_app;
GRANT INSERT (grupo_compra, id_comprador, id_vendedor, modalidad_entrega, direccion_entrega,
              notas, costo_envio, modificado_por) ON pedido TO agro_app;
GRANT UPDATE (estado, notas, modificado_por) ON pedido TO agro_app;

GRANT SELECT ON detalle_pedido TO agro_app;
GRANT INSERT (id_pedido, id_producto, cantidad) ON detalle_pedido TO agro_app;   -- sin precio

GRANT SELECT ON envio, historial_envio TO agro_app;
GRANT UPDATE (transportista, numero_guia, fecha_estimada) ON envio TO agro_app;

GRANT SELECT ON pago TO agro_app;
GRANT INSERT (id_pedido, metodo, proveedor_ref) ON pago TO agro_app;                 -- sin monto
GRANT UPDATE (estado, proveedor_ref, referencia, fecha_pago) ON pago TO agro_app;

GRANT SELECT ON calificacion TO agro_app;
GRANT INSERT (id_pedido, id_comprador, puntuacion, comentario) ON calificacion TO agro_app;

GRANT SELECT ON devolucion TO agro_app;
GRANT INSERT (id_pedido, id_comprador, motivo, evidencia_url) ON devolucion TO agro_app;
GRANT UPDATE (estado, resolucion) ON devolucion TO agro_app;

GRANT SELECT ON financiamiento TO agro_app;
GRANT INSERT (id_comprador, id_pedido, num_plazos) ON financiamiento TO agro_app;
GRANT UPDATE (estado, plazos_pagados) ON financiamiento TO agro_app;

GRANT SELECT ON log_cambios TO agro_app;

-- Vistas públicas
GRANT SELECT ON v_vendedor_publico, v_producto_catalogo, v_terreno_catalogo,
                v_calificacion_publica, v_estadisticas_publicas TO agro_app, agro_lectura;

-- Funciones: nadie las ejecuta salvo a quien se le da permiso
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA agro FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
    app_user_id(), app_role(), app_rol_id(), es_admin(),
    fn_usuario_display(uuid), fn_comprador_display(uuid), fn_contacto_vendedor(uuid),
    fn_registrar_usuario(text, text, text, text, text, bytea, text, bytea, text, text,
                         double precision, double precision, text, text, text),
    fn_id_rol(uuid, text), fn_auth_login(text, text),
    fn_sesion_crear(uuid, text, text, text, timestamptz), fn_sesion_validar(text),
    fn_sesion_cerrar(text), fn_cambiar_password(text, text),
    fn_verificar_integridad()
TO agro_app;
GRANT EXECUTE ON FUNCTION fn_usuario_display(uuid), fn_comprador_display(uuid),
                          app_user_id(), app_role(), app_rol_id(), es_admin() TO agro_lectura;
