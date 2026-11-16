-- Index des empreintes pour la recherche de doublons à grande échelle (14 novembre 2026, P2).
-- Jusqu'ici chaque nouvelle vidéo était comparée à TOUTES les autres. Au-delà d'un seuil (réglé dans le worker), on ne
-- compare plus qu'aux vidéos « candidates » : les 200 qui partagent le plus de clés avec elle (coût fixe, quelle que soit
-- la taille de la base ; une vraie copie partage bien plus de clés que deux vidéos sans rapport).
--   clés visuelles : chaque image (empreinte de 64 bits) découpée en 4 tranches de 16 bits, clé = tranche × 65 536 + valeur ;
--   clés sonores   : chaque mot Chromaprint (32 bits) découpé en 2 moitiés, clé = (4 + moitié) × 65 536 + valeur.
-- Les clés trop fréquentes (image noire, plan fixe banal) ne comptent pas. Sous le seuil, rien ne change.

CREATE TABLE core.fingerprint_keys (
    key       integer NOT NULL CHECK (key BETWEEN 0 AND 6 * 65536 - 1),
    video_id  uuid NOT NULL REFERENCES core.video_fingerprints (video_id) ON DELETE CASCADE,
    PRIMARY KEY (key, video_id)
);
CREATE INDEX fingerprint_keys_video ON core.fingerprint_keys (video_id);
REVOKE ALL ON core.fingerprint_keys FROM PUBLIC;

CREATE FUNCTION core.save_fingerprint_keys(p_video uuid, p_keys integer[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    DELETE FROM core.fingerprint_keys WHERE video_id = p_video;
    INSERT INTO core.fingerprint_keys (key, video_id)
    SELECT DISTINCT k, p_video FROM unnest(p_keys) k
     WHERE EXISTS (SELECT 1 FROM core.video_fingerprints WHERE video_id = p_video)
    ON CONFLICT DO NOTHING;
$$;

-- Empreintes pas encore indexées (vidéos d'avant l'index, ou index perdu) : le worker les rattrape.
CREATE FUNCTION core.fingerprints_unindexed(p_limit integer)
RETURNS TABLE (video_id uuid, algo_version smallint, visual bytea, audio bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT f.video_id, f.algo_version, f.visual, f.audio FROM core.video_fingerprints f
     WHERE NOT EXISTS (SELECT 1 FROM core.fingerprint_keys k WHERE k.video_id = f.video_id)
     ORDER BY f.video_id LIMIT least(p_limit, 500);
$$;

CREATE FUNCTION core.fingerprints_count() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT count(*)::integer FROM core.video_fingerprints;
$$;

-- Les p_limit vidéos qui partagent le plus de clés avec la requête (2 au moins), sans compter les clés présentes dans
-- plus de p_max_share des vidéos indexées (et plus de 20 vidéos).
CREATE FUNCTION core.fingerprint_candidates(p_video uuid, p_keys integer[], p_limit integer, p_max_share real)
RETURNS TABLE (video_id uuid, algo_version smallint, visual bytea, visual_mirror bytea, audio bytea, camera bytea, original_sha256 bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH demandees AS (SELECT DISTINCT k AS key FROM unnest(p_keys) k),
         total AS (SELECT count(*) AS n FROM core.video_fingerprints),
         utiles AS (SELECT d.key FROM demandees d JOIN core.fingerprint_keys f ON f.key = d.key
                     GROUP BY d.key HAVING count(*) <= greatest(20, p_max_share * (SELECT n FROM total))),
         proches AS (SELECT f.video_id FROM core.fingerprint_keys f JOIN utiles u ON u.key = f.key
                      WHERE f.video_id <> p_video GROUP BY f.video_id HAVING count(*) >= 2
                      ORDER BY count(*) DESC, f.video_id LIMIT least(p_limit, 1000))
    SELECT f.video_id, f.algo_version, f.visual, f.visual_mirror, f.audio, f.camera, v.original_sha256
      FROM proches p JOIN core.video_fingerprints f ON f.video_id = p.video_id JOIN core.videos v ON v.id = f.video_id;
$$;

-- Même fichier d'origine (empreinte SHA-256 identique) : toujours candidat, quel que soit l'index.
CREATE FUNCTION core.fingerprints_same_original(p_video uuid)
RETURNS TABLE (video_id uuid, algo_version smallint, visual bytea, visual_mirror bytea, audio bytea, camera bytea, original_sha256 bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT f.video_id, f.algo_version, f.visual, f.visual_mirror, f.audio, f.camera, v.original_sha256
      FROM core.video_fingerprints f JOIN core.videos v ON v.id = f.video_id
     WHERE f.video_id <> p_video AND v.original_sha256 IS NOT NULL
       AND v.original_sha256 = (SELECT original_sha256 FROM core.videos WHERE id = p_video);
$$;

REVOKE ALL ON FUNCTION core.save_fingerprint_keys(uuid, integer[]), core.fingerprints_unindexed(integer),
                       core.fingerprints_count(), core.fingerprint_candidates(uuid, integer[], integer, real),
                       core.fingerprints_same_original(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.save_fingerprint_keys(uuid, integer[]), core.fingerprints_unindexed(integer),
                          core.fingerprints_count(), core.fingerprint_candidates(uuid, integer[], integer, real),
                          core.fingerprints_same_original(uuid) TO argos_worker;
