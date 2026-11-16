-- Envoi avec un compte (9 novembre 2026, choix de l’administrateur) : le code de 12 mots n'a plus à être noté. Il est gardé, chiffré dans
-- le navigateur pour la clé du compte (elle-même protégée par le mot de passe) : le serveur ne peut pas le lire.
ALTER TABLE core.video_owners ADD COLUMN code_sealed jsonb;

CREATE FUNCTION core.set_owner_code(p_video uuid, p_sealed jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    UPDATE core.video_owners SET code_sealed = p_sealed WHERE video_id = p_video;
$$;

CREATE FUNCTION core.owned_code(p_account uuid, p_video uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT o.code_sealed FROM core.video_owners o WHERE o.account_id = p_account AND o.video_id = p_video;
$$;

REVOKE ALL ON FUNCTION core.set_owner_code(uuid, jsonb), core.owned_code(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.set_owner_code(uuid, jsonb), core.owned_code(uuid, uuid) TO argos_app;

-- Au retrait de la vidéo, le code disparaît avec elle.
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
    RETURN NULL;
END;
$$;
