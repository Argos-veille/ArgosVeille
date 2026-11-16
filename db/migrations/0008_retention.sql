-- Purges automatiques : rien n'est conservé plus longtemps que nécessaire.

-- Coupe le lien entre un vote (et sa convocation) et son auteur après N mois.
-- La convocation doit être coupée aussi, sinon elle permettrait de reconstituer le lien.
CREATE FUNCTION core.unlink_old_votes(p_months integer DEFAULT 6) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, public
AS $$
DECLARE
    v_count integer;
BEGIN
    UPDATE core.summons s SET account_id = NULL, unlinked_at = now()
    WHERE s.account_id IS NOT NULL
      AND s.sent_at < now() - make_interval(months => p_months);

    UPDATE core.votes SET account_id = NULL, unlinked_at = now()
    WHERE account_id IS NOT NULL
      AND cast_at < now() - make_interval(months => p_months);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END
$$;

-- Purge les données de connexion légales au-delà de la durée imposée (1 an, à confirmer avec l'avocat).
CREATE FUNCTION identity.purge_legal_logs(p_retention interval DEFAULT interval '1 year') RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = identity, public
AS $$
DECLARE
    v_count integer;
BEGIN
    DELETE FROM identity.legal_connection_logs WHERE occurred_at < now() - p_retention;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END
$$;
