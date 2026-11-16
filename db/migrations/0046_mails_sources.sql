-- Mails aux sources qui envoient avec leur compte (étape 2, 7 novembre 2026, choix de l’administrateur) :
--   ready     le floutage est prêt à vérifier (toujours envoyé : sans réponse en 7 jours, la vidéo part
--             en relecture avec le floutage automatique)
--   in_review la vidéo est en relecture                       (désactivable)
--   decided   décision : publiée, rejetée, en débat, sans décision (désactivable)
--   legal     masquée ou retirée pour motif légal             (désactivable)
-- Les mails ne disent rien de la vidéo (ni nom, ni contenu) : seulement d'aller voir « Mes vidéos ».
-- File d'attente remplie par un déclencheur sur le statut des vidéos, vidée par le site chaque minute.

ALTER TABLE core.accounts ADD COLUMN notify_owner_review   boolean NOT NULL DEFAULT true,
                          ADD COLUMN notify_owner_decision boolean NOT NULL DEFAULT true,
                          ADD COLUMN notify_owner_legal    boolean NOT NULL DEFAULT true;
GRANT SELECT (notify_owner_review, notify_owner_decision, notify_owner_legal),
      UPDATE (notify_owner_review, notify_owner_decision, notify_owner_legal) ON core.accounts TO argos_app;

CREATE TABLE core.owner_notifications (
    id         bigserial PRIMARY KEY,
    video_id   uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('ready', 'in_review', 'decided', 'legal')),
    status     text NOT NULL,                     -- statut de la vidéo à ce moment
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz
);
CREATE INDEX owner_notifications_a_envoyer ON core.owner_notifications (created_at) WHERE sent_at IS NULL;
REVOKE ALL ON core.owner_notifications FROM PUBLIC;

CREATE FUNCTION core.queue_owner_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_kind text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.video_owners WHERE video_id = NEW.id) THEN
        RETURN NULL;
    END IF;
    v_kind := CASE
        WHEN NEW.status = 'awaiting_author' THEN 'ready'
        WHEN NEW.status = 'in_review' AND OLD.status = 'awaiting_author' THEN 'in_review'
        WHEN NEW.status IN ('published', 'rejected', 'under_debate', 'no_decision') THEN 'decided'
        WHEN NEW.status IN ('hidden', 'removed') THEN 'legal'
    END;
    IF v_kind IS NOT NULL THEN
        INSERT INTO core.owner_notifications (video_id, kind, status) VALUES (NEW.id, v_kind, NEW.status);
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER videos_owner_notification AFTER UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
    EXECUTE FUNCTION core.queue_owner_notification();

-- Mails à envoyer : compte actif et préférence active. Les autres sont marqués envoyés sans mail
-- (préférence coupée, compte fermé, vidéo redevenue anonyme).
CREATE FUNCTION core.take_owner_notifications(p_limit integer DEFAULT 100)
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
       AND (m.kind = 'ready'
            OR (m.kind = 'in_review' AND a.notify_owner_review)
            OR (m.kind = 'decided' AND a.notify_owner_decision)
            OR (m.kind = 'legal' AND a.notify_owner_legal));
END $$;

-- Échec d'envoi (serveur de mail indisponible) : le mail repart au tour suivant.
CREATE FUNCTION core.retry_owner_notification(p_id bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    UPDATE core.owner_notifications SET sent_at = NULL WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION core.queue_owner_notification(), core.take_owner_notifications(integer),
                       core.retry_owner_notification(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.take_owner_notifications(integer), core.retry_owner_notification(bigint) TO argos_app;
