-- Position d'une vidéo dans la file de traitement (5 novembre 2026), pour la page de suivi.
--
-- Une vidéo « en traitement » attend que le worker la prenne (processing_started_at vide, ou essai
-- abandonné depuis plus de 2 heures) ; le worker prend toujours la plus ancienne. La fonction ne
-- renvoie qu'un nombre : 0 si la vidéo est en cours de traitement (ou n'est pas en traitement),
-- sinon sa place dans la file (1 = la prochaine).
CREATE FUNCTION core.processing_queue_position(p_video uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH attente AS (
        SELECT id, submitted_at FROM core.videos
         WHERE status = 'processing'
           AND (processing_started_at IS NULL OR processing_started_at < now() - interval '2 hours')
    )
    SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM attente WHERE id = p_video) THEN 0
                ELSE (SELECT count(*)::int FROM attente a, attente moi
                       WHERE moi.id = p_video AND (a.submitted_at, a.id) <= (moi.submitted_at, moi.id)) END
$$;
REVOKE ALL ON FUNCTION core.processing_queue_position(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.processing_queue_position(uuid) TO argos_app;
