-- Certification et expiration (15 novembre 2026) : un statut de journaliste, d'avocat ou d'association dure un an.
-- Le retrait manuel du dernier statut retirait déjà la certification (0088) ; l'expiration, non : le badge restait.
-- Le moteur retire désormais la certification des comptes qui ont eu un statut et n'en ont plus aucun de valable.
-- Un compte certifié par « confiance » seule (aucun statut) n'est pas touché.
CREATE FUNCTION core.expire_certifications() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    UPDATE core.accounts a SET certified = false
     WHERE a.certified
       AND EXISTS (SELECT 1 FROM core.verifications v
                    WHERE v.account_id = a.id AND v.category IN ('journalist', 'lawyer', 'association') AND v.revoked_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM core.verifications v
                        WHERE v.account_id = a.id AND v.revoked_at IS NULL AND v.expires_at > now());
    GET DIAGNOSTICS n = ROW_COUNT;
    -- Les statuts arrivés à échéance sont clos : un compte sans statut valable n'en garde aucun « ouvert ».
    UPDATE core.verifications SET revoked_at = expires_at WHERE revoked_at IS NULL AND expires_at <= now();
    RETURN n;
END $$;
REVOKE ALL ON FUNCTION core.expire_certifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.expire_certifications() TO argos_scoring;
