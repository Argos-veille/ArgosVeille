-- Rattachement décidé par le super-administrateur (9 novembre 2026, demande de l’administrateur), depuis une ressemblance :
-- clé physique et motif, journal public. Vaut pour une vidéo publiée (elle quitte la carte tout de suite) ou
-- encore en cours d'examen (appliqué à sa publication). Le choix de l'administration prime sur le vote.
CREATE FUNCTION core.admin_attach_version(p_admin uuid, p_match uuid, p_video uuid, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    m core.video_matches%ROWTYPE;
    cible uuid;
    statut text;
    statut_cible text;
    parent uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF char_length(btrim(p_reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'argos:motif'; END IF;
    SELECT * INTO m FROM core.video_matches WHERE id = p_match FOR UPDATE;
    IF NOT FOUND OR p_video NOT IN (m.video_id, m.other_video_id) THEN RAISE EXCEPTION 'argos:introuvable'; END IF;
    cible := CASE WHEN p_video = m.video_id THEN m.other_video_id ELSE m.video_id END;

    SELECT status INTO statut FROM core.videos WHERE id = p_video FOR UPDATE;
    SELECT status, duplicate_of INTO statut_cible, parent FROM core.videos WHERE id = cible FOR UPDATE;
    IF statut_cible <> 'published' OR statut NOT IN ('awaiting_author', 'in_review', 'jury', 'under_debate', 'no_decision', 'published') THEN
        RAISE EXCEPTION 'argos:action_impossible';
    END IF;
    -- La fiche visée est elle-même une version : on remonte à sa fiche d'origine, sans jamais boucler.
    IF parent IS NOT NULL AND parent <> p_video AND EXISTS (SELECT 1 FROM core.videos WHERE id = parent AND status = 'published') THEN
        cible := parent;
    ELSIF parent = p_video THEN
        RAISE EXCEPTION 'argos:action_impossible';
    END IF;

    UPDATE core.videos SET duplicate_of = cible WHERE id = p_video;
    UPDATE core.videos SET duplicate_of = cible WHERE duplicate_of = p_video;   -- ses versions suivent
    UPDATE core.video_matches SET dismissed_at = now() WHERE id = p_match;
    PERFORM ledger.append('admin_action', jsonb_build_object('action', 'attach_version', 'video', p_video,
                                                             'version_of', cible, 'reason', btrim(p_reason)));
    RETURN cible;
END $$;

CREATE OR REPLACE FUNCTION core.settle_duplicate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    p jsonb;
    total numeric;
    cible uuid;
    poids numeric;
BEGIN
    IF NEW.duplicate_of IS NOT NULL THEN RETURN NEW; END IF;   -- déjà rattachée par l'administration
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

REVOKE ALL ON FUNCTION core.admin_attach_version(uuid, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_attach_version(uuid, uuid, uuid, text) TO argos_app;
