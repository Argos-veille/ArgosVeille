-- Retrait d'une vidéo par sa source (étape 5c, 4 novembre 2026).
--
-- Le retrait est irréversible : fichiers effacés (par l'application, d'après les emplacements que
-- renvoie core.withdraw_video), description et position effacées, conversations fermées,
-- convocations en attente annulées. Une trace minimale reste, et le retrait est inscrit au journal
-- public, pour que la disparition d'une vidéo ne passe pas pour une censure.

ALTER TABLE core.videos DROP CONSTRAINT videos_status_check;
ALTER TABLE core.videos ADD CONSTRAINT videos_status_check
    CHECK (status IN ('uploading', 'processing', 'awaiting_author', 'in_review', 'jury', 'published', 'rejected',
                      'under_debate', 'no_decision', 'hidden', 'removed', 'withdrawn'));

ALTER TABLE core.videos
    ADD COLUMN withdrawn_at timestamptz,
    -- Conservation légale (réquisition, demande de conservation) : bloque le retrait par la source.
    -- Posé par l'administration ; en attente de l'avis de l'avocat (question 20).
    ADD COLUMN legal_hold   boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT videos_withdrawn_at CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL));

GRANT SELECT (withdrawn_at) ON core.videos TO argos_app;
GRANT SELECT (legal_hold), UPDATE (legal_hold) ON core.videos TO argos_admin;

ALTER TABLE ledger.entries DROP CONSTRAINT entries_kind_check;
ALTER TABLE ledger.entries ADD CONSTRAINT entries_kind_check CHECK (kind IN (
    'video_received', 'decision', 'removal', 'rule_change', 'authority_request', 'admin_action', 'event_link',
    'withdrawal'));

-- Une convocation pour une vidéo retirée est annulée : elle ne compte ni pour ni contre le relecteur.
ALTER TABLE core.summons DROP CONSTRAINT summons_outcome_check;
ALTER TABLE core.summons ADD CONSTRAINT summons_outcome_check
    CHECK (outcome IN ('pending', 'voted', 'passed', 'expired', 'cancelled'));

-- Journal public : le retrait par la source y figure, comme les décisions et les retraits légaux.
CREATE OR REPLACE FUNCTION core.log_video_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, public
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT NEW.is_control THEN
        IF NEW.status IN ('published', 'rejected', 'under_debate', 'no_decision', 'hidden', 'removed') THEN
            PERFORM ledger.append(
                CASE WHEN NEW.status IN ('hidden', 'removed') THEN 'removal' ELSE 'decision' END,
                jsonb_build_object('video', NEW.id, 'status', NEW.status, 'from', OLD.status,
                                   'stage', NEW.decided_by_stage));
        ELSIF NEW.status = 'withdrawn' THEN
            PERFORM ledger.append('withdrawal', jsonb_build_object('video', NEW.id, 'from', OLD.status));
        END IF;
    END IF;
    RETURN NEW;
END
$$;

-- Retrait, en une transaction, de la vidéo désignée par l'empreinte de son jeton de suivi.
-- Renvoie le résultat et, en cas de succès, les emplacements des fichiers à effacer.
CREATE FUNCTION core.withdraw_video(p_tracking_hash bytea) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v record;
BEGIN
    SELECT vi.id, vi.status, vi.legal_hold, vi.r2_original_enc_key, vi.r2_blurred_key INTO v
      FROM core.pseudonyms p JOIN core.videos vi ON vi.id = p.video_id
     WHERE p.tracking_code_hash = p_tracking_hash
       FOR UPDATE OF vi;
    IF NOT FOUND THEN RETURN jsonb_build_object('resultat', 'introuvable'); END IF;
    IF v.status = 'withdrawn' THEN RETURN jsonb_build_object('resultat', 'deja_retiree'); END IF;
    IF v.status = 'uploading' THEN RETURN jsonb_build_object('resultat', 'envoi_en_cours', 'video', v.id); END IF;
    IF v.legal_hold THEN RETURN jsonb_build_object('resultat', 'bloque'); END IF;

    UPDATE core.videos
       SET status = 'withdrawn', withdrawn_at = now(),
           description = NULL, description_mt = NULL, location = NULL, location_precision = NULL,
           r2_original_enc_key = NULL, r2_blurred_key = NULL
     WHERE id = v.id;
    UPDATE core.conversations SET closed_at = now()
     WHERE pseudonym_id IN (SELECT id FROM core.pseudonyms WHERE video_id = v.id) AND closed_at IS NULL;
    UPDATE core.summons SET outcome = 'cancelled' WHERE video_id = v.id AND outcome = 'pending';
    RETURN jsonb_build_object('resultat', 'ok', 'video', v.id,
                              'original', v.r2_original_enc_key, 'floutee', v.r2_blurred_key);
END
$$;

REVOKE ALL ON FUNCTION core.withdraw_video(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.withdraw_video(bytea) TO argos_app;
