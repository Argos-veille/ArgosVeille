-- Workers séparés (14 novembre 2026, demande de l’administrateur) : deux workers de récupération téléchargent les vidéos envoyées
-- par lien ; un worker de traitement floute les vidéos dans l'ordre d'arrivée, seulement celles qui sont prêtes (fichier
-- reçu ou lien déjà récupéré). Une récupération lente (Tor) ne bloque donc plus le floutage.
ALTER TABLE core.video_fetches
    ADD COLUMN started_at timestamptz,
    ADD COLUMN attempts   integer NOT NULL DEFAULT 0;

-- Réserve la plus ancienne récupération à faire (ou reprend une récupération abandonnée depuis 15 minutes).
CREATE FUNCTION core.take_fetch_job() RETURNS TABLE (video_id uuid, attempts integer)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    UPDATE core.video_fetches f SET started_at = now(), attempts = f.attempts + 1
     WHERE f.video_id = (SELECT q.video_id FROM core.video_fetches q JOIN core.videos v ON v.id = q.video_id
                          WHERE v.status = 'processing' AND (q.started_at IS NULL OR q.started_at < now() - interval '15 minutes')
                          ORDER BY q.created_at LIMIT 1 FOR UPDATE OF q SKIP LOCKED)
    RETURNING f.video_id, f.attempts;
$$;
REVOKE ALL ON FUNCTION core.take_fetch_job() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.take_fetch_job() TO argos_worker;
-- Le worker de traitement laisse de côté les vidéos dont le lien n'est pas encore récupéré (il ne lit jamais l'adresse).
GRANT SELECT (video_id) ON core.video_fetches TO argos_worker;
