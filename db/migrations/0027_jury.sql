-- Jury de second examen (étape 7c, 5 novembre 2026).
--
-- Une vidéo dont le vote reste serré après l'élargissement passe au statut « jury ». Le moteur de
-- relecture (argos_scoring) tire alors 11 jurés, avec 3 convocations par place (2 jours pour
-- répondre), parmi le vivier : comptes actifs d'au moins 60 jours, double authentification active,
-- non signalés pour collusion, dans les 30 % des meilleurs scores ; jamais un relecteur du premier
-- tour de la même vidéo ; au plus 2 jurys par 7 jours. Le jury dure 5 jours.
--
-- Chaque juré compte pour une voix (pas de poids) et répond oui ou non (pas d'« en partie »), les
-- raisons étant facultatives. Le juré sait qu'il s'agit d'un second examen, sans aucun chiffre.
-- 8 « oui » : publiée, si le premier tour avait atteint 50 % ; 8 « non » : rejetée ; sinon, ou
-- moins de 8 votes au bout de 5 jours : « en débat ». Quand le jury tranche, son verdict sert de
-- référence à tous les votants, premier tour compris (gain / perte, minorité notée) ; en débat,
-- aucun score ne bouge.
--
-- Vivier trop petit (au lancement, personne n'a 60 jours) : la vidéo reste au statut « jury », en
-- attente de jurés, tant qu'il n'y a pas 33 jurés possibles (11 places × 3 convocations) ; une
-- alerte est ouverte pour le super-administrateur, qui peut trancher lui-même entre-temps.

-- --- Vidéos : début du jury -------------------------------------------------------------------

ALTER TABLE core.videos
    ADD COLUMN jury_since      timestamptz,   -- passage au statut « jury »
    ADD COLUMN jury_started_at timestamptz;   -- premier tirage des jurés : début des 5 jours

CREATE OR REPLACE FUNCTION core.mark_review_started() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'in_review' AND OLD.status IS DISTINCT FROM 'in_review' AND OLD.status <> 'hidden' THEN
        NEW.review_started_at := now();
    END IF;
    IF NEW.status = 'jury' AND OLD.status IS DISTINCT FROM 'jury' AND OLD.status <> 'hidden' THEN
        NEW.jury_since := now();
        NEW.jury_started_at := NULL;
    END IF;
    RETURN NEW;
END $$;

GRANT SELECT (jury_since, jury_started_at) ON core.videos TO argos_app, argos_scoring;

-- --- Votes du jury : oui ou non -----------------------------------------------------------------

ALTER TABLE core.votes ADD CONSTRAINT votes_jury_yes_no CHECK (round <> 'jury' OR verdict <> 'partly') NOT VALID;

-- --- Alertes pour le super-administrateur -------------------------------------------------------
-- Ouvertes et refermées par le moteur ; lues par l'interface d'administration (étape à venir).

CREATE TABLE core.admin_alerts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        text NOT NULL CHECK (kind IN ('jury_waiting')),
    video_id    uuid REFERENCES core.videos (id) ON DELETE CASCADE,
    details     jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
);
CREATE UNIQUE INDEX admin_alerts_open ON core.admin_alerts (kind, video_id) WHERE resolved_at IS NULL;
REVOKE ALL ON core.admin_alerts FROM PUBLIC;
GRANT SELECT ON core.admin_alerts TO argos_app, argos_scoring;

-- --- Vivier des jurés -----------------------------------------------------------------------------

-- Jurés possibles pour une vidéo : le haut du classement (30 %) parmi les comptes anciens, actifs,
-- non signalés et protégés par une double authentification, moins les relecteurs du premier tour,
-- ceux qui ont déjà siégé 2 fois en 7 jours et ceux qui ont atteint leurs 5 relectures du jour.
CREATE FUNCTION core.jury_pool(p_video uuid, p jsonb) RETURNS TABLE (account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH anciens AS (
        SELECT a.id, a.score
          FROM core.accounts a
         WHERE a.status = 'active' AND NOT a.suspect
           AND a.created_at <= now() - make_interval(days => (p ->> 'jury_min_age_days')::int)
           AND EXISTS (SELECT 1 FROM core.mfa_factors f WHERE f.account_id = a.id AND f.revoked_at IS NULL)
    ), haut AS (
        SELECT id FROM anciens
         ORDER BY score DESC, id
         LIMIT ceil((SELECT count(*) FROM anciens) * (p ->> 'jury_pool_share')::numeric)::int
    )
    SELECT h.id FROM haut h
     WHERE NOT EXISTS (SELECT 1 FROM core.summons s
                        WHERE s.video_id = p_video AND s.account_id = h.id)   -- premier tour, ou déjà convoqué au jury
       AND (SELECT count(*) FROM core.summons s
             WHERE s.account_id = h.id AND s.round = 'jury' AND s.outcome IN ('pending', 'voted')
               AND s.sent_at > now() - make_interval(days => 7)) < (p ->> 'jury_max_per_week')::int
       AND (SELECT count(*) FROM core.votes vo
             WHERE vo.account_id = h.id AND vo.cast_at > now() - interval '24 hours') < (p ->> 'reviews_per_day')::int
$$;
REVOKE ALL ON FUNCTION core.jury_pool(uuid, jsonb) FROM PUBLIC;

-- --- Tirage des jurés -----------------------------------------------------------------------------

CREATE FUNCTION core.draw_jury() RETURNS integer
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

        fin := v.jury_started_at + make_interval(days => (p ->> 'jury_days')::int);
        CONTINUE WHEN fin <= now() + interval '1 hour';   -- trop tard pour convoquer
        places := (p ->> 'jury_size')::int
                  - (SELECT count(*) FROM core.votes WHERE video_id = v.id AND round = 'jury');
        CONTINUE WHEN places <= 0;
        manque := places * (p ->> 'summons_per_seat')::int
                  - (SELECT count(*) FROM core.summons WHERE video_id = v.id AND round = 'jury' AND outcome = 'pending');
        CONTINUE WHEN manque <= 0;

        INSERT INTO core.summons (video_id, account_id, round, expires_at)
        SELECT v.id, j.account_id, 'jury', least(now() + make_interval(days => (p ->> 'summons_days')::int), fin)
          FROM core.jury_pool(v.id, p) j
         ORDER BY gen_random_uuid()
         LIMIT manque;
        GET DIAGNOSTICS ajout = ROW_COUNT;
        total := total + ajout;
    END LOOP;
    RETURN total;
END
$$;
REVOKE ALL ON FUNCTION core.draw_jury() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.draw_jury() TO argos_scoring;

-- --- Contrôle des votes : le jury en plus du premier tour -------------------------------------------

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
           OR now() >= v_video.jury_started_at + make_interval(days => (v_params ->> 'jury_days')::int) THEN
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
        IF now() - v_created < make_interval(days => (v_params ->> 'novice_days')::int) THEN
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

-- --- Décisions du jury ------------------------------------------------------------------------------

CREATE FUNCTION core.decide_juries() RETURNS integer
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
                  AND now() < v.jury_started_at + make_interval(days => (p ->> 'jury_days')::int);

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
REVOKE ALL ON FUNCTION core.decide_juries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.decide_juries() TO argos_scoring;
