-- Statuts des comptes (7 novembre 2026, demande de l’administrateur) : depuis la fiche d'un compte, l'administration
-- accorde ou retire n'importe quel statut — journaliste, avocat, association, analyste OSINT, compte de confiance —
-- et un utilisateur peut saisir un code de compte spécial après son inscription (« Mon compte »).
--   - analyste OSINT : règles inchangées (double authentification exigée, inscription au journal public) ;
--   - journaliste, avocat, association : renouvellement annuel, rien de public ; accorder l'un d'eux certifie
--     aussi le compte (délais sautés), comme un code ;
--   - confiance : certification seule (délais sautés), sans catégorie.

CREATE FUNCTION core.admin_set_status(p_admin uuid, p_account uuid, p_status text, p_grant boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
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
            RAISE EXCEPTION 'argos:deja_ainsi';
        END IF;
        INSERT INTO core.verifications (account_id, category, expires_at, verified_by)
        VALUES (p_account, p_status, now() + interval '1 year', p_admin);
        UPDATE core.accounts SET certified = true WHERE id = p_account;
    ELSE
        UPDATE core.verifications SET revoked_at = now()
         WHERE account_id = p_account AND category = p_status AND revoked_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'argos:deja_ainsi';
        END IF;
    END IF;
END $$;

-- Statuts actifs d'un compte (fiche d'administration).
CREATE FUNCTION core.admin_account_statuses(p_admin uuid, p_account uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN array(
        SELECT DISTINCT category FROM core.verifications
         WHERE account_id = p_account AND revoked_at IS NULL AND expires_at > now()
        UNION
        SELECT 'trusted' FROM core.accounts WHERE id = p_account AND certified
        ORDER BY 1);
END $$;

-- Code saisi après l'inscription : même effet qu'à l'inscription, sans doublon de catégorie.
CREATE OR REPLACE FUNCTION core.redeem_account_code(p_account uuid, p_hmac bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    c record;
BEGIN
    SELECT id, category, created_by INTO c FROM core.account_codes
     WHERE code_hmac = p_hmac AND revoked_at IS NULL AND used_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    UPDATE core.account_codes SET used_at = now(), used_by = p_account WHERE id = c.id;
    UPDATE core.accounts SET certified = true WHERE id = p_account;
    IF c.category <> 'trusted' AND NOT EXISTS (
        SELECT 1 FROM core.verifications WHERE account_id = p_account AND category = c.category
                                           AND revoked_at IS NULL AND expires_at > now()) THEN
        INSERT INTO core.verifications (account_id, category, expires_at, verified_by)
        VALUES (p_account, c.category, now() + interval '1 year', c.created_by);
    END IF;
    RETURN c.category;
END $$;

REVOKE ALL ON FUNCTION core.admin_set_status(uuid, uuid, text, boolean), core.admin_account_statuses(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_set_status(uuid, uuid, text, boolean), core.admin_account_statuses(uuid, uuid) TO argos_app;
