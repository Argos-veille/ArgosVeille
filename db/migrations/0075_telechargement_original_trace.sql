-- Téléchargement de l'original par l'administration (9 novembre 2026, demande de l’administrateur) : clé physique et motif,
-- inscrit au journal public, et la source est prévenue. Sans cela, l'original pouvait être ouvert sans laisser de trace.
CREATE TABLE core.original_downloads (
    id            bigserial PRIMARY KEY,
    video_id      uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    reason        text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
    downloaded_at timestamptz NOT NULL DEFAULT now(),
    downloaded_by uuid REFERENCES core.accounts (id)
);
CREATE INDEX original_downloads_video ON core.original_downloads (video_id);
REVOKE ALL ON core.original_downloads FROM PUBLIC;

ALTER TABLE core.owner_notifications DROP CONSTRAINT owner_notifications_kind_check;
ALTER TABLE core.owner_notifications ADD CONSTRAINT owner_notifications_kind_check CHECK (kind IN ('ready', 'in_review', 'decided', 'legal', 'released', 'original_downloaded'));

-- Remplace core.admin_release_envelope : plus aucun moyen d'obtenir l'enveloppe sans laisser de trace.
DROP FUNCTION core.admin_release_envelope(uuid, uuid);
CREATE FUNCTION core.admin_open_original(p_admin uuid, p_video uuid, p_reason text)
RETURNS TABLE (envelope jsonb, original_sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'argos:motif'; END IF;
    IF NOT EXISTS (SELECT 1 FROM core.release_consents c WHERE c.video_id = p_video AND c.envelope IS NOT NULL) THEN
        RAISE EXCEPTION 'argos:pas_autorisee';
    END IF;
    INSERT INTO core.original_downloads (video_id, reason, downloaded_by) VALUES (p_video, btrim(p_reason), p_admin);
    PERFORM ledger.append('admin_action', jsonb_build_object('action', 'original_downloaded', 'video', p_video, 'reason', btrim(p_reason)));
    IF EXISTS (SELECT 1 FROM core.video_owners WHERE video_id = p_video) THEN
        INSERT INTO core.owner_notifications (video_id, kind, status)
        SELECT p_video, 'original_downloaded', status FROM core.videos WHERE id = p_video;
    END IF;
    RETURN QUERY
    SELECT c.envelope, encode(v.original_sha256, 'hex')
      FROM core.release_consents c JOIN core.videos v ON v.id = c.video_id WHERE c.video_id = p_video;
END $$;
REVOKE ALL ON FUNCTION core.admin_open_original(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_open_original(uuid, uuid, text) TO argos_app;

CREATE OR REPLACE FUNCTION core.release_status(p_video uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT jsonb_build_object(
        'autorisee', EXISTS (SELECT 1 FROM core.release_consents c WHERE c.video_id = p_video AND c.envelope IS NOT NULL),
        'autoriseeLe', (SELECT c.granted_at FROM core.release_consents c WHERE c.video_id = p_video AND c.envelope IS NOT NULL),
        'transmissions', coalesce((SELECT jsonb_agg(jsonb_build_object('le', r.released_at, 'destinataire', r.recipient_kind)
                                                    ORDER BY r.released_at)
                                     FROM core.original_releases r WHERE r.video_id = p_video), '[]'::jsonb),
        'telechargements', coalesce((SELECT jsonb_agg(d.downloaded_at ORDER BY d.downloaded_at)
                                       FROM core.original_downloads d WHERE d.video_id = p_video), '[]'::jsonb))
$$;

CREATE OR REPLACE FUNCTION core.take_owner_notifications(p_limit integer DEFAULT 100)
RETURNS TABLE (id bigint, account_id uuid, kind text, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    RETURN QUERY
    WITH lot AS (
        SELECT n.id FROM core.owner_notifications n
         WHERE n.sent_at IS NULL ORDER BY n.created_at LIMIT p_limit FOR UPDATE SKIP LOCKED
    ), marques AS (
        UPDATE core.owner_notifications n SET sent_at = now() FROM lot WHERE n.id = lot.id
        RETURNING n.id, n.video_id, n.kind, n.status
    )
    SELECT m.id, a.id, m.kind, m.status
      FROM marques m
      JOIN core.video_owners o ON o.video_id = m.video_id
      JOIN core.accounts a ON a.id = o.account_id
     WHERE a.status = 'active'
       AND (m.kind IN ('ready', 'released', 'original_downloaded')
            OR (m.kind = 'in_review' AND a.notify_owner_review)
            OR (m.kind = 'decided' AND a.notify_owner_decision)
            OR (m.kind = 'legal' AND a.notify_owner_legal));
END $$;
