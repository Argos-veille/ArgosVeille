-- Relecture croisée (15 novembre 2026) : depuis N3, le super-administrateur ne se connecte plus au site public, où se
-- fait la relecture. Il n'est donc plus tiré au sort, ni pour le premier tour ni pour un jury (sinon ses convocations
-- expireraient : places perdues et score abaissé). Il garde l'administration et les outils d'analyste (0131).
CREATE OR REPLACE FUNCTION core.draw_summons() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    p      jsonb;
    v      record;
    places integer;
    manque integer;
    ajout  integer;
    total  integer := 0;
BEGIN
    SELECT params INTO p FROM core.settings ORDER BY version DESC LIMIT 1;
    UPDATE core.summons SET outcome = 'expired' WHERE outcome = 'pending' AND expires_at <= now();

    FOR v IN SELECT id FROM core.videos WHERE status = 'in_review'
              ORDER BY submitted_at FOR UPDATE SKIP LOCKED LOOP
        places := core.review_seats(v.id)
                  - (SELECT count(*) FROM core.votes WHERE video_id = v.id AND round = 'review');
        CONTINUE WHEN places <= 0;
        manque := places * (p ->> 'summons_per_seat')::int
                  - (SELECT count(*) FROM core.summons WHERE video_id = v.id AND round = 'review' AND outcome = 'pending');
        CONTINUE WHEN manque <= 0;

        INSERT INTO core.summons (video_id, account_id, round, expires_at)
        SELECT v.id, a.id, 'review', now() + ((p ->> 'summons_days')::numeric * interval '1 day')
          FROM core.accounts a
         WHERE a.status = 'active'
           AND NOT a.review_opt_out                                                     -- « ne pas me convoquer »
           AND NOT a.is_superadmin
           AND NOT EXISTS (SELECT 1 FROM core.video_owners o WHERE o.video_id = v.id AND o.account_id = a.id)  -- sa propre vidéo
           AND NOT EXISTS (SELECT 1 FROM core.summons s
                            WHERE s.video_id = v.id AND s.account_id = a.id AND s.round = 'review')
           AND (SELECT count(*) FROM core.votes vo
                 WHERE vo.account_id = a.id AND vo.cast_at > now() - interval '24 hours') < (p ->> 'reviews_per_day')::int
         ORDER BY gen_random_uuid()
         LIMIT manque;
        GET DIAGNOSTICS ajout = ROW_COUNT;
        total := total + ajout;
    END LOOP;
    RETURN total;
END
$$;

CREATE OR REPLACE FUNCTION core.jury_pool(p_video uuid, p jsonb) RETURNS TABLE (account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH anciens AS (
        SELECT a.id, a.score
          FROM core.accounts a
         WHERE a.status = 'active' AND NOT a.suspect AND NOT a.review_opt_out AND NOT a.is_superadmin
           AND (a.certified OR a.created_at <= now() - ((p ->> 'jury_min_age_days')::numeric * interval '1 day'))
           AND EXISTS (SELECT 1 FROM core.mfa_factors f WHERE f.account_id = a.id AND f.revoked_at IS NULL)
    ), haut AS (
        SELECT id FROM anciens
         ORDER BY score DESC, id
         LIMIT ceil((SELECT count(*) FROM anciens) * (p ->> 'jury_pool_share')::numeric)::int
    )
    SELECT h.id FROM haut h
     WHERE NOT EXISTS (SELECT 1 FROM core.video_owners o WHERE o.video_id = p_video AND o.account_id = h.id)
       AND NOT EXISTS (SELECT 1 FROM core.summons s
                        WHERE s.video_id = p_video AND s.account_id = h.id)   -- premier tour, ou déjà convoqué au jury
       AND (SELECT count(*) FROM core.summons s
             WHERE s.account_id = h.id AND s.round = 'jury' AND s.outcome IN ('pending', 'voted')
               AND s.sent_at > now() - make_interval(days => 7)) < (p ->> 'jury_max_per_week')::int
       AND (SELECT count(*) FROM core.votes vo
             WHERE vo.account_id = h.id AND vo.cast_at > now() - interval '24 hours') < (p ->> 'reviews_per_day')::int
$$;
