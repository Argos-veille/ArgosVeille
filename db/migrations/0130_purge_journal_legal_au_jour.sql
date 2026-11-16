-- Purge du journal légal (relectures du 15 novembre 2026) : avec le jour J en clair et « - 1 year 1 day », une ligne
-- partait à J + 1 an + 2 jours. Le décret (art. 5) demande un an à compter du jour : elle part désormais à J + 1 an + 1 jour.
CREATE OR REPLACE FUNCTION identity.purge_legal_logs() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_count integer;
BEGIN
    DELETE FROM identity.legal_connection_logs
     WHERE occurred_at < date_trunc('day', now(), 'Europe/Paris') - interval '1 year';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END
$$;
