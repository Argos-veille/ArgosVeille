-- Lieu ou date inconnus à l'envoi (14 novembre 2026, demande de l’administrateur).
--
-- La source peut dire qu'elle ne connaît pas le lieu précis (repère approximatif, gardé à la commune) ou la
-- date précise (« au plus tard le »). La vidéo suit la relecture normale ; si la relecture ou le jury la
-- publie, elle attend d'abord qu'un analyste OSINT établisse ce qui manque (statut awaiting_osint, non public).
-- Une correction d'analyste qui établit le dernier élément manquant la publie. L'administration peut la
-- publier ou la rejeter directement depuis cet état.

ALTER TABLE core.videos
    ADD COLUMN date_to_establish     boolean NOT NULL DEFAULT false,
    ADD COLUMN location_to_establish boolean NOT NULL DEFAULT false;
GRANT SELECT (date_to_establish, location_to_establish) ON core.videos TO argos_app;
GRANT INSERT (date_to_establish, location_to_establish) ON core.videos TO argos_app;

ALTER TABLE core.videos DROP CONSTRAINT videos_status_check;
ALTER TABLE core.videos ADD CONSTRAINT videos_status_check
    CHECK (status IN ('uploading', 'processing', 'failed', 'awaiting_author', 'in_review', 'jury', 'published',
                      'rejected', 'under_debate', 'no_decision', 'hidden', 'removed', 'withdrawn', 'awaiting_osint'));

-- Publication par la relecture ou le jury d'une vidéo encore « à établir » : elle attend l'analyse.
-- Nom choisi pour passer avant les autres déclencheurs BEFORE (ordre alphabétique).
CREATE FUNCTION core.hold_for_osint() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.date_to_establish OR NEW.location_to_establish THEN
        NEW.status := 'awaiting_osint';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER videos_aa_hold_for_osint BEFORE UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (OLD.status IN ('in_review', 'jury') AND NEW.status = 'published' AND NOT NEW.is_control)
    EXECUTE FUNCTION core.hold_for_osint();

-- Fin du premier tour : la vidéo mise en attente d'analyse règle aussi ses doublons et « même événement ».
DROP TRIGGER videos_settle_duplicate ON core.videos;
CREATE TRIGGER videos_settle_duplicate BEFORE UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (OLD.status = 'in_review' AND NEW.status IN ('published', 'jury', 'under_debate', 'no_decision', 'rejected', 'awaiting_osint'))
    EXECUTE FUNCTION core.settle_duplicate();
DROP TRIGGER videos_settle_event_answers ON core.videos;
CREATE TRIGGER videos_settle_event_answers AFTER UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (OLD.status = 'in_review' AND NEW.status IN ('published', 'jury', 'under_debate', 'no_decision', 'rejected', 'awaiting_osint'))
    EXECUTE FUNCTION core.settle_event_answers();

-- Journal public : la mise en attente d'analyse est une décision comme les autres.
CREATE OR REPLACE FUNCTION core.log_video_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, public
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT NEW.is_control THEN
        IF NEW.status IN ('published', 'rejected', 'under_debate', 'no_decision', 'hidden', 'removed', 'awaiting_osint') THEN
            PERFORM ledger.append(
                CASE WHEN NEW.status IN ('hidden', 'removed') THEN 'removal' ELSE 'decision' END,
                jsonb_build_object('video', NEW.id, 'status', NEW.status, 'from', OLD.status,
                                   'stage', NEW.decided_by_stage));
        ELSIF NEW.status = 'withdrawn' THEN
            PERFORM ledger.append('withdrawal', jsonb_build_object('video', NEW.id, 'from', OLD.status));
        END IF;
    END IF;
    RETURN NEW;
END
$$;

-- Décision de l'administration : possible aussi depuis l'attente d'analyse (publier sans attendre, ou rejeter).
CREATE OR REPLACE FUNCTION core.admin_decide(p_admin uuid, p_video uuid, p_decision text, p_reason text) RETURNS text
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
       OR v.status NOT IN ('in_review', 'jury', 'published', 'rejected', 'under_debate', 'no_decision', 'awaiting_osint') THEN
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
    RETURN (SELECT status FROM core.videos WHERE id = p_video);
END
$$;

-- Correction d'un analyste : possible aussi en attente d'analyse ; elle peut établir la date et/ou le lieu.
-- Quand plus rien n'est à établir, une vidéo en attente d'analyse est publiée.
DROP FUNCTION core.osint_correct_context(uuid, uuid, timestamptz, boolean, double precision, double precision, text, text, text[]);
CREATE FUNCTION core.osint_correct_context(p_account uuid, p_video uuid, p_occurred_at timestamptz, p_time_known boolean,
                                           p_lat double precision, p_lon double precision, p_precision text,
                                           p_justification text, p_links text[],
                                           p_settles_date boolean DEFAULT false, p_settles_location boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v       record;
    v_id    uuid;
    pseudo  text;
    lieu    public.geography;
    reste   boolean;
BEGIN
    IF NOT core.is_osint_analyst(p_account) THEN
        RAISE EXCEPTION 'argos:reserve_analyste';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.mfa_factors WHERE account_id = p_account AND revoked_at IS NULL) THEN
        RAISE EXCEPTION 'argos:double_auth_requise';
    END IF;
    SELECT vi.id, vi.status, vi.occurred_at, vi.occurred_time_known, vi.location, vi.location_precision, vi.declared_occurred_at,
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
    lieu := public.ST_SetSRID(public.ST_MakePoint(p_lon, p_lat), 4326)::public.geography;

    -- Première correction : ce que la source a déclaré est mis de côté, pour toujours.
    IF v.declared_occurred_at IS NULL THEN
        UPDATE core.videos SET declared_occurred_at = v.occurred_at, declared_time_known = v.occurred_time_known,
                               declared_location = v.location, declared_location_precision = v.location_precision
         WHERE id = p_video;
    END IF;
    INSERT INTO core.context_corrections (video_id, author_id, occurred_at, time_known, location, location_precision,
                                          previous_occurred_at, previous_time_known, previous_location, previous_precision,
                                          justification, links)
    VALUES (p_video, p_account, p_occurred_at, coalesce(p_time_known, true), lieu, p_precision,
            v.occurred_at, v.occurred_time_known, v.location, v.location_precision, btrim(p_justification), p_links)
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
$$;
REVOKE ALL ON FUNCTION core.osint_correct_context(uuid, uuid, timestamptz, boolean, double precision, double precision, text, text, text[], boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.osint_correct_context(uuid, uuid, timestamptz, boolean, double precision, double precision, text, text, text[], boolean, boolean) TO argos_app;
