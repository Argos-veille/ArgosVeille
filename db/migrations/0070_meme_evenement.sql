-- Même événement, filmé sous un autre angle (9 novembre 2026, phase D6). Chaque vidéo garde sa fiche et son point
-- sur la carte ; les fiches sont reliées. Une proposition vient de la source, d'un relecteur, d'un analyste ou de
-- l'administration ; elle ne désigne qu'une vidéo publiée. Validée par les relecteurs (65 %, au moins 3 réponses),
-- par 2 autres analystes si les deux vidéos sont publiées, ou par le super-administrateur. Jamais automatique.
CREATE TABLE core.event_proposals (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id        uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    target_video_id uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    origin          text NOT NULL CHECK (origin IN ('source', 'reviewer', 'analyst', 'admin')),
    proposer_id     uuid REFERENCES core.accounts (id) ON DELETE SET NULL,
    justification   text,
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'validated', 'refused')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    decided_at      timestamptz,
    UNIQUE (video_id, target_video_id),
    CHECK (video_id <> target_video_id)
);
CREATE INDEX event_proposals_target ON core.event_proposals (target_video_id);
CREATE INDEX event_proposals_pending ON core.event_proposals (video_id) WHERE status = 'pending';

CREATE TABLE core.event_proposal_answers (
    proposal_id uuid NOT NULL REFERENCES core.event_proposals (id) ON DELETE CASCADE,
    vote_id     uuid NOT NULL REFERENCES core.votes (id) ON DELETE CASCADE,
    agrees      boolean NOT NULL,
    weight      numeric(6, 3) NOT NULL,
    PRIMARY KEY (proposal_id, vote_id)
);

CREATE TABLE core.event_proposal_reviews (
    proposal_id uuid NOT NULL REFERENCES core.event_proposals (id) ON DELETE CASCADE,
    analyst_id  uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    agrees      boolean NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (proposal_id, analyst_id)
);
REVOKE ALL ON core.event_proposals, core.event_proposal_answers, core.event_proposal_reviews FROM PUBLIC;

-- Relie deux vidéos : même groupe, en fusionnant si chacune en avait déjà un.
CREATE FUNCTION core.link_event(p_video uuid, p_target uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    a uuid;
    b uuid;
BEGIN
    SELECT event_id INTO a FROM core.event_links WHERE video_id = p_video AND status = 'validated' LIMIT 1;
    SELECT event_id INTO b FROM core.event_links WHERE video_id = p_target AND status = 'validated' LIMIT 1;
    IF a IS NULL AND b IS NULL THEN
        INSERT INTO core.events DEFAULT VALUES RETURNING id INTO a;
    ELSIF a IS NULL THEN
        a := b;
    ELSIF b IS NOT NULL AND a <> b THEN
        UPDATE core.event_links l SET event_id = a WHERE l.event_id = b
           AND NOT EXISTS (SELECT 1 FROM core.event_links x WHERE x.event_id = a AND x.video_id = l.video_id);
        DELETE FROM core.events WHERE id = b;
    END IF;
    INSERT INTO core.event_links (event_id, video_id, status) VALUES (a, p_video, 'validated'), (a, p_target, 'validated')
        ON CONFLICT (event_id, video_id) DO UPDATE SET status = 'validated';
    PERFORM ledger.append('event_link', jsonb_build_object('video', p_video, 'target', p_target, 'event', a));
    RETURN a;
END $$;

CREATE FUNCTION core.settle_event_proposal(p_id uuid, p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    q core.event_proposals%ROWTYPE;
BEGIN
    UPDATE core.event_proposals SET status = p_status, decided_at = now() WHERE id = p_id AND status = 'pending' RETURNING * INTO q;
    IF FOUND AND p_status = 'validated' THEN PERFORM core.link_event(q.video_id, q.target_video_id); END IF;
END $$;

-- Crée la proposition, ou renvoie celle qui relie déjà ces deux vidéos, dans un sens ou dans l'autre.
CREATE FUNCTION core.propose_event(p_video uuid, p_target uuid, p_origin text, p_proposer uuid, p_justification text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_id uuid;
BEGIN
    IF p_video = p_target OR NOT EXISTS (SELECT 1 FROM core.videos WHERE id = p_target AND status = 'published' AND NOT is_control) THEN
        RETURN NULL;
    END IF;
    SELECT id INTO v_id FROM core.event_proposals
     WHERE (video_id = p_video AND target_video_id = p_target) OR (video_id = p_target AND target_video_id = p_video) LIMIT 1;
    IF v_id IS NULL THEN
        INSERT INTO core.event_proposals (video_id, target_video_id, origin, proposer_id, justification)
        VALUES (p_video, p_target, p_origin, p_proposer, p_justification) RETURNING id INTO v_id;
    END IF;
    RETURN v_id;
END $$;

-- La source, à l'envoi : aucun compte n'est enregistré.
CREATE FUNCTION core.source_propose_event(p_video uuid, p_target uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT core.propose_event(p_video, p_target, 'source', NULL, NULL)
     WHERE EXISTS (SELECT 1 FROM core.videos WHERE id = p_video AND status = 'uploading');
$$;

-- Vidéos publiées proches : moins de 500 m, le même jour, ou à moins de 2 h si les deux heures sont connues.
CREATE FUNCTION core.event_suggestions(p_video uuid, p_limit integer) RETURNS TABLE (id uuid, pseudonym text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp, public AS $$
    SELECT o.id, p.pseudonym
      FROM core.videos v
      JOIN core.videos o ON o.id <> v.id AND o.status = 'published' AND NOT o.is_control AND o.duplicate_of IS NULL
       AND ST_DWithin(v.location, o.location, 500)
       AND CASE WHEN v.occurred_time_known AND o.occurred_time_known
                THEN abs(extract(epoch FROM v.occurred_at - o.occurred_at)) <= 7200
                ELSE (v.occurred_at AT TIME ZONE 'Europe/Paris')::date = (o.occurred_at AT TIME ZONE 'Europe/Paris')::date END
      LEFT JOIN core.pseudonyms p ON p.video_id = o.id
     WHERE v.id = p_video
       AND v.duplicate_of IS DISTINCT FROM o.id
       AND NOT EXISTS (SELECT 1 FROM core.event_proposals q WHERE q.status <> 'pending'
                        AND ((q.video_id = v.id AND q.target_video_id = o.id) OR (q.video_id = o.id AND q.target_video_id = v.id)))
     ORDER BY abs(extract(epoch FROM v.occurred_at - o.occurred_at)), o.id
     LIMIT least(p_limit, 10);
$$;

-- Ce que le relecteur doit vérifier : les propositions en attente, puis les suggestions.
CREATE FUNCTION core.reviewer_event_candidates(p_video uuid) RETURNS TABLE (id uuid, pseudonym text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT DISTINCT ON (x.id) x.id, x.pseudonym FROM (
        SELECT o.id, p.pseudonym, 0 AS rang
          FROM core.event_proposals q JOIN core.videos o ON o.id = q.target_video_id AND o.status = 'published' AND NOT o.is_control
          LEFT JOIN core.pseudonyms p ON p.video_id = o.id
         WHERE q.video_id = p_video AND q.status = 'pending'
        UNION ALL
        SELECT s.id, s.pseudonym, 1 FROM core.event_suggestions(p_video, 5) s
    ) x ORDER BY x.id, x.rang LIMIT 10;
$$;

-- Réponses d'un relecteur, juste après son vote. « Oui » sur une suggestion crée la proposition.
CREATE FUNCTION core.record_event_answers(p_account uuid, p_summons uuid, p_answers jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    vo core.votes%ROWTYPE;
    r jsonb;
    q uuid;
    d boolean;
BEGIN
    SELECT * INTO vo FROM core.votes WHERE summons_id = p_summons AND account_id = p_account AND round = 'review';
    IF NOT FOUND THEN RAISE EXCEPTION 'argos:introuvable'; END IF;
    FOR r IN SELECT * FROM jsonb_array_elements(p_answers) LOOP
        d := (r ->> 'oui')::boolean;
        IF d THEN
            q := core.propose_event(vo.video_id, (r ->> 'fiche')::uuid, 'reviewer', p_account, NULL);
        ELSE
            SELECT id INTO q FROM core.event_proposals WHERE video_id = vo.video_id AND target_video_id = (r ->> 'fiche')::uuid;
        END IF;
        IF q IS NOT NULL THEN
            INSERT INTO core.event_proposal_answers (proposal_id, vote_id, agrees, weight) VALUES (q, vo.id, d, vo.weight)
                ON CONFLICT DO NOTHING;
        END IF;
    END LOOP;
END $$;

-- Fin du premier tour. Sans majorité nette, la proposition reste en attente (les analystes pourront la reprendre).
CREATE FUNCTION core.settle_event_answers() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    p jsonb;
    q record;
BEGIN
    SELECT params INTO p FROM core.settings ORDER BY version DESC LIMIT 1;
    FOR q IN
        SELECT a.proposal_id, count(*) AS n, sum(a.weight) FILTER (WHERE a.agrees) AS oui, sum(a.weight) AS total
          FROM core.event_proposal_answers a JOIN core.event_proposals e ON e.id = a.proposal_id
         WHERE e.video_id = NEW.id AND e.status = 'pending' GROUP BY a.proposal_id
    LOOP
        IF q.n >= 3 AND q.total > 0 THEN
            IF coalesce(q.oui, 0) / q.total >= (p ->> 'publish_threshold')::numeric THEN
                PERFORM core.settle_event_proposal(q.proposal_id, 'validated');
            ELSIF coalesce(q.oui, 0) / q.total <= (p ->> 'reject_threshold')::numeric THEN
                PERFORM core.settle_event_proposal(q.proposal_id, 'refused');
            END IF;
        END IF;
    END LOOP;
    RETURN NULL;
END $$;
CREATE TRIGGER videos_settle_event_answers AFTER UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (OLD.status = 'in_review' AND NEW.status IN ('published', 'jury', 'under_debate', 'no_decision', 'rejected'))
    EXECUTE FUNCTION core.settle_event_answers();

-- Analystes OSINT.
CREATE FUNCTION core.require_analyst_mfa(p_account uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF NOT core.is_osint_analyst(p_account) THEN RAISE EXCEPTION 'argos:reserve_analyste'; END IF;
    IF NOT EXISTS (SELECT 1 FROM core.mfa_factors WHERE account_id = p_account AND revoked_at IS NULL) THEN
        RAISE EXCEPTION 'argos:double_auth_requise';
    END IF;
END $$;

CREATE FUNCTION core.osint_propose_event(p_account uuid, p_video text, p_target text, p_justification text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    a uuid;
    b uuid;
    r uuid;
BEGIN
    PERFORM core.require_analyst_mfa(p_account);
    IF char_length(btrim(p_justification)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'argos:justification'; END IF;
    SELECT v.id INTO a FROM core.videos v LEFT JOIN core.pseudonyms p ON p.video_id = v.id
     WHERE v.status IN ('published', 'in_review', 'jury') AND NOT v.is_control
       AND (v.id::text = lower(substring(p_video FROM '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'))
            OR lower(p.pseudonym) = lower(btrim(p_video))) LIMIT 1;
    b := core.resolve_published(p_target);
    IF a IS NULL OR b IS NULL OR a = b THEN RAISE EXCEPTION 'argos:fiche_introuvable'; END IF;
    r := core.propose_event(a, b, 'analyst', p_account, btrim(p_justification));
    IF (SELECT status FROM core.event_proposals WHERE id = r) <> 'pending' THEN RAISE EXCEPTION 'argos:deja_tranchee'; END IF;
    RETURN r;
END $$;

CREATE FUNCTION core.osint_event_queue(p_account uuid)
RETURNS TABLE (id uuid, origin text, justification text, created_at timestamptz,
               video_id uuid, video_pseudonym text, target_id uuid, target_pseudonym text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_analyst_mfa(p_account);
    RETURN QUERY
    SELECT q.id, q.origin, q.justification, q.created_at, q.video_id, pa.pseudonym, q.target_video_id, pb.pseudonym
      FROM core.event_proposals q
      JOIN core.videos va ON va.id = q.video_id AND va.status = 'published'
      JOIN core.videos vb ON vb.id = q.target_video_id AND vb.status = 'published'
      LEFT JOIN core.pseudonyms pa ON pa.video_id = q.video_id
      LEFT JOIN core.pseudonyms pb ON pb.video_id = q.target_video_id
     WHERE q.status = 'pending' AND q.proposer_id IS DISTINCT FROM p_account
       AND NOT EXISTS (SELECT 1 FROM core.event_proposal_reviews r WHERE r.proposal_id = q.id AND r.analyst_id = p_account)
     ORDER BY q.created_at LIMIT 100;
END $$;

CREATE FUNCTION core.osint_review_event(p_account uuid, p_id uuid, p_agrees boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    q core.event_proposals%ROWTYPE;
    n integer;
BEGIN
    PERFORM core.require_analyst_mfa(p_account);
    SELECT * INTO q FROM core.event_proposals WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR q.status <> 'pending' THEN RAISE EXCEPTION 'argos:introuvable'; END IF;
    IF q.proposer_id = p_account THEN RAISE EXCEPTION 'argos:propre_proposition'; END IF;
    IF (SELECT count(*) FROM core.videos WHERE id IN (q.video_id, q.target_video_id) AND status = 'published') <> 2 THEN
        RAISE EXCEPTION 'argos:video_hors_relecture';
    END IF;
    INSERT INTO core.event_proposal_reviews (proposal_id, analyst_id, agrees) VALUES (p_id, p_account, p_agrees)
        ON CONFLICT DO NOTHING;
    SELECT count(*) INTO n FROM core.event_proposal_reviews WHERE proposal_id = p_id AND agrees = p_agrees;
    IF n >= 2 THEN
        PERFORM core.settle_event_proposal(p_id, CASE WHEN p_agrees THEN 'validated' ELSE 'refused' END);
        RETURN CASE WHEN p_agrees THEN 'validated' ELSE 'refused' END;
    END IF;
    RETURN 'pending';
END $$;

-- Administration.
CREATE FUNCTION core.admin_event_proposals(p_admin uuid)
RETURNS TABLE (id uuid, origin text, justification text, created_at timestamptz, video_id uuid, video_pseudonym text, video_status text,
               target_id uuid, target_pseudonym text, oui integer, non integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY
    SELECT q.id, q.origin, q.justification, q.created_at, q.video_id, pa.pseudonym, va.status, q.target_video_id, pb.pseudonym,
           (SELECT count(*)::int FROM core.event_proposal_answers a WHERE a.proposal_id = q.id AND a.agrees)
           + (SELECT count(*)::int FROM core.event_proposal_reviews r WHERE r.proposal_id = q.id AND r.agrees),
           (SELECT count(*)::int FROM core.event_proposal_answers a WHERE a.proposal_id = q.id AND NOT a.agrees)
           + (SELECT count(*)::int FROM core.event_proposal_reviews r WHERE r.proposal_id = q.id AND NOT r.agrees)
      FROM core.event_proposals q
      JOIN core.videos va ON va.id = q.video_id
      LEFT JOIN core.pseudonyms pa ON pa.video_id = q.video_id
      LEFT JOIN core.pseudonyms pb ON pb.video_id = q.target_video_id
     WHERE q.status = 'pending' ORDER BY q.created_at LIMIT 300;
END $$;

CREATE FUNCTION core.admin_decide_event(p_admin uuid, p_id uuid, p_accept boolean, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    q core.event_proposals%ROWTYPE;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF char_length(btrim(p_reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'argos:motif'; END IF;
    SELECT * INTO q FROM core.event_proposals WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR q.status <> 'pending' THEN RAISE EXCEPTION 'argos:introuvable'; END IF;
    PERFORM core.settle_event_proposal(p_id, CASE WHEN p_accept THEN 'validated' ELSE 'refused' END);
    PERFORM ledger.append('admin_action', jsonb_build_object('action', CASE WHEN p_accept THEN 'event_validated' ELSE 'event_refused' END,
                          'video', q.video_id, 'target', q.target_video_id, 'reason', btrim(p_reason)));
END $$;

CREATE FUNCTION core.admin_link_event(p_admin uuid, p_video uuid, p_reference text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    b uuid;
    q uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF char_length(btrim(p_reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'argos:motif'; END IF;
    b := core.resolve_published(p_reference);
    IF b IS NULL OR b = p_video OR NOT EXISTS (SELECT 1 FROM core.videos WHERE id = p_video
          AND status IN ('awaiting_author', 'in_review', 'jury', 'under_debate', 'no_decision', 'published')) THEN
        RAISE EXCEPTION 'argos:fiche_introuvable';
    END IF;
    q := core.propose_event(p_video, b, 'admin', p_admin, btrim(p_reason));
    UPDATE core.event_proposals SET status = 'validated', decided_at = now() WHERE id = q;
    PERFORM core.link_event(p_video, b);
    PERFORM ledger.append('admin_action', jsonb_build_object('action', 'event_validated', 'video', p_video, 'target', b, 'reason', btrim(p_reason)));
END $$;

CREATE FUNCTION core.admin_unlink_event(p_admin uuid, p_video uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF char_length(btrim(p_reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'argos:motif'; END IF;
    UPDATE core.event_links SET status = 'refused' WHERE video_id = p_video AND status = 'validated';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE EXCEPTION 'argos:introuvable'; END IF;
    UPDATE core.event_proposals SET status = 'refused', decided_at = now()
     WHERE status = 'validated' AND (video_id = p_video OR target_video_id = p_video);
    PERFORM ledger.append('admin_action', jsonb_build_object('action', 'event_unlinked', 'video', p_video, 'reason', btrim(p_reason)));
END $$;

-- Fiches : public (seulement les vidéos publiées, hors versions) et administration (toutes).
CREATE FUNCTION core.public_event_videos(p_video uuid) RETURNS TABLE (id uuid, pseudonym text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT o.id, p.pseudonym
      FROM core.event_links moi
      JOIN core.event_links l ON l.event_id = moi.event_id AND l.video_id <> moi.video_id AND l.status = 'validated'
      JOIN core.videos o ON o.id = l.video_id AND o.status = 'published' AND NOT o.is_control
      LEFT JOIN core.pseudonyms p ON p.video_id = o.id
     WHERE moi.video_id = p_video AND moi.status = 'validated'
       AND NOT EXISTS (SELECT 1 FROM core.videos m WHERE m.id = o.duplicate_of AND m.status = 'published')
     ORDER BY o.occurred_at, o.id;
$$;

CREATE FUNCTION core.admin_event_videos(p_admin uuid, p_video uuid) RETURNS TABLE (id uuid, pseudonym text, status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY
    SELECT o.id, p.pseudonym, o.status
      FROM core.event_links moi
      JOIN core.event_links l ON l.event_id = moi.event_id AND l.video_id <> moi.video_id AND l.status = 'validated'
      JOIN core.videos o ON o.id = l.video_id
      LEFT JOIN core.pseudonyms p ON p.video_id = o.id
     WHERE moi.video_id = p_video AND moi.status = 'validated' ORDER BY o.occurred_at, o.id;
END $$;

-- Au retrait par la source, ses liens et propositions disparaissent aussi.
CREATE OR REPLACE FUNCTION core.erase_withdrawn_fingerprints() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    DELETE FROM core.video_fingerprints WHERE video_id = NEW.id;
    DELETE FROM core.video_matches WHERE video_id = NEW.id OR other_video_id = NEW.id;
    DELETE FROM core.event_links WHERE video_id = NEW.id;
    DELETE FROM core.event_proposals WHERE video_id = NEW.id OR target_video_id = NEW.id;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION core.link_event(uuid, uuid), core.settle_event_proposal(uuid, text), core.propose_event(uuid, uuid, text, uuid, text),
                       core.settle_event_answers(), core.source_propose_event(uuid, uuid), core.event_suggestions(uuid, integer),
                       core.reviewer_event_candidates(uuid), core.record_event_answers(uuid, uuid, jsonb), core.require_analyst_mfa(uuid),
                       core.osint_propose_event(uuid, text, text, text), core.osint_event_queue(uuid), core.osint_review_event(uuid, uuid, boolean),
                       core.admin_event_proposals(uuid), core.admin_decide_event(uuid, uuid, boolean, text), core.admin_link_event(uuid, uuid, text, text),
                       core.admin_unlink_event(uuid, uuid, text), core.public_event_videos(uuid), core.admin_event_videos(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.source_propose_event(uuid, uuid), core.reviewer_event_candidates(uuid), core.record_event_answers(uuid, uuid, jsonb),
                          core.osint_propose_event(uuid, text, text, text), core.osint_event_queue(uuid), core.osint_review_event(uuid, uuid, boolean),
                          core.admin_event_proposals(uuid), core.admin_decide_event(uuid, uuid, boolean, text), core.admin_link_event(uuid, uuid, text, text),
                          core.admin_unlink_event(uuid, uuid, text), core.public_event_videos(uuid), core.admin_event_videos(uuid, uuid) TO argos_app;
