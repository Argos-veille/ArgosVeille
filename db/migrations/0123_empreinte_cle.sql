-- Audit du 15 novembre 2026, H10 : l'empreinte de l'original n'est plus le SHA-256 du fichier en clair (une base saisie et
-- un téléphone saisi suffisaient à prouver que CE fichier avait été envoyé) mais une empreinte CLÉE par la clé de
-- l'original (navigateur/src/empreinte.ts) : seuls la source et les destinataires d'une enveloppe peuvent la recalculer.
--   original_hash_scheme : 0 = SHA-256 simple (vidéos d'avant, laissées telles quelles : décision de l’administrateur, limite
--   connue), 1 = empreinte clée (tout nouvel envoi, fichier ou lien).
-- Doublons : la comparaison « même original » (fingerprints_same_original) ne trouve plus rien entre deux envois du même
-- fichier (chaque envoi a sa clé) ; elle ne se trompe pas pour autant. La ressemblance image et son reste.
ALTER TABLE core.videos ADD COLUMN original_hash_scheme smallint NOT NULL DEFAULT 0 CHECK (original_hash_scheme IN (0, 1));

-- Envoi par lien : une NOUVELLE version de finish_fetch (5 arguments) pose le schéma 1 ; celle à 4 arguments reste
-- inchangée (schéma 0). Ainsi, pendant un redéploiement (migrations avant le redémarrage des services), l'ancien worker
-- ne peut pas étiqueter « clée » une empreinte encore calculée en SHA-256 simple (relecture croisée).
CREATE FUNCTION core.finish_fetch(p_video uuid, p_sha256 bytea, p_enc_sha256 bytea, p_key text, p_schema smallint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    n integer;
BEGIN
    IF p_schema IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION 'argos:schema_empreinte';
    END IF;
    UPDATE core.videos SET original_sha256 = p_sha256, original_hash_scheme = 1, original_enc_sha256 = p_enc_sha256, r2_original_enc_key = p_key
     WHERE id = p_video AND status = 'processing';
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM core.video_fetches WHERE video_id = p_video;
    RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION core.finish_fetch(uuid, bytea, bytea, text, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.finish_fetch(uuid, bytea, bytea, text, smallint) TO argos_worker;

-- Le site écrit le schéma à l'envoi (droits colonne par colonne sur core.videos), jamais ensuite.
GRANT INSERT (original_hash_scheme) ON core.videos TO argos_app;
