-- ============================================================
--  AgroConnecta — 04_seguridad_rls.sql
--  Row Level Security: cada fila solo la ve / modifica quien debe.
--  Aplica al usuario de la API (agro_app). El dueño (agro_owner) y el
--  administrador de la BD no están sujetos a estas políticas.
-- ============================================================
SET ROLE agro_owner;
SET search_path = agro, public;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['usuario','comprador','vendedor','administrador','sesion','score_agroconfianza',
        'categoria','producto','producto_imagen','terreno','terreno_imagen','pedido','detalle_pedido',
        'envio','historial_envio','pago','calificacion','devolucion','financiamiento','log_cambios']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END $$;

-- ─── Usuarios y perfiles ─────────────────────────────────────
CREATE POLICY usuario_propio ON usuario FOR SELECT TO agro_app
    USING (id_usuario = app_user_id() OR es_admin());
CREATE POLICY usuario_actualizar ON usuario FOR UPDATE TO agro_app
    USING (id_usuario = app_user_id() OR es_admin())
    WITH CHECK (id_usuario = app_user_id() OR es_admin());

CREATE POLICY comprador_ver ON comprador FOR SELECT TO agro_app
    USING (id_usuario = app_user_id() OR es_admin()
           OR (app_role() = 'VENDEDOR' AND EXISTS (
                SELECT 1 FROM pedido p WHERE p.id_comprador = comprador.id_comprador
                                         AND p.id_vendedor = app_rol_id())));
CREATE POLICY comprador_actualizar ON comprador FOR UPDATE TO agro_app
    USING (id_usuario = app_user_id() OR es_admin());

CREATE POLICY vendedor_ver ON vendedor FOR SELECT TO agro_app USING (true);
CREATE POLICY vendedor_actualizar ON vendedor FOR UPDATE TO agro_app
    USING (id_usuario = app_user_id() OR es_admin())
    WITH CHECK (id_usuario = app_user_id() OR es_admin());

CREATE POLICY administrador_ver ON administrador FOR SELECT TO agro_app
    USING (id_usuario = app_user_id() OR es_admin());

CREATE POLICY score_ver ON score_agroconfianza FOR SELECT TO agro_app USING (true);
-- sesion: sin políticas para agro_app → solo accesible vía funciones SECURITY DEFINER

-- ─── Catálogo ────────────────────────────────────────────────
CREATE POLICY categoria_ver ON categoria FOR SELECT TO agro_app USING (true);
CREATE POLICY categoria_admin_ins ON categoria FOR INSERT TO agro_app WITH CHECK (es_admin());
CREATE POLICY categoria_admin_upd ON categoria FOR UPDATE TO agro_app USING (es_admin());

CREATE POLICY producto_ver ON producto FOR SELECT TO agro_app
    USING (estado <> 'INACTIVO' OR id_vendedor = app_rol_id() OR es_admin());
CREATE POLICY producto_crear ON producto FOR INSERT TO agro_app
    WITH CHECK ((app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id()) OR es_admin());
CREATE POLICY producto_editar ON producto FOR UPDATE TO agro_app
    USING ((app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id()) OR es_admin())
    WITH CHECK ((app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id()) OR es_admin());

CREATE POLICY prodimg_ver ON producto_imagen FOR SELECT TO agro_app USING (true);
CREATE POLICY prodimg_dueno ON producto_imagen FOR ALL TO agro_app
    USING (EXISTS (SELECT 1 FROM producto p WHERE p.id_producto = producto_imagen.id_producto
                   AND ((app_role() = 'VENDEDOR' AND p.id_vendedor = app_rol_id()) OR es_admin())))
    WITH CHECK (EXISTS (SELECT 1 FROM producto p WHERE p.id_producto = producto_imagen.id_producto
                   AND ((app_role() = 'VENDEDOR' AND p.id_vendedor = app_rol_id()) OR es_admin())));

CREATE POLICY terreno_ver ON terreno FOR SELECT TO agro_app
    USING (estado <> 'INACTIVO' OR id_vendedor = app_rol_id() OR es_admin());
CREATE POLICY terreno_crear ON terreno FOR INSERT TO agro_app
    WITH CHECK ((app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id()) OR es_admin());
CREATE POLICY terreno_editar ON terreno FOR UPDATE TO agro_app
    USING ((app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id()) OR es_admin())
    WITH CHECK ((app_role() = 'VENDEDOR' AND id_vendedor = app_rol_id()) OR es_admin());

CREATE POLICY terrimg_ver ON terreno_imagen FOR SELECT TO agro_app USING (true);
CREATE POLICY terrimg_dueno ON terreno_imagen FOR ALL TO agro_app
    USING (EXISTS (SELECT 1 FROM terreno t WHERE t.id_terreno = terreno_imagen.id_terreno
                   AND ((app_role() = 'VENDEDOR' AND t.id_vendedor = app_rol_id()) OR es_admin())))
    WITH CHECK (EXISTS (SELECT 1 FROM terreno t WHERE t.id_terreno = terreno_imagen.id_terreno
                   AND ((app_role() = 'VENDEDOR' AND t.id_vendedor = app_rol_id()) OR es_admin())));

-- ─── Pedidos: comprador dueño, vendedor del pedido o admin ────
CREATE POLICY pedido_ver ON pedido FOR SELECT TO agro_app
    USING (id_comprador = app_rol_id() OR id_vendedor = app_rol_id() OR es_admin());
CREATE POLICY pedido_crear ON pedido FOR INSERT TO agro_app
    WITH CHECK (app_role() = 'COMPRADOR' AND id_comprador = app_rol_id());
CREATE POLICY pedido_actualizar ON pedido FOR UPDATE TO agro_app
    USING (id_comprador = app_rol_id() OR id_vendedor = app_rol_id() OR es_admin());

CREATE POLICY detalle_ver ON detalle_pedido FOR SELECT TO agro_app
    USING (EXISTS (SELECT 1 FROM pedido p WHERE p.id_pedido = detalle_pedido.id_pedido));
CREATE POLICY detalle_crear ON detalle_pedido FOR INSERT TO agro_app
    WITH CHECK (EXISTS (SELECT 1 FROM pedido p WHERE p.id_pedido = detalle_pedido.id_pedido
                        AND p.id_comprador = app_rol_id() AND p.estado = 'PENDIENTE'));

CREATE POLICY envio_ver ON envio FOR SELECT TO agro_app
    USING (EXISTS (SELECT 1 FROM pedido p WHERE p.id_pedido = envio.id_pedido));
CREATE POLICY envio_vendedor ON envio FOR UPDATE TO agro_app
    USING (EXISTS (SELECT 1 FROM pedido p WHERE p.id_pedido = envio.id_pedido
                   AND (p.id_vendedor = app_rol_id() OR es_admin())));

CREATE POLICY historial_ver ON historial_envio FOR SELECT TO agro_app
    USING (EXISTS (SELECT 1 FROM envio e JOIN pedido p ON p.id_pedido = e.id_pedido
                   WHERE e.id_envio = historial_envio.id_envio));

CREATE POLICY pago_ver ON pago FOR SELECT TO agro_app
    USING (EXISTS (SELECT 1 FROM pedido p WHERE p.id_pedido = pago.id_pedido));
CREATE POLICY pago_crear ON pago FOR INSERT TO agro_app
    WITH CHECK (EXISTS (SELECT 1 FROM pedido p WHERE p.id_pedido = pago.id_pedido
                        AND p.id_comprador = app_rol_id()));
-- Solo el sistema (confirmación de Stripe / Mercado Pago) o un admin cambian el estado de un pago
CREATE POLICY pago_sistema ON pago FOR UPDATE TO agro_app
    USING (es_admin()) WITH CHECK (es_admin());

-- ─── Reputación y postventa ─────────────────────────────────
CREATE POLICY calificacion_ver ON calificacion FOR SELECT TO agro_app USING (true);
CREATE POLICY calificacion_crear ON calificacion FOR INSERT TO agro_app
    WITH CHECK (app_role() = 'COMPRADOR' AND id_comprador = app_rol_id());

CREATE POLICY devolucion_ver ON devolucion FOR SELECT TO agro_app
    USING (id_comprador = app_rol_id() OR es_admin()
           OR EXISTS (SELECT 1 FROM pedido p WHERE p.id_pedido = devolucion.id_pedido
                      AND p.id_vendedor = app_rol_id()));
CREATE POLICY devolucion_crear ON devolucion FOR INSERT TO agro_app
    WITH CHECK (app_role() = 'COMPRADOR' AND id_comprador = app_rol_id());
CREATE POLICY devolucion_admin ON devolucion FOR UPDATE TO agro_app USING (es_admin());

CREATE POLICY financiamiento_ver ON financiamiento FOR SELECT TO agro_app
    USING (id_comprador = app_rol_id() OR es_admin());
CREATE POLICY financiamiento_crear ON financiamiento FOR INSERT TO agro_app
    WITH CHECK (app_role() = 'COMPRADOR' AND id_comprador = app_rol_id());
CREATE POLICY financiamiento_admin ON financiamiento FOR UPDATE TO agro_app USING (es_admin());

CREATE POLICY log_admin ON log_cambios FOR SELECT TO agro_app USING (es_admin());

RESET ROLE;
