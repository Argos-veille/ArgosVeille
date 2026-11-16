-- Correction de la description par l'administration (15 novembre 2026, demande de l’administrateur) : un détail qui identifie
-- quelqu'un (nom, adresse…) ne force plus à refuser ou retirer toute la vidéo. L'administration seule (super-admin,
-- rôle argos_administration) peut corriger la description ou masquer un passage (« [retiré] »).
--   - le texte de la source est mis de côté pour toujours (declared_description, posé à la première correction) ;
--   - chaque correction garde le texte d'avant, avec une justification obligatoire ;
--   - inscrite au journal public (action de l'administration, donc différée comme les autres depuis 0091) ;
--   - annulable, la dernière d'abord, comme les corrections du contexte.
-- La fiche publique et les données ouvertes lisent videos.description : elles montrent la version corrigée.

ALTER TABLE core.videos ADD COLUMN declared_description text;

CREATE TABLE core.description_corrections (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id             uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    created_at           timestamptz NOT NULL DEFAULT now(),
    description          text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 5000),
    previous_description text,
    justification        text NOT NULL CHECK (char_length(justification) BETWEEN 10 AND 2000),
    cancelled_at         timestamptz,
    cancel_reason        text
);
CREATE INDEX description_corrections_video ON core.description_corrections (video_id, created_at);
REVOKE ALL ON core.description_corrections FROM PUBLIC;

CREATE FUNCTION core.admin_correct_description(p_admin uuid, p_video uuid, p_description text, p_justification text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v       record;
    v_id    uuid;
    texte   text := btrim(coalesce(p_description, ''));
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_admin AND is_superadmin AND status = 'active') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    IF length(btrim(coalesce(p_justification, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:justification';
    END IF;
    IF char_length(texte) NOT BETWEEN 1 AND 5000
       OR texte ~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' THEN
        RAISE EXCEPTION 'argos:description_invalide';
    END IF;
    SELECT id, description, declared_description INTO v FROM core.videos
     WHERE id = p_video AND status NOT IN ('uploading', 'withdrawn', 'removed') AND NOT is_control FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    IF texte = coalesce(v.description, '') THEN
        RAISE EXCEPTION 'argos:deja_ainsi';
    END IF;
    INSERT INTO core.description_corrections (video_id, description, previous_description, justification)
    VALUES (p_video, texte, v.description, btrim(p_justification)) RETURNING id INTO v_id;
    UPDATE core.videos SET declared_description = coalesce(declared_description, description),
                           description = texte, description_mt = NULL   -- la traduction automatique ne vaut plus
     WHERE id = p_video;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', 'description_corrected', 'video', p_video, 'correction', v_id, 'reason', btrim(p_justification)));
    RETURN v_id;
END $$;

CREATE FUNCTION core.admin_cancel_description_correction(p_admin uuid, p_correction uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    c record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_admin AND is_superadmin AND status = 'active') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:motif';
    END IF;
    SELECT * INTO c FROM core.description_corrections WHERE id = p_correction AND cancelled_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:correction_introuvable';
    END IF;
    IF EXISTS (SELECT 1 FROM core.description_corrections WHERE video_id = c.video_id AND cancelled_at IS NULL
                                                             AND created_at > c.created_at) THEN
        RAISE EXCEPTION 'argos:correction_pas_la_derniere';
    END IF;
    UPDATE core.description_corrections SET cancelled_at = now(), cancel_reason = btrim(p_reason) WHERE id = p_correction;
    UPDATE core.videos SET description = c.previous_description, description_mt = NULL WHERE id = c.video_id;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', 'cancel_description_correction', 'video', c.video_id, 'correction', p_correction, 'reason', btrim(p_reason)));
END $$;

-- Retrait par la source : la description est effacée (0020) ; son texte d'origine et l'historique des corrections aussi.
CREATE FUNCTION core.forget_description_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    NEW.declared_description := NULL;
    DELETE FROM core.description_corrections WHERE video_id = NEW.id;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.forget_description_history() FROM PUBLIC;
CREATE TRIGGER videos_forget_description_history BEFORE UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (NEW.status = 'withdrawn' AND OLD.status IS DISTINCT FROM 'withdrawn')
    EXECUTE FUNCTION core.forget_description_history();

-- Historique pour la fiche admin : texte de la source, puis chaque correction.
CREATE FUNCTION core.admin_description_history(p_admin uuid, p_video uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_admin AND is_superadmin AND status = 'active') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    RETURN jsonb_build_object(
        'source', (SELECT coalesce(declared_description, description) FROM core.videos WHERE id = p_video),
        'corrections', coalesce((SELECT jsonb_agg(jsonb_build_object(
                'id', c.id, 'le', c.created_at, 'texte', c.description, 'avant', c.previous_description,
                'justification', c.justification, 'annuleeLe', c.cancelled_at, 'motifAnnulation', c.cancel_reason)
                ORDER BY c.created_at DESC) FROM core.description_corrections c WHERE c.video_id = p_video), '[]'));
END $$;

REVOKE ALL ON FUNCTION core.admin_correct_description(uuid, uuid, text, text),
                       core.admin_cancel_description_correction(uuid, uuid, text),
                       core.admin_description_history(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_correct_description(uuid, uuid, text, text),
                          core.admin_cancel_description_correction(uuid, uuid, text),
                          core.admin_description_history(uuid, uuid) TO argos_administration;
