-- Notes de l'administration (14 novembre 2026, demande de l’administrateur) : pense-bêtes privés en tête du tableau de bord,
-- avec une date facultative (échéance). Réservées au super-administrateur, jamais publiques ni au journal.

CREATE TABLE core.admin_notes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title       text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
    due_date    date,
    details     text CHECK (details IS NULL OR length(details) <= 2000),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON core.admin_notes FROM PUBLIC;

CREATE FUNCTION core.admin_notes_list(p_admin uuid)
RETURNS TABLE (id uuid, title text, due_date date, details text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY SELECT n.id, n.title, n.due_date, n.details FROM core.admin_notes n
                  ORDER BY n.due_date NULLS LAST, n.created_at;
END $$;

-- p_id NULL : nouvelle note ; sinon modification. Renvoie l'identifiant (NULL : note introuvable).
CREATE FUNCTION core.admin_note_save(p_admin uuid, p_id uuid, p_title text, p_due date, p_details text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_id uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF length(btrim(coalesce(p_title, ''))) NOT BETWEEN 1 AND 200 OR length(coalesce(p_details, '')) > 2000 THEN
        RAISE EXCEPTION 'argos:details';
    END IF;
    IF p_id IS NULL THEN
        INSERT INTO core.admin_notes (title, due_date, details)
        VALUES (btrim(p_title), p_due, nullif(btrim(coalesce(p_details, '')), '')) RETURNING id INTO v_id;
    ELSE
        UPDATE core.admin_notes SET title = btrim(p_title), due_date = p_due,
                                    details = nullif(btrim(coalesce(p_details, '')), ''), updated_at = now()
         WHERE id = p_id RETURNING id INTO v_id;
    END IF;
    RETURN v_id;
END $$;

CREATE FUNCTION core.admin_note_delete(p_admin uuid, p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    DELETE FROM core.admin_notes WHERE id = p_id;
    RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION core.admin_notes_list(uuid), core.admin_note_save(uuid, uuid, text, date, text),
                       core.admin_note_delete(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_notes_list(uuid), core.admin_note_save(uuid, uuid, text, date, text),
                          core.admin_note_delete(uuid, uuid) TO argos_app;
