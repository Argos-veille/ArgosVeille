-- Audit du 15 novembre 2026, H5 : un site public compromis pouvait se faire passer pour l'« Administration » auprès
-- d'une source (ouvrir une conversation with_admin) et remplacer ou supprimer la clé de messagerie d'un compte vérifié
-- ou de l'administration (les messages, et un original partagé, auraient été chiffrés pour lui).
--   1. Une conversation « Administration » ne s'ouvre que depuis l'API d'administration (rôle argos_administration).
--   2. Le site public ne peut plus remplacer ni supprimer une clé publique existante (seulement en créer une, et
--      rechiffrer la partie privée avec un nouveau mot de passe).
--   3. La clé de messagerie du super-administrateur ne peut être effacée que depuis l'administration.

-- 1. Vérifié avec les droits de l'appelant (et non du propriétaire, comme le reste de guard_conversation).
CREATE FUNCTION core.guard_conversation_admin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF NEW.with_admin AND NOT pg_has_role(current_user, 'argos_administration', 'MEMBER') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER conversations_guard_admin BEFORE INSERT ON core.conversations
    FOR EACH ROW EXECUTE FUNCTION core.guard_conversation_admin();

-- 2. Plus de remplacement ni de suppression directe d'une clé publique.
REVOKE UPDATE (public_key) ON core.public_keys FROM argos_app;
REVOKE DELETE ON core.public_keys FROM argos_app;

-- 3. Réinitialisation du mot de passe : la clé du compte est effacée (la partie privée n'est plus lisible), sauf celle
-- du super-administrateur depuis le site public (connexion de l'API publique : session_user = argos_api) : elle est
-- alors gardée (la réinitialisation réussit ; la clé se remplace depuis l'administration).
CREATE OR REPLACE FUNCTION core.forget_account_message_key(p_account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM core.accounts WHERE id = p_account AND is_superadmin)
       AND NOT pg_has_role(session_user, 'argos_administration', 'MEMBER') THEN
        RETURN;
    END IF;
    UPDATE core.public_keys k SET owner_wrapped = NULL
      FROM core.pseudonyms p, core.video_owners o
     WHERE k.pseudonym_id = p.id AND o.video_id = p.video_id AND o.account_id = p_account AND k.owner_wrapped IS NOT NULL;
    DELETE FROM core.public_keys WHERE account_id = p_account;
END $$;
