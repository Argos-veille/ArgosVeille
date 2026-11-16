-- Ajout d'une vidéo par un lien (9 novembre 2026, choix de l’administrateur) : ouvert à tout le monde. Le lien sert uniquement à
-- récupérer la vidéo : personne ne le voit, et il est effacé dès la récupération finie ou impossible.
ALTER TABLE core.videos DROP CONSTRAINT videos_failure_reason_check;
ALTER TABLE core.videos ADD CONSTRAINT videos_failure_reason_check CHECK (failure_reason IN ('not_a_video', 'unsupported_format', 'too_long', 'too_large', 'unreadable', 'processing_error', 'fetch_failed'));

CREATE TABLE core.video_fetches (
    video_id   uuid PRIMARY KEY REFERENCES core.videos (id) ON DELETE CASCADE,
    url        text NOT NULL CHECK (url ~ '^https://[^[:space:]]+$' AND char_length(url) <= 2048),
    created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON core.video_fetches FROM PUBLIC;
GRANT INSERT ON core.video_fetches TO argos_app;

CREATE FUNCTION core.take_fetch(p_video uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT url FROM core.video_fetches WHERE video_id = p_video;
$$;

CREATE FUNCTION core.finish_fetch(p_video uuid, p_sha256 bytea, p_enc_sha256 bytea, p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    UPDATE core.videos SET original_sha256 = p_sha256, original_enc_sha256 = p_enc_sha256, r2_original_enc_key = p_key
     WHERE id = p_video AND status = 'processing';
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM core.video_fetches WHERE video_id = p_video;
    RETURN n = 1;
END $$;

-- Échec ou retrait : le lien ne reste jamais.
CREATE FUNCTION core.erase_fetch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    DELETE FROM core.video_fetches WHERE video_id = NEW.id;
    RETURN NULL;
END $$;
CREATE TRIGGER videos_erase_fetch AFTER UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (NEW.status IN ('failed', 'withdrawn')) EXECUTE FUNCTION core.erase_fetch();

REVOKE ALL ON FUNCTION core.take_fetch(uuid), core.finish_fetch(uuid, bytea, bytea, text), core.erase_fetch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.take_fetch(uuid), core.finish_fetch(uuid, bytea, bytea, text) TO argos_worker;
