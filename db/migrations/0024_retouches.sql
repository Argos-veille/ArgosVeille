-- Retouches du floutage par la source (étape 6c-2, 4 novembre 2026).
--
-- La source peut retirer des flous et ajouter des zones, puis la vidéo repasse en traitement
-- (« awaiting_author » → « processing »), 10 fois au plus. Délai de vérification : 7 jours au total
-- depuis le premier aperçu, avec au moins 24 h après le retour de la dernière retouche.

ALTER TABLE core.videos ADD COLUMN review_deadline timestamptz;

-- awaiting_since ne marque plus que la PREMIÈRE arrivée à « à vérifier » ; l'échéance est recalculée
-- à chaque retour (après une retouche).
CREATE OR REPLACE FUNCTION core.mark_awaiting_since() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'awaiting_author' AND OLD.status IS DISTINCT FROM 'awaiting_author' THEN
        NEW.awaiting_since := coalesce(OLD.awaiting_since, now());
        NEW.review_deadline := greatest(NEW.awaiting_since + interval '7 days', now() + interval '24 hours');
    END IF;
    RETURN NEW;
END $$;

UPDATE core.videos SET review_deadline = awaiting_since + interval '7 days'
 WHERE status = 'awaiting_author' AND review_deadline IS NULL;

DROP INDEX core.videos_awaiting;
CREATE INDEX videos_review_deadline ON core.videos (review_deadline) WHERE status = 'awaiting_author';

-- Transitions : ajout de la retouche (site), qui doit compter une retouche de plus, 10 au plus.
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
    IF core.acting_as('argos_app') AND OLD.status = 'awaiting_author' AND NEW.status = 'processing'
       AND NEW.retouches = OLD.retouches + 1 AND NEW.retouches <= 10 THEN
        RETURN NEW;   -- retouche demandée par l'auteur
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

-- Le nombre de retouches ne fait que monter (une par passage en traitement).
CREATE FUNCTION core.guard_retouches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.retouches <> OLD.retouches AND current_user <> 'argos_owner'
       AND NOT (NEW.retouches = OLD.retouches + 1 AND OLD.status = 'awaiting_author' AND NEW.status = 'processing') THEN
        RAISE EXCEPTION 'le nombre de retouches ne change qu''avec une retouche';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER videos_guard_retouches BEFORE UPDATE OF retouches ON core.videos
    FOR EACH ROW EXECUTE FUNCTION core.guard_retouches();
REVOKE ALL ON FUNCTION core.guard_retouches() FROM PUBLIC;

-- Le site relance le traitement d'une retouche : compteur de tentatives et avancement remis à zéro.
GRANT SELECT (review_deadline) ON core.videos TO argos_app;
GRANT UPDATE (processing_attempts, processing_progress, processing_started_at) ON core.videos TO argos_app;
