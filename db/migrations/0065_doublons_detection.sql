-- Détection des doublons (9 novembre 2026, phase D2) : ressemblances trouvées par le worker, visibles de
-- l'administration seulement. Une ressemblance n'a aucun effet automatique : c'est une alerte.
CREATE TABLE core.video_matches (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id       uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,   -- la plus récente
    other_video_id uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    level          text NOT NULL CHECK (level IN ('exact', 'strong', 'possible')),
    visual_score   real,
    audio_score    real,
    camera_score   real,
    detected_at    timestamptz NOT NULL DEFAULT now(),
    dismissed_at   timestamptz,
    UNIQUE (video_id, other_video_id),
    CHECK (video_id <> other_video_id)
);
CREATE INDEX video_matches_other ON core.video_matches (other_video_id);
REVOKE ALL ON core.video_matches FROM PUBLIC;

CREATE FUNCTION core.fingerprint_of(p_video uuid)
RETURNS TABLE (algo_version smallint, visual bytea, visual_mirror bytea, audio bytea, camera bytea, original_sha256 bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT f.algo_version, f.visual, f.visual_mirror, f.audio, f.camera, v.original_sha256
      FROM core.video_fingerprints f JOIN core.videos v ON v.id = f.video_id
     WHERE f.video_id = p_video;
$$;

CREATE FUNCTION core.fingerprints_page(p_after uuid, p_limit integer, p_exclude uuid)
RETURNS TABLE (video_id uuid, algo_version smallint, visual bytea, visual_mirror bytea, audio bytea, camera bytea, original_sha256 bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT f.video_id, f.algo_version, f.visual, f.visual_mirror, f.audio, f.camera, v.original_sha256
      FROM core.video_fingerprints f JOIN core.videos v ON v.id = f.video_id
     WHERE f.video_id <> p_exclude AND (p_after IS NULL OR f.video_id > p_after)
     ORDER BY f.video_id LIMIT least(p_limit, 500);
$$;

CREATE FUNCTION core.save_match(p_video uuid, p_other uuid, p_level text, p_visual real, p_audio real, p_camera real) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    INSERT INTO core.video_matches (video_id, other_video_id, level, visual_score, audio_score, camera_score)
    SELECT p_video, p_other, p_level, p_visual, p_audio, p_camera
     WHERE NOT EXISTS (SELECT 1 FROM core.video_matches WHERE video_id = p_other AND other_video_id = p_video)
    ON CONFLICT (video_id, other_video_id) DO NOTHING;
$$;

-- Au retrait par la source, ses ressemblances disparaissent avec ses empreintes.
CREATE OR REPLACE FUNCTION core.erase_withdrawn_fingerprints() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    DELETE FROM core.video_fingerprints WHERE video_id = NEW.id;
    DELETE FROM core.video_matches WHERE video_id = NEW.id OR other_video_id = NEW.id;
    RETURN NULL;
END;
$$;

CREATE FUNCTION core.admin_matches(p_admin uuid, p_dismissed boolean)
RETURNS TABLE (id uuid, level text, visual_score real, audio_score real, camera_score real, detected_at timestamptz,
               video_id uuid, video_pseudonym text, video_status text, other_video_id uuid, other_pseudonym text, other_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY
    SELECT m.id, m.level, m.visual_score, m.audio_score, m.camera_score, m.detected_at,
           m.video_id, pa.pseudonym, va.status, m.other_video_id, pb.pseudonym, vb.status
      FROM core.video_matches m
      JOIN core.videos va ON va.id = m.video_id
      JOIN core.videos vb ON vb.id = m.other_video_id
      LEFT JOIN core.pseudonyms pa ON pa.video_id = m.video_id
      LEFT JOIN core.pseudonyms pb ON pb.video_id = m.other_video_id
     WHERE (m.dismissed_at IS NOT NULL) = p_dismissed
     ORDER BY array_position(ARRAY['exact', 'strong', 'possible'], m.level), m.detected_at DESC
     LIMIT 300;
END $$;

CREATE FUNCTION core.admin_dismiss_match(p_admin uuid, p_match uuid, p_dismiss boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    UPDATE core.video_matches SET dismissed_at = CASE WHEN p_dismiss THEN now() END WHERE id = p_match;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
END $$;

CREATE FUNCTION core.admin_dashboard_matches(p_admin uuid) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN (SELECT count(*)::int FROM core.video_matches WHERE dismissed_at IS NULL);
END $$;

REVOKE ALL ON FUNCTION core.fingerprint_of(uuid), core.fingerprints_page(uuid, integer, uuid),
                       core.save_match(uuid, uuid, text, real, real, real), core.admin_matches(uuid, boolean),
                       core.admin_dismiss_match(uuid, uuid, boolean), core.admin_dashboard_matches(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.fingerprint_of(uuid), core.fingerprints_page(uuid, integer, uuid),
                          core.save_match(uuid, uuid, text, real, real, real) TO argos_worker;
GRANT EXECUTE ON FUNCTION core.admin_matches(uuid, boolean), core.admin_dismiss_match(uuid, uuid, boolean),
                          core.admin_dashboard_matches(uuid) TO argos_app;
