-- Finitions avant l'ouverture (14 novembre 2026).
--   1. Recours de l'administration : les vidéos « sans décision » (pas assez de votes) comptées au tableau de bord ;
--      core.admin_decide permet déjà de les publier ou de les rejeter.
--   2. Retirer le dernier statut journaliste / avocat / association retire aussi la certification.
--   3. Lieu ou date à établir (0086) : notes d'analystes permises en attente d'analyse ; annuler la correction qui
--      avait établi la date ou le lieu les remet « à établir » (une vidéo publiée par cette correction repart
--      en attente d'analyse).

-- 1. Tableau de bord ---------------------------------------------------------------------------------------------
CREATE FUNCTION core.admin_dashboard_recours(p_admin uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN (SELECT jsonb_build_object('sansDecision', count(*), 'plusAncienne', min(decided_at))
              FROM core.videos WHERE status = 'no_decision' AND NOT is_control);
END $$;
REVOKE ALL ON FUNCTION core.admin_dashboard_recours(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_dashboard_recours(uuid) TO argos_app;

-- 2. Statuts des comptes -----------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.admin_set_status(p_admin uuid, p_account uuid, p_status text, p_grant boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF p_status NOT IN ('journalist', 'lawyer', 'association', 'osint_analyst', 'trusted') THEN
        RAISE EXCEPTION 'argos:statut_inconnu';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_account AND status = 'active') THEN
        RAISE EXCEPTION 'argos:compte_inconnu';
    END IF;
    IF p_status = 'osint_analyst' THEN
        PERFORM core.admin_set_osint(p_admin, p_account, p_grant);
    ELSIF p_status = 'trusted' THEN
        UPDATE core.accounts SET certified = p_grant WHERE id = p_account AND certified IS DISTINCT FROM p_grant;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'argos:deja_ainsi';
        END IF;
    ELSIF p_grant THEN
        UPDATE core.verifications SET revoked_at = now()
         WHERE account_id = p_account AND category = p_status AND revoked_at IS NULL AND expires_at <= now();
        IF EXISTS (SELECT 1 FROM core.verifications WHERE account_id = p_account AND category = p_status AND revoked_at IS NULL) THEN
            RAISE EXCEPTION 'argos:deja_ainsi';
        END IF;
        INSERT INTO core.verifications (account_id, category, expires_at, verified_by)
        VALUES (p_account, p_status, now() + interval '1 year', p_admin);
        UPDATE core.accounts SET certified = true WHERE id = p_account;
    ELSE
        UPDATE core.verifications SET revoked_at = now()
         WHERE account_id = p_account AND category = p_status AND revoked_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'argos:deja_ainsi';
        END IF;
        -- Plus aucun statut journaliste / avocat / association : la certification tombe avec (« confiance »
        -- se redonne à part si besoin).
        IF NOT EXISTS (SELECT 1 FROM core.verifications WHERE account_id = p_account AND revoked_at IS NULL AND expires_at > now()) THEN
            UPDATE core.accounts SET certified = false WHERE id = p_account;
        END IF;
    END IF;
END $$;

-- 3. Lieu ou date à établir --------------------------------------------------------------------------------------
ALTER TABLE core.context_corrections
    ADD COLUMN settled_date     boolean NOT NULL DEFAULT false,   -- cette correction a établi la date
    ADD COLUMN settled_location boolean NOT NULL DEFAULT false;   -- cette correction a établi le lieu

DROP FUNCTION core.osint_correct_context(uuid, uuid, timestamptz, boolean, double precision, double precision, text, text, text[], boolean, boolean);
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
$$;
REVOKE ALL ON FUNCTION core.osint_correct_context(uuid, uuid, timestamptz, boolean, double precision, double precision, text, text, text[], boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.osint_correct_context(uuid, uuid, timestamptz, boolean, double precision, double precision, text, text, text[], boolean, boolean) TO argos_app;

CREATE OR REPLACE FUNCTION core.admin_cancel_correction(p_admin uuid, p_correction uuid, p_reason text) RETURNS void
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
                           location = c.previous_location, location_precision = c.previous_precision,
                           date_to_establish = date_to_establish OR c.settled_date,
                           location_to_establish = location_to_establish OR c.settled_location
     WHERE id = c.video_id;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', 'cancel_correction', 'video', c.video_id, 'correction', p_correction, 'reason', btrim(p_reason)));
    -- La correction annulée avait établi la date ou le lieu d'une vidéo publiée : elle repart en attente d'analyse.
    IF c.settled_date OR c.settled_location THEN
        UPDATE core.videos SET status = 'awaiting_osint' WHERE id = c.video_id AND status = 'published';
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION core.osint_note_create(p_account uuid, p_video uuid, p_finding text, p_explanation text,
                                                  p_links text[], p_public boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_id uuid;
BEGIN
    IF NOT core.is_osint_analyst(p_account) THEN
        RAISE EXCEPTION 'argos:reserve_analyste';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.mfa_factors WHERE account_id = p_account AND revoked_at IS NULL) THEN
        RAISE EXCEPTION 'argos:double_auth_requise';
    END IF;
    PERFORM 1 FROM core.videos vi WHERE vi.id = p_video AND vi.status IN ('in_review', 'jury', 'awaiting_osint') AND NOT vi.is_control FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:video_hors_relecture';
    END IF;
    IF (SELECT count(*) FROM core.osint_notes WHERE video_id = p_video AND author_id = p_account
                                                 AND withdrawn_at IS NULL AND masked_at IS NULL) >= 3 THEN
        RAISE EXCEPTION 'argos:plafond_notes';
    END IF;
    PERFORM core.check_osint_content(p_finding, p_explanation, p_links);
    INSERT INTO core.osint_notes (video_id, author_id, finding, explanation, links, wants_public)
    VALUES (p_video, p_account, btrim(p_finding), btrim(p_explanation), p_links, coalesce(p_public, false))
    RETURNING osint_notes.id INTO v_id;
    INSERT INTO core.osint_note_versions (note_id, version, finding, explanation, links)
    VALUES (v_id, 1, btrim(p_finding), btrim(p_explanation), p_links);
    RETURN v_id;
END
$$;
