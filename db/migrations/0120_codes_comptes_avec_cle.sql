-- Audit du 15 novembre 2026, H4 : créer un code de compte vérifié (journaliste, avocat, association, analyste) ne
-- demandait ni la clé physique, ni motif, ni trace, alors qu'accorder le même statut depuis la fiche d'un compte exige
-- la clé. Désormais : motif obligatoire et inscription au journal public (action de l'administration, différée comme les
-- autres), en plus de la clé vérifiée par l'API. Le nom du code (souvent celui de la personne) n'y figure jamais.

DROP FUNCTION core.admin_create_account_code(uuid, bytea, text, text, timestamptz, bytea);
DROP FUNCTION core.admin_revoke_account_code(uuid, uuid);

CREATE FUNCTION core.admin_create_account_code(p_admin uuid, p_hmac bytea, p_label text, p_category text,
                                               p_expires timestamptz, p_code_enc bytea, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_id uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:motif';
    END IF;
    IF p_expires IS NOT NULL AND p_expires <= now() THEN
        RAISE EXCEPTION 'argos:expiration_passee';
    END IF;
    INSERT INTO core.account_codes (code_hmac, label, category, created_by, expires_at, code_enc)
    VALUES (p_hmac, btrim(p_label), p_category, p_admin, p_expires, p_code_enc) RETURNING id INTO v_id;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', 'account_code_created', 'category', p_category, 'reason', btrim(p_reason)));
    RETURN v_id;
END $$;

CREATE FUNCTION core.admin_revoke_account_code(p_admin uuid, p_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_category text;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:motif';
    END IF;
    UPDATE core.account_codes SET revoked_at = now() WHERE id = p_id AND revoked_at IS NULL AND used_at IS NULL
    RETURNING category INTO v_category;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', 'account_code_revoked', 'category', v_category, 'reason', btrim(p_reason)));
END $$;

REVOKE ALL ON FUNCTION core.admin_create_account_code(uuid, bytea, text, text, timestamptz, bytea, text),
                       core.admin_revoke_account_code(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_create_account_code(uuid, bytea, text, text, timestamptz, bytea, text),
                          core.admin_revoke_account_code(uuid, uuid, text) TO argos_administration;
