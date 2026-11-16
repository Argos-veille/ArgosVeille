-- Suppression d'une vidéo en échec de traitement par le super-administrateur (9 novembre 2026, demande de l’administrateur) :
-- clé physique et motif, inscrite au journal public. Réservée à cet état ; jamais sous gel légal.
CREATE FUNCTION core.admin_delete_failed(p_admin uuid, p_video uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v record;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF char_length(btrim(p_reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'argos:motif'; END IF;
    SELECT status, legal_hold INTO v FROM core.videos WHERE id = p_video FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'argos:introuvable'; END IF;
    IF v.status <> 'failed' OR v.legal_hold THEN RAISE EXCEPTION 'argos:action_impossible'; END IF;
    PERFORM ledger.append('admin_action', jsonb_build_object('action', 'delete_failed', 'video', p_video, 'reason', btrim(p_reason)));
    DELETE FROM core.videos WHERE id = p_video;
END $$;
REVOKE ALL ON FUNCTION core.admin_delete_failed(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_delete_failed(uuid, uuid, text) TO argos_app;
