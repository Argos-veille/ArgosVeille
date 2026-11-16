-- Durées des réglages en jours FRACTIONNAIRES (7 novembre 2026, demande de l’administrateur via la session de
-- simulation d'activité) : en développement, on peut raccourcir relecture et jury (ex. 0.007 jour ≈ 10 min).
-- En production, avec des jours entiers, le comportement est identique.
--   make_interval(days => (p ->> 'x')::int)  →  (p ->> 'x')::numeric * interval '1 day'
-- Réglages concernés : summons_days, max_review_days, jury_days, novice_days, inactivity_days, jury_min_age_days.
-- draw_jury : la marge « trop tard pour convoquer » (1 h) devient least(1 h, 10 % de jury_days).
-- Fonctions recopiées de leur dernière version (0026, 0027, 0045), sans autre changement.

-- draw_summons (dernière version : 0045_envoi_avec_compte.sql)
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

-- jury_pool (dernière version : 0045_envoi_avec_compte.sql)
CREATE OR REPLACE FUNCTION core.jury_pool(p_video uuid, p jsonb) RETURNS TABLE (account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH anciens AS (
        SELECT a.id, a.score
          FROM core.accounts a
         WHERE a.status = 'active' AND NOT a.suspect AND NOT a.review_opt_out
           AND a.created_at <= now() - ((p ->> 'jury_min_age_days')::numeric * interval '1 day')
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

-- compute_vote_weight (dernière version : 0027_jury.sql)
CREATE OR REPLACE FUNCTION core.compute_vote_weight() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, public
AS $$
DECLARE
    v_summons  core.summons%ROWTYPE;
    v_score    numeric;
    v_created  timestamptz;
    v_status   text;
    v_video    record;
    v_params   jsonb;
    v_votes    integer;
    v_places   integer;
BEGIN
    SELECT * INTO v_summons FROM core.summons WHERE id = NEW.summons_id FOR UPDATE;
    IF NOT FOUND
       OR v_summons.account_id IS DISTINCT FROM NEW.account_id
       OR v_summons.video_id <> NEW.video_id
       OR v_summons.round <> NEW.round THEN
        RAISE EXCEPTION 'argos:sans_convocation';
    END IF;
    IF v_summons.outcome <> 'pending' OR v_summons.expires_at < now() THEN
        RAISE EXCEPTION 'argos:convocation_terminee';
    END IF;

    SELECT score, created_at, status INTO v_score, v_created, v_status
      FROM core.accounts WHERE id = NEW.account_id;
    IF v_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'argos:compte_inactif';
    END IF;
    SELECT params INTO v_params FROM core.settings ORDER BY version DESC LIMIT 1;
    IF (SELECT count(*) FROM core.votes WHERE account_id = NEW.account_id AND cast_at > now() - interval '24 hours')
       >= (v_params ->> 'reviews_per_day')::int THEN
        RAISE EXCEPTION 'argos:plafond_journalier';
    END IF;

    -- Verrou sur la vidéo : deux votes simultanés ne prennent pas la même dernière place.
    SELECT status, jury_started_at INTO v_video FROM core.videos WHERE id = NEW.video_id FOR UPDATE;
    IF NEW.round = 'review' THEN
        IF v_video.status IS DISTINCT FROM 'in_review' THEN
            RAISE EXCEPTION 'argos:relecture_terminee';
        END IF;
        v_places := core.review_seats(NEW.video_id);
    ELSE
        IF v_video.status IS DISTINCT FROM 'jury' OR v_video.jury_started_at IS NULL
           OR now() >= v_video.jury_started_at + ((v_params ->> 'jury_days')::numeric * interval '1 day') THEN
            RAISE EXCEPTION 'argos:relecture_terminee';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM core.mfa_factors WHERE account_id = NEW.account_id AND revoked_at IS NULL) THEN
            RAISE EXCEPTION 'argos:double_auth_requise';
        END IF;
        v_places := (v_params ->> 'jury_size')::int;
    END IF;
    v_votes := (SELECT count(*) FROM core.votes WHERE video_id = NEW.video_id AND round = NEW.round);
    IF v_votes >= v_places THEN
        RAISE EXCEPTION 'argos:places_prises';
    END IF;
    IF v_votes + 1 >= v_places THEN
        UPDATE core.summons SET outcome = 'cancelled'
         WHERE video_id = NEW.video_id AND round = NEW.round AND outcome = 'pending' AND id <> NEW.summons_id;
    END IF;

    NEW.is_valid := CASE NEW.verdict WHEN 'valid' THEN true WHEN 'invalid' THEN false END;
    IF NEW.round = 'jury' THEN
        NEW.weight := 1;   -- un juré, une voix
    ELSE
        NEW.weight := v_score;
        IF now() - v_created < ((v_params ->> 'novice_days')::numeric * interval '1 day') THEN
            NEW.weight := v_score * (v_params ->> 'novice_factor')::numeric;
        END IF;
    END IF;
    NEW.cast_at := now();

    UPDATE core.summons SET outcome = 'voted', answered_at = now() WHERE id = NEW.summons_id;
    UPDATE core.accounts SET last_vote_at = now() WHERE id = NEW.account_id;
    IF coalesce((NEW.answers ->> 'face_identifiable')::boolean, false) THEN
        INSERT INTO core.reports (video_id, severity, reason_code, details)
        VALUES (NEW.video_id, 'normal', 'visible_identity',
                CASE NEW.round WHEN 'jury' THEN 'Visage signalé identifiable par un juré.'
                               ELSE 'Visage signalé identifiable par un relecteur pendant la relecture.' END);
    END IF;
    RETURN NEW;
END
$$;

-- decide_reviews (dernière version : 0026_votes_decisions.sql)
CREATE OR REPLACE FUNCTION core.decide_reviews() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    p       jsonb;
    v       record;
    n       integer;
    total   numeric;
    pour    numeric;
    r       numeric;
    fin     boolean;
    statut  text;
    majo    text;
    vo      record;
    minorite uuid[];
    faites  integer := 0;
BEGIN
    SELECT params INTO p FROM core.settings ORDER BY version DESC LIMIT 1;
    FOR v IN SELECT id, is_control, control_truth, enlargements, review_started_at FROM core.videos
              WHERE status = 'in_review' FOR UPDATE SKIP LOCKED LOOP
        SELECT count(*), coalesce(sum(weight), 0),
               coalesce(sum(weight) FILTER (WHERE verdict = 'valid'), 0)
               + 0.5 * coalesce(sum(weight) FILTER (WHERE verdict = 'partly'), 0)
          INTO n, total, pour
          FROM core.votes WHERE video_id = v.id AND round = 'review';
        fin := now() >= coalesce(v.review_started_at, now()) + ((p ->> 'max_review_days')::numeric * interval '1 day');
        CONTINUE WHEN n < core.review_seats(v.id) AND NOT fin;
        r := CASE WHEN total > 0 THEN round(pour / total, 4) END;

        -- Vidéo de contrôle : la bonne réponse est connue ; jamais publiée.
        IF v.is_control THEN
            FOR vo IN SELECT account_id, verdict FROM core.votes WHERE video_id = v.id AND round = 'review'
                                                                   AND account_id IS NOT NULL LOOP
                IF vo.verdict = 'partly' THEN
                    PERFORM core.score_loss(vo.account_id, (p ->> 'control_loss')::numeric / 2, p);
                ELSIF (vo.verdict = 'valid') = v.control_truth THEN
                    PERFORM core.score_gain(vo.account_id, p);
                ELSE
                    PERFORM core.score_loss(vo.account_id, (p ->> 'control_loss')::numeric, p);
                END IF;
            END LOOP;
            statut := 'no_decision';
        ELSIF total >= (p ->> 'min_total_weight')::numeric THEN
            IF r >= (p ->> 'publish_threshold')::numeric THEN
                statut := 'published';
            ELSIF r <= (p ->> 'reject_threshold')::numeric THEN
                statut := 'rejected';
            ELSIF v.enlargements < (p ->> 'max_enlargements')::int AND NOT fin THEN
                UPDATE core.videos SET enlargements = enlargements + 1 WHERE id = v.id;
                CONTINUE;
            ELSE
                statut := 'jury';   -- vote serré : second examen (7c)
            END IF;
        ELSIF fin THEN
            statut := 'no_decision';
        ELSE
            -- Toutes les places sont prises mais le poids manque (beaucoup de nouveaux comptes) : on recrute.
            UPDATE core.videos SET extra_seats = least(300, extra_seats + (p ->> 'enlargement_size')::int) WHERE id = v.id;
            CONTINUE;
        END IF;

        UPDATE core.videos SET status = statut, first_round_ratio = r,
               decided_at = CASE WHEN statut = 'jury' THEN NULL ELSE now() END,
               decided_by_stage = CASE WHEN statut = 'jury' THEN NULL ELSE 'review' END
         WHERE id = v.id;
        UPDATE core.summons SET outcome = 'cancelled' WHERE video_id = v.id AND round = 'review' AND outcome = 'pending';
        faites := faites + 1;

        -- Scores : seulement sur un consensus net ; « en partie » ne gagne ni ne perd.
        IF NOT v.is_control AND statut IN ('published', 'rejected') THEN
            majo := CASE WHEN r >= (p ->> 'consensus_threshold')::numeric THEN 'valid'
                         WHEN r <= 1 - (p ->> 'consensus_threshold')::numeric THEN 'invalid' END;
            IF majo IS NOT NULL THEN
                minorite := '{}';
                FOR vo IN SELECT account_id, verdict FROM core.votes WHERE video_id = v.id AND round = 'review'
                                                                       AND account_id IS NOT NULL AND verdict <> 'partly' LOOP
                    IF vo.verdict = majo THEN
                        PERFORM core.score_gain(vo.account_id, p);
                    ELSE
                        PERFORM core.score_loss(vo.account_id, (p ->> 'loss')::numeric, p);
                        minorite := minorite || vo.account_id;
                    END IF;
                END LOOP;
                PERFORM core.note_minority(minorite, p);
            END IF;
        END IF;
    END LOOP;
    RETURN faites;
END
$$;

-- decay_scores (dernière version : 0026_votes_decisions.sql)
CREATE OR REPLACE FUNCTION core.decay_scores() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    p jsonb;
    n integer;
BEGIN
    IF EXISTS (SELECT 1 FROM core.engine_state WHERE name = 'decay' AND value > now() - interval '23 hours') THEN
        RETURN 0;
    END IF;
    INSERT INTO core.engine_state VALUES ('decay', now()) ON CONFLICT (name) DO UPDATE SET value = now();
    SELECT params INTO p FROM core.settings ORDER BY version DESC LIMIT 1;
    UPDATE core.accounts
       SET score = score + ((p ->> 'score_initial')::numeric - score) * (p ->> 'decay')::numeric
     WHERE coalesce(last_vote_at, created_at) < now() - ((p ->> 'inactivity_days')::numeric * interval '1 day')
       AND score <> (p ->> 'score_initial')::numeric;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END
$$;

-- draw_jury (dernière version : 0027_jury.sql)
CREATE OR REPLACE FUNCTION core.draw_jury() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    p       jsonb;
    v       record;
    places  integer;
    manque  integer;
    vivier  integer;
    fin     timestamptz;
    ajout   integer;
    total   integer := 0;
BEGIN
    SELECT params INTO p FROM core.settings ORDER BY version DESC LIMIT 1;
    UPDATE core.summons SET outcome = 'expired' WHERE outcome = 'pending' AND expires_at <= now();
    -- Alertes devenues sans objet : jury commencé, ou vidéo sortie du jury (décision de l'administration…).
    UPDATE core.admin_alerts al SET resolved_at = now()
      FROM core.videos vi
     WHERE al.kind = 'jury_waiting' AND al.resolved_at IS NULL AND vi.id = al.video_id
       AND (vi.status <> 'jury' OR vi.jury_started_at IS NOT NULL);

    FOR v IN SELECT id, jury_started_at FROM core.videos WHERE status = 'jury'
              ORDER BY jury_since NULLS FIRST FOR UPDATE SKIP LOCKED LOOP
        IF v.jury_started_at IS NULL THEN
            vivier := (SELECT count(*) FROM core.jury_pool(v.id, p));
            IF vivier < (p ->> 'jury_size')::int * (p ->> 'summons_per_seat')::int THEN
                INSERT INTO core.admin_alerts (kind, video_id, details)
                VALUES ('jury_waiting', v.id, jsonb_build_object('pool', vivier))
                ON CONFLICT (kind, video_id) WHERE resolved_at IS NULL
                DO UPDATE SET details = EXCLUDED.details;
                CONTINUE;   -- en attente de jurés
            END IF;
            UPDATE core.videos SET jury_started_at = now() WHERE id = v.id;
            UPDATE core.admin_alerts SET resolved_at = now()
             WHERE kind = 'jury_waiting' AND video_id = v.id AND resolved_at IS NULL;
            v.jury_started_at := now();
        END IF;

        fin := v.jury_started_at + ((p ->> 'jury_days')::numeric * interval '1 day');
        CONTINUE WHEN fin <= now() + least(interval '1 hour', (p ->> 'jury_days')::numeric * interval '2.4 hours');   -- trop tard pour convoquer
        places := (p ->> 'jury_size')::int
                  - (SELECT count(*) FROM core.votes WHERE video_id = v.id AND round = 'jury');
        CONTINUE WHEN places <= 0;
        manque := places * (p ->> 'summons_per_seat')::int
                  - (SELECT count(*) FROM core.summons WHERE video_id = v.id AND round = 'jury' AND outcome = 'pending');
        CONTINUE WHEN manque <= 0;

        INSERT INTO core.summons (video_id, account_id, round, expires_at)
        SELECT v.id, j.account_id, 'jury', least(now() + ((p ->> 'summons_days')::numeric * interval '1 day'), fin)
          FROM core.jury_pool(v.id, p) j
         ORDER BY gen_random_uuid()
         LIMIT manque;
        GET DIAGNOSTICS ajout = ROW_COUNT;
        total := total + ajout;
    END LOOP;
    RETURN total;
END
$$;

-- decide_juries (dernière version : 0027_jury.sql)
CREATE OR REPLACE FUNCTION core.decide_juries() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    p        jsonb;
    v        record;
    n        integer;
    oui      integer;
    non      integer;
    statut   text;
    verite   text;
    vo       record;
    minorite uuid[];
    faites   integer := 0;
BEGIN
    SELECT params INTO p FROM core.settings ORDER BY version DESC LIMIT 1;
    FOR v IN SELECT id, first_round_ratio, jury_started_at FROM core.videos
              WHERE status = 'jury' AND jury_started_at IS NOT NULL FOR UPDATE SKIP LOCKED LOOP
        SELECT count(*), count(*) FILTER (WHERE verdict = 'valid'), count(*) FILTER (WHERE verdict = 'invalid')
          INTO n, oui, non
          FROM core.votes WHERE video_id = v.id AND round = 'jury';
        CONTINUE WHEN n < (p ->> 'jury_size')::int
                  AND now() < v.jury_started_at + ((p ->> 'jury_days')::numeric * interval '1 day');

        verite := NULL;
        IF n < (p ->> 'jury_min_votes')::int THEN
            statut := 'under_debate';
        ELSIF oui >= (p ->> 'jury_majority')::int THEN
            IF coalesce(v.first_round_ratio, 0) >= (p ->> 'jury_publish_floor')::numeric THEN
                statut := 'published';
                verite := 'valid';
            ELSE
                statut := 'under_debate';   -- trop peu soutenue au premier tour
            END IF;
        ELSIF non >= (p ->> 'jury_majority')::int THEN
            statut := 'rejected';
            verite := 'invalid';
        ELSE
            statut := 'under_debate';
        END IF;

        UPDATE core.videos SET status = statut, decided_at = now(), decided_by_stage = 'jury' WHERE id = v.id;
        UPDATE core.summons SET outcome = 'cancelled' WHERE video_id = v.id AND round = 'jury' AND outcome = 'pending';
        faites := faites + 1;

        -- Le jury a tranché : son verdict sert de référence à tous les votants (« en partie » neutre).
        IF verite IS NOT NULL THEN
            minorite := '{}';
            FOR vo IN SELECT account_id, verdict FROM core.votes
                       WHERE video_id = v.id AND account_id IS NOT NULL AND verdict <> 'partly' LOOP
                IF vo.verdict = verite THEN
                    PERFORM core.score_gain(vo.account_id, p);
                ELSE
                    PERFORM core.score_loss(vo.account_id, (p ->> 'loss')::numeric, p);
                    minorite := minorite || vo.account_id;
                END IF;
            END LOOP;
            PERFORM core.note_minority(minorite, p);
        END IF;
    END LOOP;
    RETURN faites;
END
$$;
