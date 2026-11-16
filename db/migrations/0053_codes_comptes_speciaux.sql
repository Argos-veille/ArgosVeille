-- Codes de COMPTES SPÉCIAUX (7 novembre 2026, choix de l’administrateur), dans la page « Gestion des codes » :
--   - à la création, l'administrateur choisit le type : journaliste, avocat, association, analyste OSINT, ou
--     « confiance » seule ;
--   - saisi à l'inscription, le code CERTIFIE le compte : il saute les délais (période novice de 30 jours,
--     60 jours d'ancienneté pour le jury — la double authentification reste exigée pour le jury) et reçoit
--     automatiquement la catégorie choisie (core.verifications, renouvelable chaque année) ;
--   - un code sert UNE SEULE fois ; expiration facultative ; révocable tant qu'il n'a pas servi ; rien de public
--     (ni journal, ni badge) pour ne pas exposer un avocat ou un journaliste ;
--   - comme les codes bêta : empreinte HMAC pour la vérification, copie chiffrée pour le réafficher.

ALTER TABLE core.accounts ADD COLUMN certified boolean NOT NULL DEFAULT false;
GRANT SELECT (certified) ON core.accounts TO argos_app;

CREATE TABLE core.account_codes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hmac  bytea NOT NULL UNIQUE,
    code_enc   bytea,
    category   text NOT NULL CHECK (category IN ('journalist', 'lawyer', 'association', 'osint_analyst', 'trusted')),
    label      text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES core.accounts (id),
    expires_at timestamptz,
    revoked_at timestamptz,
    used_at    timestamptz,
    used_by    uuid REFERENCES core.accounts (id) ON DELETE SET NULL
);
REVOKE ALL ON core.account_codes FROM PUBLIC;

-- Le code peut-il servir ? Renvoie sa catégorie, ou NULL (inconnu, révoqué, expiré ou déjà utilisé).
CREATE FUNCTION core.account_code_category(p_hmac bytea) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT category FROM core.account_codes
     WHERE code_hmac = p_hmac AND revoked_at IS NULL AND used_at IS NULL AND (expires_at IS NULL OR expires_at > now())
$$;

-- Utiliser le code pour un compte (à la fin de l'inscription) : une seule fois, verrou sur la ligne.
CREATE FUNCTION core.redeem_account_code(p_account uuid, p_hmac bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    c record;
BEGIN
    SELECT id, category, created_by INTO c FROM core.account_codes
     WHERE code_hmac = p_hmac AND revoked_at IS NULL AND used_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    UPDATE core.account_codes SET used_at = now(), used_by = p_account WHERE id = c.id;
    UPDATE core.accounts SET certified = true WHERE id = p_account;
    IF c.category <> 'trusted' THEN
        INSERT INTO core.verifications (account_id, category, expires_at, verified_by)
        VALUES (p_account, c.category, now() + interval '1 year', c.created_by);
    END IF;
    RETURN c.category;
END $$;

CREATE FUNCTION core.admin_account_codes(p_admin uuid)
RETURNS TABLE (id uuid, label text, category text, created_at timestamptz, expires_at timestamptz, revoked_at timestamptz,
               used_at timestamptz, used_by_username text, code_enc bytea)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY SELECT c.id, c.label, c.category, c.created_at, c.expires_at, c.revoked_at, c.used_at, a.username, c.code_enc
                   FROM core.account_codes c LEFT JOIN core.accounts a ON a.id = c.used_by
                  ORDER BY (c.revoked_at IS NULL AND c.used_at IS NULL) DESC, c.created_at DESC;
END $$;

CREATE FUNCTION core.admin_create_account_code(p_admin uuid, p_hmac bytea, p_label text, p_category text,
                                               p_expires timestamptz, p_code_enc bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_id uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF p_expires IS NOT NULL AND p_expires <= now() THEN
        RAISE EXCEPTION 'argos:expiration_passee';
    END IF;
    INSERT INTO core.account_codes (code_hmac, label, category, created_by, expires_at, code_enc)
    VALUES (p_hmac, btrim(p_label), p_category, p_admin, p_expires, p_code_enc) RETURNING id INTO v_id;
    RETURN v_id;
END $$;

CREATE FUNCTION core.admin_revoke_account_code(p_admin uuid, p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    UPDATE core.account_codes SET revoked_at = now() WHERE id = p_id AND revoked_at IS NULL AND used_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
END $$;

-- Supprimer de la liste les codes qui ne peuvent plus servir (utilisés, révoqués, expirés) : un, ou tous.
-- Supprimer un code utilisé ne retire pas la certification du compte.
CREATE FUNCTION core.admin_delete_account_codes(p_admin uuid, p_id uuid DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    DELETE FROM core.account_codes
     WHERE (p_id IS NULL OR id = p_id)
       AND (used_at IS NOT NULL OR revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= now()));
    GET DIAGNOSTICS n = ROW_COUNT;
    IF p_id IS NOT NULL AND n = 0 THEN
        RAISE EXCEPTION 'argos:code_encore_actif';
    END IF;
    RETURN n;
END $$;

REVOKE ALL ON FUNCTION core.account_code_category(bytea), core.redeem_account_code(uuid, bytea), core.admin_account_codes(uuid),
                       core.admin_create_account_code(uuid, bytea, text, text, timestamptz, bytea),
                       core.admin_revoke_account_code(uuid, uuid), core.admin_delete_account_codes(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.account_code_category(bytea), core.redeem_account_code(uuid, bytea), core.admin_account_codes(uuid),
                          core.admin_create_account_code(uuid, bytea, text, text, timestamptz, bytea),
                          core.admin_revoke_account_code(uuid, uuid), core.admin_delete_account_codes(uuid, uuid) TO argos_app;

-- Délais sautés pour les comptes certifiés (fonctions recopiées de 0048, seule la condition change).

CREATE OR REPLACE FUNCTION core.jury_pool(p_video uuid, p jsonb) RETURNS TABLE (account_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH anciens AS (
        SELECT a.id, a.score
          FROM core.accounts a
         WHERE a.status = 'active' AND NOT a.suspect AND NOT a.review_opt_out
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

    -- Compte certifié (code de compte spécial) : pas de période novice.
    SELECT score, CASE WHEN certified THEN '-infinity'::timestamptz ELSE created_at END, status
      INTO v_score, v_created, v_status
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
