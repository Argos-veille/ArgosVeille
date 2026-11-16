-- Administration : détail des erreurs du serveur des dernières heures (9 novembre 2026, demande de l’administrateur).
CREATE FUNCTION core.admin_recent_errors(p_admin uuid, p_hours integer)
RETURNS TABLE (request_id uuid, created_at timestamptz, method text, route text, status smallint, error_name text, message text, stack text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY SELECT e.request_id, e.created_at, e.method, e.route, e.status, e.error_name, e.message, e.stack
                   FROM core.request_errors e
                  WHERE e.created_at > now() - make_interval(hours => least(greatest(p_hours, 1), 336))
                  ORDER BY e.created_at DESC LIMIT 300;
END $$;
REVOKE ALL ON FUNCTION core.admin_recent_errors(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_recent_errors(uuid, integer) TO argos_app;
