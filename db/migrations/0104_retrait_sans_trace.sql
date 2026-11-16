-- Revue de sécurité B2 : une vidéo retirée par sa source ne garde plus rien qui relie une personne à elle (sauf gel
-- légal, où tout est gardé pour la justice) :
--   - le lien avec le compte qui l'a envoyée (video_owners) est effacé : elle disparaît de « Mes vidéos » ;
--   - l'empreinte du code de suivi est remplacée par une valeur au hasard : le code ne désigne plus cette vidéo ;
--   - l'heure du retrait est gardée au jour seulement.
-- (L'empreinte de l'original l'est déjà depuis 0100, les empreintes de doublons depuis 0064.)
CREATE OR REPLACE FUNCTION core.erase_withdrawn_fingerprints() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    DELETE FROM core.video_fingerprints WHERE video_id = NEW.id;
    DELETE FROM core.video_matches WHERE video_id = NEW.id OR other_video_id = NEW.id;
    DELETE FROM core.event_links WHERE video_id = NEW.id;
    DELETE FROM core.event_proposals WHERE video_id = NEW.id OR target_video_id = NEW.id;
    DELETE FROM core.control_videos WHERE video_id = NEW.id;
    DELETE FROM core.video_origins WHERE video_id = NEW.id;
    UPDATE core.video_owners SET code_sealed = NULL WHERE video_id = NEW.id;
    IF NOT NEW.legal_hold THEN
        DELETE FROM core.video_owners WHERE video_id = NEW.id;
        UPDATE core.pseudonyms SET tracking_code_hash = decode(md5(random()::text) || md5(random()::text), 'hex')
         WHERE video_id = NEW.id;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION core.forget_original_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'withdrawn' AND OLD.status IS DISTINCT FROM 'withdrawn' THEN
        NEW.withdrawn_at := date_trunc('day', coalesce(NEW.withdrawn_at, now()));
        IF NOT NEW.legal_hold THEN
            NEW.original_sha256 := NULL;
        END IF;
    END IF;
    RETURN NEW;
END $$;

-- Vidéos déjà retirées.
UPDATE core.videos SET withdrawn_at = date_trunc('day', withdrawn_at) WHERE status = 'withdrawn' AND withdrawn_at IS NOT NULL;
DELETE FROM core.video_owners o USING core.videos v WHERE v.id = o.video_id AND v.status = 'withdrawn' AND NOT v.legal_hold;
UPDATE core.pseudonyms p SET tracking_code_hash = decode(md5(random()::text) || md5(random()::text), 'hex')
  FROM core.videos v WHERE v.id = p.video_id AND v.status = 'withdrawn' AND NOT v.legal_hold;
