-- Re-flouter une vidéo déjà postée (8 novembre 2026, validé par l’administrateur) : l'ADMINISTRATION seulement, après un
-- signalement, AJOUTE des zones de flou sur la version floutée (jamais en retirer : il n'y a plus d'image nette).
-- En relecture, devant le jury, publiée ou en débat. L'API prépare la version actuelle (depuis R2 en production) à
-- côté de la vidéo, le worker la réencode avec les zones, la nouvelle version remplace l'ancienne (qui reste visible
-- d'ici là). Journal public : « floutage complété », sans détail. La décision des relecteurs reste valable.

CREATE TABLE core.reblur_requests (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id        uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    zones           jsonb NOT NULL CHECK (jsonb_typeof(zones) = 'array' AND jsonb_array_length(zones) BETWEEN 1 AND 50),
    reason          text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
    requested_by    uuid REFERENCES core.accounts (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    source_ready_at timestamptz,
    started_at      timestamptz,
    attempts        integer NOT NULL DEFAULT 0,
    done_at         timestamptz,
    failed_at       timestamptz
);
CREATE UNIQUE INDEX reblur_un_en_cours ON core.reblur_requests (video_id) WHERE done_at IS NULL AND failed_at IS NULL;
REVOKE ALL ON core.reblur_requests FROM PUBLIC;

CREATE FUNCTION core.admin_request_reblur(p_admin uuid, p_video uuid, p_zones jsonb, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_id uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'argos:motif'; END IF;
    IF NOT EXISTS (SELECT 1 FROM core.videos WHERE id = p_video AND status IN ('in_review', 'jury', 'published', 'under_debate')) THEN
        RAISE EXCEPTION 'argos:action_impossible';
    END IF;
    IF EXISTS (SELECT 1 FROM core.reblur_requests WHERE video_id = p_video AND done_at IS NULL AND failed_at IS NULL) THEN
        RAISE EXCEPTION 'argos:deja_en_cours';
    END IF;
    INSERT INTO core.reblur_requests (video_id, zones, reason, requested_by) VALUES (p_video, p_zones, btrim(p_reason), p_admin)
    RETURNING id INTO v_id;
    PERFORM ledger.append('admin_action', jsonb_build_object('action', 'reblur', 'video', p_video));
    RETURN v_id;
END $$;

-- L'API a déposé la version actuelle à côté de la vidéo : le worker peut commencer.
CREATE FUNCTION core.reblur_source_ready(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    UPDATE core.reblur_requests SET source_ready_at = now() WHERE id = p_id AND source_ready_at IS NULL;
$$;

CREATE FUNCTION core.reblur_state(p_video uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT jsonb_build_object('enCours', EXISTS (SELECT 1 FROM core.reblur_requests WHERE video_id = p_video AND done_at IS NULL AND failed_at IS NULL),
                              'derniere', (SELECT jsonb_build_object('le', coalesce(done_at, failed_at, created_at), 'echec', failed_at IS NOT NULL,
                                                                     'faite', done_at IS NOT NULL)
                                             FROM core.reblur_requests WHERE video_id = p_video ORDER BY created_at DESC LIMIT 1));
$$;

-- Worker : la plus ancienne demande prête (3 essais au plus, reprise après 2 heures sans nouvelles).
CREATE FUNCTION core.take_reblur() RETURNS TABLE (id uuid, video_id uuid, zones jsonb, keep_audio boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    UPDATE core.reblur_requests r SET failed_at = now()
     WHERE r.done_at IS NULL AND r.failed_at IS NULL AND r.attempts >= 3 AND r.started_at < now() - interval '2 hours';
    RETURN QUERY
    UPDATE core.reblur_requests r SET started_at = now(), attempts = r.attempts + 1
     WHERE r.id = (SELECT q.id FROM core.reblur_requests q
                    WHERE q.source_ready_at IS NOT NULL AND q.done_at IS NULL AND q.failed_at IS NULL AND q.attempts < 3
                      AND (q.started_at IS NULL OR q.started_at < now() - interval '2 hours')
                    ORDER BY q.created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING r.id, r.video_id, r.zones, (SELECT v.keep_audio FROM core.videos v WHERE v.id = r.video_id);
END $$;

CREATE FUNCTION core.finish_reblur(p_id uuid, p_sha bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH r AS (UPDATE core.reblur_requests SET done_at = now() WHERE id = p_id AND done_at IS NULL RETURNING video_id)
    UPDATE core.videos v SET blurred_sha256 = p_sha FROM r WHERE v.id = r.video_id;
$$;

CREATE FUNCTION core.fail_reblur(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    UPDATE core.reblur_requests SET failed_at = now() WHERE id = p_id AND done_at IS NULL;
$$;

REVOKE ALL ON FUNCTION core.admin_request_reblur(uuid, uuid, jsonb, text), core.reblur_source_ready(uuid), core.reblur_state(uuid),
                       core.take_reblur(), core.finish_reblur(uuid, bytea), core.fail_reblur(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_request_reblur(uuid, uuid, jsonb, text), core.reblur_source_ready(uuid), core.reblur_state(uuid)
    TO argos_app;
GRANT EXECUTE ON FUNCTION core.take_reblur(), core.finish_reblur(uuid, bytea), core.fail_reblur(uuid) TO argos_worker;
