-- Empreintes des vidéos, pour repérer les doublons (9 novembre 2026, validé par l’administrateur).
-- Calculées par le worker sur la copie de travail, avant le floutage. Elles ne permettent ni de revoir
-- ni de réécouter la vidéo, et ne sont lisibles que par le worker (aucun droit pour le site).
-- Effacées quand la source retire sa vidéo ; gardées après un retrait légal (alerte si elle revient).
-- Pas d'empreinte du son si la source a choisi de le retirer.
CREATE TABLE core.video_fingerprints (
    video_id      uuid PRIMARY KEY REFERENCES core.videos (id) ON DELETE CASCADE,
    computed_at   timestamptz NOT NULL DEFAULT now(),
    algo_version  smallint NOT NULL CHECK (algo_version >= 1),
    origin        text NOT NULL CHECK (origin IN ('working_copy', 'blurred')),
    visual        bytea NOT NULL CHECK (octet_length(visual) % 8 = 0 AND octet_length(visual) <= 1048576),
    visual_mirror bytea NOT NULL CHECK (octet_length(visual_mirror) = octet_length(visual)),
    audio         bytea CHECK (octet_length(audio) % 4 = 0 AND octet_length(audio) <= 1048576),
    camera        bytea CHECK (octet_length(camera) % 8 = 0 AND octet_length(camera) <= 1048576)
);
REVOKE ALL ON core.video_fingerprints FROM PUBLIC;

-- Le verrou sur la vidéo évite qu'une empreinte s'écrive juste après un retrait.
CREATE FUNCTION core.save_fingerprints(p_video uuid, p_version smallint, p_origin text, p_visual bytea,
                                       p_visual_mirror bytea, p_audio bytea, p_camera bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    s text;
BEGIN
    SELECT status INTO s FROM core.videos WHERE id = p_video FOR SHARE;
    IF s IS NULL OR s IN ('uploading', 'failed', 'withdrawn') THEN RETURN false; END IF;
    INSERT INTO core.video_fingerprints (video_id, algo_version, origin, visual, visual_mirror, audio, camera)
    VALUES (p_video, p_version, p_origin, p_visual, p_visual_mirror, p_audio, p_camera)
    ON CONFLICT (video_id) DO NOTHING;
    RETURN true;
END;
$$;

-- Vidéos déjà traitées sans empreinte (rattrapage à partir de la version floutée).
CREATE FUNCTION core.fingerprints_missing(p_limit integer) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT v.id FROM core.videos v
     WHERE v.status NOT IN ('uploading', 'processing', 'failed', 'withdrawn')
       AND v.r2_blurred_key IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM core.video_fingerprints f WHERE f.video_id = v.id)
     ORDER BY v.submitted_at DESC LIMIT least(p_limit, 1000);
$$;

CREATE FUNCTION core.erase_withdrawn_fingerprints() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    DELETE FROM core.video_fingerprints WHERE video_id = NEW.id;
    RETURN NULL;
END;
$$;
CREATE TRIGGER videos_withdrawn_erase_fingerprints AFTER UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (NEW.status = 'withdrawn' AND OLD.status IS DISTINCT FROM 'withdrawn')
    EXECUTE FUNCTION core.erase_withdrawn_fingerprints();

REVOKE ALL ON FUNCTION core.save_fingerprints(uuid, smallint, text, bytea, bytea, bytea, bytea),
                       core.fingerprints_missing(integer), core.erase_withdrawn_fingerprints() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.save_fingerprints(uuid, smallint, text, bytea, bytea, bytea, bytea),
                          core.fingerprints_missing(integer) TO argos_worker;
