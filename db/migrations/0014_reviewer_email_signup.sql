-- Mail obligatoire pour les relecteurs et création atomique d'un compte (décisions du 4 novembre 2026).
--
-- Le mail du relecteur est obligatoire et vérifié : il complique la fraude et sert à la récupération
-- du mot de passe. Il est conservé chiffré (pour lui écrire) et sous forme d'empreinte HMAC (pour
-- qu'un même mail ne serve pas à plusieurs comptes). L'empreinte est calculée sur une forme nettoyée
-- par l'application (minuscules, sans « +étiquette », sans les points pour Gmail).

ALTER TABLE identity.account_identities DROP CONSTRAINT email_verified_needs_email;
ALTER TABLE identity.account_identities
    ADD COLUMN email_hmac bytea NOT NULL UNIQUE,
    ALTER COLUMN email_enc SET NOT NULL,
    ALTER COLUMN email_verified_at SET NOT NULL,
    ALTER COLUMN email_verified_at SET DEFAULT now();

COMMENT ON COLUMN identity.account_identities.email_enc IS
    'Mail du relecteur, chiffré. Sert uniquement aux convocations, aux alertes de sécurité '
    'et à la récupération du mot de passe.';

-- Création d'un compte de relecteur, en une seule transaction : compte, mot de passe, identité
-- et journal légal. Appelée par le rôle d'inscription (argos_identity), qui n'a sinon aucun accès
-- aux comptes : la fonction n'écrit que ce qu'on lui passe et ne renvoie que l'identifiant créé.
-- Un pseudo, un numéro ou un mail déjà pris lève l'erreur d'unicité standard (23505).
CREATE FUNCTION identity.create_reviewer(
    p_username      text,
    p_password_hash text,
    p_phone_hmac    bytea,
    p_email_hmac    bytea,
    p_email_enc     bytea,
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
    IF EXISTS (SELECT 1 FROM identity.account_identities
                WHERE banned AND (phone_hmac = p_phone_hmac OR email_hmac = p_email_hmac)) THEN
        RAISE EXCEPTION 'numéro ou mail banni' USING ERRCODE = '42501';
    END IF;

    INSERT INTO core.accounts (username) VALUES (p_username) RETURNING id INTO v_id;
    INSERT INTO core.credentials (account_id, password_hash) VALUES (v_id, p_password_hash);
    INSERT INTO identity.account_identities (account_id, phone_hmac, email_hmac, email_enc)
         VALUES (v_id, p_phone_hmac, p_email_hmac, p_email_enc);
    INSERT INTO identity.legal_connection_logs (account_id, action, ip, source_port)
         VALUES (v_id, 'signup', p_ip, p_source_port);
    RETURN v_id;
END
$$;

REVOKE ALL ON FUNCTION identity.create_reviewer(text, text, bytea, bytea, bytea, inet, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identity.create_reviewer(text, text, bytea, bytea, bytea, inet, integer)
      TO argos_identity;
