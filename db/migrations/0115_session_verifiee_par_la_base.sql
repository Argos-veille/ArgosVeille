-- Lien compte ↔ vidéo (15 novembre 2026, dernier point de la revue) : my_videos, owned_video et owned_code croyaient
-- l'identifiant de compte donné par le site. Un site compromis pouvait donc lister les vidéos de n'importe quel compte,
-- c'est-à-dire désigner leur source. Désormais :
--   - ces fonctions reçoivent l'empreinte du jeton de session (cookie) et retrouvent elles-mêmes le compte ;
--   - le site ne peut plus lire les empreintes de session (colonne token_hash) : il ne connaît que celles des
--     visiteurs qui lui envoient leur cookie ; la session est lue par une fonction de la base.

-- Lecture d'une session valable (même règle qu'avant dans le site : non retirée, non expirée, active récemment).
CREATE FUNCTION core.read_session(p_token_hash bytea, p_inactivity_days integer)
RETURNS TABLE (id uuid, account_id uuid, last_seen_at timestamptz, username text, status text, suspended_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT s.id, s.account_id, s.last_seen_at, a.username, a.status, a.suspended_until
      FROM core.sessions s JOIN core.accounts a ON a.id = s.account_id
     WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
       AND s.last_seen_at > now() - make_interval(days => least(greatest(p_inactivity_days, 1), 30))
$$;

-- Compte d'une session valable et active, ou NULL.
CREATE FUNCTION core.session_account(p_token_hash bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT s.account_id FROM core.sessions s JOIN core.accounts a ON a.id = s.account_id
     WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
       AND s.last_seen_at > now() - interval '30 days'
       AND (a.status = 'active' OR (a.status = 'suspended' AND a.suspended_until <= now()))
$$;

REVOKE SELECT ON core.sessions FROM argos_app, argos_admin;
GRANT SELECT (id, account_id, created_at, expires_at, revoked_at, is_admin, last_seen_at, device_label) ON core.sessions
    TO argos_app, argos_admin;

DROP FUNCTION core.my_videos(uuid);
DROP FUNCTION core.owned_video(uuid, uuid);
DROP FUNCTION core.owned_code(uuid, uuid);

CREATE FUNCTION core.my_videos(p_session bytea)
RETURNS TABLE (video_id uuid, pseudonym text, status text, submitted_at timestamptz, decided_at timestamptz, withdrawn_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT v.id, p.pseudonym, v.status, v.submitted_at, v.decided_at, v.withdrawn_at
      FROM core.video_owners o
      JOIN core.videos v ON v.id = o.video_id
      JOIN core.pseudonyms p ON p.video_id = v.id
     WHERE o.account_id = core.session_account(p_session)
     ORDER BY v.submitted_at DESC
$$;

CREATE FUNCTION core.owned_video(p_session bytea, p_video uuid) RETURNS TABLE (tracking_code_hash bytea, copy_key_enc bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT p.tracking_code_hash, o.copy_key_enc
      FROM core.video_owners o
      JOIN core.pseudonyms p ON p.video_id = o.video_id
      JOIN core.accounts a ON a.id = o.account_id
     WHERE o.account_id = core.session_account(p_session) AND o.video_id = p_video AND a.status = 'active'
$$;

CREATE FUNCTION core.owned_code(p_session bytea, p_video uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT o.code_sealed FROM core.video_owners o
     WHERE o.account_id = core.session_account(p_session) AND o.video_id = p_video;
$$;

REVOKE ALL ON FUNCTION core.read_session(bytea, integer), core.session_account(bytea), core.my_videos(bytea),
                       core.owned_video(bytea, uuid), core.owned_code(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.read_session(bytea, integer), core.my_videos(bytea), core.owned_video(bytea, uuid),
                          core.owned_code(bytea, uuid) TO argos_app;
