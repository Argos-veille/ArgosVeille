-- Codes bêta : supprimer ceux qui ne servent plus (révoqués ou expirés), pour garder une liste courte
-- (demande de l’administrateur, 7 novembre 2026). Un code encore valable ne peut pas être supprimé : le révoquer d'abord.
CREATE FUNCTION core.admin_delete_beta_codes(p_admin uuid, p_id uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    DELETE FROM core.beta_codes
     WHERE (p_id IS NULL OR id = p_id)
       AND (revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= now()));
    GET DIAGNOSTICS n = ROW_COUNT;
    IF p_id IS NOT NULL AND n = 0 THEN
        RAISE EXCEPTION 'argos:code_encore_actif';
    END IF;
    RETURN n;
END $$;
REVOKE ALL ON FUNCTION core.admin_delete_beta_codes(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_delete_beta_codes(uuid, uuid) TO argos_app;
