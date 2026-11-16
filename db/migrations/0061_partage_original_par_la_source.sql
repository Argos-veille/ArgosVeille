-- La source transmet ELLE-MÊME l'original à un compte vérifié, depuis la messagerie (8 novembre 2026, validé par
-- l’administrateur) : son navigateur chiffre la clé de l'original pour la clé de messagerie du compte vérifié (enveloppe
-- ARGOS-K1, liée à l'empreinte de l'original) ; le serveur ne peut pas l'ouvrir. Le compte vérifié télécharge
-- l'original chiffré et le déchiffre dans son navigateur. La source peut retirer le partage tant qu'il n'a pas été
-- téléchargé ; au premier téléchargement, la transmission est inscrite au journal public (type de destinataire,
-- jamais de nom) et dans les transmissions de la vidéo, comme celles de l'administration.

CREATE TABLE core.original_shares (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES core.conversations (id) ON DELETE CASCADE,
    envelope        jsonb NOT NULL CHECK (length(envelope::text) <= 2000),
    created_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    downloaded_at   timestamptz
);
CREATE UNIQUE INDEX original_shares_un_actif ON core.original_shares (conversation_id) WHERE revoked_at IS NULL;
REVOKE ALL ON core.original_shares FROM PUBLIC;
GRANT SELECT ON core.original_shares TO argos_app;

ALTER TABLE ledger.entries DROP CONSTRAINT entries_kind_check;
ALTER TABLE ledger.entries ADD CONSTRAINT entries_kind_check CHECK (kind IN (
    'video_received', 'decision', 'removal', 'rule_change', 'authority_request', 'admin_action', 'event_link',
    'withdrawal', 'correction', 'original_shared'));

-- Partager (la source) : conversation ouverte avec un compte vérifié (pas l'administration), original disponible.
CREATE FUNCTION core.share_original(p_conversation uuid, p_envelope jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    c core.conversations;
    v_id uuid;
BEGIN
    SELECT * INTO c FROM core.conversations WHERE id = p_conversation FOR UPDATE;
    IF c.id IS NULL OR c.closed_at IS NOT NULL THEN RAISE EXCEPTION 'argos:conversation_fermee'; END IF;
    IF c.with_admin THEN RAISE EXCEPTION 'argos:conversation_admin'; END IF;
    IF NOT EXISTS (SELECT 1 FROM core.verifications WHERE account_id = c.verified_account_id
                     AND category IN ('journalist', 'lawyer', 'association') AND revoked_at IS NULL AND expires_at > now()) THEN
        RAISE EXCEPTION 'argos:compte_non_verifie';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.pseudonyms p JOIN core.videos v ON v.id = p.video_id
                    WHERE p.id = c.pseudonym_id AND v.status NOT IN ('uploading', 'withdrawn', 'removed')
                      AND v.original_sha256 IS NOT NULL) THEN
        RAISE EXCEPTION 'argos:video_indisponible';
    END IF;
    IF p_envelope ->> 'v' <> '1' OR p_envelope ->> 'epk' IS NULL OR p_envelope ->> 'chiffre' IS NULL THEN
        RAISE EXCEPTION 'argos:enveloppe_invalide';
    END IF;
    UPDATE core.original_shares SET revoked_at = now() WHERE conversation_id = c.id AND revoked_at IS NULL AND downloaded_at IS NULL;
    IF EXISTS (SELECT 1 FROM core.original_shares WHERE conversation_id = c.id AND revoked_at IS NULL) THEN
        RAISE EXCEPTION 'argos:deja_telecharge';   -- déjà téléchargé : rien à repartager
    END IF;
    INSERT INTO core.original_shares (conversation_id, envelope) VALUES (c.id, p_envelope) RETURNING id INTO v_id;
    RETURN v_id;
END $$;

-- Retirer (la source), tant que ce n'est pas téléchargé.
CREATE FUNCTION core.revoke_share(p_conversation uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH m AS (UPDATE core.original_shares SET revoked_at = now()
                WHERE conversation_id = p_conversation AND revoked_at IS NULL AND downloaded_at IS NULL RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM m);
$$;

-- Télécharger (le compte vérifié de la conversation) : l'enveloppe, la vidéo, l'empreinte de l'original. Au premier
-- téléchargement : transmission inscrite (vidéo, journal public, mail à la source qui a envoyé avec son compte).
CREATE FUNCTION core.take_share(p_account uuid, p_conversation uuid)
RETURNS TABLE (envelope jsonb, video_id uuid, original_sha256 text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    s core.original_shares;
    c core.conversations;
    v uuid;
    cat text;
BEGIN
    SELECT * INTO c FROM core.conversations WHERE id = p_conversation AND verified_account_id = p_account AND NOT with_admin;
    IF c.id IS NULL THEN RAISE EXCEPTION 'argos:introuvable'; END IF;
    SELECT category INTO cat FROM core.verifications WHERE account_id = p_account
       AND category IN ('journalist', 'lawyer', 'association') AND revoked_at IS NULL AND expires_at > now()
     ORDER BY verified_at DESC LIMIT 1;
    IF cat IS NULL THEN RAISE EXCEPTION 'argos:compte_non_verifie'; END IF;
    SELECT * INTO s FROM core.original_shares WHERE conversation_id = c.id AND revoked_at IS NULL FOR UPDATE;
    IF s.id IS NULL THEN RAISE EXCEPTION 'argos:pas_de_partage'; END IF;
    SELECT p.video_id INTO v FROM core.pseudonyms p WHERE p.id = c.pseudonym_id;
    IF NOT EXISTS (SELECT 1 FROM core.videos WHERE id = v AND status NOT IN ('withdrawn', 'removed')) THEN
        RAISE EXCEPTION 'argos:video_indisponible';
    END IF;
    IF s.downloaded_at IS NULL THEN
        UPDATE core.original_shares SET downloaded_at = now() WHERE id = s.id;
        INSERT INTO core.original_releases (video_id, recipient_kind, reason, released_by)
        VALUES (v, cat, 'Transmis directement par la source, depuis la messagerie.', NULL);
        PERFORM ledger.append('original_shared', jsonb_build_object('video', v, 'recipient', cat));
        IF EXISTS (SELECT 1 FROM core.video_owners o WHERE o.video_id = v) THEN
            INSERT INTO core.owner_notifications (video_id, kind, status) SELECT v, 'released', status FROM core.videos WHERE id = v;
        END IF;
    END IF;
    RETURN QUERY SELECT s.envelope, v, encode(vi.original_sha256, 'hex') FROM core.videos vi WHERE vi.id = v;
END $$;

-- État d'un partage pour une conversation (les deux côtés).
CREATE FUNCTION core.share_state(p_conversation uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('le', s.created_at, 'telechargeLe', s.downloaded_at) END
      FROM (SELECT 1) x LEFT JOIN core.original_shares s ON s.conversation_id = p_conversation AND s.revoked_at IS NULL;
$$;

REVOKE ALL ON FUNCTION core.share_original(uuid, jsonb), core.revoke_share(uuid), core.take_share(uuid, uuid),
                       core.share_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.share_original(uuid, jsonb), core.revoke_share(uuid), core.take_share(uuid, uuid),
                          core.share_state(uuid) TO argos_app;
