-- Codes de secours et changement de mot de passe (étape 4d, 4 novembre 2026).
--
-- 10 codes par compte, montrés une seule fois. La base n'en garde que l'empreinte HMAC (clé hors
-- de la base) : un code fait ~50 bits, un simple hachage serait cassable par force brute.
-- Un code sert une fois ; une régénération annule tous les codes restants.

ALTER TABLE core.backup_codes
    ADD COLUMN created_at     timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN invalidated_at timestamptz,
    ADD CONSTRAINT backup_codes_hash_format CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT backup_codes_hash_unique UNIQUE (code_hash);

CREATE INDEX backup_codes_active ON core.backup_codes (account_id)
    WHERE used_at IS NULL AND invalidated_at IS NULL;

-- Le site marque un code utilisé ou annulé, rien d'autre ; et jamais dans l'autre sens.
REVOKE UPDATE ON core.backup_codes FROM argos_app;
GRANT UPDATE (used_at, invalidated_at) ON core.backup_codes TO argos_app;

CREATE FUNCTION core.forbid_backup_code_reuse() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (OLD.used_at IS NOT NULL AND NEW.used_at IS DISTINCT FROM OLD.used_at)
       OR (OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at) THEN
        RAISE EXCEPTION 'un code de secours utilisé ou annulé ne peut pas redevenir valable';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER backup_codes_forbid_reuse BEFORE UPDATE ON core.backup_codes
    FOR EACH ROW EXECUTE FUNCTION core.forbid_backup_code_reuse();
REVOKE ALL ON FUNCTION core.forbid_backup_code_reuse() FROM PUBLIC;

-- Mot de passe : le site ne peut changer que l'empreinte et sa date, jamais le compte concerné.
REVOKE UPDATE ON core.credentials FROM argos_app;
GRANT UPDATE (password_hash, updated_at) ON core.credentials TO argos_app;

-- La création d'un relecteur inclut désormais ses 10 codes de secours, dans la même transaction.
DROP FUNCTION identity.create_reviewer(text, text, bytea, bytea, bytea, inet, integer);

CREATE FUNCTION identity.create_reviewer(
    p_username      text,
    p_password_hash text,
    p_phone_hmac    bytea,
    p_email_hmac    bytea,
    p_email_enc     bytea,
    p_backup_hashes text[],
    p_ip            inet,
    p_source_port   integer
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_id uuid;
BEGIN
    IF p_password_hash IS NULL OR p_password_hash NOT LIKE '$argon2id$%' THEN
        RAISE EXCEPTION 'empreinte de mot de passe invalide (Argon2id attendu)' USING ERRCODE = '22023';
    END IF;
    IF coalesce(cardinality(p_backup_hashes), 0) <> 10 THEN
        RAISE EXCEPTION '10 codes de secours attendus' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM identity.account_identities
                WHERE banned AND (phone_hmac = p_phone_hmac OR email_hmac = p_email_hmac)) THEN
        RAISE EXCEPTION 'numéro ou mail banni' USING ERRCODE = '42501';
    END IF;

    INSERT INTO core.accounts (username) VALUES (p_username) RETURNING id INTO v_id;
    INSERT INTO core.credentials (account_id, password_hash) VALUES (v_id, p_password_hash);
    INSERT INTO core.backup_codes (account_id, code_hash) SELECT v_id, h FROM unnest(p_backup_hashes) AS h;
    INSERT INTO identity.account_identities (account_id, phone_hmac, email_hmac, email_enc)
         VALUES (v_id, p_phone_hmac, p_email_hmac, p_email_enc);
    INSERT INTO identity.legal_connection_logs (account_id, action, ip, source_port)
         VALUES (v_id, 'signup', p_ip, p_source_port);
    RETURN v_id;
END
$$;

REVOKE ALL ON FUNCTION identity.create_reviewer(text, text, bytea, bytea, bytea, text[], inet, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.create_reviewer(text, text, bytea, bytea, bytea, text[], inet, integer)
      TO argos_identity;
