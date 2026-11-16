-- Administration, phase A3 (5 novembre 2026) : gestion des comptes et messagerie avec l'administration.
--
-- Décisions de l’administrateur (5 novembre 2026) :
--   - sanctions au journal public SANS le pseudo (type, durée, motif) ;
--   - un mail motivé au compte à chaque suspension ou bannissement ;
--   - l'administration ne voit pas l'adresse mail, mais peut écrire au compte, qui peut répondre :
--     conversation sur le site (mail « vous avez un message », réponse depuis « Mon compte »).
-- Messages entre l'administration et un compte : en clair dans la base (ce n'est pas la messagerie
-- chiffrée de bout en bout prévue pour les témoins).

ALTER TABLE core.sanctions ADD COLUMN reason text,
                           ADD COLUMN lifted_at timestamptz;
ALTER TABLE core.sanctions DROP CONSTRAINT sanctions_kind_check;
ALTER TABLE core.sanctions ADD CONSTRAINT sanctions_kind_check CHECK (kind IN ('logout', 'suspend', 'ban'));

CREATE TABLE core.account_messages (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    from_admin boolean NOT NULL,
    body       text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at    timestamptz
);
CREATE INDEX account_messages_compte ON core.account_messages (account_id, created_at);
CREATE INDEX account_messages_non_lus ON core.account_messages (from_admin, account_id) WHERE read_at IS NULL;

-- Liste des comptes. Filtres : text (pseudo), status, analyst, mfa, unread (réponses non lues).
CREATE FUNCTION core.admin_accounts(p_admin uuid, p_filters jsonb)
RETURNS TABLE (id uuid, username text, created_at timestamptz, status text, suspended_until timestamptz, score numeric,
               votes integer, last_vote_at timestamptz, last_seen timestamptz, mfa boolean, analyst boolean, suspect boolean,
               superadmin boolean, unread integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    f_text    text := nullif(btrim(coalesce(p_filters ->> 'text', '')), '');
    f_status  text := p_filters ->> 'status';
    f_analyst boolean := coalesce((p_filters ->> 'analyst')::boolean, false);
    f_mfa     boolean := coalesce((p_filters ->> 'mfa')::boolean, false);
    f_unread  boolean := coalesce((p_filters ->> 'unread')::boolean, false);
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY
        SELECT c.x_id, c.x_username, c.x_created, c.x_status, c.x_until, c.x_score, c.x_votes, c.x_last_vote, c.x_seen,
               c.x_mfa, c.x_analyst, c.x_suspect, c.x_superadmin, c.x_unread
          FROM (
            SELECT a.id AS x_id, a.username AS x_username, a.created_at AS x_created, a.status AS x_status,
                   a.suspended_until AS x_until, a.score AS x_score,
                   (SELECT count(*)::int FROM core.votes vo WHERE vo.account_id = a.id) AS x_votes,
                   a.last_vote_at AS x_last_vote,
                   (SELECT max(s.last_seen_at) FROM core.sessions s WHERE s.account_id = a.id) AS x_seen,
                   EXISTS (SELECT 1 FROM core.mfa_factors m WHERE m.account_id = a.id AND m.revoked_at IS NULL) AS x_mfa,
                   coalesce(core.is_osint_analyst(a.id), false) AS x_analyst, a.suspect AS x_suspect, a.is_superadmin AS x_superadmin,
                   (SELECT count(*)::int FROM core.account_messages am
                     WHERE am.account_id = a.id AND NOT am.from_admin AND am.read_at IS NULL) AS x_unread
              FROM core.accounts a
             WHERE a.status <> 'deleted'
               AND (f_text IS NULL OR a.username ILIKE '%' || f_text || '%' OR a.id::text = f_text)
               AND (f_status IS NULL OR a.status = f_status)
        ) c
         WHERE (NOT f_analyst OR c.x_analyst) AND (NOT f_mfa OR c.x_mfa) AND (NOT f_unread OR c.x_unread > 0)
         ORDER BY c.x_unread DESC, c.x_created DESC
         LIMIT 300;
END $$;

-- Fiche d'un compte : activité (des totaux), sanctions, conversation. Marque les réponses comme lues.
CREATE FUNCTION core.admin_account(p_admin uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    r jsonb;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    SELECT jsonb_build_object(
        'id', a.id, 'pseudo', a.username, 'inscritLe', a.created_at, 'statut', a.status, 'suspenduJusqua', a.suspended_until,
        'score', a.score, 'suspect', a.suspect, 'superAdmin', a.is_superadmin,
        'analyste', coalesce(core.is_osint_analyst(a.id), false),
        'doubleAuth', (SELECT coalesce(jsonb_agg(DISTINCT m.kind), '[]'::jsonb) FROM core.mfa_factors m
                        WHERE m.account_id = a.id AND m.revoked_at IS NULL),
        'sessionsOuvertes', (SELECT count(*) FROM core.sessions s WHERE s.account_id = a.id AND s.revoked_at IS NULL AND s.expires_at > now()),
        'derniereActivite', (SELECT max(s.last_seen_at) FROM core.sessions s WHERE s.account_id = a.id),
        'activite', jsonb_build_object(
            'votes', (SELECT count(*) FROM core.votes vo WHERE vo.account_id = a.id AND vo.round = 'review'),
            'votesJury', (SELECT count(*) FROM core.votes vo WHERE vo.account_id = a.id AND vo.round = 'jury'),
            'dernierVote', a.last_vote_at,
            'convocations30j', (SELECT count(*) FROM core.summons s WHERE s.account_id = a.id AND s.sent_at > now() - interval '30 days'),
            'notes', (SELECT count(*) FROM core.osint_notes n WHERE n.author_id = a.id),
            'notesMasquees', (SELECT count(*) FROM core.osint_notes n WHERE n.author_id = a.id AND n.masked_at IS NOT NULL),
            'corrections', (SELECT count(*) FROM core.context_corrections c WHERE c.author_id = a.id),
            'signalements', (SELECT count(*) FROM core.reports rp WHERE rp.reporter_id = a.id)),
        'sanctions', (SELECT coalesce(jsonb_agg(jsonb_build_object('type', s.kind, 'le', s.starts_at, 'fin', s.ends_at,
                                                                     'motif', s.reason, 'leveeLe', s.lifted_at) ORDER BY s.starts_at DESC), '[]'::jsonb)
                        FROM core.sanctions s WHERE s.account_id = a.id),
        'messages', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', am.id, 'deLAdmin', am.from_admin, 'texte', am.body,
                                                                    'le', am.created_at, 'luLe', am.read_at) ORDER BY am.created_at), '[]'::jsonb)
                       FROM core.account_messages am WHERE am.account_id = a.id)
    ) INTO r
      FROM core.accounts a WHERE a.id = p_id AND a.status <> 'deleted';
    IF r IS NULL THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    UPDATE core.account_messages SET read_at = now() WHERE account_id = p_id AND NOT from_admin AND read_at IS NULL;
    RETURN r;
END $$;

-- Déconnecter, suspendre (1 à 365 jours), lever une suspension, bannir. Motif obligatoire.
-- Journal public : le type, la durée et le motif, jamais le pseudo.
CREATE FUNCTION core.admin_sanction(p_admin uuid, p_account uuid, p_action text, p_days integer, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    c record;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF p_action NOT IN ('logout', 'suspend', 'lift', 'ban') THEN
        RAISE EXCEPTION 'argos:action_inconnue';
    END IF;
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:motif';
    END IF;
    SELECT id, status, is_superadmin INTO c FROM core.accounts WHERE id = p_account AND status <> 'deleted' FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    IF c.is_superadmin THEN
        RAISE EXCEPTION 'argos:action_impossible';
    END IF;

    IF p_action = 'logout' THEN
        INSERT INTO core.sanctions (account_id, kind, reason_code, reason, issued_by) VALUES (p_account, 'logout', 'admin', btrim(p_reason), p_admin);
    ELSIF p_action = 'suspend' THEN
        IF c.status = 'banned' OR p_days IS NULL OR p_days NOT BETWEEN 1 AND 365 THEN RAISE EXCEPTION 'argos:action_impossible'; END IF;
        UPDATE core.accounts SET status = 'suspended', suspended_until = now() + make_interval(days => p_days) WHERE id = p_account;
        INSERT INTO core.sanctions (account_id, kind, reason_code, reason, ends_at, issued_by)
        VALUES (p_account, 'suspend', 'admin', btrim(p_reason), now() + make_interval(days => p_days), p_admin);
    ELSIF p_action = 'lift' THEN
        IF c.status <> 'suspended' THEN RAISE EXCEPTION 'argos:action_impossible'; END IF;
        UPDATE core.accounts SET status = 'active', suspended_until = NULL WHERE id = p_account;
        UPDATE core.sanctions SET lifted_at = now() WHERE account_id = p_account AND kind = 'suspend' AND lifted_at IS NULL;
    ELSE
        IF c.status = 'banned' THEN RAISE EXCEPTION 'argos:deja_ainsi'; END IF;
        UPDATE core.accounts SET status = 'banned', suspended_until = NULL WHERE id = p_account;
        INSERT INTO core.sanctions (account_id, kind, reason_code, reason, issued_by) VALUES (p_account, 'ban', 'admin', btrim(p_reason), p_admin);
    END IF;
    IF p_action <> 'lift' THEN
        UPDATE core.sessions SET revoked_at = now() WHERE account_id = p_account AND revoked_at IS NULL;
    END IF;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', CASE p_action WHEN 'logout' THEN 'logout_account' WHEN 'suspend' THEN 'suspend_account'
                                WHEN 'lift' THEN 'lift_suspension' ELSE 'ban_account' END,
        'days', CASE WHEN p_action = 'suspend' THEN p_days END, 'reason', btrim(p_reason)));
END $$;

-- Suspensions arrivées à échéance : le compte redevient actif (appelé par le moteur).
CREATE FUNCTION core.lift_expired_suspensions() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    UPDATE core.accounts SET status = 'active', suspended_until = NULL
     WHERE status = 'suspended' AND suspended_until <= now();
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- Messages : l'administration écrit ; le compte lit et répond (seulement dans une conversation déjà ouverte
-- par l'administration, 20 réponses par jour au plus).
CREATE FUNCTION core.admin_send_message(p_admin uuid, p_account uuid, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_id uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_account AND status <> 'deleted' AND NOT is_superadmin) THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    IF length(btrim(coalesce(p_body, ''))) NOT BETWEEN 2 AND 5000 THEN
        RAISE EXCEPTION 'argos:message_invalide';
    END IF;
    INSERT INTO core.account_messages (account_id, from_admin, body) VALUES (p_account, true, btrim(p_body)) RETURNING id INTO v_id;
    RETURN v_id;
END $$;

CREATE FUNCTION core.my_messages(p_account uuid)
RETURNS TABLE (id uuid, from_admin boolean, body text, created_at timestamptz, read_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    RETURN QUERY SELECT am.id, am.from_admin, am.body, am.created_at, am.read_at
                   FROM core.account_messages am WHERE am.account_id = p_account ORDER BY am.created_at;
    UPDATE core.account_messages am SET read_at = now() WHERE am.account_id = p_account AND am.from_admin AND am.read_at IS NULL;
END $$;

CREATE FUNCTION core.my_unread_messages(p_account uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT count(*)::int FROM core.account_messages WHERE account_id = p_account AND from_admin AND read_at IS NULL;
$$;

CREATE FUNCTION core.reply_message(p_account uuid, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.account_messages WHERE account_id = p_account AND from_admin) THEN
        RAISE EXCEPTION 'argos:aucune_conversation';
    END IF;
    IF length(btrim(coalesce(p_body, ''))) NOT BETWEEN 2 AND 5000 THEN
        RAISE EXCEPTION 'argos:message_invalide';
    END IF;
    IF (SELECT count(*) FROM core.account_messages WHERE account_id = p_account AND NOT from_admin
          AND created_at > now() - interval '24 hours') >= 20 THEN
        RAISE EXCEPTION 'argos:trop_de_messages';
    END IF;
    INSERT INTO core.account_messages (account_id, from_admin, body) VALUES (p_account, false, btrim(p_body)) RETURNING id INTO v_id;
    RETURN v_id;
END $$;

-- Tableau de bord : les réponses non lues s'ajoutent à « à traiter ».
CREATE OR REPLACE FUNCTION core.admin_dashboard_messages(p_admin uuid) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN (SELECT count(DISTINCT account_id)::int FROM core.account_messages WHERE NOT from_admin AND read_at IS NULL);
END $$;

REVOKE ALL ON TABLE core.account_messages FROM PUBLIC;
REVOKE ALL ON FUNCTION core.admin_accounts(uuid, jsonb), core.admin_account(uuid, uuid),
                       core.admin_sanction(uuid, uuid, text, integer, text), core.lift_expired_suspensions(),
                       core.admin_send_message(uuid, uuid, text), core.my_messages(uuid), core.my_unread_messages(uuid),
                       core.reply_message(uuid, text), core.admin_dashboard_messages(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_accounts(uuid, jsonb), core.admin_account(uuid, uuid),
                          core.admin_sanction(uuid, uuid, text, integer, text), core.admin_send_message(uuid, uuid, text),
                          core.my_messages(uuid), core.my_unread_messages(uuid), core.reply_message(uuid, text),
                          core.admin_dashboard_messages(uuid) TO argos_app;
GRANT EXECUTE ON FUNCTION core.lift_expired_suspensions() TO argos_scoring;
