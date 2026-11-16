-- Corrections de la date, de l'heure et du lieu par les analystes OSINT (5 novembre 2026, demande de l’administrateur).
--
-- Un analyste OSINT en titre (double authentification active) peut corriger la date, l'heure et le lieu
-- d'une vidéo en relecture ou devant le jury, avec une justification et des sources. La correction
-- s'applique tout de suite ; ce que la source a déclaré reste gardé (declared_*) et toujours affiché à
-- côté. Chaque correction garde les valeurs qu'elle remplace ; elle est inscrite au journal public. Le
-- super-administrateur peut annuler la dernière correction encore active d'une vidéo, avec un motif.

ALTER TABLE ledger.entries DROP CONSTRAINT entries_kind_check;
ALTER TABLE ledger.entries ADD CONSTRAINT entries_kind_check CHECK (kind IN (
    'video_received', 'decision', 'removal', 'rule_change', 'authority_request', 'admin_action', 'event_link',
    'withdrawal', 'correction'));

ALTER TABLE core.videos
    ADD COLUMN declared_occurred_at          timestamptz,   -- ce que la source a déclaré (rempli à la 1re correction)
    ADD COLUMN declared_time_known           boolean,
    ADD COLUMN declared_location             geography(Point, 4326),
    ADD COLUMN declared_location_precision   text;
GRANT SELECT (declared_occurred_at, declared_time_known, declared_location, declared_location_precision)
      ON core.videos TO argos_app;

CREATE TABLE core.context_corrections (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id            uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    author_id           uuid REFERENCES core.accounts (id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    occurred_at         timestamptz NOT NULL,
    time_known          boolean NOT NULL,
    location            geography(Point, 4326) NOT NULL,
    location_precision  text NOT NULL CHECK (location_precision IN ('exact', 'approx_100m', 'municipality')),
    previous_occurred_at timestamptz,
    previous_time_known boolean,
    previous_location   geography(Point, 4326),
    previous_precision  text,
    justification       text NOT NULL CHECK (length(btrim(justification)) BETWEEN 10 AND 5000),
    links               text[] NOT NULL,
    cancelled_at        timestamptz,
    cancel_reason       text,
    CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL))
);
CREATE INDEX context_corrections_video ON core.context_corrections (video_id, created_at);
REVOKE ALL ON core.context_corrections FROM PUBLIC;
GRANT SELECT ON core.context_corrections TO argos_app;

CREATE FUNCTION core.osint_correct_context(p_account uuid, p_video uuid, p_occurred_at timestamptz, p_time_known boolean,
                                           p_lat double precision, p_lon double precision, p_precision text,
                                           p_justification text, p_links text[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v       record;
    v_id    uuid;
    pseudo  text;
    lieu    public.geography;
BEGIN
    IF NOT core.is_osint_analyst(p_account) THEN
        RAISE EXCEPTION 'argos:reserve_analyste';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.mfa_factors WHERE account_id = p_account AND revoked_at IS NULL) THEN
        RAISE EXCEPTION 'argos:double_auth_requise';
    END IF;
    SELECT vi.id, vi.occurred_at, vi.occurred_time_known, vi.location, vi.location_precision, vi.declared_occurred_at
      INTO v FROM core.videos vi
     WHERE vi.id = p_video AND vi.status IN ('in_review', 'jury') AND NOT vi.is_control FOR UPDATE;
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
                           location = lieu, location_precision = p_precision
     WHERE id = p_video;
    SELECT username INTO pseudo FROM core.accounts WHERE id = p_account;
    PERFORM ledger.append('correction', jsonb_build_object('video', p_video, 'correction', v_id, 'analyst', pseudo));
    RETURN v_id;
END
$$;

-- Annulation par le super-administrateur : seulement la dernière correction encore active de la vidéo
-- (les précédentes s'annulent ensuite une à une) ; la vidéo reprend les valeurs d'avant.
CREATE FUNCTION core.admin_cancel_correction(p_admin uuid, p_correction uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    c record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_admin AND is_superadmin AND status = 'active') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:motif';
    END IF;
    SELECT * INTO c FROM core.context_corrections WHERE id = p_correction AND cancelled_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:correction_introuvable';
    END IF;
    IF EXISTS (SELECT 1 FROM core.context_corrections WHERE video_id = c.video_id AND cancelled_at IS NULL
                                                         AND created_at > c.created_at) THEN
        RAISE EXCEPTION 'argos:correction_pas_la_derniere';
    END IF;
    UPDATE core.context_corrections SET cancelled_at = now(), cancel_reason = btrim(p_reason) WHERE id = p_correction;
    UPDATE core.videos SET occurred_at = c.previous_occurred_at, occurred_time_known = c.previous_time_known,
                           location = c.previous_location, location_precision = c.previous_precision
     WHERE id = c.video_id;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', 'cancel_correction', 'video', c.video_id, 'correction', p_correction, 'reason', btrim(p_reason)));
END
$$;

REVOKE ALL ON FUNCTION core.osint_correct_context(uuid, uuid, timestamptz, boolean, double precision, double precision, text, text, text[]),
                       core.admin_cancel_correction(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.osint_correct_context(uuid, uuid, timestamptz, boolean, double precision, double precision, text, text, text[]),
                          core.admin_cancel_correction(uuid, uuid, text) TO argos_app;
