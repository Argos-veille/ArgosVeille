-- Envoi des vidéos par les sources, sans compte (étape 5b, 4 novembre 2026).
--
-- Une vidéo naît au statut « uploading » (envoi en cours) : ses morceaux arrivent, puis la
-- finalisation la fait passer à « processing » (floutage, étape 6). Un envoi jamais finalisé
-- expire au bout de 24 h et est effacé.

ALTER TABLE core.videos DROP CONSTRAINT videos_status_check;
ALTER TABLE core.videos ADD CONSTRAINT videos_status_check
    CHECK (status IN ('uploading', 'processing', 'awaiting_author', 'in_review', 'jury',
                      'published', 'rejected', 'under_debate', 'no_decision', 'hidden', 'removed'));
ALTER TABLE core.videos ALTER COLUMN status SET DEFAULT 'uploading';

ALTER TABLE core.videos
    -- Indicateur calculé dans le navigateur de la source (les métadonnées brutes ne sont jamais envoyées).
    ADD COLUMN metadata_check      text CHECK (metadata_check IN ('coherent', 'incoherent', 'absent')),
    -- Empreinte du fichier chiffré tel que stocké : prouve plus tard qu'il n'a pas été modifié.
    ADD COLUMN original_enc_sha256 bytea CHECK (original_enc_sha256 IS NULL OR length(original_enc_sha256) = 32),
    ADD COLUMN upload_expires_at   timestamptz,
    ADD CONSTRAINT videos_uploading_expires CHECK (status <> 'uploading' OR upload_expires_at IS NOT NULL),
    ADD CONSTRAINT videos_description_length CHECK (description IS NULL OR length(description) <= 5000);

CREATE INDEX videos_uploading_expiry ON core.videos (upload_expires_at) WHERE status = 'uploading';

-- Une vidéo créée par le site commence toujours au statut « uploading ».
CREATE OR REPLACE FUNCTION core.guard_video_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'uploading' AND current_user <> 'argos_owner' THEN
        RAISE EXCEPTION 'une vidéo commence toujours au statut uploading';
    END IF;
    RETURN NEW;
END
$$;

-- Transitions : ajout de « uploading → processing » (finalisation de l'envoi) pour le site.
CREATE OR REPLACE FUNCTION core.guard_video_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR current_user = 'argos_owner' THEN
        RETURN NEW;
    END IF;
    IF core.acting_as('argos_app') AND OLD.status = 'uploading' AND NEW.status = 'processing' THEN
        RETURN NEW;   -- envoi finalisé
    END IF;
    IF core.acting_as('argos_worker') AND OLD.status = 'processing' AND NEW.status = 'awaiting_author' THEN
        RETURN NEW;   -- floutage terminé
    END IF;
    IF core.acting_as('argos_app') AND OLD.status = 'awaiting_author' AND NEW.status = 'in_review' THEN
        RETURN NEW;   -- l'auteur valide le floutage
    END IF;
    IF core.acting_as('argos_scoring') AND OLD.status IN ('in_review', 'jury')
       AND NEW.status IN ('jury', 'published', 'rejected', 'under_debate', 'no_decision') THEN
        RETURN NEW;   -- décision communautaire
    END IF;
    IF core.acting_as('argos_admin') AND NEW.status IN ('hidden', 'removed') THEN
        RETURN NEW;   -- masquage ou retrait pour motif légal
    END IF;
    IF core.acting_as('argos_admin') AND OLD.status = 'hidden'
       AND NEW.status IN ('in_review', 'published', 'under_debate') THEN
        RETURN NEW;   -- rétablissement après un masquage d'urgence
    END IF;
    RAISE EXCEPTION 'transition de statut interdite pour %: % -> %', current_user, OLD.status, NEW.status;
END
$$;

-- Le site saisit l'indicateur et l'échéance à la création, l'empreinte et l'emplacement du
-- fichier chiffré à la finalisation.
GRANT INSERT (metadata_check, upload_expires_at) ON core.videos TO argos_app;
GRANT SELECT (metadata_check, original_enc_sha256, upload_expires_at, r2_original_enc_key) ON core.videos TO argos_app;
GRANT UPDATE (original_enc_sha256, r2_original_enc_key, upload_expires_at) ON core.videos TO argos_app;

-- Effacement d'un envoi abandonné : uniquement s'il est encore « uploading ». Le site n'a pas
-- le droit de supprimer une vidéo ; ces fonctions sont la seule exception, strictement bornée.
CREATE FUNCTION core.abandon_upload(p_video uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
    WITH d AS (DELETE FROM core.videos WHERE id = p_video AND status = 'uploading' RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM d)
$$;

CREATE FUNCTION core.purge_expired_uploads() RETURNS SETOF uuid
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
    DELETE FROM core.videos WHERE status = 'uploading' AND upload_expires_at < now() RETURNING id
$$;

REVOKE ALL ON FUNCTION core.abandon_upload(uuid), core.purge_expired_uploads() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.abandon_upload(uuid), core.purge_expired_uploads() TO argos_app;
