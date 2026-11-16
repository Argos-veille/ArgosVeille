-- Rattacher APRÈS COUP un envoi anonyme à son compte (8 novembre 2026, validé par l’administrateur) : la source, connectée,
-- prouve avec le code de 12 mots (empreinte du jeton de suivi) que la vidéo est la sienne. Le lien compte ↔ vidéo est
-- alors le même que pour un envoi avec compte, et DÉFINITIF (pas de détachement : il a pu être vu, il reste dans les
-- sauvegardes). La vidéo rejoint « Mes vidéos » : mails d'avancement, messages lisibles sans les 12 mots, retouche.

CREATE FUNCTION core.claim_video_with_code(p_account uuid, p_tracking_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_account AND status = 'active') THEN
        RAISE EXCEPTION 'argos:compte_inactif';
    END IF;
    SELECT p.video_id INTO v FROM core.pseudonyms p JOIN core.videos vi ON vi.id = p.video_id
     WHERE p.tracking_code_hash = p_tracking_hash AND vi.status NOT IN ('uploading', 'withdrawn', 'removed');
    IF v IS NULL THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    IF EXISTS (SELECT 1 FROM core.video_owners WHERE video_id = v) THEN
        RAISE EXCEPTION 'argos:deja_rattachee';
    END IF;
    INSERT INTO core.video_owners (video_id, account_id) VALUES (v, p_account);
    RETURN v;
END $$;
REVOKE ALL ON FUNCTION core.claim_video_with_code(uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.claim_video_with_code(uuid, bytea) TO argos_app;

-- Clé de messagerie d'une vidéo : son enveloppe pour le compte peut désormais être AJOUTÉE une fois (rattachement),
-- toujours jamais remplacée ; point public et partie privée restent immuables.
CREATE OR REPLACE FUNCTION core.guard_public_keys_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
    IF OLD.pseudonym_id IS NOT NULL AND (NEW.public_key <> OLD.public_key OR NEW.wrapped_private <> OLD.wrapped_private
       OR (NEW.owner_wrapped IS NOT NULL AND OLD.owner_wrapped IS NOT NULL AND NEW.owner_wrapped IS DISTINCT FROM OLD.owner_wrapped)) THEN
        RAISE EXCEPTION 'argos:modification_interdite';
    END IF;
    IF NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.pseudonym_id IS DISTINCT FROM OLD.pseudonym_id THEN
        RAISE EXCEPTION 'argos:modification_interdite';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END
$$;
