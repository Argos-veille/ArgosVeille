-- Audit du 15 novembre 2026, H2 : la session d'administration (ouverte avec la clé physique) était une clé Redis
-- « admin-session:<id> », que l'API publique pouvait écrire (même utilisateur Redis). Un site public compromis pouvait
-- donc s'ouvrir l'administration sans la clé. Elle est désormais en base, et seul le rôle de l'API d'administration
-- (argos_administration) peut l'ouvrir, la lire ou la fermer. Règles inchangées : 30 minutes au plus, 10 sans activité.

CREATE TABLE core.admin_sessions (
    session_id  uuid PRIMARY KEY REFERENCES core.sessions (id) ON DELETE CASCADE,
    started_at  timestamptz NOT NULL DEFAULT now(),
    last_at     timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON core.admin_sessions FROM PUBLIC;

-- Ouverte après la vérification de la clé physique (dans l'API d'administration).
CREATE FUNCTION core.admin_session_open(p_admin uuid, p_session uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.sessions s JOIN core.accounts a ON a.id = s.account_id
                    WHERE s.id = p_session AND s.account_id = p_admin AND s.revoked_at IS NULL AND s.expires_at > now()
                      AND a.is_superadmin AND a.status = 'active') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    INSERT INTO core.admin_sessions (session_id) VALUES (p_session)
    ON CONFLICT (session_id) DO UPDATE SET started_at = now(), last_at = now();
END $$;

-- Temps restant en millisecondes (0 : fermée ou expirée, et alors effacée) ; p_touch prolonge l'inactivité.
CREATE FUNCTION core.admin_session_remaining(p_session uuid, p_touch boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    s record;
BEGIN
    SELECT a.started_at, a.last_at INTO s FROM core.admin_sessions a
      JOIN core.sessions x ON x.id = a.session_id
     WHERE a.session_id = p_session AND x.revoked_at IS NULL AND x.expires_at > now();
    IF NOT FOUND THEN
        DELETE FROM core.admin_sessions WHERE session_id = p_session;
        RETURN 0;
    END IF;
    IF now() - s.started_at > interval '30 minutes' OR now() - s.last_at > interval '10 minutes' THEN
        DELETE FROM core.admin_sessions WHERE session_id = p_session;
        RETURN 0;
    END IF;
    IF p_touch THEN
        UPDATE core.admin_sessions SET last_at = now() WHERE session_id = p_session;
    END IF;
    RETURN (extract(epoch FROM least(interval '30 minutes' - (now() - s.started_at), interval '10 minutes')) * 1000)::integer;
END $$;

CREATE FUNCTION core.admin_session_close(p_session uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    DELETE FROM core.admin_sessions WHERE session_id = p_session;
$$;

REVOKE ALL ON FUNCTION core.admin_session_open(uuid, uuid), core.admin_session_remaining(uuid, boolean),
                       core.admin_session_close(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_session_open(uuid, uuid), core.admin_session_remaining(uuid, boolean),
                          core.admin_session_close(uuid) TO argos_administration;
