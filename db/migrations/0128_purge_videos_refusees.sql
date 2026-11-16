-- Second audit (15 novembre 2026, T1 + E1), décision de l’administrateur : une vidéo refusée, ou restée sans décision, n'est pas
-- archivée. 30 jours après sa décision (marge pour que l'administration la remette en relecture si besoin : la source
-- n'a pas de recours), tout ce qui la décrit ou la relie à sa source est effacé, AU MOINS autant qu'au retrait par la
-- source (0104) : fichiers (par l'API), description, lieu, empreintes, doublons, événements, origine, lien de
-- récupération, lien compte ↔ vidéo, code de suivi, empreinte de l'original, conversations et clés de la vidéo,
-- notes et corrections d'analystes, détails des signalements. Restent la ligne (statut, jour d'envoi et de décision)
-- pour que les chiffres publiés ne bougent pas, et le journal public. Jamais sous gel légal ni pour une vidéo de contrôle.
ALTER TABLE core.videos ADD COLUMN purged_on date;   -- jour de l'effacement (heure de Paris)

-- Toutes les traces d'une vidéo qui la décrivent ou la relient à sa source (sauf sa ligne et le journal public).
CREATE FUNCTION core.erase_video_traces(v uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    UPDATE core.videos SET original_sha256 = NULL, original_enc_sha256 = NULL, blurred_sha256 = NULL, timestamp_token = NULL
     WHERE id = v;
    DELETE FROM core.description_corrections WHERE video_id = v;
    DELETE FROM core.replies WHERE video_id = v;
    DELETE FROM core.reblur_requests WHERE video_id = v;
    DELETE FROM core.admin_alerts WHERE video_id = v;
    DELETE FROM core.video_fingerprints WHERE video_id = v;            -- et leur index (fingerprint_keys, en cascade)
    DELETE FROM core.video_matches WHERE video_id = v OR other_video_id = v;
    DELETE FROM core.event_links WHERE video_id = v;
    DELETE FROM core.event_proposals WHERE video_id = v OR target_video_id = v;
    DELETE FROM core.control_videos WHERE video_id = v;
    DELETE FROM core.video_origins WHERE video_id = v;
    DELETE FROM core.video_fetches WHERE video_id = v;
    DELETE FROM core.video_owners WHERE video_id = v;                  -- lien compte ↔ vidéo
    DELETE FROM core.release_consents WHERE video_id = v;
    DELETE FROM core.owner_notifications WHERE video_id = v;
    DELETE FROM core.osint_notes WHERE video_id = v;                   -- versions et jugements en cascade
    DELETE FROM core.context_corrections WHERE video_id = v;
    UPDATE core.reports SET details = NULL WHERE video_id = v;
    -- Conversations (messages, partages en cascade) et clés de messagerie de la vidéo.
    DELETE FROM core.conversations WHERE pseudonym_id IN (SELECT id FROM core.pseudonyms WHERE video_id = v);
    DELETE FROM core.public_keys WHERE pseudonym_id IN (SELECT id FROM core.pseudonyms WHERE video_id = v);
    -- Les 12 mots ne désignent plus la vidéo.
    UPDATE core.pseudonyms SET tracking_code_hash = public.gen_random_bytes(32) WHERE video_id = v;
    UPDATE core.summons SET outcome = 'cancelled' WHERE video_id = v AND outcome = 'pending';
END $$;
REVOKE ALL ON FUNCTION core.erase_video_traces(uuid) FROM PUBLIC;

CREATE FUNCTION core.purge_unpublished_videos(p_days integer DEFAULT 30) RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v uuid;
BEGIN
    FOR v IN
        SELECT id FROM core.videos
         WHERE status IN ('rejected', 'no_decision') AND purged_on IS NULL AND NOT legal_hold AND NOT is_control
           AND decided_at < now() - make_interval(days => greatest(p_days, 30))
         ORDER BY decided_at
         LIMIT 100
           FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE core.videos
           SET description = NULL, description_mt = NULL, location = NULL, location_precision = NULL,
               declared_location = NULL, declared_location_precision = NULL,
               r2_original_enc_key = NULL, r2_blurred_key = NULL, r2_preview_key = NULL,
               purged_on = (now() AT TIME ZONE 'Europe/Paris')::date
         WHERE id = v;
        PERFORM core.erase_video_traces(v);
        RETURN NEXT v;
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION core.purge_unpublished_videos(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.purge_unpublished_videos(integer) TO argos_app;

-- Plus d'empreinte pour une vidéo effacée (le rattrapage ne la recalcule pas : plus de version floutée).
CREATE OR REPLACE FUNCTION core.save_fingerprints(p_video uuid, p_version smallint, p_origin text, p_visual bytea,
                                                  p_visual_mirror bytea, p_audio bytea, p_camera bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    s text;
    p date;
BEGIN
    SELECT status, purged_on INTO s, p FROM core.videos WHERE id = p_video FOR SHARE;
    IF s IS NULL OR s IN ('uploading', 'failed', 'withdrawn') OR p IS NOT NULL THEN RETURN false; END IF;
    INSERT INTO core.video_fingerprints (video_id, algo_version, origin, visual, visual_mirror, audio, camera)
    VALUES (p_video, p_version, p_origin, p_visual, p_visual_mirror, p_audio, p_camera)
    ON CONFLICT (video_id) DO NOTHING;
    RETURN true;
END;
$$;
