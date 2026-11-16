-- Nouveau motif de signalement (15 novembre 2026, demande de l’administrateur, lié à la description obligatoire) :
-- « Le texte identifie quelqu'un (nom, adresse…) ». Grave, comme une personne reconnaissable sur l'image.
ALTER TABLE core.reports DROP CONSTRAINT reports_reason_code_check;
ALTER TABLE core.reports ADD CONSTRAINT reports_reason_code_check
    CHECK (reason_code IN ('visible_identity', 'identifying_text', 'illegal_content', 'defamation', 'wrong_context', 'other'));

CREATE OR REPLACE FUNCTION core.report_video(p_account uuid, p_video uuid, p_reason text, p_details text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
    v_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_account AND status = 'active') THEN
        RAISE EXCEPTION 'argos:compte_inactif';
    END IF;
    IF p_reason NOT IN ('visible_identity', 'identifying_text', 'illegal_content', 'defamation', 'wrong_context', 'other') THEN
        RAISE EXCEPTION 'argos:motif_inconnu';
    END IF;
    IF length(btrim(coalesce(p_details, ''))) > 2000 OR (p_reason = 'other' AND length(btrim(coalesce(p_details, ''))) < 10) THEN
        RAISE EXCEPTION 'argos:details';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.videos WHERE id = p_video AND status IN ('published', 'under_debate') AND NOT is_control) THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    IF EXISTS (SELECT 1 FROM core.reports WHERE video_id = p_video AND reporter_id = p_account AND status = 'open') THEN
        RAISE EXCEPTION 'argos:deja_signale';
    END IF;
    IF (SELECT count(*) FROM core.reports WHERE reporter_id = p_account AND created_at > now() - interval '24 hours') >= 10 THEN
        RAISE EXCEPTION 'argos:trop_de_signalements';
    END IF;
    INSERT INTO core.reports (video_id, severity, reason_code, details, reporter_id)
    VALUES (p_video, CASE WHEN p_reason IN ('visible_identity', 'identifying_text', 'illegal_content') THEN 'serious' ELSE 'normal' END,
            p_reason, nullif(btrim(coalesce(p_details, '')), ''), p_account)
    RETURNING id INTO v_id;
    RETURN v_id;
END $function$;
