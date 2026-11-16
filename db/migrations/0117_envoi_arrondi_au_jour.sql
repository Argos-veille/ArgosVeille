-- Heure d'envoi arrondie au JOUR (15 novembre 2026, décision de l’administrateur ; remplace l'heure de 0107) : tant que les envois
-- sont rares, un seul envoi dans une heure se relierait quand même à son adresse IP dans le journal légal. Le jour (heure
-- de Paris) noie l'envoi parmi ceux de la journée. Le délai de la source est arrondi au jour suivant : jamais plus court.
-- Limite : les dépôts sur R2 restent groupés à l'heure (un dépôt quotidien laisserait l'original une journée sur le seul VPS).

CREATE OR REPLACE FUNCTION core.round_submission_dates()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
    v_pseudonyms uuid[];
BEGIN
    NEW.submitted_at := date_trunc('day', NEW.submitted_at, 'Europe/Paris');
    NEW.processing_started_at := NULL;   -- ne sert qu'aux reprises du worker, pendant le traitement
    IF NEW.awaiting_since IS NOT NULL THEN
        NEW.awaiting_since := date_trunc('day', NEW.awaiting_since, 'Europe/Paris');
    END IF;
    IF NEW.review_deadline IS NOT NULL AND NEW.review_deadline <> date_trunc('day', NEW.review_deadline, 'Europe/Paris') THEN
        NEW.review_deadline := date_trunc('day', NEW.review_deadline, 'Europe/Paris') + interval '1 day';   -- arrondi au-dessus : jamais moins de temps pour la source
    END IF;
    UPDATE core.video_owners SET created_at = date_trunc('day', created_at, 'Europe/Paris') WHERE video_id = NEW.id;
    UPDATE core.release_consents SET granted_at = date_trunc('day', granted_at, 'Europe/Paris') WHERE video_id = NEW.id;
    UPDATE core.event_proposals SET created_at = date_trunc('day', created_at, 'Europe/Paris') WHERE video_id = NEW.id;
    SELECT array_agg(id) INTO v_pseudonyms FROM core.pseudonyms WHERE video_id = NEW.id;
    UPDATE core.public_keys SET created_at = date_trunc('day', created_at, 'Europe/Paris'), updated_at = date_trunc('day', updated_at, 'Europe/Paris')
     WHERE pseudonym_id = ANY (v_pseudonyms);
    UPDATE core.video_fingerprints SET computed_at = date_trunc('day', computed_at, 'Europe/Paris') WHERE video_id = NEW.id;
    RETURN NEW;
END $function$;

ALTER TABLE core.video_fingerprints ALTER COLUMN computed_at SET DEFAULT date_trunc('day', now(), 'Europe/Paris');
ALTER TABLE core.video_matches ALTER COLUMN detected_at SET DEFAULT date_trunc('day', now(), 'Europe/Paris');

-- Vidéos déjà sorties du traitement : arrondies au jour une fois pour toutes.
ALTER TABLE core.videos DISABLE TRIGGER USER;
UPDATE core.videos SET submitted_at = date_trunc('day', submitted_at, 'Europe/Paris'),
                       awaiting_since = date_trunc('day', awaiting_since, 'Europe/Paris'),
                       review_deadline = CASE WHEN review_deadline = date_trunc('day', review_deadline, 'Europe/Paris') THEN review_deadline
                                              ELSE date_trunc('day', review_deadline, 'Europe/Paris') + interval '1 day' END
 WHERE status NOT IN ('uploading', 'processing');
ALTER TABLE core.videos ENABLE TRIGGER USER;
UPDATE core.video_owners o SET created_at = date_trunc('day', o.created_at, 'Europe/Paris')
  FROM core.videos v WHERE v.id = o.video_id AND v.status NOT IN ('uploading', 'processing');
UPDATE core.release_consents r SET granted_at = date_trunc('day', r.granted_at, 'Europe/Paris')
  FROM core.videos v WHERE v.id = r.video_id AND v.status NOT IN ('uploading', 'processing');
UPDATE core.event_proposals e SET created_at = date_trunc('day', e.created_at, 'Europe/Paris')
  FROM core.videos v WHERE v.id = e.video_id AND v.status NOT IN ('uploading', 'processing');
UPDATE core.public_keys k SET created_at = date_trunc('day', k.created_at, 'Europe/Paris'), updated_at = date_trunc('day', k.updated_at, 'Europe/Paris')
  FROM core.pseudonyms p JOIN core.videos v ON v.id = p.video_id
 WHERE p.id = k.pseudonym_id AND v.status NOT IN ('uploading', 'processing');
UPDATE core.video_fingerprints SET computed_at = date_trunc('day', computed_at, 'Europe/Paris');
UPDATE core.video_matches SET detected_at = date_trunc('day', detected_at, 'Europe/Paris');
