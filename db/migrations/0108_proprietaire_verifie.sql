-- Point bas de la revue (15 novembre 2026) : quatre fonctions croyaient l'identifiant de vidéo donné par le site.
-- La base vérifie maintenant le lien avec la vidéo visée :
--   code gardé et clé de copie → le compte doit être propriétaire de la vidéo ;
--   accord de transmission (donné ou retiré) → l'empreinte du code de suivi doit être celle de la vidéo.
-- Une erreur de programmation qui viserait une autre vidéo est ainsi refusée par la base.

DROP FUNCTION core.set_owner_code(uuid, jsonb);
DROP FUNCTION core.set_owner_copy_key(uuid, bytea);
DROP FUNCTION core.grant_release(uuid, jsonb);
DROP FUNCTION core.revoke_release(uuid);

CREATE FUNCTION core.set_owner_code(p_video uuid, p_account uuid, p_sealed jsonb) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH m AS (UPDATE core.video_owners SET code_sealed = p_sealed
                WHERE video_id = p_video AND account_id = p_account RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM m)
$$;

CREATE FUNCTION core.set_owner_copy_key(p_video uuid, p_account uuid, p_key_enc bytea) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH m AS (UPDATE core.video_owners SET copy_key_enc = p_key_enc
                WHERE video_id = p_video AND account_id = p_account RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM m)
$$;

-- Vrai si l'empreinte est celle du code de suivi de la vidéo.
CREATE FUNCTION core.tracking_matches(p_video uuid, p_tracking_hash bytea) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT p_tracking_hash IS NOT NULL AND EXISTS (
        SELECT 1 FROM core.pseudonyms WHERE video_id = p_video AND tracking_code_hash = p_tracking_hash)
$$;

CREATE FUNCTION core.grant_release(p_video uuid, p_tracking_hash bytea, p_envelope jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF p_envelope IS NULL OR p_envelope ->> 'v' <> '1' OR jsonb_typeof(p_envelope -> 'destinataires') <> 'array' THEN
        RAISE EXCEPTION 'argos:enveloppe_invalide';
    END IF;
    IF NOT core.tracking_matches(p_video, p_tracking_hash)
       OR NOT EXISTS (SELECT 1 FROM core.videos WHERE id = p_video
                       AND status NOT IN ('withdrawn', 'removed') AND NOT is_control) THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    INSERT INTO core.release_consents (video_id, envelope) VALUES (p_video, p_envelope)
    ON CONFLICT (video_id) DO UPDATE SET envelope = EXCLUDED.envelope, granted_at = now(), revoked_at = NULL;
END $$;

CREATE FUNCTION core.revoke_release(p_video uuid, p_tracking_hash bytea) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH m AS (UPDATE core.release_consents SET envelope = NULL, revoked_at = now()
                WHERE video_id = p_video AND envelope IS NOT NULL AND core.tracking_matches(p_video, p_tracking_hash)
                RETURNING 1)
    SELECT EXISTS (SELECT 1 FROM m)
$$;

REVOKE ALL ON FUNCTION core.set_owner_code(uuid, uuid, jsonb), core.set_owner_copy_key(uuid, uuid, bytea),
                       core.tracking_matches(uuid, bytea), core.grant_release(uuid, bytea, jsonb),
                       core.revoke_release(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.set_owner_code(uuid, uuid, jsonb), core.set_owner_copy_key(uuid, uuid, bytea),
                          core.grant_release(uuid, bytea, jsonb), core.revoke_release(uuid, bytea) TO argos_app;
