-- Relecture (9 novembre 2026, phase D4) : « Cette vidéo est déjà présente sur le site ». Réponse indépendante
-- du verdict, sans effet sur les scores. Confirmée à la fin du premier tour si les votes désignant une même
-- fiche publiée atteignent le seuil de publication (65 %) du poids total des votes.
ALTER TABLE core.votes ADD COLUMN duplicate_of uuid REFERENCES core.videos (id) ON DELETE SET NULL;
ALTER TABLE core.videos ADD COLUMN duplicate_of uuid REFERENCES core.videos (id) ON DELETE SET NULL;
CREATE INDEX videos_duplicate_of ON core.videos (duplicate_of) WHERE duplicate_of IS NOT NULL;

-- Fiche publiée désignée par un relecteur : son lien, son identifiant ou son nom.
CREATE FUNCTION core.resolve_published(p_reference text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT v.id FROM core.videos v
      LEFT JOIN core.pseudonyms p ON p.video_id = v.id
     WHERE v.status = 'published' AND NOT v.is_control
       AND (v.id::text = lower(substring(p_reference FROM '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'))
            OR lower(p.pseudonym) = lower(btrim(p_reference)))
     LIMIT 1;
$$;

-- Ressemblance montrée au relecteur : seulement une vidéo publiée, à tous les niveaux de ressemblance.
CREATE FUNCTION core.reviewer_lookalike(p_video uuid) RETURNS TABLE (id uuid, pseudonym text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT o.id, p.pseudonym
      FROM core.video_matches m
      JOIN core.videos o ON o.id = CASE WHEN m.video_id = p_video THEN m.other_video_id ELSE m.video_id END
      LEFT JOIN core.pseudonyms p ON p.video_id = o.id
     WHERE (m.video_id = p_video OR m.other_video_id = p_video) AND m.dismissed_at IS NULL
       AND o.status = 'published' AND NOT o.is_control
     ORDER BY array_position(ARRAY['exact', 'strong', 'possible'], m.level), m.detected_at
     LIMIT 1;
$$;

CREATE FUNCTION core.settle_duplicate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    p jsonb;
    total numeric;
    cible uuid;
    poids numeric;
BEGIN
    SELECT params INTO p FROM core.settings ORDER BY version DESC LIMIT 1;
    SELECT coalesce(sum(weight), 0) INTO total FROM core.votes WHERE video_id = NEW.id AND round = 'review';
    SELECT vo.duplicate_of, sum(vo.weight) INTO cible, poids
      FROM core.votes vo JOIN core.videos o ON o.id = vo.duplicate_of AND o.status = 'published'
     WHERE vo.video_id = NEW.id AND vo.round = 'review'
     GROUP BY vo.duplicate_of ORDER BY sum(vo.weight) DESC, vo.duplicate_of LIMIT 1;
    IF cible IS NOT NULL AND total > 0 AND poids / total >= (p ->> 'publish_threshold')::numeric THEN
        NEW.duplicate_of := cible;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER videos_settle_duplicate BEFORE UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (OLD.status = 'in_review' AND NEW.status IN ('published', 'jury', 'under_debate', 'no_decision', 'rejected'))
    EXECUTE FUNCTION core.settle_duplicate();

REVOKE ALL ON FUNCTION core.resolve_published(text), core.reviewer_lookalike(uuid), core.settle_duplicate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_published(text), core.reviewer_lookalike(uuid) TO argos_app;
