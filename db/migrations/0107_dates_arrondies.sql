-- Point bas de la revue (15 novembre 2026, demande de l’administrateur) : le journal légal garde l'adresse IP de chaque envoi à la
-- seconde (décret 2021-1362). Si la vidéo gardait elle aussi son heure d'envoi à la seconde, on relierait directement
-- une IP à une vidéo. L'heure exacte ne sert qu'à la file de floutage (ordre d'arrivée) : elle est gardée tant que la
-- vidéo attend ou est traitée, puis arrondie à l'heure dès qu'elle sort du traitement, avec toutes les dates posées au
-- moment de l'envoi (lien au compte, clé de messagerie, accord de transmission, événement proposé) et celles du
-- traitement (début, fin, empreintes, doublons).

CREATE FUNCTION core.round_submission_dates() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_pseudonyms uuid[];
BEGIN
    NEW.submitted_at := date_trunc('hour', NEW.submitted_at);
    NEW.processing_started_at := NULL;   -- ne sert qu'aux reprises du worker, pendant le traitement
    IF NEW.awaiting_since IS NOT NULL THEN
        NEW.awaiting_since := date_trunc('hour', NEW.awaiting_since);
    END IF;
    IF NEW.review_deadline IS NOT NULL AND NEW.review_deadline <> date_trunc('hour', NEW.review_deadline) THEN
        NEW.review_deadline := date_trunc('hour', NEW.review_deadline) + interval '1 hour';   -- arrondi au-dessus : jamais moins de temps pour la source
    END IF;
    UPDATE core.video_owners SET created_at = date_trunc('hour', created_at) WHERE video_id = NEW.id;
    UPDATE core.release_consents SET granted_at = date_trunc('hour', granted_at) WHERE video_id = NEW.id;
    UPDATE core.event_proposals SET created_at = date_trunc('hour', created_at) WHERE video_id = NEW.id;
    SELECT array_agg(id) INTO v_pseudonyms FROM core.pseudonyms WHERE video_id = NEW.id;
    UPDATE core.public_keys SET created_at = date_trunc('hour', created_at), updated_at = date_trunc('hour', updated_at)
     WHERE pseudonym_id = ANY (v_pseudonyms);
    UPDATE core.video_fingerprints SET computed_at = date_trunc('hour', computed_at) WHERE video_id = NEW.id;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.round_submission_dates() FROM PUBLIC;

-- « zz » : après les autres déclencheurs BEFORE (dont videos_mark_awaiting_since, qui pose awaiting_since et le délai).
CREATE TRIGGER videos_zz_round_submission_dates BEFORE UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (OLD.status IN ('uploading', 'processing') AND NEW.status NOT IN ('uploading', 'processing'))
    EXECUTE FUNCTION core.round_submission_dates();

-- Empreintes et doublons enregistrés après la sortie du traitement : datés à l'heure dès l'écriture.
ALTER TABLE core.video_fingerprints ALTER COLUMN computed_at SET DEFAULT date_trunc('hour', now());
ALTER TABLE core.video_matches ALTER COLUMN detected_at SET DEFAULT date_trunc('hour', now());

-- Vidéos déjà sorties du traitement : arrondies une fois pour toutes (sans repasser par les déclencheurs de statut).
ALTER TABLE core.videos DISABLE TRIGGER USER;
UPDATE core.videos SET submitted_at = date_trunc('hour', submitted_at), processing_started_at = NULL,
                       awaiting_since = date_trunc('hour', awaiting_since),
                       review_deadline = CASE WHEN review_deadline = date_trunc('hour', review_deadline) THEN review_deadline
                                              ELSE date_trunc('hour', review_deadline) + interval '1 hour' END
 WHERE status NOT IN ('uploading', 'processing');
ALTER TABLE core.videos ENABLE TRIGGER USER;
UPDATE core.video_owners o SET created_at = date_trunc('hour', o.created_at)
  FROM core.videos v WHERE v.id = o.video_id AND v.status NOT IN ('uploading', 'processing');
UPDATE core.release_consents r SET granted_at = date_trunc('hour', r.granted_at)
  FROM core.videos v WHERE v.id = r.video_id AND v.status NOT IN ('uploading', 'processing');
UPDATE core.event_proposals e SET created_at = date_trunc('hour', e.created_at)
  FROM core.videos v WHERE v.id = e.video_id AND v.status NOT IN ('uploading', 'processing');
UPDATE core.public_keys k SET created_at = date_trunc('hour', k.created_at), updated_at = date_trunc('hour', k.updated_at)
  FROM core.pseudonyms p JOIN core.videos v ON v.id = p.video_id
 WHERE p.id = k.pseudonym_id AND v.status NOT IN ('uploading', 'processing');
UPDATE core.video_fingerprints SET computed_at = date_trunc('hour', computed_at);
UPDATE core.video_matches SET detected_at = date_trunc('hour', detected_at);
