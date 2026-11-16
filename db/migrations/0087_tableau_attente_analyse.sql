-- Tableau de bord : vidéos en attente d'analyse (lieu ou date à établir, 0086) — 14 novembre 2026.

CREATE FUNCTION core.admin_dashboard_osint(p_admin uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN (SELECT jsonb_build_object(
        'enAttente', count(*) FILTER (WHERE status = 'awaiting_osint'),
        'plusAncienne', min(decided_at) FILTER (WHERE status = 'awaiting_osint'),
        -- Vidéos parties en attente d'analyse dans les 30 derniers jours (journal : décision « awaiting_osint »).
        'arrivees30j', (SELECT count(*) FROM ledger.entries e
                         WHERE e.kind = 'decision' AND e.payload ->> 'status' = 'awaiting_osint'
                           AND e.recorded_at > now() - interval '30 days'))
      FROM core.videos WHERE NOT is_control);
END $$;
REVOKE ALL ON FUNCTION core.admin_dashboard_osint(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_dashboard_osint(uuid) TO argos_app;
