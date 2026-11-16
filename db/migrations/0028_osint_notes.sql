-- Notes d'analyse OSINT (étape 7d-1, 5 novembre 2026).
--
-- Un analyste OSINT vérifié garde un compte ordinaire (même score, même poids de vote). Il peut, sans
-- convocation, voir toute vidéo en relecture ou devant le jury (version floutée et contexte
-- seulement) et y joindre des notes : un constat (200 caractères), une explication (5 000) et
-- 1 à 10 liens https vers ses sources. Une note n'est pas un vote. Au plus 3 notes actives par
-- analyste et par vidéo. L'auteur corrige (chaque version est gardée et visible) ou retire sa note
-- (elle reste dans l'historique) ; le super-administrateur la masque avec un motif (journal public).
-- Si l'analyste perd son statut, ses notes restent, marquées « analyste retiré ».
--
-- Le statut est une vérification (comme journaliste, avocat, association), d'un an, accordée ou
-- retirée par le super-administrateur (clé physique vérifiée par le site, journal public), et
-- seulement à un compte protégé par une double authentification.
--
-- Côté relecteur et juré, les notes restent repliées tant qu'il n'a pas ouvert la vidéo : il se fait
-- une première impression seul.

-- --- Statut d'analyste ----------------------------------------------------------------------------

ALTER TABLE core.verifications DROP CONSTRAINT verifications_category_check;
ALTER TABLE core.verifications ADD CONSTRAINT verifications_category_check
    CHECK (category IN ('journalist', 'lawyer', 'association', 'osint_analyst'));
CREATE UNIQUE INDEX verifications_one_active ON core.verifications (account_id, category) WHERE revoked_at IS NULL;

-- Analyste en titre : vérification non retirée, non expirée, compte actif.
CREATE FUNCTION core.is_osint_analyst(p_account uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM core.verifications ve JOIN core.accounts a ON a.id = ve.account_id
                    WHERE ve.account_id = p_account AND ve.category = 'osint_analyst'
                      AND ve.revoked_at IS NULL AND ve.expires_at > now() AND a.status = 'active')
$$;
REVOKE ALL ON FUNCTION core.is_osint_analyst(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.is_osint_analyst(uuid) TO argos_app;

CREATE FUNCTION core.admin_set_osint(p_admin uuid, p_account uuid, p_grant boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    pseudo text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_admin AND is_superadmin AND status = 'active') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    SELECT username INTO pseudo FROM core.accounts WHERE id = p_account AND status = 'active';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:compte_inconnu';
    END IF;
    IF p_grant THEN
        IF NOT EXISTS (SELECT 1 FROM core.mfa_factors WHERE account_id = p_account AND revoked_at IS NULL) THEN
            RAISE EXCEPTION 'argos:double_auth_requise';
        END IF;
        -- Une vérification expirée est close avant d'en ouvrir une nouvelle (renouvellement).
        UPDATE core.verifications SET revoked_at = now()
         WHERE account_id = p_account AND category = 'osint_analyst' AND revoked_at IS NULL AND expires_at <= now();
        IF EXISTS (SELECT 1 FROM core.verifications WHERE account_id = p_account AND category = 'osint_analyst'
                                                      AND revoked_at IS NULL) THEN
            RAISE EXCEPTION 'argos:deja_ainsi';
        END IF;
        INSERT INTO core.verifications (account_id, category, expires_at, verified_by)
        VALUES (p_account, 'osint_analyst', now() + interval '1 year', p_admin);
    ELSE
        UPDATE core.verifications SET revoked_at = now()
         WHERE account_id = p_account AND category = 'osint_analyst' AND revoked_at IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'argos:deja_ainsi';
        END IF;
    END IF;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', CASE WHEN p_grant THEN 'osint_grant' ELSE 'osint_revoke' END, 'analyst', pseudo));
END
$$;
REVOKE ALL ON FUNCTION core.admin_set_osint(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_set_osint(uuid, uuid, boolean) TO argos_app;

-- --- Notes ----------------------------------------------------------------------------------------

CREATE TABLE core.osint_notes (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id     uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    author_id    uuid REFERENCES core.accounts (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    version      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    finding      text NOT NULL,
    explanation  text NOT NULL,
    links        text[] NOT NULL,
    wants_public boolean NOT NULL DEFAULT false,   -- choix de l'analyste pour la fiche publique (7d-2)
    withdrawn_at timestamptz,                      -- retirée par son auteur
    masked_at    timestamptz,                      -- masquée par l'administration
    mask_reason  text,
    CHECK (length(btrim(finding)) BETWEEN 1 AND 200),
    CHECK (length(btrim(explanation)) BETWEEN 1 AND 5000),
    CHECK ((masked_at IS NULL) = (mask_reason IS NULL))
);
CREATE INDEX osint_notes_video ON core.osint_notes (video_id);

-- Chaque version d'une note, la première comprise : l'historique est visible des lecteurs.
CREATE TABLE core.osint_note_versions (
    note_id     uuid NOT NULL REFERENCES core.osint_notes (id) ON DELETE CASCADE,
    version     integer NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    finding     text NOT NULL,
    explanation text NOT NULL,
    links       text[] NOT NULL,
    PRIMARY KEY (note_id, version)
);

REVOKE ALL ON core.osint_notes, core.osint_note_versions FROM PUBLIC;
GRANT SELECT ON core.osint_notes, core.osint_note_versions TO argos_app;

-- Vérification du contenu (le site vérifie aussi ; la base a le dernier mot).
CREATE FUNCTION core.check_osint_content(p_finding text, p_explanation text, p_links text[]) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF length(btrim(coalesce(p_finding, ''))) NOT BETWEEN 1 AND 200
       OR length(btrim(coalesce(p_explanation, ''))) NOT BETWEEN 1 AND 5000 THEN
        RAISE EXCEPTION 'argos:note_invalide';
    END IF;
    IF coalesce(cardinality(p_links), 0) NOT BETWEEN 1 AND 10
       OR EXISTS (SELECT 1 FROM unnest(p_links) l
                   WHERE l IS NULL OR length(l) > 2000 OR l !~ '^https://[^\s/?#@]+\.[^\s/?#@]+([/?#]\S*)?$') THEN
        RAISE EXCEPTION 'argos:liens_invalides';
    END IF;
END $$;
REVOKE ALL ON FUNCTION core.check_osint_content(text, text, text[]) FROM PUBLIC;

-- Écrire une note : analyste en titre, double authentification active, vidéo en relecture ou au jury.
CREATE FUNCTION core.osint_note_create(p_account uuid, p_video uuid, p_finding text, p_explanation text,
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
    PERFORM 1 FROM core.videos vi WHERE vi.id = p_video AND vi.status IN ('in_review', 'jury') AND NOT vi.is_control FOR UPDATE;
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

-- Corriger sa note (nouvelle version), ou seulement changer son choix pour la fiche publique.
CREATE FUNCTION core.osint_note_edit(p_account uuid, p_note uuid, p_finding text, p_explanation text,
                                     p_links text[], p_public boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    n record;
BEGIN
    SELECT * INTO n FROM core.osint_notes WHERE id = p_note AND author_id = p_account FOR UPDATE;
    IF NOT FOUND OR n.withdrawn_at IS NOT NULL OR n.masked_at IS NOT NULL THEN
        RAISE EXCEPTION 'argos:note_introuvable';
    END IF;
    IF NOT core.is_osint_analyst(p_account) THEN
        RAISE EXCEPTION 'argos:reserve_analyste';
    END IF;
    PERFORM core.check_osint_content(p_finding, p_explanation, p_links);
    IF btrim(p_finding) IS DISTINCT FROM n.finding OR btrim(p_explanation) IS DISTINCT FROM n.explanation
       OR p_links IS DISTINCT FROM n.links THEN
        UPDATE core.osint_notes SET version = version + 1, updated_at = now(),
               finding = btrim(p_finding), explanation = btrim(p_explanation), links = p_links
         WHERE id = p_note;
        INSERT INTO core.osint_note_versions (note_id, version, finding, explanation, links)
        VALUES (p_note, n.version + 1, btrim(p_finding), btrim(p_explanation), p_links);
    END IF;
    UPDATE core.osint_notes SET wants_public = coalesce(p_public, wants_public) WHERE id = p_note;
    RETURN (SELECT version FROM core.osint_notes WHERE id = p_note);
END
$$;

CREATE FUNCTION core.osint_note_withdraw(p_account uuid, p_note uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    UPDATE core.osint_notes SET withdrawn_at = now()
     WHERE id = p_note AND author_id = p_account AND withdrawn_at IS NULL AND masked_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:note_introuvable';
    END IF;
END
$$;

CREATE FUNCTION core.admin_mask_note(p_admin uuid, p_note uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_admin AND is_superadmin AND status = 'active') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:motif';
    END IF;
    UPDATE core.osint_notes SET masked_at = now(), mask_reason = btrim(p_reason)
     WHERE id = p_note AND masked_at IS NULL
    RETURNING video_id INTO v;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:note_introuvable';
    END IF;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', 'mask_note', 'note', p_note, 'video', v, 'reason', btrim(p_reason)));
END
$$;

REVOKE ALL ON FUNCTION core.check_osint_content(text, text, text[]),
                       core.osint_note_create(uuid, uuid, text, text, text[], boolean),
                       core.osint_note_edit(uuid, uuid, text, text, text[], boolean),
                       core.osint_note_withdraw(uuid, uuid),
                       core.admin_mask_note(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.osint_note_create(uuid, uuid, text, text, text[], boolean),
                          core.osint_note_edit(uuid, uuid, text, text, text[], boolean),
                          core.osint_note_withdraw(uuid, uuid),
                          core.admin_mask_note(uuid, uuid, text) TO argos_app;

-- --- Première impression : notes repliées tant que la vidéo n'a pas été ouverte ------------------

ALTER TABLE core.summons ADD COLUMN video_opened_at timestamptz;
GRANT SELECT (video_opened_at), UPDATE (video_opened_at) ON core.summons TO argos_app;

-- Le site peut seulement noter la première ouverture de la vidéo, sur une convocation en attente.
CREATE OR REPLACE FUNCTION core.guard_summons_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    attendu core.summons;
BEGIN
    IF current_user = 'argos_owner' OR core.acting_as('argos_scoring') THEN
        RETURN NEW;
    END IF;
    -- Première ouverture de la vidéo : seule cette colonne change, convocation en attente et valable.
    attendu := OLD;
    attendu.video_opened_at := NEW.video_opened_at;
    IF OLD.video_opened_at IS NULL AND NEW.video_opened_at IS NOT NULL AND OLD.outcome = 'pending'
       AND OLD.expires_at > now() AND NEW IS NOT DISTINCT FROM attendu THEN
        RETURN NEW;
    END IF;
    IF NEW.video_opened_at IS NOT DISTINCT FROM OLD.video_opened_at
       AND OLD.outcome = 'pending' AND NEW.outcome = 'passed' AND OLD.expires_at > now()
       AND NEW.answered_at IS NOT NULL THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'changement de convocation interdit : % -> %', OLD.outcome, NEW.outcome;
END $$;
