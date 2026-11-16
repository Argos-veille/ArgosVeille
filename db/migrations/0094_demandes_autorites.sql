-- Demandes des autorités (14 novembre 2026, demande de l’administrateur) : registre privé tenu par le super-administrateur.
-- Jamais au journal public une par une (une entrée datée et liée à une vidéo pourrait révéler une enquête ou qu'on
-- cherche une source) : seulement comptées, par trimestre terminé, dans le rapport de transparence (petits nombres
-- masqués par l'API).

CREATE TABLE core.authority_requests (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    received_on  date NOT NULL,
    requester    text NOT NULL CHECK (requester IN ('police', 'judicial', 'administration', 'other')),
    nature       text NOT NULL CHECK (nature IN ('removal', 'identification', 'preservation', 'other')),
    video_id     uuid REFERENCES core.videos (id) ON DELETE SET NULL,
    outcome      text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'complied', 'partial', 'refused')),
    notes        text CHECK (notes IS NULL OR length(notes) <= 5000),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON core.authority_requests FROM PUBLIC;

CREATE FUNCTION core.admin_authority_requests(p_admin uuid)
RETURNS TABLE (id uuid, received_on date, requester text, nature text, video_id uuid, video_pseudonym text,
               outcome text, notes text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY SELECT r.id, r.received_on, r.requester, r.nature, r.video_id,
                        (SELECT p.pseudonym FROM core.pseudonyms p WHERE p.video_id = r.video_id), r.outcome, r.notes
                   FROM core.authority_requests r ORDER BY r.received_on DESC, r.created_at DESC;
END $$;

-- p_id NULL : nouvelle demande ; sinon modification. Renvoie l'identifiant (NULL : introuvable).
CREATE FUNCTION core.admin_authority_request_save(p_admin uuid, p_id uuid, p_received date, p_requester text, p_nature text,
                                                  p_video uuid, p_outcome text, p_notes text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_id uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF p_received IS NULL OR p_received > current_date OR p_received < '2026-01-01' THEN
        RAISE EXCEPTION 'argos:date_invalide';
    END IF;
    IF length(coalesce(p_notes, '')) > 5000 THEN
        RAISE EXCEPTION 'argos:details';
    END IF;
    IF p_video IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.videos WHERE id = p_video) THEN
        RAISE EXCEPTION 'argos:video_introuvable';
    END IF;
    IF p_id IS NULL THEN
        INSERT INTO core.authority_requests (received_on, requester, nature, video_id, outcome, notes)
        VALUES (p_received, p_requester, p_nature, p_video, p_outcome, nullif(btrim(coalesce(p_notes, '')), ''))
        RETURNING id INTO v_id;
    ELSE
        UPDATE core.authority_requests
           SET received_on = p_received, requester = p_requester, nature = p_nature, video_id = p_video, outcome = p_outcome,
               notes = nullif(btrim(coalesce(p_notes, '')), ''), updated_at = now()
         WHERE id = p_id RETURNING id INTO v_id;
    END IF;
    RETURN v_id;
END $$;

CREATE FUNCTION core.admin_authority_request_delete(p_admin uuid, p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    DELETE FROM core.authority_requests WHERE id = p_id;
    RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION core.admin_authority_requests(uuid),
                       core.admin_authority_request_save(uuid, uuid, date, text, text, uuid, text, text),
                       core.admin_authority_request_delete(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_authority_requests(uuid),
                          core.admin_authority_request_save(uuid, uuid, date, text, text, uuid, text, text),
                          core.admin_authority_request_delete(uuid, uuid) TO argos_app;

-- Rapport de transparence : le nombre de demandes reçues pendant le trimestre, par auteur, par objet et par suite.
CREATE OR REPLACE FUNCTION core.transparency_authority(p_from date, p_to date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, public
AS $$
    SELECT jsonb_build_object(
        'parAuteur', coalesce((SELECT jsonb_object_agg(requester, n) FROM (SELECT requester, count(*) AS n FROM core.authority_requests
                                WHERE received_on >= p_from AND received_on < p_to GROUP BY 1) x), '{}'),
        'parObjet', coalesce((SELECT jsonb_object_agg(nature, n) FROM (SELECT nature, count(*) AS n FROM core.authority_requests
                                WHERE received_on >= p_from AND received_on < p_to GROUP BY 1) x), '{}'),
        'parSuite', coalesce((SELECT jsonb_object_agg(outcome, n) FROM (SELECT outcome, count(*) AS n FROM core.authority_requests
                                WHERE received_on >= p_from AND received_on < p_to GROUP BY 1) x), '{}'))
$$;
REVOKE ALL ON FUNCTION core.transparency_authority(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.transparency_authority(date, date) TO argos_app;
