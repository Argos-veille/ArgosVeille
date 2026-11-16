-- Revue de sécurité B7 : un re-floutage ne fait jamais réapparaître une vidéo retirée (par sa source ou pour motif
-- légal). La demande en cours est abandonnée au retrait ; le worker n'en prend plus ; et s'il finit quand même un
-- re-floutage commencé avant, la base le refuse et le worker efface ce qu'il a produit.
CREATE OR REPLACE FUNCTION core.take_reblur() RETURNS TABLE (id uuid, video_id uuid, zones jsonb, keep_audio boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    UPDATE core.reblur_requests r SET failed_at = now()
     WHERE r.done_at IS NULL AND r.failed_at IS NULL AND r.attempts >= 3 AND r.started_at < now() - interval '2 hours';
    RETURN QUERY
    UPDATE core.reblur_requests r SET started_at = now(), attempts = r.attempts + 1
     WHERE r.id = (SELECT q.id FROM core.reblur_requests q JOIN core.videos v ON v.id = q.video_id
                    WHERE q.source_ready_at IS NOT NULL AND q.done_at IS NULL AND q.failed_at IS NULL AND q.attempts < 3
                      AND (q.started_at IS NULL OR q.started_at < now() - interval '2 hours')
                      AND v.status NOT IN ('withdrawn', 'removed')
                    ORDER BY q.created_at LIMIT 1 FOR UPDATE OF q SKIP LOCKED)
    RETURNING r.id, r.video_id, r.zones, (SELECT v.keep_audio FROM core.videos v WHERE v.id = r.video_id);
END $$;

-- Renvoie vrai si le re-floutage est accepté ; faux si la vidéo a été retirée entre-temps (le worker efface alors tout).
DROP FUNCTION core.finish_reblur(uuid, bytea);
CREATE FUNCTION core.finish_reblur(p_id uuid, p_sha bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_video uuid;
BEGIN
    SELECT r.video_id INTO v_video FROM core.reblur_requests r JOIN core.videos v ON v.id = r.video_id
     WHERE r.id = p_id AND r.done_at IS NULL AND v.status NOT IN ('withdrawn', 'removed') FOR UPDATE OF v;
    IF NOT FOUND THEN
        UPDATE core.reblur_requests SET failed_at = now() WHERE id = p_id AND done_at IS NULL AND failed_at IS NULL;
        RETURN false;
    END IF;
    UPDATE core.reblur_requests SET done_at = now() WHERE id = p_id;
    UPDATE core.videos SET blurred_sha256 = p_sha WHERE id = v_video;
    RETURN true;
END $$;
REVOKE ALL ON FUNCTION core.finish_reblur(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.finish_reblur(uuid, bytea) TO argos_worker;

-- Au retrait, la demande de re-floutage en cours est abandonnée.
CREATE FUNCTION core.cancel_reblur_on_removal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    UPDATE core.reblur_requests SET failed_at = now() WHERE video_id = NEW.id AND done_at IS NULL AND failed_at IS NULL;
    RETURN NEW;
END $$;
CREATE TRIGGER videos_cancel_reblur AFTER UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (NEW.status IN ('withdrawn', 'removed') AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION core.cancel_reblur_on_removal();
REVOKE ALL ON FUNCTION core.cancel_reblur_on_removal() FROM PUBLIC;
