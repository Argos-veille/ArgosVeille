-- Messagerie avec les sources, M3 (8 novembre 2026, validé par l’administrateur) :
--   1. mails sans contenu, au plus un par jour et par compte :
--        - à la source qui a envoyé AVEC SON COMPTE : « un message vous attend » (aucun mail pour un envoi anonyme :
--          la source revient avec son code) ; désactivable (notify_owner_message) ;
--        - au compte vérifié quand la source lui répond ; désactivable (notify_source_replies) ;
--        - jamais à l'administration (non-lus sur son tableau de bord) ;
--   2. signaler un message reçu ; le texte peut être révélé à l'administration (le site le vérifie en le déchiffrant
--      avec la clé du message que fournit la personne : il ne peut pas être inventé). L'administration le traite.

ALTER TABLE core.accounts
    ADD COLUMN notify_owner_message  boolean NOT NULL DEFAULT true,
    ADD COLUMN notify_source_replies boolean NOT NULL DEFAULT true,
    ADD COLUMN messages_notified_at  timestamptz;
GRANT SELECT (notify_owner_message, notify_source_replies),
      UPDATE (notify_owner_message, notify_source_replies) ON core.accounts TO argos_app;

-- Comptes à prévenir maintenant (et note l'envoi) : un message non lu de l'autre partie, arrivé depuis le dernier mail,
-- dernier mail il y a plus de 24 heures. « source » : propriétaire d'une vidéo (envoi avec compte) ; « verifie » : compte
-- vérifié à qui la source a répondu.
CREATE FUNCTION core.take_message_notifications() RETURNS TABLE (account_id uuid, kind text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH candidats AS (
        SELECT o.account_id, 'source'::text AS kind
          FROM core.conversations c JOIN core.pseudonyms p ON p.id = c.pseudonym_id
          JOIN core.video_owners o ON o.video_id = p.video_id JOIN core.accounts a ON a.id = o.account_id
         WHERE a.notify_owner_message AND a.status = 'active'
           AND c.last_message_at > coalesce(c.witness_read_at, '-infinity')
           AND c.last_message_at > coalesce(a.messages_notified_at, '-infinity')
           AND coalesce(a.messages_notified_at, '-infinity') < now() - interval '24 hours'
        UNION
        SELECT c.verified_account_id, 'verifie'
          FROM core.conversations c JOIN core.accounts a ON a.id = c.verified_account_id
         WHERE NOT c.with_admin AND a.notify_source_replies AND a.status = 'active' AND NOT a.is_superadmin
           AND c.last_message_at > coalesce(c.verified_read_at, '-infinity')
           AND c.last_message_at > coalesce(a.messages_notified_at, '-infinity')
           AND coalesce(a.messages_notified_at, '-infinity') < now() - interval '24 hours'
    ), uniques AS (
        SELECT DISTINCT ON (account_id) account_id, kind FROM candidats ORDER BY account_id, kind
    ), notes AS (
        UPDATE core.accounts a SET messages_notified_at = now() FROM uniques u WHERE a.id = u.account_id RETURNING a.id
    )
    SELECT u.account_id, u.kind FROM uniques u JOIN notes n ON n.id = u.account_id;
$$;

-- Signalement d'un message : traitement par l'administration.
ALTER TABLE core.messages ADD COLUMN report_handled_at timestamptz;

CREATE FUNCTION core.admin_reported_messages(p_admin uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'message', m.id, 'conversation', c.id, 'video', p.video_id, 'pseudonyme', p.pseudonym,
                'de', CASE WHEN m.sender = 'witness' THEN 'source' WHEN c.with_admin THEN 'administration' ELSE 'compte' END,
                'compte', CASE WHEN m.sender = 'verified' AND NOT c.with_admin THEN a.username END,
                'envoyeLe', m.sent_at, 'signaleLe', m.reported_at, 'texte', m.revealed_text,
                'conversationOuverte', c.closed_at IS NULL) ORDER BY m.reported_at), '[]'::jsonb)
              FROM core.messages m JOIN core.conversations c ON c.id = m.conversation_id
              JOIN core.pseudonyms p ON p.id = c.pseudonym_id LEFT JOIN core.accounts a ON a.id = c.verified_account_id
             WHERE m.reported_at IS NOT NULL AND m.report_handled_at IS NULL);
END $$;

CREATE FUNCTION core.admin_handle_reported_message(p_admin uuid, p_message uuid, p_close boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_conv uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    UPDATE core.messages SET report_handled_at = now()
     WHERE id = p_message AND reported_at IS NOT NULL AND report_handled_at IS NULL
    RETURNING conversation_id INTO v_conv;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    IF p_close THEN
        UPDATE core.conversations SET closed_at = now() WHERE id = v_conv AND closed_at IS NULL;
    END IF;
END $$;

REVOKE ALL ON FUNCTION core.take_message_notifications(), core.admin_reported_messages(uuid),
                       core.admin_handle_reported_message(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.take_message_notifications(), core.admin_reported_messages(uuid),
                          core.admin_handle_reported_message(uuid, uuid, boolean) TO argos_app;
