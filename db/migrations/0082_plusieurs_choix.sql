-- Plusieurs choix à l'envoi pour « Plus précisément » et « Situation » (9 novembre 2026) : 3 au plus.
-- subcategory et situation restent le choix principal ; ces listes portent les autres choix.
ALTER TABLE core.videos
    ADD COLUMN extra_subcategories text[] NOT NULL DEFAULT '{}',
    ADD COLUMN extra_situations    text[] NOT NULL DEFAULT '{}',
    ADD CONSTRAINT videos_extra_subcategories_valid CHECK (
        cardinality(extra_subcategories) <= 2
        AND (cardinality(extra_subcategories) < 2 OR extra_subcategories[1] <> extra_subcategories[2])
        AND (cardinality(extra_subcategories) = 0 OR (
            subcategory IS NOT NULL AND subcategory <> ALL (extra_subcategories) AND (
                (category = 'violence' AND extra_subcategories <@ ARRAY['strikes', 'disproportionate_force', 'weapons', 'chokehold', 'other_violence'])
                OR (category = 'abuse' AND extra_subcategories <@ ARRAY['contested_arrest', 'discriminatory_stop', 'insults', 'intimidation',
                        'filming_obstruction', 'property_destruction', 'complaint_refused', 'other_abuse']))))
    ),
    ADD CONSTRAINT videos_extra_situations_valid CHECK (
        cardinality(extra_situations) <= 2
        AND (cardinality(extra_situations) < 2 OR extra_situations[1] <> extra_situations[2])
        AND (cardinality(extra_situations) = 0 OR (
            situation IS NOT NULL AND situation <> ALL (extra_situations)
            AND extra_situations <@ ARRAY['demonstration', 'stop', 'arrest', 'other']))
    );

-- Comme les autres champs du contexte : saisis à l'envoi, jamais modifiés ensuite par le site.
GRANT SELECT (extra_subcategories, extra_situations), INSERT (extra_subcategories, extra_situations)
      ON core.videos TO argos_app;

-- Liste de l'administration : les autres choix sont affichés, et le filtre en tient compte.
DROP FUNCTION core.admin_videos(uuid, jsonb);

CREATE FUNCTION core.admin_videos(p_admin uuid, p_filters jsonb)
RETURNS TABLE (id uuid, status text, submitted_at timestamptz, decided_at timestamptz, category text, subcategory text,
               occurred_at timestamptz, description text, pseudonym text, open_reports integer, legal_hold boolean, forces text,
               extra_subcategories text[])
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
               v.legal_hold, v.forces, v.extra_subcategories
          FROM core.videos v LEFT JOIN core.pseudonyms p ON p.video_id = v.id
         WHERE NOT v.is_control AND v.status <> 'uploading'
           AND (f_status IS NULL OR v.status = f_status)
           AND (f_category IS NULL OR v.category = f_category)
           AND (f_sub IS NULL OR v.subcategory = f_sub OR f_sub = ANY (v.extra_subcategories))
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
