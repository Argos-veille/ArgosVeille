-- Règles de relecture modifiables depuis l'administration (13 novembre 2026, demande de l’administrateur).
-- Chaque changement ajoute une nouvelle version (jamais de réécriture), avec son motif, inscrit au
-- journal public (rule_change). Réservé au super-administrateur ; l'API vérifie la clé physique et
-- les bornes de chaque réglage.

ALTER TABLE core.settings ADD COLUMN reason text;

-- log_admin_action (dernière version : 0011_hardening.sql) : le motif d'un changement de règle part au journal.
CREATE OR REPLACE FUNCTION core.log_admin_action() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, public
AS $$
-- Tests imbriqués par table : PL/pgSQL refuse de lire un champ absent de la table déclencheuse.
BEGIN
    IF TG_TABLE_NAME = 'sanctions' THEN
        PERFORM ledger.append('admin_action', jsonb_build_object(
            'action', 'sanction', 'kind', NEW.kind, 'reason', NEW.reason_code));
    ELSIF TG_TABLE_NAME = 'admin_rights' THEN
        IF TG_OP = 'INSERT' THEN
            PERFORM ledger.append('admin_action', jsonb_build_object(
                'action', 'right_granted', 'right', NEW.right_code, 'expires', NEW.expires_at));
        ELSIF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
            PERFORM ledger.append('admin_action', jsonb_build_object(
                'action', 'right_revoked', 'right', NEW.right_code));
        END IF;
    ELSIF TG_TABLE_NAME = 'verifications' THEN
        PERFORM ledger.append('admin_action', jsonb_build_object(
            'action', 'verification', 'category', NEW.category));
    ELSIF TG_TABLE_NAME = 'settings' THEN
        PERFORM ledger.append('rule_change', jsonb_strip_nulls(jsonb_build_object(
            'version', NEW.version, 'params', NEW.params, 'reason', NEW.reason)));
    END IF;
    RETURN NEW;
END
$$;

-- Nouvelle version des règles : la dernière, avec les valeurs changées. Renvoie le numéro de version.
CREATE FUNCTION core.admin_set_rules(p_admin uuid, p_changes jsonb, p_reason text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_params jsonb;
    v_version integer;
    k text;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'argos:motif'; END IF;
    IF jsonb_typeof(p_changes) <> 'object' OR p_changes = '{}'::jsonb THEN RAISE EXCEPTION 'argos:regles_invalides'; END IF;
    FOR k IN SELECT jsonb_object_keys(p_changes) LOOP
        IF jsonb_typeof(p_changes -> k) <> 'number' THEN RAISE EXCEPTION 'argos:regles_invalides'; END IF;
    END LOOP;
    SELECT params INTO v_params FROM core.settings ORDER BY version DESC LIMIT 1 FOR UPDATE;
    IF v_params @> p_changes THEN RAISE EXCEPTION 'argos:deja_ainsi'; END IF;
    INSERT INTO core.settings (params, changed_by, reason)
    VALUES (v_params || p_changes, p_admin, btrim(p_reason))
    RETURNING version INTO v_version;
    RETURN v_version;
END $$;
REVOKE ALL ON FUNCTION core.admin_set_rules(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_set_rules(uuid, jsonb, text) TO argos_app;

