-- Transmission de l'original (étape 3, 7 novembre 2026, choix de l’administrateur) :
--   - la source autorise (oui/non) l'administration à transmettre l'original non flouté à une association,
--     un avocat ou un journaliste ; l'administration tranche ensuite au cas par cas ;
--   - le navigateur de la source chiffre la clé de l'original pour la clé d'administration (enveloppe
--     ECDH P-256, format ARGOS-E1) : le serveur garde l'enveloppe sans pouvoir l'ouvrir ; la clé secrète
--     est dans la YubiKey de l'administrateur (copie de secours hors ligne) ;
--   - à l'envoi, ou plus tard depuis le suivi avec le code de 12 mots ; retirable à tout moment (les
--     transmissions déjà faites restent) ; retirer la vidéo efface l'autorisation ;
--   - chaque transmission est inscrite au journal public (type de destinataire et motif, jamais de nom)
--     et la source est prévenue (mail si compte, page de suivi sinon).

CREATE TABLE core.release_consents (
    video_id   uuid PRIMARY KEY REFERENCES core.videos (id) ON DELETE CASCADE,
    envelope   jsonb,                              -- NULL une fois l'autorisation retirée
    granted_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    CONSTRAINT release_consents_etat CHECK ((envelope IS NULL) = (revoked_at IS NOT NULL))
);
REVOKE ALL ON core.release_consents FROM PUBLIC;

CREATE TABLE core.original_releases (
    id             bigserial PRIMARY KEY,
    video_id       uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    recipient_kind text NOT NULL CHECK (recipient_kind IN ('association', 'lawyer', 'journalist', 'other')),
    reason         text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 2000),
    released_at    timestamptz NOT NULL DEFAULT now(),
    released_by    uuid REFERENCES core.accounts (id)
);
CREATE INDEX original_releases_video ON core.original_releases (video_id);
REVOKE ALL ON core.original_releases FROM PUBLIC;

-- Autoriser (à l'envoi ou plus tard) : une nouvelle enveloppe remplace l'ancienne.
CREATE FUNCTION core.grant_release(p_video uuid, p_envelope jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF p_envelope IS NULL OR p_envelope ->> 'v' <> '1' OR jsonb_typeof(p_envelope -> 'destinataires') <> 'array' THEN
        RAISE EXCEPTION 'argos:enveloppe_invalide';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.videos WHERE id = p_video
                    AND status NOT IN ('withdrawn', 'removed') AND NOT is_control) THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    INSERT INTO core.release_consents (video_id, envelope) VALUES (p_video, p_envelope)
    ON CONFLICT (video_id) DO UPDATE SET envelope = EXCLUDED.envelope, granted_at = now(), revoked_at = NULL;
END $$;

CREATE FUNCTION core.revoke_release(p_video uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH m AS (UPDATE core.release_consents SET envelope = NULL, revoked_at = now()
                WHERE video_id = p_video AND envelope IS NOT NULL RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM m)
$$;

-- Ce que voit la source : autorisation en cours, et les transmissions faites (date + type de destinataire).
CREATE FUNCTION core.release_status(p_video uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT jsonb_build_object(
        'autorisee', EXISTS (SELECT 1 FROM core.release_consents c WHERE c.video_id = p_video AND c.envelope IS NOT NULL),
        'autoriseeLe', (SELECT c.granted_at FROM core.release_consents c WHERE c.video_id = p_video AND c.envelope IS NOT NULL),
        'transmissions', coalesce((SELECT jsonb_agg(jsonb_build_object('le', r.released_at, 'destinataire', r.recipient_kind)
                                                    ORDER BY r.released_at)
                                     FROM core.original_releases r WHERE r.video_id = p_video), '[]'::jsonb))
$$;

-- Administration : l'enveloppe et l'empreinte de l'original, pour l'ouvrir sur le PC de l'administrateur.
CREATE FUNCTION core.admin_release_envelope(p_admin uuid, p_video uuid)
RETURNS TABLE (envelope jsonb, original_sha256 text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY
    SELECT c.envelope, encode(v.original_sha256, 'hex')
      FROM core.release_consents c JOIN core.videos v ON v.id = c.video_id
     WHERE c.video_id = p_video AND c.envelope IS NOT NULL;
END $$;

-- Une transmission faite : journal public (sans nom) ; la source est prévenue (file des mails / suivi).
CREATE FUNCTION core.record_release(p_admin uuid, p_video uuid, p_recipient text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF p_recipient NOT IN ('association', 'lawyer', 'journalist', 'other') THEN
        RAISE EXCEPTION 'argos:destinataire_inconnu';
    END IF;
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:motif';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.release_consents WHERE video_id = p_video AND envelope IS NOT NULL) THEN
        RAISE EXCEPTION 'argos:pas_autorisee';
    END IF;
    INSERT INTO core.original_releases (video_id, recipient_kind, reason, released_by)
    VALUES (p_video, p_recipient, btrim(p_reason), p_admin);
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', 'original_released', 'video', p_video, 'recipient', p_recipient, 'reason', btrim(p_reason)));
    IF EXISTS (SELECT 1 FROM core.video_owners WHERE video_id = p_video) THEN
        INSERT INTO core.owner_notifications (video_id, kind, status)
        SELECT p_video, 'released', status FROM core.videos WHERE id = p_video;
    END IF;
END $$;

-- Mail « original transmis » pour les vidéos envoyées avec un compte (toujours envoyé : choix C).
ALTER TABLE core.owner_notifications DROP CONSTRAINT owner_notifications_kind_check;
ALTER TABLE core.owner_notifications ADD CONSTRAINT owner_notifications_kind_check
    CHECK (kind IN ('ready', 'in_review', 'decided', 'legal', 'released'));
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
       AND (m.kind IN ('ready', 'released')
            OR (m.kind = 'in_review' AND a.notify_owner_review)
            OR (m.kind = 'decided' AND a.notify_owner_decision)
            OR (m.kind = 'legal' AND a.notify_owner_legal));
END $$;

-- Vidéo retirée (par la source ou pour motif légal) : l'autorisation disparaît avec l'original.
CREATE FUNCTION core.forget_release_consent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    UPDATE core.release_consents SET envelope = NULL, revoked_at = now() WHERE video_id = NEW.id AND envelope IS NOT NULL;
    RETURN NULL;
END $$;
CREATE TRIGGER videos_forget_release_consent AFTER UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (NEW.status IN ('withdrawn', 'removed') AND OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION core.forget_release_consent();

REVOKE ALL ON FUNCTION core.grant_release(uuid, jsonb), core.revoke_release(uuid), core.release_status(uuid),
                       core.admin_release_envelope(uuid, uuid), core.record_release(uuid, uuid, text, text),
                       core.forget_release_consent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.grant_release(uuid, jsonb), core.revoke_release(uuid), core.release_status(uuid),
                          core.admin_release_envelope(uuid, uuid), core.record_release(uuid, uuid, text, text) TO argos_app;
