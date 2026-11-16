-- Relecture croisée de la purge (15 novembre 2026) :
--   1. une vidéo effacée (purge ou retrait) ne garde plus l'heure exacte des faits (arrondie au jour), ni son lien de doublon,
--      ni le lieu DÉCLARÉ par la source (le retrait ne l'effaçait pas) : toutes les mises à NULL sont ici ;
--   2. le RETRAIT par la source efface désormais les mêmes traces que la purge (core.erase_video_traces) : conversations et
--      messages, clés de la vidéo, notes et corrections d'analystes, signalements, réponses, zones de re-floutage,
--      alertes, empreintes du fichier. Jamais sous gel légal (le retrait y est d'ailleurs refusé).
CREATE OR REPLACE FUNCTION core.erase_video_traces(v uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    UPDATE core.videos
       SET description = NULL, description_mt = NULL, location = NULL, location_precision = NULL,
           declared_location = NULL, declared_location_precision = NULL,
           r2_original_enc_key = NULL, r2_blurred_key = NULL, r2_preview_key = NULL,
           original_sha256 = NULL, original_enc_sha256 = NULL, blurred_sha256 = NULL, timestamp_token = NULL,
           occurred_at = date_trunc('day', occurred_at, 'Europe/Paris'), occurred_time_known = false,
           declared_occurred_at = date_trunc('day', declared_occurred_at, 'Europe/Paris'), declared_time_known = false,
           duplicate_of = NULL
     WHERE id = v;
    UPDATE core.videos SET duplicate_of = NULL WHERE duplicate_of = v;
    DELETE FROM core.description_corrections WHERE video_id = v;
    DELETE FROM core.replies WHERE video_id = v;
    DELETE FROM core.reblur_requests WHERE video_id = v;
    DELETE FROM core.admin_alerts WHERE video_id = v;
    DELETE FROM core.video_fingerprints WHERE video_id = v;            -- et leur index (fingerprint_keys, en cascade)
    DELETE FROM core.video_matches WHERE video_id = v OR other_video_id = v;
    DELETE FROM core.event_links WHERE video_id = v;
    DELETE FROM core.event_proposals WHERE video_id = v OR target_video_id = v;
    DELETE FROM core.control_videos WHERE video_id = v;
    DELETE FROM core.video_origins WHERE video_id = v;
    DELETE FROM core.video_fetches WHERE video_id = v;
    DELETE FROM core.video_owners WHERE video_id = v;                  -- lien compte ↔ vidéo
    DELETE FROM core.release_consents WHERE video_id = v;
    DELETE FROM core.owner_notifications WHERE video_id = v;
    DELETE FROM core.osint_notes WHERE video_id = v;                   -- versions et jugements en cascade
    DELETE FROM core.context_corrections WHERE video_id = v;
    UPDATE core.reports SET details = NULL WHERE video_id = v;
    -- Conversations (messages, partages en cascade) et clés de messagerie de la vidéo.
    DELETE FROM core.conversations WHERE pseudonym_id IN (SELECT id FROM core.pseudonyms WHERE video_id = v);
    DELETE FROM core.public_keys WHERE pseudonym_id IN (SELECT id FROM core.pseudonyms WHERE video_id = v);
    -- Les 12 mots ne désignent plus la vidéo.
    UPDATE core.pseudonyms SET tracking_code_hash = public.gen_random_bytes(32) WHERE video_id = v;
    UPDATE core.summons SET outcome = 'cancelled' WHERE video_id = v AND outcome = 'pending';
END $$;

-- Retrait par la source : même effacement (le gel légal garde tout, comme avant).
CREATE OR REPLACE FUNCTION core.erase_withdrawn_fingerprints() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF NEW.legal_hold THEN
        -- Comme 0104 : sous gel légal, le lien compte ↔ vidéo et le code de suivi sont gardés pour la justice.
        DELETE FROM core.video_fingerprints WHERE video_id = NEW.id;
        DELETE FROM core.video_matches WHERE video_id = NEW.id OR other_video_id = NEW.id;
        DELETE FROM core.event_links WHERE video_id = NEW.id;
        DELETE FROM core.event_proposals WHERE video_id = NEW.id OR target_video_id = NEW.id;
        DELETE FROM core.control_videos WHERE video_id = NEW.id;
        DELETE FROM core.video_origins WHERE video_id = NEW.id;
        UPDATE core.video_owners SET code_sealed = NULL WHERE video_id = NEW.id;
    ELSE
        PERFORM core.erase_video_traces(NEW.id);
    END IF;
    RETURN NULL;
END;
$$;
