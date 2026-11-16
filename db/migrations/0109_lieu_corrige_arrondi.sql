-- Point bas de la revue (15 novembre 2026) : à précision égale ou moindre que celle de la source, le point donné par
-- l'analyste passait tel quel (seul le site l'arrondissait). La base l'arrondit maintenant toujours selon la précision.
CREATE OR REPLACE FUNCTION core.osint_correct_context(p_account uuid, p_video uuid, p_occurred_at timestamp with time zone, p_time_known boolean, p_lat double precision, p_lon double precision, p_precision text, p_justification text, p_links text[], p_settles_date boolean DEFAULT false, p_settles_location boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
    v       record;
    v_id    uuid;
    pseudo  text;
    lieu    public.geography;
    reste   boolean;
    source  text;      -- précision choisie par la source
    rang    jsonb := '{"municipality": 1, "approx_100m": 2, "exact": 3}';
    libre   boolean;   -- lieu « à établir » : la source ne connaissait pas le lieu, pas de plafond
BEGIN
    IF NOT core.is_osint_analyst(p_account) THEN
        RAISE EXCEPTION 'argos:reserve_analyste';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.mfa_factors WHERE account_id = p_account AND revoked_at IS NULL) THEN
        RAISE EXCEPTION 'argos:double_auth_requise';
    END IF;
    SELECT vi.id, vi.status, vi.occurred_at, vi.occurred_time_known, vi.location, vi.location_precision, vi.declared_occurred_at, vi.declared_location_precision,
           vi.date_to_establish, vi.location_to_establish
      INTO v FROM core.videos vi
     WHERE vi.id = p_video AND vi.status IN ('in_review', 'jury', 'awaiting_osint') AND NOT vi.is_control FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:video_hors_relecture';
    END IF;
    IF p_occurred_at IS NULL OR p_occurred_at > now() + interval '10 minutes' OR p_occurred_at < '2000-01-01' THEN
        RAISE EXCEPTION 'argos:date_invalide';
    END IF;
    IF p_precision NOT IN ('exact', 'approx_100m', 'municipality') OR p_lat NOT BETWEEN -90 AND 90 OR p_lon NOT BETWEEN -180 AND 180 THEN
        RAISE EXCEPTION 'argos:lieu_invalide';
    END IF;
    IF length(btrim(coalesce(p_justification, ''))) NOT BETWEEN 10 AND 5000 THEN
        RAISE EXCEPTION 'argos:justification';
    END IF;
    IF coalesce(cardinality(p_links), 0) NOT BETWEEN 1 AND 10
       OR EXISTS (SELECT 1 FROM unnest(p_links) l
                   WHERE l IS NULL OR length(l) > 2000 OR l !~ '^https://[^\s/?#@]+\.[^\s/?#@]+([/?#]\S*)?$') THEN
        RAISE EXCEPTION 'argos:liens_invalides';
    END IF;
    -- Jamais plus précis que ce que la source a choisi : le lieu exact de la prise de vue peut désigner celle ou celui
    -- qui filme. Sauf si la source ne connaissait pas le lieu (vidéo reprise des réseaux) : l'analyste l'établit librement.
    source := coalesce(v.declared_location_precision, v.location_precision);
    libre := v.location_to_establish OR EXISTS (SELECT 1 FROM core.context_corrections cc
                                                 WHERE cc.video_id = p_video AND cc.settled_location AND cc.cancelled_at IS NULL);
    IF NOT libre AND source IS NOT NULL AND (rang ->> p_precision)::int > (rang ->> source)::int THEN
        p_precision := source;
        p_lat := round(p_lat::numeric, CASE source WHEN 'approx_100m' THEN 3 ELSE 2 END)::double precision;
        p_lon := round(p_lon::numeric, CASE source WHEN 'approx_100m' THEN 3 ELSE 2 END)::double precision;
    END IF;
    -- Point arrondi selon la précision retenue, comme à l'envoi (5, 3 ou 2 décimales), même sans plafond : la base
    -- ne compte plus sur le site pour arrondir (point bas de la revue, 15 novembre 2026).
    p_lat := round(p_lat::numeric, CASE p_precision WHEN 'exact' THEN 5 WHEN 'approx_100m' THEN 3 ELSE 2 END)::double precision;
    p_lon := round(p_lon::numeric, CASE p_precision WHEN 'exact' THEN 5 WHEN 'approx_100m' THEN 3 ELSE 2 END)::double precision;
    lieu := public.ST_SetSRID(public.ST_MakePoint(p_lon, p_lat), 4326)::public.geography;

    -- Première correction : ce que la source a déclaré est mis de côté, pour toujours.
    IF v.declared_occurred_at IS NULL THEN
        UPDATE core.videos SET declared_occurred_at = v.occurred_at, declared_time_known = v.occurred_time_known,
                               declared_location = v.location, declared_location_precision = v.location_precision
         WHERE id = p_video;
    END IF;
    INSERT INTO core.context_corrections (video_id, author_id, occurred_at, time_known, location, location_precision,
                                          previous_occurred_at, previous_time_known, previous_location, previous_precision,
                                          justification, links, settled_date, settled_location)
    VALUES (p_video, p_account, p_occurred_at, coalesce(p_time_known, true), lieu, p_precision,
            v.occurred_at, v.occurred_time_known, v.location, v.location_precision, btrim(p_justification), p_links,
            v.date_to_establish AND coalesce(p_settles_date, false), v.location_to_establish AND coalesce(p_settles_location, false))
    RETURNING id INTO v_id;
    UPDATE core.videos SET occurred_at = p_occurred_at, occurred_time_known = coalesce(p_time_known, true),
                           location = lieu, location_precision = p_precision,
                           date_to_establish = date_to_establish AND NOT coalesce(p_settles_date, false),
                           location_to_establish = location_to_establish AND NOT coalesce(p_settles_location, false)
     WHERE id = p_video
    RETURNING date_to_establish OR location_to_establish INTO reste;
    SELECT username INTO pseudo FROM core.accounts WHERE id = p_account;
    PERFORM ledger.append('correction', jsonb_build_object('video', p_video, 'correction', v_id, 'analyst', pseudo));
    IF v.status = 'awaiting_osint' AND NOT reste THEN
        UPDATE core.videos SET status = 'published' WHERE id = p_video;
    END IF;
    RETURN v_id;
END
$function$;
