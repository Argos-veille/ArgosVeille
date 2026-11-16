-- Origine d'une vidéo (9 novembre 2026, demande de l’administrateur) : qui l'a publiée, le lien, des précisions. Visible des relecteurs,
-- des analystes et de l'administration ; sur la fiche publique seulement si la personne qui envoie le choisit, car un
-- compte personnel peut être celui d'un témoin à protéger. Le serveur n'ouvre jamais le lien.
CREATE TABLE core.video_origins (
    video_id     uuid PRIMARY KEY REFERENCES core.videos (id) ON DELETE CASCADE,
    published_by text CHECK (char_length(published_by) BETWEEN 1 AND 200),
    url          text CHECK (url ~ '^https://[^[:space:]]+$' AND char_length(url) <= 500),
    details      text CHECK (char_length(details) BETWEEN 1 AND 2000),
    is_public    boolean NOT NULL DEFAULT false,
    hidden_at    timestamptz,
    CHECK (published_by IS NOT NULL OR url IS NOT NULL OR details IS NOT NULL),
    CHECK (NOT is_public OR published_by IS NOT NULL)
);
REVOKE ALL ON core.video_origins FROM PUBLIC;
GRANT SELECT, INSERT ON core.video_origins TO argos_app;

-- Retirer le crédit public (la personne citée le demande, par exemple) : clé physique et motif, journal.
CREATE FUNCTION core.admin_hide_origin(p_admin uuid, p_video uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF char_length(btrim(p_reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'argos:motif'; END IF;
    UPDATE core.video_origins SET hidden_at = now() WHERE video_id = p_video AND is_public AND hidden_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE EXCEPTION 'argos:introuvable'; END IF;
    PERFORM ledger.append('admin_action', jsonb_build_object('action', 'origin_hidden', 'video', p_video, 'reason', btrim(p_reason)));
END $$;
REVOKE ALL ON FUNCTION core.admin_hide_origin(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_hide_origin(uuid, uuid, text) TO argos_app;

CREATE OR REPLACE FUNCTION core.erase_withdrawn_fingerprints() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    DELETE FROM core.video_fingerprints WHERE video_id = NEW.id;
    DELETE FROM core.video_matches WHERE video_id = NEW.id OR other_video_id = NEW.id;
    DELETE FROM core.event_links WHERE video_id = NEW.id;
    DELETE FROM core.event_proposals WHERE video_id = NEW.id OR target_video_id = NEW.id;
    DELETE FROM core.control_videos WHERE video_id = NEW.id;
    DELETE FROM core.video_origins WHERE video_id = NEW.id;
    RETURN NULL;
END;
$$;
