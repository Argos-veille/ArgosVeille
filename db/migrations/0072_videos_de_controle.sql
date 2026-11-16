-- Vidéos de contrôle (9 novembre 2026, validé par l’administrateur) : des vidéos déjà tranchées très nettement par le premier tour
-- (publiées ou rejetées, 85 % d'accord au moins) sont présentées à d'autres relecteurs, sous un nom inventé. La bonne réponse
-- est connue. Aucun effet sur la vidéo ni sur sa source. Actif à partir de 30 vidéos, pour environ 15 % des convocations.
-- Les analystes OSINT ne reçoivent pas de contrôle : ils les repéreraient, leur espace ne listant que les vidéos en relecture.
ALTER TABLE core.summons DROP CONSTRAINT summons_round_check;
ALTER TABLE core.summons ADD CONSTRAINT summons_round_check CHECK (round IN ('review', 'jury', 'control'));
ALTER TABLE core.votes DROP CONSTRAINT votes_round_check;
ALTER TABLE core.votes ADD CONSTRAINT votes_round_check CHECK (round IN ('review', 'jury', 'control'));
ALTER TABLE core.votes ADD COLUMN control_scored_at timestamptz;

CREATE TABLE core.control_videos (
    video_id          uuid PRIMARY KEY REFERENCES core.videos (id) ON DELETE CASCADE,
    truth             boolean NOT NULL,
    display_pseudonym text NOT NULL UNIQUE,
    added_at          timestamptz NOT NULL DEFAULT now(),
    disabled_at       timestamptz
);
REVOKE ALL ON core.control_videos FROM PUBLIC;
GRANT SELECT (video_id, display_pseudonym) ON core.control_videos TO argos_app;   -- jamais la bonne réponse

CREATE FUNCTION core.control_active(p_video uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM core.control_videos c JOIN core.videos v ON v.id = c.video_id
                    WHERE c.video_id = p_video AND c.disabled_at IS NULL AND v.status IN ('published', 'rejected')
                      AND NOT v.legal_hold AND v.r2_blurred_key IS NOT NULL);
$$;

CREATE FUNCTION core.control_pseudonym() RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    a text[] := ARRAY['Héron', 'Loup', 'Renard', 'Lynx', 'Chouette', 'Faucon', 'Castor', 'Blaireau', 'Hermine', 'Loutre', 'Cerf', 'Chamois', 'Bouquetin', 'Marmotte', 'Écureuil', 'Hérisson', 'Lièvre', 'Martinet', 'Hirondelle', 'Mésange', 'Rouge-gorge', 'Pinson', 'Corbeau', 'Pie', 'Geai', 'Milan', 'Busard', 'Vautour', 'Aigle', 'Grue', 'Cigogne', 'Martin', 'Goéland', 'Cormoran', 'Macareux', 'Dauphin', 'Phoque', 'Baleine', 'Thon', 'Saumon', 'Truite', 'Brochet', 'Tortue', 'Lézard', 'Salamandre', 'Grenouille', 'Crapaud', 'Abeille', 'Bourdon', 'Libellule', 'Papillon', 'Coccinelle', 'Grillon', 'Cigale', 'Fourmi', 'Ours', 'Bison', 'Chevreuil', 'Sanglier', 'Genette', 'Fouine', 'Belette', 'Putois', 'Mouflon'];
    c text[] := ARRAY['Ambre', 'Azur', 'Corail', 'Ivoire', 'Jade', 'Lilas', 'Ocre', 'Opale', 'Perle', 'Pourpre', 'Rubis', 'Saphir', 'Sépia', 'Turquoise', 'Vermeil', 'Émeraude', 'Indigo', 'Cuivre', 'Bronze', 'Argent', 'Cendre', 'Cobalt', 'Grenat', 'Garance', 'Safran', 'Sauge', 'Prune', 'Olive', 'Ardoise', 'Carmin', 'Céladon', 'Topaze'];
BEGIN
    RETURN a[1 + floor(random() * array_length(a, 1))::int] || '-' || c[1 + floor(random() * array_length(c, 1))::int]
           || '-' || (1000 + floor(random() * 9000)::int)::text;
END $$;

-- Ajoute au lot les vidéos devenues éligibles, puis convoque : jamais à quelqu'un qui a déjà vu la vidéo.
CREATE FUNCTION core.draw_controls() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    p jsonb;
    n integer;
BEGIN
    SELECT params INTO p FROM core.settings ORDER BY version DESC LIMIT 1;
    INSERT INTO core.control_videos (video_id, truth, display_pseudonym)
    SELECT v.id, v.status = 'published', core.control_pseudonym()
      FROM core.videos v
     WHERE NOT v.is_control AND v.decided_by_stage = 'review' AND v.duplicate_of IS NULL AND NOT v.legal_hold
       AND v.r2_blurred_key IS NOT NULL
       AND ((v.status = 'published' AND v.first_round_ratio >= 0.85) OR (v.status = 'rejected' AND v.first_round_ratio <= 0.15))
       AND NOT EXISTS (SELECT 1 FROM core.control_videos c WHERE c.video_id = v.id)
    ON CONFLICT DO NOTHING;

    IF (SELECT count(*) FROM core.control_videos c WHERE core.control_active(c.video_id)) < coalesce((p ->> 'control_min_pool')::int, 30) THEN
        RETURN 0;
    END IF;

    INSERT INTO core.summons (video_id, account_id, round, expires_at)
    SELECT c.video_id, a.id, 'control', now() + ((p ->> 'summons_days')::numeric * interval '1 day')
      FROM core.accounts a
     CROSS JOIN LATERAL (
        SELECT cv.video_id FROM core.control_videos cv
         WHERE core.control_active(cv.video_id)
           AND NOT EXISTS (SELECT 1 FROM core.video_owners o WHERE o.video_id = cv.video_id AND o.account_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM core.summons s WHERE s.video_id = cv.video_id AND s.account_id = a.id)
         ORDER BY random() LIMIT 1) c
     WHERE a.status = 'active' AND NOT a.review_opt_out AND NOT core.is_osint_analyst(a.id)
       AND (SELECT count(*) FROM core.votes vo WHERE vo.account_id = a.id AND vo.cast_at > now() - interval '24 hours') < (p ->> 'reviews_per_day')::int
       AND EXISTS (SELECT 1 FROM core.summons s WHERE s.account_id = a.id AND s.round = 'review' AND s.outcome = 'pending')
       AND NOT EXISTS (SELECT 1 FROM core.summons s WHERE s.account_id = a.id AND s.round = 'control' AND s.outcome = 'pending')
       AND ((SELECT count(*) FROM core.summons s WHERE s.account_id = a.id AND s.round = 'control' AND s.sent_at > now() - interval '30 days') + 1)::numeric
           / ((SELECT count(*) FROM core.summons s WHERE s.account_id = a.id AND s.round IN ('review', 'control') AND s.sent_at > now() - interval '30 days') + 1)
           <= (p ->> 'control_rate')::numeric;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- Score appliqué avec 2 jours de retard, pour que la variation ne désigne pas la vidéo de contrôle.
CREATE FUNCTION core.score_controls() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    p jsonb;
    vo record;
    n integer := 0;
BEGIN
    SELECT params INTO p FROM core.settings ORDER BY version DESC LIMIT 1;
    FOR vo IN SELECT v.id, v.account_id, v.verdict, c.truth
                FROM core.votes v JOIN core.control_videos c ON c.video_id = v.video_id
               WHERE v.round = 'control' AND v.control_scored_at IS NULL AND v.account_id IS NOT NULL
                 AND v.cast_at < now() - interval '2 days'
                 FOR UPDATE OF v SKIP LOCKED LOOP
        IF vo.verdict = 'partly' THEN
            PERFORM core.score_loss(vo.account_id, (p ->> 'control_loss')::numeric / 2, p);
        ELSIF (vo.verdict = 'valid') = vo.truth THEN
            PERFORM core.score_gain(vo.account_id, p);
        ELSE
            PERFORM core.score_loss(vo.account_id, (p ->> 'control_loss')::numeric, p);
        END IF;
        UPDATE core.votes SET control_scored_at = now() WHERE id = vo.id;
        n := n + 1;
    END LOOP;
    RETURN n;
END $$;

CREATE FUNCTION core.admin_controls(p_admin uuid)
RETURNS TABLE (video_id uuid, pseudonym text, display_pseudonym text, truth boolean, active boolean, disabled boolean, votes integer, corrects integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY
    SELECT c.video_id, p.pseudonym, c.display_pseudonym, c.truth, core.control_active(c.video_id), c.disabled_at IS NOT NULL,
           (SELECT count(*)::int FROM core.votes vo WHERE vo.video_id = c.video_id AND vo.round = 'control'),
           (SELECT count(*)::int FROM core.votes vo WHERE vo.video_id = c.video_id AND vo.round = 'control'
              AND vo.verdict <> 'partly' AND (vo.verdict = 'valid') = c.truth)
      FROM core.control_videos c LEFT JOIN core.pseudonyms p ON p.video_id = c.video_id
     ORDER BY c.added_at DESC LIMIT 500;
END $$;

CREATE FUNCTION core.admin_control_set(p_admin uuid, p_video uuid, p_active boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    UPDATE core.control_videos SET disabled_at = CASE WHEN p_active THEN NULL ELSE now() END WHERE video_id = p_video;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
END $$;

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
    IF NEW.round = 'control' THEN
        IF NOT core.control_active(NEW.video_id) THEN
            RAISE EXCEPTION 'argos:relecture_terminee';
        END IF;
    ELSIF NEW.round = 'review' THEN
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
    IF NEW.round <> 'control' THEN   -- une vidéo de contrôle n'a pas de places limitées
        v_votes := (SELECT count(*) FROM core.votes WHERE video_id = NEW.video_id AND round = NEW.round);
        IF v_votes >= v_places THEN
            RAISE EXCEPTION 'argos:places_prises';
        END IF;
        IF v_votes + 1 >= v_places THEN
            UPDATE core.summons SET outcome = 'cancelled'
             WHERE video_id = NEW.video_id AND round = NEW.round AND outcome = 'pending' AND id <> NEW.summons_id;
        END IF;
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

CREATE OR REPLACE FUNCTION core.erase_withdrawn_fingerprints() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    DELETE FROM core.video_fingerprints WHERE video_id = NEW.id;
    DELETE FROM core.video_matches WHERE video_id = NEW.id OR other_video_id = NEW.id;
    DELETE FROM core.event_links WHERE video_id = NEW.id;
    DELETE FROM core.event_proposals WHERE video_id = NEW.id OR target_video_id = NEW.id;
    DELETE FROM core.control_videos WHERE video_id = NEW.id;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION core.control_active(uuid), core.control_pseudonym(), core.draw_controls(), core.score_controls(),
                       core.admin_controls(uuid), core.admin_control_set(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.control_active(uuid), core.admin_controls(uuid), core.admin_control_set(uuid, uuid, boolean) TO argos_app;
GRANT EXECUTE ON FUNCTION core.draw_controls(), core.score_controls() TO argos_scoring;
