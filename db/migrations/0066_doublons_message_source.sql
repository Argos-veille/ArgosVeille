-- Message à la source (9 novembre 2026, phase D3) : seulement si sa vidéo ressemble fortement à une vidéo
-- DÉJÀ PUBLIÉE. Jamais pour une vidéo non publiée : sinon on pourrait tester ce qui a été envoyé au site.
CREATE FUNCTION core.published_lookalike(p_video uuid) RETURNS TABLE (id uuid, pseudonym text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT o.id, p.pseudonym
      FROM core.video_matches m
      JOIN core.videos moi ON moi.id = p_video AND moi.status IN ('awaiting_author', 'in_review', 'jury')
      JOIN core.videos o ON o.id = CASE WHEN m.video_id = p_video THEN m.other_video_id ELSE m.video_id END
      LEFT JOIN core.pseudonyms p ON p.video_id = o.id
     WHERE (m.video_id = p_video OR m.other_video_id = p_video)
       AND m.level IN ('exact', 'strong') AND m.dismissed_at IS NULL
       AND o.status = 'published' AND NOT o.is_control
     ORDER BY array_position(ARRAY['exact', 'strong'], m.level), m.detected_at
     LIMIT 1;
$$;
REVOKE ALL ON FUNCTION core.published_lookalike(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.published_lookalike(uuid) TO argos_app;
