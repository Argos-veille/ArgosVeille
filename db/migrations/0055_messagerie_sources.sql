-- Messagerie avec les sources (M1, 8 novembre 2026, validée par l’administrateur) : seuls les comptes vérifiés
-- (journaliste, avocat, association) et l'administration écrivent à la source d'une vidéo, qui peut répondre.
--   - compte vérifié : seulement si la source l'a accepté pour cette vidéo (pseudonyms.contact_allowed) ;
--   - administration (super-admin) : toujours ; la source ne peut pas fermer cette conversation ;
--   - chiffrement de bout en bout : le serveur ne garde que des clés publiques, des clés privées chiffrées
--     dans le navigateur, et des messages chiffrés qu'il ne peut pas lire.
-- Clés :
--   - une paire par vidéo (pseudonyme), créée à l'envoi ; sa partie privée est chiffrée avec une clé tirée des
--     12 mots (wrapped_private) et, pour un envoi avec compte, aussi pour la clé du compte (owner_wrapped) ;
--   - une paire par compte, chiffrée avec une clé tirée du mot de passe (kdf_salt, kdf_iterations) : perdue
--     (effacée) si le mot de passe est réinitialisé, rechiffrée par le navigateur s'il est changé.

ALTER TABLE core.public_keys
    ADD COLUMN wrapped_private bytea,
    ADD COLUMN kdf_salt        bytea,
    ADD COLUMN kdf_iterations  integer,
    ADD COLUMN owner_wrapped   jsonb,
    ADD COLUMN updated_at      timestamptz NOT NULL DEFAULT now(),
    ADD CONSTRAINT public_keys_point CHECK (length(public_key) = 65 AND get_byte(public_key, 0) = 4),
    ADD CONSTRAINT public_keys_privee CHECK (wrapped_private IS NOT NULL AND length(wrapped_private) BETWEEN 28 AND 512),
    ADD CONSTRAINT public_keys_kdf CHECK (
        (account_id IS NOT NULL AND kdf_salt IS NOT NULL AND length(kdf_salt) = 16 AND kdf_iterations >= 100000
                                AND owner_wrapped IS NULL)
     OR (pseudonym_id IS NOT NULL AND kdf_salt IS NULL AND kdf_iterations IS NULL)),
    ADD CONSTRAINT public_keys_owner_taille CHECK (owner_wrapped IS NULL OR length(owner_wrapped::text) <= 2000);
CREATE UNIQUE INDEX public_keys_un_par_compte ON core.public_keys (account_id) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX public_keys_un_par_pseudonyme ON core.public_keys (pseudonym_id) WHERE pseudonym_id IS NOT NULL;

ALTER TABLE core.conversations
    ADD COLUMN with_admin      boolean NOT NULL DEFAULT false,
    ADD COLUMN last_message_at timestamptz,
    ADD COLUMN witness_read_at timestamptz,
    ADD COLUMN verified_read_at timestamptz;

-- Messages : enveloppe JSON (texte chiffré + clé du message chiffrée pour chacune des deux parties).
ALTER TABLE core.messages ADD CONSTRAINT messages_taille CHECK (length(ciphertext) <= 24000);

-- Une conversation : vidéo ni retirée ni en cours d'envoi ; administration = super-admin actif ;
-- sinon compte vérifié journaliste, avocat ou association (pas analyste ni « confiance ») et accord de la source.
CREATE OR REPLACE FUNCTION core.guard_conversation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.pseudonyms p JOIN core.videos v ON v.id = p.video_id
                    WHERE p.id = NEW.pseudonym_id AND v.status NOT IN ('uploading', 'withdrawn', 'removed')) THEN
        RAISE EXCEPTION 'argos:video_indisponible';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.public_keys WHERE pseudonym_id = NEW.pseudonym_id) THEN
        RAISE EXCEPTION 'argos:source_sans_messagerie';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.public_keys WHERE account_id = NEW.verified_account_id) THEN
        RAISE EXCEPTION 'argos:compte_sans_messagerie';
    END IF;
    IF NEW.with_admin THEN
        IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = NEW.verified_account_id AND is_superadmin AND status = 'active') THEN
            RAISE EXCEPTION 'argos:reserve_super_admin';
        END IF;
        RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.pseudonyms WHERE id = NEW.pseudonym_id AND contact_allowed) THEN
        RAISE EXCEPTION 'argos:contact_refuse';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.accounts a JOIN core.verifications f ON f.account_id = a.id
                    WHERE a.id = NEW.verified_account_id AND a.status = 'active'
                      AND f.category IN ('journalist', 'lawyer', 'association')
                      AND f.revoked_at IS NULL AND f.expires_at > now()) THEN
        RAISE EXCEPTION 'argos:compte_non_verifie';
    END IF;
    RETURN NEW;
END
$$;

-- Un message : conversation ouverte ; un compte vérifié qui a perdu son statut (ou une source qui a retiré son
-- accord) ne peut plus écrire, sauf dans une conversation avec l'administration.
CREATE FUNCTION core.guard_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    c core.conversations;
BEGIN
    SELECT * INTO c FROM core.conversations WHERE id = NEW.conversation_id FOR UPDATE;
    IF c.closed_at IS NOT NULL THEN
        RAISE EXCEPTION 'argos:conversation_fermee';
    END IF;
    IF NOT c.with_admin THEN
        IF NOT EXISTS (SELECT 1 FROM core.pseudonyms WHERE id = c.pseudonym_id AND contact_allowed) THEN
            RAISE EXCEPTION 'argos:contact_refuse';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM core.verifications
                        WHERE account_id = c.verified_account_id AND category IN ('journalist', 'lawyer', 'association')
                          AND revoked_at IS NULL AND expires_at > now()) THEN
            RAISE EXCEPTION 'argos:compte_non_verifie';
        END IF;
    END IF;
    NEW.sent_at := now();
    NEW.reported_at := NULL;
    NEW.revealed_text := NULL;
    UPDATE core.conversations SET last_message_at = NEW.sent_at,
           witness_read_at = CASE WHEN NEW.sender = 'witness' THEN NEW.sent_at ELSE witness_read_at END,
           verified_read_at = CASE WHEN NEW.sender = 'verified' THEN NEW.sent_at ELSE verified_read_at END
     WHERE id = c.id;
    RETURN NEW;
END
$$;
CREATE TRIGGER messages_guard BEFORE INSERT ON core.messages FOR EACH ROW EXECUTE FUNCTION core.guard_message();

-- Fermer une conversation : la source (sauf avec l'administration) ou le compte vérifié ; jamais rouverte.
CREATE FUNCTION core.guard_conversation_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
        RAISE EXCEPTION 'argos:conversation_fermee';
    END IF;
    IF NEW.pseudonym_id <> OLD.pseudonym_id OR NEW.verified_account_id <> OLD.verified_account_id
       OR NEW.with_admin <> OLD.with_admin OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'argos:modification_interdite';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER conversations_guard_update BEFORE UPDATE ON core.conversations
    FOR EACH ROW EXECUTE FUNCTION core.guard_conversation_update();

-- Droits de l'application : les clés (pas de suppression des clés de vidéo), les conversations, les messages.
REVOKE ALL ON core.public_keys, core.conversations, core.messages FROM argos_app;
GRANT SELECT, INSERT ON core.public_keys TO argos_app;
GRANT UPDATE (public_key, wrapped_private, kdf_salt, kdf_iterations, owner_wrapped, updated_at) ON core.public_keys TO argos_app;
GRANT DELETE ON core.public_keys TO argos_app;   -- clé de compte seulement (réinitialisation), voir la règle ci-dessous
GRANT SELECT, INSERT ON core.conversations TO argos_app;
GRANT UPDATE (closed_at, witness_read_at, verified_read_at, last_message_at) ON core.conversations TO argos_app;
GRANT SELECT, INSERT (conversation_id, sender, ciphertext) ON core.messages TO argos_app;
GRANT UPDATE (reported_at, revealed_text) ON core.messages TO argos_app;

CREATE FUNCTION core.guard_public_keys_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.pseudonym_id IS NOT NULL AND pg_has_role(current_user, 'argos_app', 'USAGE') THEN
        RAISE EXCEPTION 'argos:modification_interdite';
    END IF;
    RETURN OLD;
END
$$;
CREATE TRIGGER public_keys_guard_delete BEFORE DELETE ON core.public_keys
    FOR EACH ROW EXECUTE FUNCTION core.guard_public_keys_delete();

-- Une clé de vidéo ne change jamais de point public ni de partie privée ; seule l'enveloppe pour le compte
-- peut être effacée (mot de passe réinitialisé : la clé du compte n'existe plus).
CREATE FUNCTION core.guard_public_keys_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.pseudonym_id IS NOT NULL AND (NEW.public_key <> OLD.public_key OR NEW.wrapped_private <> OLD.wrapped_private
       OR (NEW.owner_wrapped IS NOT NULL AND NEW.owner_wrapped IS DISTINCT FROM OLD.owner_wrapped)) THEN
        RAISE EXCEPTION 'argos:modification_interdite';
    END IF;
    IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.pseudonym_id IS DISTINCT FROM OLD.pseudonym_id THEN
        RAISE EXCEPTION 'argos:modification_interdite';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END
$$;
CREATE TRIGGER public_keys_guard_update BEFORE UPDATE ON core.public_keys
    FOR EACH ROW EXECUTE FUNCTION core.guard_public_keys_update();

-- Non-lus pour l'en-tête : conversations d'un compte vérifié (ou de l'admin) avec un message de la source non lu.
CREATE FUNCTION core.my_unread_source_messages(p_account uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT count(*)::int FROM core.conversations c
     WHERE c.verified_account_id = p_account
       AND c.last_message_at IS NOT NULL AND c.last_message_at > coalesce(c.verified_read_at, '-infinity');
$$;
REVOKE ALL ON FUNCTION core.my_unread_source_messages(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.my_unread_source_messages(uuid) TO argos_app;

-- Mot de passe réinitialisé : la clé du compte disparaît, et avec elle les enveloppes des clés de ses vidéos
-- (le site ne lit pas lui-même le lien compte ↔ vidéo).
CREATE FUNCTION core.forget_account_message_key(p_account uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    UPDATE core.public_keys k SET owner_wrapped = NULL
      FROM core.pseudonyms p, core.video_owners o
     WHERE k.pseudonym_id = p.id AND o.video_id = p.video_id AND o.account_id = p_account AND k.owner_wrapped IS NOT NULL;
    DELETE FROM core.public_keys WHERE account_id = p_account;
$$;
REVOKE ALL ON FUNCTION core.forget_account_message_key(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.forget_account_message_key(uuid) TO argos_app;
