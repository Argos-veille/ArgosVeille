-- Origine d'une vidéo modifiable après coup par le super-administrateur (9 novembre 2026, demande de l’administrateur) : clé physique
-- et motif, inscrit au journal public (le motif seulement, jamais le nom ni le lien). Tout vider supprime l'origine.
DROP FUNCTION core.admin_hide_origin(uuid, uuid, text);

CREATE FUNCTION core.admin_set_origin(p_admin uuid, p_video uuid, p_by text, p_url text, p_details text, p_public boolean, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF char_length(btrim(p_reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'argos:motif'; END IF;
    IF NOT EXISTS (SELECT 1 FROM core.videos WHERE id = p_video AND status NOT IN ('uploading', 'withdrawn')) THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    IF p_public AND p_by IS NULL THEN RAISE EXCEPTION 'argos:origine_invalide'; END IF;
    IF p_by IS NULL AND p_url IS NULL AND p_details IS NULL THEN
        DELETE FROM core.video_origins WHERE video_id = p_video;
    ELSE
        INSERT INTO core.video_origins (video_id, published_by, url, details, is_public) VALUES (p_video, p_by, p_url, p_details, p_public)
        ON CONFLICT (video_id) DO UPDATE SET published_by = EXCLUDED.published_by, url = EXCLUDED.url, details = EXCLUDED.details,
                                             is_public = EXCLUDED.is_public, hidden_at = NULL;
    END IF;
    PERFORM ledger.append('admin_action', jsonb_build_object('action', 'origin_edited', 'video', p_video, 'reason', btrim(p_reason)));
END $$;
REVOKE ALL ON FUNCTION core.admin_set_origin(uuid, uuid, text, text, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_set_origin(uuid, uuid, text, text, text, boolean, text) TO argos_app;
