-- Statuts annuels (journaliste, avocat, association, analyste) : rappels et renouvellement (15 novembre 2026, demande de
-- l’administrateur). Jusqu'ici, rien ne prévenait de l'échéance, et un statut actif ne pouvait pas être prolongé.
--   - le titulaire reçoit un mail 30 jours puis 7 jours avant l'échéance (envoyé par l'API) ;
--   - le tableau de bord de l'administration liste les statuts qui expirent dans les 30 jours ;
--   - « accorder » un statut encore actif le renouvelle, dans les 30 jours avant l'échéance : un an de plus.
ALTER TABLE core.verifications ADD COLUMN reminded_30_at timestamptz, ADD COLUMN reminded_7_at timestamptz;

CREATE OR REPLACE FUNCTION core.admin_set_status(p_admin uuid, p_account uuid, p_status text, p_grant boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF p_status NOT IN ('journalist', 'lawyer', 'association', 'osint_analyst', 'trusted') THEN
        RAISE EXCEPTION 'argos:statut_inconnu';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_account AND status = 'active') THEN
        RAISE EXCEPTION 'argos:compte_inconnu';
    END IF;
    IF p_status = 'osint_analyst' THEN
        PERFORM core.admin_set_osint(p_admin, p_account, p_grant);
    ELSIF p_status = 'trusted' THEN
        UPDATE core.accounts SET certified = p_grant WHERE id = p_account AND certified IS DISTINCT FROM p_grant;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'argos:deja_ainsi';
        END IF;
    ELSIF p_grant THEN
        UPDATE core.verifications SET revoked_at = now()
         WHERE account_id = p_account AND category = p_status AND revoked_at IS NULL AND expires_at <= now();
        IF EXISTS (SELECT 1 FROM core.verifications WHERE account_id = p_account AND category = p_status AND revoked_at IS NULL) THEN
            -- Renouvellement : possible dans les 30 jours avant l'échéance, un an de plus à partir de l'échéance (0118).
            UPDATE core.verifications SET expires_at = expires_at + interval '1 year', reminded_30_at = NULL, reminded_7_at = NULL
             WHERE account_id = p_account AND category = p_status AND revoked_at IS NULL AND expires_at <= now() + interval '30 days';
            IF NOT FOUND THEN
                RAISE EXCEPTION 'argos:deja_ainsi';
            END IF;
        ELSE
            INSERT INTO core.verifications (account_id, category, expires_at, verified_by)
            VALUES (p_account, p_status, now() + interval '1 year', p_admin);
        END IF;
        UPDATE core.accounts SET certified = true WHERE id = p_account;
    ELSE
        UPDATE core.verifications SET revoked_at = now()
         WHERE account_id = p_account AND category = p_status AND revoked_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'argos:deja_ainsi';
        END IF;
        -- Plus aucun statut journaliste / avocat / association : la certification tombe avec (« confiance »
        -- se redonne à part si besoin).
        IF NOT EXISTS (SELECT 1 FROM core.verifications WHERE account_id = p_account AND revoked_at IS NULL AND expires_at > now()) THEN
            UPDATE core.accounts SET certified = false WHERE id = p_account;
        END IF;
    END IF;
END $function$;

CREATE OR REPLACE FUNCTION core.admin_set_osint(p_admin uuid, p_account uuid, p_grant boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
    pseudo text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_admin AND is_superadmin AND status = 'active') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    SELECT username INTO pseudo FROM core.accounts WHERE id = p_account AND status = 'active';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:compte_inconnu';
    END IF;
    IF p_grant THEN
        IF NOT EXISTS (SELECT 1 FROM core.mfa_factors WHERE account_id = p_account AND revoked_at IS NULL) THEN
            RAISE EXCEPTION 'argos:double_auth_requise';
        END IF;
        -- Une vérification expirée est close avant d'en ouvrir une nouvelle (renouvellement).
        UPDATE core.verifications SET revoked_at = now()
         WHERE account_id = p_account AND category = 'osint_analyst' AND revoked_at IS NULL AND expires_at <= now();
        IF EXISTS (SELECT 1 FROM core.verifications WHERE account_id = p_account AND category = 'osint_analyst'
                                                      AND revoked_at IS NULL) THEN
            -- Renouvellement : possible dans les 30 jours avant l'échéance, un an de plus à partir de l'échéance (0118).
            UPDATE core.verifications SET expires_at = expires_at + interval '1 year', reminded_30_at = NULL, reminded_7_at = NULL
             WHERE account_id = p_account AND category = 'osint_analyst' AND revoked_at IS NULL
               AND expires_at <= now() + interval '30 days';
            IF NOT FOUND THEN
                RAISE EXCEPTION 'argos:deja_ainsi';
            END IF;
        ELSE
            INSERT INTO core.verifications (account_id, category, expires_at, verified_by)
            VALUES (p_account, 'osint_analyst', now() + interval '1 year', p_admin);
        END IF;
    ELSE
        UPDATE core.verifications SET revoked_at = now()
         WHERE account_id = p_account AND category = 'osint_analyst' AND revoked_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'argos:deja_ainsi';
        END IF;
    END IF;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', CASE WHEN p_grant THEN 'osint_grant' ELSE 'osint_revoke' END, 'analyst', pseudo));
END
$function$;

-- Rappels à envoyer maintenant (marqués comme envoyés dans la même transaction) : un par statut et par palier.
CREATE FUNCTION core.take_status_reminders() RETURNS TABLE (account_id uuid, category text, expires_at timestamptz, palier integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    RETURN QUERY
    WITH sept AS (
        UPDATE core.verifications v SET reminded_7_at = now(), reminded_30_at = coalesce(v.reminded_30_at, now())
         WHERE v.revoked_at IS NULL AND v.expires_at > now() AND v.expires_at <= now() + interval '7 days' AND v.reminded_7_at IS NULL
         RETURNING v.account_id, v.category, v.expires_at, 7),
    trente AS (
        UPDATE core.verifications v SET reminded_30_at = now()
         WHERE v.revoked_at IS NULL AND v.expires_at > now() + interval '7 days' AND v.expires_at <= now() + interval '30 days'
           AND v.reminded_30_at IS NULL
         RETURNING v.account_id, v.category, v.expires_at, 30)
    SELECT * FROM sept UNION ALL SELECT * FROM trente;
END $$;

-- Tableau de bord : statuts qui expirent dans les 30 jours (les 5 plus proches).
CREATE FUNCTION core.admin_dashboard_statuses(p_admin uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN jsonb_build_object(
        'nombre', (SELECT count(*) FROM core.verifications v JOIN core.accounts a ON a.id = v.account_id
                    WHERE v.revoked_at IS NULL AND v.expires_at > now() AND v.expires_at <= now() + interval '30 days' AND a.status = 'active'),
        'prochains', coalesce((SELECT jsonb_agg(x ORDER BY x ->> 'expire') FROM (
            SELECT jsonb_build_object('compte', a.id, 'pseudo', a.username, 'statut', v.category, 'expire', v.expires_at) AS x
              FROM core.verifications v JOIN core.accounts a ON a.id = v.account_id
             WHERE v.revoked_at IS NULL AND v.expires_at > now() AND v.expires_at <= now() + interval '30 days' AND a.status = 'active'
             ORDER BY v.expires_at LIMIT 5) y), '[]'));
END $$;

-- Fiche d'un compte : échéance de chaque statut actif.
CREATE FUNCTION core.admin_account_status_dates(p_admin uuid, p_account uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN coalesce((SELECT jsonb_object_agg(category, max_exp) FROM (
        SELECT category, max(expires_at) AS max_exp FROM core.verifications
         WHERE account_id = p_account AND revoked_at IS NULL AND expires_at > now() GROUP BY category) x), '{}');
END $$;

REVOKE ALL ON FUNCTION core.take_status_reminders(), core.admin_dashboard_statuses(uuid),
                       core.admin_account_status_dates(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.take_status_reminders() TO argos_app;
GRANT EXECUTE ON FUNCTION core.admin_dashboard_statuses(uuid), core.admin_account_status_dates(uuid, uuid) TO argos_administration;
