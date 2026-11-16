-- Statuts vérifiés et double authentification (14 novembre 2026, demande de l’administrateur, suite de la revue A3) :
-- journaliste, avocat, association et analyste OSINT ne s'accordent qu'à un compte qui a déjà une double
-- authentification active, que ce soit par l'administration (admin_set_status, admin_set_osint) ou par un code de
-- statut (redeem_account_code : refusé sans consommer le code). Vérifié ici, pour toutes les voies à la fois.
CREATE FUNCTION core.verification_requires_mfa() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Connexion directe du propriétaire de la base (migrations, données de démonstration, tests) : il peut déjà tout.
    -- Le site, l'administration et les codes passent par leurs propres rôles de connexion, toujours contrôlés.
    IF session_user = 'argos_owner' AND current_setting('argos.forcer_controle', true) IS DISTINCT FROM 'oui' THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.mfa_factors WHERE account_id = NEW.account_id AND revoked_at IS NULL) THEN
        RAISE EXCEPTION 'argos:double_auth_requise';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER verifications_require_mfa BEFORE INSERT ON core.verifications
    FOR EACH ROW EXECUTE FUNCTION core.verification_requires_mfa();
REVOKE ALL ON FUNCTION core.verification_requires_mfa() FROM PUBLIC;
