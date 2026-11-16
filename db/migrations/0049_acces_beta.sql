-- Accès à la bêta par code (validé par l’administrateur le 7 novembre 2026) : tant que le site n'est pas ouvert,
-- la page d'attente propose « J'ai un code » ; un code donne accès au vrai site.
--   - un code PAR PERSONNE, réutilisable sur d'autres appareils et d'autres jours, sans obligation de
--     s'inscrire ; valable jusqu'à son expiration (facultative) ou sa révocation ;
--   - créés et révoqués depuis l'administration ; la base ne garde que l'empreinte HMAC du code et un
--     libellé pour s'y retrouver (ex. « Marie, asso X »), jamais le code lui-même.

CREATE TABLE core.beta_codes (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hmac    bytea NOT NULL UNIQUE,
    label        text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
    created_at   timestamptz NOT NULL DEFAULT now(),
    created_by   uuid REFERENCES core.accounts (id),
    expires_at   timestamptz,
    revoked_at   timestamptz,
    last_used_at timestamptz,
    entries      integer NOT NULL DEFAULT 0      -- nombre de fois où le code a été saisi (appareils, jours)
);
REVOKE ALL ON core.beta_codes FROM PUBLIC;

-- Le code est-il valable ? (appelé à chaque requête, avec un cache côté site et API)
CREATE FUNCTION core.beta_code_valid(p_hmac bytea) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    -- Renvoie la date d'expiration (ou +infinity), NULL si le code n'est pas valable.
    SELECT coalesce(expires_at, 'infinity'::timestamptz) FROM core.beta_codes
     WHERE code_hmac = p_hmac AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
$$;

-- Saisie du code sur un appareil : compté, pour que l'administration voie s'il sert.
CREATE FUNCTION core.beta_code_enter(p_hmac bytea) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_fin timestamptz;
BEGIN
    UPDATE core.beta_codes SET entries = entries + 1, last_used_at = now()
     WHERE code_hmac = p_hmac AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
    RETURNING coalesce(expires_at, 'infinity'::timestamptz) INTO v_fin;
    RETURN v_fin;
END $$;

CREATE FUNCTION core.admin_beta_codes(p_admin uuid)
RETURNS TABLE (id uuid, label text, created_at timestamptz, expires_at timestamptz, revoked_at timestamptz,
               last_used_at timestamptz, entries integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY SELECT c.id, c.label, c.created_at, c.expires_at, c.revoked_at, c.last_used_at, c.entries
                   FROM core.beta_codes c ORDER BY c.revoked_at IS NOT NULL, c.created_at DESC;
END $$;

CREATE FUNCTION core.admin_create_beta_code(p_admin uuid, p_hmac bytea, p_label text, p_expires timestamptz)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_id uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF p_expires IS NOT NULL AND p_expires <= now() THEN
        RAISE EXCEPTION 'argos:expiration_passee';
    END IF;
    INSERT INTO core.beta_codes (code_hmac, label, created_by, expires_at)
    VALUES (p_hmac, btrim(p_label), p_admin, p_expires) RETURNING id INTO v_id;
    RETURN v_id;
END $$;

CREATE FUNCTION core.admin_revoke_beta_code(p_admin uuid, p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    UPDATE core.beta_codes SET revoked_at = now() WHERE id = p_id AND revoked_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
END $$;

REVOKE ALL ON FUNCTION core.beta_code_valid(bytea), core.beta_code_enter(bytea), core.admin_beta_codes(uuid),
                       core.admin_create_beta_code(uuid, bytea, text, timestamptz), core.admin_revoke_beta_code(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.beta_code_valid(bytea), core.beta_code_enter(bytea), core.admin_beta_codes(uuid),
                          core.admin_create_beta_code(uuid, bytea, text, timestamptz), core.admin_revoke_beta_code(uuid, uuid) TO argos_app;
