-- Vote, décision et scores (étape 7b, 4 novembre 2026).
--
-- Vote « à la manière des notes de communauté » : la vidéo montre-t-elle ce qui est annoncé ?
-- oui / en partie / non, avec des raisons propres au oui et au non (« en partie » propose les deux).
-- Un « en partie » compte pour moitié. Le moteur de relecture (argos_scoring) tranche :
-- publication à 65 % du poids, rejet à 35 %, poids minimal 15 ; entre les deux, 15 relecteurs de
-- plus une fois, puis le jury (7c) ; 7 jours sans assez de poids : sans décision. Les scores ne
-- bougent que sur un consensus net (80 %) ou une vidéo de contrôle. Le super-administrateur peut
-- trancher lui-même (clé physique vérifiée par le site, motif écrit, journal public).

-- --- Votes -----------------------------------------------------------------------------------

ALTER TABLE core.votes
    ADD COLUMN verdict text CHECK (verdict IN ('valid', 'partly', 'invalid')),
    ADD COLUMN reasons text[] NOT NULL DEFAULT '{}',
    ALTER COLUMN is_valid DROP NOT NULL;   -- NULL pour « en partie » (calculé depuis verdict)
UPDATE core.votes SET verdict = CASE WHEN is_valid THEN 'valid' ELSE 'invalid' END WHERE verdict IS NULL;
ALTER TABLE core.votes
    ALTER COLUMN verdict SET NOT NULL,
    ADD CONSTRAINT votes_reasons_match CHECK (
        cardinality(reasons) BETWEEN (CASE WHEN round = 'jury' THEN 0 ELSE 1 END) AND 9
        AND CASE verdict
            WHEN 'valid' THEN reasons <@ ARRAY['intervention_visible', 'context_consistent', 'authentic', 'category_matches']
            WHEN 'invalid' THEN reasons <@ ARRAY['wrong_category', 'old_or_reused', 'misleading_edit', 'nothing_visible',
                                                 'context_inconsistent']
            ELSE reasons <@ ARRAY['intervention_visible', 'context_consistent', 'authentic', 'category_matches',
                                  'wrong_category', 'old_or_reused', 'misleading_edit', 'nothing_visible', 'context_inconsistent']
        END) NOT VALID;   -- vérifiée pour tout nouveau vote ; aucun vote réel n'existe avant cette migration
GRANT INSERT ON core.votes TO argos_app;

-- --- Vidéos : début de la relecture, places supplémentaires, décision de l'administration ----

ALTER TABLE core.videos
    ADD COLUMN review_started_at timestamptz,
    ADD COLUMN extra_seats       smallint NOT NULL DEFAULT 0 CHECK (extra_seats BETWEEN 0 AND 300);
UPDATE core.videos SET review_started_at = now() WHERE status = 'in_review' AND review_started_at IS NULL;
ALTER TABLE core.videos DROP CONSTRAINT videos_decided_by_stage_check;
ALTER TABLE core.videos ADD CONSTRAINT videos_decided_by_stage_check
    CHECK (decided_by_stage IN ('review', 'jury', 'legal', 'admin'));

CREATE FUNCTION core.mark_review_started() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'in_review' AND OLD.status IS DISTINCT FROM 'in_review' AND OLD.status <> 'hidden' THEN
        NEW.review_started_at := now();
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER videos_mark_review_started BEFORE UPDATE OF status ON core.videos
    FOR EACH ROW EXECUTE FUNCTION core.mark_review_started();
REVOKE ALL ON FUNCTION core.mark_review_started() FROM PUBLIC;

GRANT SELECT (review_started_at, extra_seats, first_round_ratio) ON core.videos TO argos_app;
GRANT SELECT (is_control, control_truth, review_started_at, extra_seats) ON core.videos TO argos_scoring;

-- Places à pourvoir au premier tour (15, plus un élargissement, plus les recrues si le poids manque).
CREATE FUNCTION core.review_seats(p_video uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT (s.params ->> 'sample_size')::int * (1 + v.enlargements) + v.extra_seats
      FROM core.videos v, (SELECT params FROM core.settings ORDER BY version DESC LIMIT 1) s
     WHERE v.id = p_video
$$;
REVOKE ALL ON FUNCTION core.review_seats(uuid) FROM PUBLIC;

-- Le tirage tient compte des places supplémentaires.
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
        SELECT v.id, a.id, 'review', now() + make_interval(days => (p ->> 'summons_days')::int)
          FROM core.accounts a
         WHERE a.status = 'active'
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

-- Contrôle de chaque vote : convocation valable, compte actif, 5 votes par 24 h, places libres,
-- vidéo encore en relecture ; poids calculé par la base ; les convocations en trop sont annulées
-- dès que les places sont prises ; un visage signalé identifiable ouvre un signalement.
-- Les erreurs portent un code stable (argos:…) que le site traduit.
CREATE OR REPLACE FUNCTION core.compute_vote_weight() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, public
AS $$
DECLARE
    v_summons  core.summons%ROWTYPE;
    v_score    numeric;
    v_created  timestamptz;
    v_status   text;
    v_video    text;
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

    IF NEW.round = 'review' THEN
        -- Verrou sur la vidéo : deux votes simultanés ne prennent pas la même dernière place.
        SELECT status INTO v_video FROM core.videos WHERE id = NEW.video_id FOR UPDATE;
        IF v_video IS DISTINCT FROM 'in_review' THEN
            RAISE EXCEPTION 'argos:relecture_terminee';
        END IF;
        v_votes := (SELECT count(*) FROM core.votes WHERE video_id = NEW.video_id AND round = 'review');
        v_places := core.review_seats(NEW.video_id);
        IF v_votes >= v_places THEN
            RAISE EXCEPTION 'argos:places_prises';
        END IF;
        IF v_votes + 1 >= v_places THEN
            UPDATE core.summons SET outcome = 'cancelled'
             WHERE video_id = NEW.video_id AND round = 'review' AND outcome = 'pending' AND id <> NEW.summons_id;
        END IF;
    END IF;

    NEW.is_valid := CASE NEW.verdict WHEN 'valid' THEN true WHEN 'invalid' THEN false END;
    NEW.weight := v_score;
    IF now() - v_created < make_interval(days => (v_params ->> 'novice_days')::int) THEN
        NEW.weight := v_score * (v_params ->> 'novice_factor')::numeric;
    END IF;
    NEW.cast_at := now();

    UPDATE core.summons SET outcome = 'voted', answered_at = now() WHERE id = NEW.summons_id;
    UPDATE core.accounts SET last_vote_at = now() WHERE id = NEW.account_id;
    IF coalesce((NEW.answers ->> 'face_identifiable')::boolean, false) THEN
        INSERT INTO core.reports (video_id, severity, reason_code, details)
        VALUES (NEW.video_id, 'normal', 'visible_identity', 'Visage signalé identifiable par un relecteur pendant la relecture.');
    END IF;
    RETURN NEW;
END
$$;

-- --- Scores ----------------------------------------------------------------------------------

CREATE FUNCTION core.score_gain(p_account uuid, p jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    UPDATE core.accounts
       SET score = least((p ->> 'score_max')::numeric,
                         score + (p ->> 'gain')::numeric * greatest(0, (p ->> 'score_max')::numeric - score)
                                 / ((p ->> 'score_max')::numeric - (p ->> 'score_initial')::numeric))
     WHERE id = p_account
$$;

CREATE FUNCTION core.score_loss(p_account uuid, p_amount numeric, p jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    UPDATE core.accounts SET score = greatest((p ->> 'score_min')::numeric, score - p_amount) WHERE id = p_account
$$;

-- Comptes minoritaires ensemble : une paire qui se retrouve 3 fois dans la minorité est signalée
-- (simple alerte : exclue du jury). Au plus 40 comptes par décision, comme dans le simulateur.
CREATE FUNCTION core.note_minority(p_accounts uuid[], p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    ids uuid[];
BEGIN
    SELECT array_agg(a ORDER BY a) INTO ids
      FROM (SELECT DISTINCT a FROM unnest(p_accounts) a WHERE a IS NOT NULL ORDER BY a LIMIT 40) t;
    IF coalesce(cardinality(ids), 0) < 2 THEN RETURN; END IF;
    INSERT INTO core.collusion_pairs AS c (account_a, account_b, shared_minorities)
    SELECT x, y, 1 FROM unnest(ids) x, unnest(ids) y WHERE x < y
    ON CONFLICT (account_a, account_b) DO UPDATE SET shared_minorities = c.shared_minorities + 1, last_seen_at = now();
    UPDATE core.accounts SET suspect = true
     WHERE id IN (SELECT unnest(ARRAY[account_a, account_b]) FROM core.collusion_pairs
                   WHERE shared_minorities >= (p ->> 'collusion_threshold')::int
                     AND account_a = ANY (ids) AND account_b = ANY (ids));
END $$;

REVOKE ALL ON FUNCTION core.score_gain(uuid, jsonb), core.score_loss(uuid, numeric, jsonb),
                       core.note_minority(uuid[], jsonb) FROM PUBLIC;

-- --- Décisions du premier tour ------------------------------------------------------------------

CREATE FUNCTION core.decide_reviews() RETURNS integer
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
        fin := now() >= coalesce(v.review_started_at, now()) + make_interval(days => (p ->> 'max_review_days')::int);
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

-- Retour progressif vers le score de départ après 14 jours sans vote : une fois par jour au plus.
CREATE TABLE core.engine_state (
    name  text PRIMARY KEY,
    value timestamptz NOT NULL
);

CREATE FUNCTION core.decay_scores() RETURNS integer
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
     WHERE coalesce(last_vote_at, created_at) < now() - make_interval(days => (p ->> 'inactivity_days')::int)
       AND score <> (p ->> 'score_initial')::numeric;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END
$$;

REVOKE ALL ON FUNCTION core.decide_reviews(), core.decay_scores() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.decide_reviews(), core.decay_scores() TO argos_scoring;

-- --- Décision du super-administrateur ---------------------------------------------------------
-- Publier ou rejeter une vidéo quel que soit le vote, y compris revenir sur une décision prise.
-- Le site vérifie la clé physique juste avant ; la base vérifie le compte, le motif et l'état.
-- Les votes de la vidéo ne comptent plus pour les scores si l'administration tranche avant la
-- communauté (la vidéo quitte la relecture) ; une décision déjà prise par la communauté garde ses scores.
CREATE FUNCTION core.admin_decide(p_admin uuid, p_video uuid, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v      record;
    statut text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_admin AND is_superadmin AND status = 'active') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    IF p_decision NOT IN ('publish', 'reject') THEN
        RAISE EXCEPTION 'argos:decision_inconnue';
    END IF;
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:motif';
    END IF;
    SELECT id, status, is_control INTO v FROM core.videos WHERE id = p_video FOR UPDATE;
    IF NOT FOUND OR v.is_control
       OR v.status NOT IN ('in_review', 'jury', 'published', 'rejected', 'under_debate', 'no_decision') THEN
        RAISE EXCEPTION 'argos:video_hors_decision';
    END IF;
    statut := CASE p_decision WHEN 'publish' THEN 'published' ELSE 'rejected' END;
    IF v.status = statut THEN
        RAISE EXCEPTION 'argos:deja_ainsi';
    END IF;

    UPDATE core.videos SET status = statut, decided_at = now(), decided_by_stage = 'admin' WHERE id = p_video;
    UPDATE core.summons SET outcome = 'cancelled' WHERE video_id = p_video AND outcome = 'pending';
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', 'decision', 'video', p_video, 'from', v.status, 'to', statut, 'reason', btrim(p_reason)));
    RETURN statut;
END
$$;
REVOKE ALL ON FUNCTION core.admin_decide(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_decide(uuid, uuid, text, text) TO argos_app;
GRANT SELECT (is_superadmin) ON core.accounts TO argos_app;
