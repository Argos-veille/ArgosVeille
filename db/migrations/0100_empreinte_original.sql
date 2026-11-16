-- Revue de sécurité du 14 novembre 2026, A4 : l'empreinte (SHA-256) de l'original n'est plus publiée (la fiche publique
-- ne montre que celle de la version floutée). Un téléphone saisi permettait sinon de prouver, par simple comparaison
-- avec sa galerie, que la personne avait filmé et envoyé la vidéo.
-- Ici : retirée par la source, la vidéo perd aussi l'empreinte de son original (sauf gel légal, où l'original est gardé).
CREATE FUNCTION core.forget_original_hash() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'withdrawn' AND OLD.status IS DISTINCT FROM 'withdrawn' AND NOT NEW.legal_hold THEN
        NEW.original_sha256 := NULL;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER videos_forget_original_hash BEFORE UPDATE OF status ON core.videos
    FOR EACH ROW EXECUTE FUNCTION core.forget_original_hash();
REVOKE ALL ON FUNCTION core.forget_original_hash() FROM PUBLIC;

-- Vidéos déjà retirées : même chose.
UPDATE core.videos SET original_sha256 = NULL WHERE status = 'withdrawn' AND NOT legal_hold AND original_sha256 IS NOT NULL;
