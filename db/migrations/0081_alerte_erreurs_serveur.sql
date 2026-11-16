-- Alerte par mail quand l'API enchaîne des erreurs (9 novembre 2026) : résumé sans aucune donnée de requête.
CREATE FUNCTION core.recent_error_summary(p_minutes integer)
RETURNS TABLE (total integer, route text, occurrences integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT (SELECT count(*)::int FROM core.request_errors WHERE created_at > now() - make_interval(mins => p_minutes)),
           e.method || ' ' || e.route, count(*)::int
      FROM core.request_errors e
     WHERE e.created_at > now() - make_interval(mins => p_minutes)
     GROUP BY e.method, e.route ORDER BY count(*) DESC, 2 LIMIT 1;
$$;
REVOKE ALL ON FUNCTION core.recent_error_summary(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.recent_error_summary(integer) TO argos_app;
