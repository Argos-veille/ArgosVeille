-- Administration, phase A1 (5 novembre 2026) : tableau de bord et rapports de bug.
--
-- Tout passe par des fonctions réservées au super-administrateur (le site ne lit toujours pas les
-- rapports de bug directement). Le site vérifie en plus la session d'administration (clé physique,
-- 30 minutes au plus).

CREATE FUNCTION core.require_superadmin(p_admin uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_admin AND is_superadmin AND status = 'active') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
END $$;

CREATE FUNCTION core.admin_dashboard(p_admin uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    r jsonb;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    SELECT jsonb_build_object(
        'aTraiter', jsonb_build_object(
            'juresManquants', (SELECT count(*) FROM core.admin_alerts WHERE kind = 'jury_waiting' AND resolved_at IS NULL),
            'signalements', (SELECT count(*) FROM core.reports WHERE status = 'open'),
            'signalementsGraves', (SELECT count(*) FROM core.reports WHERE status = 'open' AND severity = 'serious'),
            'bugs', (SELECT count(*) FROM core.bug_reports WHERE status = 'open'),
            'bugsUrgents', (SELECT count(*) FROM core.bug_reports WHERE status = 'open' AND urgent)),
        'videos', (SELECT jsonb_build_object(
            'aVerifier', count(*) FILTER (WHERE status = 'awaiting_author'),
            'enTraitement', count(*) FILTER (WHERE status = 'processing'),
            'enFile', count(*) FILTER (WHERE status = 'processing'
                                         AND (processing_started_at IS NULL OR processing_started_at < now() - interval '2 hours')),
            'enRelecture', count(*) FILTER (WHERE status = 'in_review'),
            'auJury', count(*) FILTER (WHERE status = 'jury'),
            'enDebat', count(*) FILTER (WHERE status = 'under_debate'),
            'publiees', count(*) FILTER (WHERE status = 'published'),
            'publiees7j', count(*) FILTER (WHERE status = 'published' AND decided_at > now() - interval '7 days'),
            'echecs', count(*) FILTER (WHERE status = 'failed'))
            FROM core.videos WHERE NOT is_control),
        'communaute', jsonb_build_object(
            'comptes', (SELECT count(*) FROM core.accounts WHERE status = 'active'),
            'relecteursActifs30j', (SELECT count(DISTINCT account_id) FROM core.votes WHERE cast_at > now() - interval '30 days'),
            'inscriptions7j', (SELECT count(*) FROM core.accounts WHERE created_at > now() - interval '7 days'),
            'analystes', (SELECT count(*) FROM core.accounts a WHERE core.is_osint_analyst(a.id)),
            'avecDoubleAuth', (SELECT count(DISTINCT account_id) FROM core.mfa_factors WHERE revoked_at IS NULL)),
        'sante', jsonb_build_object(
            'journalIntact', ledger.verify() IS NULL,
            'entreesJournal', (SELECT count(*) FROM ledger.entries),
            'dernierAncrage', (SELECT jsonb_build_object('jour', day, 'simule', simulated, 'bloc', bitcoin_block)
                                 FROM ledger.anchors ORDER BY day DESC LIMIT 1),
            'derniereConvocation', (SELECT max(sent_at) FROM core.summons),
            'dernierVote', (SELECT max(cast_at) FROM core.votes),
            'erreursServeur24h', (SELECT count(*) FROM core.request_errors WHERE created_at > now() - interval '24 hours'))
    ) INTO r;
    RETURN r;
END $$;

CREATE FUNCTION core.admin_jury_alerts(p_admin uuid)
RETURNS TABLE (video_id uuid, depuis timestamptz, vivier integer, category text, subcategory text, occurred_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY
        SELECT al.video_id, al.created_at, (al.details ->> 'pool')::int, v.category, v.subcategory, v.occurred_at
          FROM core.admin_alerts al JOIN core.videos v ON v.id = al.video_id
         WHERE al.kind = 'jury_waiting' AND al.resolved_at IS NULL
         ORDER BY al.created_at;
END $$;

CREATE FUNCTION core.admin_bug_reports(p_admin uuid, p_status text)
RETURNS TABLE (id uuid, created_at timestamptz, theme text, subtheme text, urgent boolean, description text, page text,
               source_page boolean, pseudo text, avec_capture boolean, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY
        SELECT b.id, b.created_at, b.theme, b.subtheme, b.urgent, left(b.description, 300), b.page, b.source_page,
               a.username, b.screenshot IS NOT NULL, b.status
          FROM core.bug_reports b LEFT JOIN core.accounts a ON a.id = b.account_id
         WHERE b.status = p_status
         ORDER BY b.urgent DESC, b.created_at DESC
         LIMIT 200;
END $$;

CREATE FUNCTION core.admin_bug_report(p_admin uuid, p_id uuid)
RETURNS TABLE (id uuid, created_at timestamptz, theme text, subtheme text, urgent boolean, description text, page text,
               source_page boolean, pseudo text, telemetry jsonb, screenshot bytea, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY
        SELECT b.id, b.created_at, b.theme, b.subtheme, b.urgent, b.description, b.page, b.source_page, a.username,
               b.telemetry, b.screenshot, b.status
          FROM core.bug_reports b LEFT JOIN core.accounts a ON a.id = b.account_id WHERE b.id = p_id;
END $$;

CREATE FUNCTION core.admin_set_bug_status(p_admin uuid, p_id uuid, p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF p_status NOT IN ('open', 'handled', 'dismissed') THEN
        RAISE EXCEPTION 'argos:statut_inconnu';
    END IF;
    UPDATE core.bug_reports SET status = p_status WHERE id = p_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
END $$;

-- Erreurs du serveur liées à un numéro de requête (joint aux rapports de bug).
CREATE FUNCTION core.admin_request_errors(p_admin uuid, p_requests uuid[])
RETURNS TABLE (request_id uuid, created_at timestamptz, method text, route text, error_name text, message text, stack text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY SELECT e.request_id, e.created_at, e.method, e.route, e.error_name, e.message, e.stack
                   FROM core.request_errors e WHERE e.request_id = ANY (p_requests) ORDER BY e.created_at;
END $$;

REVOKE ALL ON FUNCTION core.require_superadmin(uuid), core.admin_dashboard(uuid), core.admin_jury_alerts(uuid),
                       core.admin_bug_reports(uuid, text), core.admin_bug_report(uuid, uuid),
                       core.admin_set_bug_status(uuid, uuid, text), core.admin_request_errors(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_dashboard(uuid), core.admin_jury_alerts(uuid), core.admin_bug_reports(uuid, text),
                          core.admin_bug_report(uuid, uuid), core.admin_set_bug_status(uuid, uuid, text),
                          core.admin_request_errors(uuid, uuid[]) TO argos_app;
