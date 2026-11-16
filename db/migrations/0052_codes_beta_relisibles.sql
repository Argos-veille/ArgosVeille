-- Codes bêta réaffichables dans l'administration (demande de l’administrateur, 7 novembre 2026), pour pouvoir les
-- renvoyer : le code est gardé CHIFFRÉ par le site (même clé que les adresses mail), en plus de son empreinte
-- qui sert toujours à la vérification. Les codes créés avant cette migration ne sont pas réaffichables.
ALTER TABLE core.beta_codes ADD COLUMN code_enc bytea;

DROP FUNCTION core.admin_create_beta_code(uuid, bytea, text, timestamptz);
CREATE FUNCTION core.admin_create_beta_code(p_admin uuid, p_hmac bytea, p_label text, p_expires timestamptz,
                                            p_code_enc bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_id uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF p_expires IS NOT NULL AND p_expires <= now() THEN
        RAISE EXCEPTION 'argos:expiration_passee';
    END IF;
    INSERT INTO core.beta_codes (code_hmac, label, created_by, expires_at, code_enc)
    VALUES (p_hmac, btrim(p_label), p_admin, p_expires, p_code_enc) RETURNING id INTO v_id;
    RETURN v_id;
END $$;

DROP FUNCTION core.admin_beta_codes(uuid);
CREATE FUNCTION core.admin_beta_codes(p_admin uuid)
RETURNS TABLE (id uuid, label text, created_at timestamptz, expires_at timestamptz, revoked_at timestamptz,
               last_used_at timestamptz, entries integer, code_enc bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY SELECT c.id, c.label, c.created_at, c.expires_at, c.revoked_at, c.last_used_at, c.entries, c.code_enc
                   FROM core.beta_codes c ORDER BY c.revoked_at IS NOT NULL, c.created_at DESC;
END $$;

REVOKE ALL ON FUNCTION core.admin_create_beta_code(uuid, bytea, text, timestamptz, bytea), core.admin_beta_codes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_create_beta_code(uuid, bytea, text, timestamptz, bytea), core.admin_beta_codes(uuid) TO argos_app;
