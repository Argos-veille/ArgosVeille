-- Filtres de la liste des vidéos de l'administration (demande de l’administrateur, 5 novembre 2026) :
-- statut, nature, forces, période d'envoi, avec signalement ouvert, sous gel légal, recherche dans le
-- pseudonyme et la description.

DROP FUNCTION core.admin_videos(uuid, text);

CREATE FUNCTION core.admin_videos(p_admin uuid, p_filters jsonb)
RETURNS TABLE (id uuid, status text, submitted_at timestamptz, decided_at timestamptz, category text, subcategory text,
               occurred_at timestamptz, description text, pseudonym text, open_reports integer, legal_hold boolean, forces text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    f_status   text := p_filters ->> 'status';
    f_category text := p_filters ->> 'category';
    f_sub      text := p_filters ->> 'subcategory';
    f_forces   text := p_filters ->> 'forces';
    f_since    date := (p_filters ->> 'since')::date;
    f_until    date := (p_filters ->> 'until')::date;
    f_reports  boolean := coalesce((p_filters ->> 'reports')::boolean, false);
    f_hold     boolean := coalesce((p_filters ->> 'hold')::boolean, false);
    f_text     text := nullif(btrim(coalesce(p_filters ->> 'text', '')), '');
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY
        SELECT v.id, v.status, v.submitted_at, v.decided_at, v.category, v.subcategory, v.occurred_at,
               left(v.description, 200), p.pseudonym,
               (SELECT count(*)::int FROM core.reports r WHERE r.video_id = v.id AND r.status = 'open'),
               v.legal_hold, v.forces
          FROM core.videos v LEFT JOIN core.pseudonyms p ON p.video_id = v.id
         WHERE NOT v.is_control AND v.status <> 'uploading'
           AND (f_status IS NULL OR v.status = f_status)
           AND (f_category IS NULL OR v.category = f_category)
           AND (f_sub IS NULL OR v.subcategory = f_sub)
           AND (f_forces IS NULL OR v.forces = f_forces)
           AND (f_since IS NULL OR v.submitted_at >= f_since::timestamptz)
           AND (f_until IS NULL OR v.submitted_at < (f_until + 1)::timestamptz)
           AND (NOT f_hold OR v.legal_hold)
           AND (NOT f_reports OR EXISTS (SELECT 1 FROM core.reports r WHERE r.video_id = v.id AND r.status = 'open'))
           AND (f_text IS NULL OR p.pseudonym ILIKE '%' || f_text || '%' OR v.description ILIKE '%' || f_text || '%'
                OR v.id::text = f_text)
         ORDER BY coalesce(v.decided_at, v.submitted_at) DESC
         LIMIT 300;
END $$;

REVOKE ALL ON FUNCTION core.admin_videos(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_videos(uuid, jsonb) TO argos_app;
