-- Formulaire de contact (9 novembre 2026). Message et adresse chiffrés par l'API ; l'adresse IP n'est pas conservée
-- avec le message. Effacé au bout d'un an. Lisible seulement par le super-administrateur.
CREATE TABLE core.contact_messages (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now(),
    reason     text NOT NULL CHECK (reason IN ('content', 'right_of_reply', 'personal_data', 'authority', 'press', 'other')),
    email_enc  bytea,
    body_enc   bytea NOT NULL,
    handled_at timestamptz,
    CHECK (reason NOT IN ('right_of_reply', 'personal_data') OR email_enc IS NOT NULL)
);
CREATE INDEX contact_messages_time ON core.contact_messages (created_at);
REVOKE ALL ON core.contact_messages FROM PUBLIC;

CREATE FUNCTION core.contact_create(p_reason text, p_email_enc bytea, p_body_enc bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    INSERT INTO core.contact_messages (reason, email_enc, body_enc) VALUES (p_reason, p_email_enc, p_body_enc);
$$;

CREATE FUNCTION core.admin_contact_messages(p_admin uuid, p_handled boolean)
RETURNS TABLE (id uuid, created_at timestamptz, reason text, email_enc bytea, body_enc bytea, handled_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY SELECT m.id, m.created_at, m.reason, m.email_enc, m.body_enc, m.handled_at
      FROM core.contact_messages m WHERE (m.handled_at IS NOT NULL) = p_handled
     ORDER BY m.created_at DESC LIMIT 300;
END $$;

CREATE FUNCTION core.admin_contact_handle(p_admin uuid, p_id uuid, p_handled boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    UPDATE core.contact_messages SET handled_at = CASE WHEN p_handled THEN now() END WHERE id = p_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
END $$;

CREATE FUNCTION core.admin_dashboard_contacts(p_admin uuid) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN (SELECT count(*)::int FROM core.contact_messages WHERE handled_at IS NULL);
END $$;

CREATE FUNCTION core.purge_contact_messages() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    DELETE FROM core.contact_messages WHERE created_at < now() - interval '1 year';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

REVOKE ALL ON FUNCTION core.contact_create(text, bytea, bytea), core.admin_contact_messages(uuid, boolean),
                       core.admin_contact_handle(uuid, uuid, boolean), core.admin_dashboard_contacts(uuid), core.purge_contact_messages() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.contact_create(text, bytea, bytea), core.admin_contact_messages(uuid, boolean),
                          core.admin_contact_handle(uuid, uuid, boolean), core.admin_dashboard_contacts(uuid), core.purge_contact_messages() TO argos_app;
