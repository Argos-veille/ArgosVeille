-- Fermer son compte (5 novembre 2026), choix de l’administrateur :
--   A. délai de grâce de 30 jours : fermé tout de suite (sessions, convocations), se reconnecter annule ;
--      effacement définitif ensuite (core.purge_closed_accounts, appelé par le moteur) ;
--   B. les empreintes du téléphone et du mail sont effacées (réinscription possible), SAUF pour un compte
--      exclu, dont l'empreinte reste marquée ;
--   C. les notes d'analyste et les corrections restent, signées « compte supprimé ».
-- Restent aussi, sans lien avec la personne : les votes (détachés tout de suite) et les journaux de
-- connexion imposés par la loi (décret 2021-1362, purgés à un an comme pour tout le monde).

ALTER TABLE core.accounts DROP CONSTRAINT accounts_status_check;
ALTER TABLE core.accounts ADD CONSTRAINT accounts_status_check
    CHECK (status IN ('active', 'suspended', 'banned', 'closing', 'deleted'));
ALTER TABLE core.accounts ADD COLUMN closing_at timestamptz,
                          ADD CONSTRAINT accounts_closing_at CHECK ((status = 'closing') = (closing_at IS NOT NULL));
-- Le pseudo d'un compte effacé disparaît (il redevient libre) ; partout, il s'affiche « compte supprimé ».
ALTER TABLE core.accounts ALTER COLUMN username DROP NOT NULL,
                          ADD CONSTRAINT accounts_username_sauf_supprime CHECK (status = 'deleted' OR username IS NOT NULL);

-- Fermeture demandée (le site a vérifié le mot de passe et la double authentification).
CREATE FUNCTION core.close_account(p_account uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    c record;
BEGIN
    SELECT id, status, is_superadmin INTO c FROM core.accounts WHERE id = p_account FOR UPDATE;
    IF NOT FOUND OR c.status <> 'active' THEN
        RAISE EXCEPTION 'argos:compte_inactif';
    END IF;
    IF c.is_superadmin THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    UPDATE core.accounts SET status = 'closing', closing_at = now() WHERE id = p_account;
    UPDATE core.sessions SET revoked_at = now() WHERE account_id = p_account AND revoked_at IS NULL;
    UPDATE core.summons SET outcome = 'cancelled' WHERE account_id = p_account AND outcome = 'pending';
    RETURN now() + interval '30 days';
END $$;

-- Reconnexion pendant le délai de grâce : la fermeture est annulée. Vrai si le compte a été rouvert.
CREATE FUNCTION core.reopen_account(p_account uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    UPDATE core.accounts SET status = 'active', closing_at = NULL
     WHERE id = p_account AND status = 'closing' AND closing_at > now() - interval '30 days';
    RETURN FOUND;
END $$;

-- Effacement définitif des comptes fermés depuis plus de 30 jours (appelé par le moteur).
CREATE FUNCTION core.purge_closed_accounts() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_ids uuid[];
BEGIN
    SELECT coalesce(array_agg(id), '{}') INTO v_ids FROM core.accounts
     WHERE status = 'closing' AND closing_at <= now() - interval '30 days';
    IF cardinality(v_ids) = 0 THEN
        RETURN 0;
    END IF;
    -- Votes et convocations : ils restent dans les statistiques, sans auteur.
    UPDATE core.summons SET account_id = NULL, unlinked_at = now() WHERE account_id = ANY (v_ids);
    UPDATE core.votes SET account_id = NULL, unlinked_at = now() WHERE account_id = ANY (v_ids);
    -- Connexion, appareils, messages, statut d'analyste.
    DELETE FROM core.credentials WHERE account_id = ANY (v_ids);
    DELETE FROM core.mfa_factors WHERE account_id = ANY (v_ids);
    DELETE FROM core.backup_codes WHERE account_id = ANY (v_ids);
    DELETE FROM core.sessions WHERE account_id = ANY (v_ids);
    DELETE FROM core.known_devices WHERE account_id = ANY (v_ids);
    DELETE FROM core.account_messages WHERE account_id = ANY (v_ids);
    UPDATE core.verifications SET revoked_at = now() WHERE account_id = ANY (v_ids) AND revoked_at IS NULL;
    UPDATE core.reports SET reporter_id = NULL WHERE reporter_id = ANY (v_ids);
    UPDATE core.bug_reports SET account_id = NULL WHERE account_id = ANY (v_ids);
    -- Identité : mail chiffré et empreintes effacés ; un compte exclu garde son empreinte marquée (sans lien).
    DELETE FROM identity.account_identities WHERE account_id = ANY (v_ids) AND NOT banned;
    UPDATE identity.account_identities SET account_id = NULL WHERE account_id = ANY (v_ids);
    UPDATE core.accounts SET status = 'deleted', closing_at = NULL, username = NULL, suspect = false WHERE id = ANY (v_ids);
    RETURN cardinality(v_ids);
END $$;

REVOKE ALL ON FUNCTION core.close_account(uuid), core.reopen_account(uuid), core.purge_closed_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.close_account(uuid), core.reopen_account(uuid) TO argos_app;
GRANT EXECUTE ON FUNCTION core.purge_closed_accounts() TO argos_scoring;
