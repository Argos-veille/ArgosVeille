-- Correction de la description, sans aucune copie (15 novembre 2026, décision de l’administrateur, remplace une partie de 0113) :
-- un passage retiré parce qu'il identifie quelqu'un ne doit rester nulle part dans la base (il serait récupérable en
-- cas de saisie). La correction remplace directement videos.description ; seuls restent la date, la vidéo et la
-- justification (aussi au journal public, sans le texte retiré). Plus d'annulation possible : il n'y a rien à rétablir.
-- Limite : les sauvegardes chiffrées gardent l'ancienne version jusqu'à leur expiration (6 mois au plus).

DROP FUNCTION core.admin_cancel_description_correction(uuid, uuid, text);
DROP FUNCTION core.admin_description_history(uuid, uuid);
DROP FUNCTION core.admin_correct_description(uuid, uuid, text, text);

ALTER TABLE core.description_corrections DROP COLUMN description, DROP COLUMN previous_description,
                                         DROP COLUMN cancelled_at, DROP COLUMN cancel_reason;
ALTER TABLE core.videos DROP COLUMN declared_description;

CREATE OR REPLACE FUNCTION core.forget_description_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    DELETE FROM core.description_corrections WHERE video_id = NEW.id;
    RETURN NEW;
END $$;

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
    IF char_length(texte) NOT BETWEEN 1 AND 5000 OR texte ~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' THEN
        RAISE EXCEPTION 'argos:description_invalide';
    END IF;
    SELECT id, description INTO v FROM core.videos
     WHERE id = p_video AND status NOT IN ('uploading', 'withdrawn', 'removed') AND NOT is_control FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    IF texte = coalesce(v.description, '') THEN
        RAISE EXCEPTION 'argos:deja_ainsi';
    END IF;
    INSERT INTO core.description_corrections (video_id, justification) VALUES (p_video, btrim(p_justification))
    RETURNING id INTO v_id;
    UPDATE core.videos SET description = texte, description_mt = NULL WHERE id = p_video;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', 'description_corrected', 'video', p_video, 'correction', v_id, 'reason', btrim(p_justification)));
    RETURN v_id;
END $$;

-- Corrections passées d'une vidéo (date et justification seulement), pour la fiche admin.
CREATE FUNCTION core.admin_description_corrections(p_admin uuid, p_video uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_admin AND is_superadmin AND status = 'active') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'le', c.created_at, 'justification', c.justification)
                                      ORDER BY c.created_at DESC)
                       FROM core.description_corrections c WHERE c.video_id = p_video), '[]');
END $$;

REVOKE ALL ON FUNCTION core.admin_correct_description(uuid, uuid, text, text),
                       core.admin_description_corrections(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_correct_description(uuid, uuid, text, text),
                          core.admin_description_corrections(uuid, uuid) TO argos_administration;
