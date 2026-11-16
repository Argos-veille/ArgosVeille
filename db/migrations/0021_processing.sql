-- Traitement des vidéos par le worker (étape 6a, 4 novembre 2026).
--
-- Le worker prend les vidéos « processing » une par une (verrou SKIP LOCKED), vérifie le fichier,
-- supprime les métadonnées, réencode (aperçu 480p puis version définitive), et fait passer la
-- vidéo à « awaiting_author » (vérification par la source) ou à « failed » (fichier refusé).

ALTER TABLE core.videos DROP CONSTRAINT videos_status_check;
ALTER TABLE core.videos ADD CONSTRAINT videos_status_check
    CHECK (status IN ('uploading', 'processing', 'failed', 'awaiting_author', 'in_review', 'jury', 'published',
                      'rejected', 'under_debate', 'no_decision', 'hidden', 'removed', 'withdrawn'));

ALTER TABLE core.videos
    -- Choix de la source à l'envoi : garder le son (preuve d'insultes, de sommations…) ou le couper
    -- (sa voix pourrait l'identifier).
    ADD COLUMN keep_audio            boolean NOT NULL DEFAULT true,
    ADD COLUMN processing_started_at timestamptz,
    ADD COLUMN processing_progress   smallint CHECK (processing_progress BETWEEN 0 AND 100),
    ADD COLUMN processing_attempts   smallint NOT NULL DEFAULT 0 CHECK (processing_attempts BETWEEN 0 AND 10),
    ADD COLUMN failure_reason        text CHECK (failure_reason IN (
        'not_a_video', 'unsupported_format', 'too_long', 'too_large', 'unreadable', 'processing_error')),
    ADD COLUMN r2_preview_key        text,
    ADD CONSTRAINT videos_failed_reason CHECK ((status = 'failed') = (failure_reason IS NOT NULL));

CREATE INDEX videos_processing_queue ON core.videos (submitted_at) WHERE status = 'processing';

-- Transitions : le worker termine (awaiting_author) ou refuse (failed) une vidéo en traitement.
CREATE OR REPLACE FUNCTION core.guard_video_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR current_user = 'argos_owner' THEN
        RETURN NEW;
    END IF;
    IF core.acting_as('argos_app') AND OLD.status = 'uploading' AND NEW.status = 'processing' THEN
        RETURN NEW;   -- envoi finalisé
    END IF;
    IF core.acting_as('argos_worker') AND OLD.status = 'processing' AND NEW.status IN ('awaiting_author', 'failed') THEN
        RETURN NEW;   -- traitement terminé, ou fichier refusé
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

-- Le site saisit le choix du son à l'envoi et lit l'avancement pour la page de suivi.
GRANT INSERT (keep_audio) ON core.videos TO argos_app;
GRANT SELECT (keep_audio, processing_progress, failure_reason, r2_preview_key) ON core.videos TO argos_app;

-- Le worker : uniquement ce dont le traitement a besoin, aucun champ de contexte (lieu, description…).
GRANT SELECT (submitted_at, keep_audio, processing_started_at, processing_attempts, r2_preview_key)
      ON core.videos TO argos_worker;
GRANT UPDATE (processing_started_at, processing_progress, processing_attempts, failure_reason, r2_preview_key)
      ON core.videos TO argos_worker;
