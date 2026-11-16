-- Administration, phase A2-2 (5 novembre 2026) : signalements par les comptes, et masquage, retrait
-- pour motif légal et gel légal par le super-administrateur.
--
-- Décisions de l’administrateur (5 novembre 2026) :
--   - signaler se fait depuis un compte (pas de signalement anonyme sur le site) ;
--   - le retrait légal efface la version floutée et garde l'original chiffré (illisible pour nous,
--     il peut servir de preuve à la source) — question 25 pour l'avocat ;
--   - la personne qui a signalé est prévenue de la suite (mail envoyé par le site).

ALTER TABLE core.reports
    ADD COLUMN reporter_id  uuid REFERENCES core.accounts (id) ON DELETE SET NULL,
    ADD COLUMN handled_note text;
-- Un seul signalement ouvert par compte et par vidéo.
CREATE UNIQUE INDEX reports_un_ouvert ON core.reports (video_id, reporter_id) WHERE status = 'open' AND reporter_id IS NOT NULL;
CREATE INDEX reports_par_compte ON core.reports (reporter_id, created_at) WHERE reporter_id IS NOT NULL;

-- Statut d'avant le masquage, pour le rétablir.
ALTER TABLE core.videos ADD COLUMN hidden_from text
    CHECK (hidden_from IS NULL OR hidden_from IN ('published', 'under_debate'));

CREATE FUNCTION core.report_video(p_account uuid, p_video uuid, p_reason text, p_details text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_account AND status = 'active') THEN
        RAISE EXCEPTION 'argos:compte_inactif';
    END IF;
    IF p_reason NOT IN ('visible_identity', 'illegal_content', 'defamation', 'wrong_context', 'other') THEN
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
    VALUES (p_video, CASE WHEN p_reason IN ('visible_identity', 'illegal_content') THEN 'serious' ELSE 'normal' END,
            p_reason, nullif(btrim(coalesce(p_details, '')), ''), p_account)
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;

CREATE FUNCTION core.admin_reports(p_admin uuid, p_status text)
RETURNS TABLE (id uuid, video_id uuid, pseudonym text, video_status text, severity text, reason_code text, details text,
               created_at timestamptz, status text, handled_at timestamptz, handled_note text, from_account boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY
        SELECT r.id, r.video_id, p.pseudonym, v.status, r.severity, r.reason_code, r.details, r.created_at, r.status,
               r.handled_at, r.handled_note, r.reporter_id IS NOT NULL
          FROM core.reports r JOIN core.videos v ON v.id = r.video_id LEFT JOIN core.pseudonyms p ON p.video_id = r.video_id
         WHERE r.status = p_status
         ORDER BY (r.severity = 'serious') DESC, r.created_at
         LIMIT 300;
END $$;

-- Classe un signalement ; renvoie le compte qui l'a fait (à prévenir), s'il existe encore.
CREATE FUNCTION core.admin_handle_report(p_admin uuid, p_id uuid, p_status text, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_reporter uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF p_status NOT IN ('handled', 'dismissed') THEN
        RAISE EXCEPTION 'argos:statut_inconnu';
    END IF;
    IF length(btrim(coalesce(p_note, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:motif';
    END IF;
    UPDATE core.reports SET status = p_status, handled_by = p_admin, handled_at = now(), handled_note = btrim(p_note)
     WHERE id = p_id AND status = 'open'
    RETURNING reporter_id INTO v_reporter;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    RETURN v_reporter;
END $$;

-- Masquer, rétablir, retirer pour motif légal, poser ou lever le gel légal. Motif obligatoire et public.
-- Renvoie 'effacer_floutee' quand le site doit effacer les fichiers de la version floutée.
CREATE FUNCTION core.admin_moderate(p_admin uuid, p_video uuid, p_action text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v record;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF p_action NOT IN ('hide', 'unhide', 'remove', 'hold', 'release') THEN
        RAISE EXCEPTION 'argos:action_inconnue';
    END IF;
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:motif';
    END IF;
    SELECT id, status, legal_hold, hidden_from, is_control INTO v FROM core.videos WHERE id = p_video FOR UPDATE;
    IF NOT FOUND OR v.is_control THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;

    IF p_action = 'hide' THEN
        IF v.status NOT IN ('published', 'under_debate') THEN RAISE EXCEPTION 'argos:action_impossible'; END IF;
        UPDATE core.videos SET status = 'hidden', hidden_from = v.status WHERE id = p_video;
    ELSIF p_action = 'unhide' THEN
        IF v.status <> 'hidden' OR v.hidden_from IS NULL THEN RAISE EXCEPTION 'argos:action_impossible'; END IF;
        UPDATE core.videos SET status = v.hidden_from, hidden_from = NULL WHERE id = p_video;
    ELSIF p_action = 'remove' THEN
        IF v.status IN ('uploading', 'removed', 'withdrawn') THEN RAISE EXCEPTION 'argos:action_impossible'; END IF;
        UPDATE core.videos SET status = 'removed', hidden_from = NULL, decided_at = now(), decided_by_stage = 'legal',
                               r2_blurred_key = NULL
         WHERE id = p_video;
        UPDATE core.summons SET outcome = 'cancelled' WHERE video_id = p_video AND outcome = 'pending';
    ELSIF p_action = 'hold' THEN
        IF v.legal_hold THEN RAISE EXCEPTION 'argos:deja_ainsi'; END IF;
        UPDATE core.videos SET legal_hold = true WHERE id = p_video;
    ELSE
        IF NOT v.legal_hold THEN RAISE EXCEPTION 'argos:deja_ainsi'; END IF;
        UPDATE core.videos SET legal_hold = false WHERE id = p_video;
    END IF;

    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', CASE p_action WHEN 'hide' THEN 'hide_video' WHEN 'unhide' THEN 'unhide_video' WHEN 'remove' THEN 'remove_video'
                                WHEN 'hold' THEN 'legal_hold' ELSE 'legal_hold_lifted' END,
        'video', p_video, 'from', v.status, 'reason', btrim(p_reason)));
    RETURN CASE WHEN p_action = 'remove' THEN 'effacer_floutee' ELSE 'ok' END;
END $$;

REVOKE ALL ON FUNCTION core.report_video(uuid, uuid, text, text), core.admin_reports(uuid, text),
                       core.admin_handle_report(uuid, uuid, text, text), core.admin_moderate(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.report_video(uuid, uuid, text, text), core.admin_reports(uuid, text),
                          core.admin_handle_report(uuid, uuid, text, text), core.admin_moderate(uuid, uuid, text, text) TO argos_app;
