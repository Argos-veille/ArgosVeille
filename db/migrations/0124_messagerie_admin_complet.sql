-- Contre-vérification de l'audit (relecture croisée, 15 novembre 2026), H5 incomplet :
--   1. Faux messages « Administration » : guard_message ne contrôlait pas l'expéditeur. Dans une conversation
--      « Administration », un message côté administration (sender = 'verified') ne peut venir que de l'API
--      d'administration. Vérifié avec les droits de l'appelant (déclencheur à part, sans SECURITY DEFINER).
--   2. forget_account_message_key : le site public pouvait effacer la clé d'un journaliste, d'un avocat ou d'une
--      association, puis poser la sienne. Ces clés, comme celle du super-administrateur, ne s'effacent plus que depuis
--      l'administration ; une réinitialisation par le site public les garde (la clé se remplace depuis l'admin).

CREATE FUNCTION core.guard_message_admin() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF NEW.sender = 'verified'
       AND EXISTS (SELECT 1 FROM core.conversations WHERE id = NEW.conversation_id AND with_admin)
       AND NOT pg_has_role(current_user, 'argos_administration', 'MEMBER') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER messages_guard_admin BEFORE INSERT ON core.messages
    FOR EACH ROW EXECUTE FUNCTION core.guard_message_admin();

CREATE OR REPLACE FUNCTION core.forget_account_message_key(p_account uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF NOT pg_has_role(session_user, 'argos_administration', 'MEMBER')
       AND (EXISTS (SELECT 1 FROM core.accounts WHERE id = p_account AND is_superadmin)
            OR EXISTS (SELECT 1 FROM core.verifications WHERE account_id = p_account AND revoked_at IS NULL
                         AND category IN ('journalist', 'lawyer', 'association'))) THEN
        RETURN;   -- clé gardée : elle ne s'efface que depuis l'administration
    END IF;
    UPDATE core.public_keys k SET owner_wrapped = NULL
      FROM core.pseudonyms p, core.video_owners o
     WHERE k.pseudonym_id = p.id AND o.video_id = p.video_id AND o.account_id = p_account AND k.owner_wrapped IS NOT NULL;
    DELETE FROM core.public_keys WHERE account_id = p_account;
END $$;
