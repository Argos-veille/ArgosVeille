-- Renvoyer une vidéo (14 novembre 2026, demande de l’administrateur, super-administrateur seul, clé physique et motif) :
--   « debate » : la mettre en débat (elle quitte la carte, reste visible dans « En débat ») ;
--   « review » : relancer sa relecture. Les convocations et votes précédents sont ARCHIVÉS (tours « review_past »,
--                « jury_past »), jamais effacés : ils ne comptent plus, et de nouveaux relecteurs sont tirés au sort.
-- Inscrit au journal comme les autres décisions de l'administration (en différé, 0091/0096).

ALTER TABLE core.summons DROP CONSTRAINT summons_round_check;
ALTER TABLE core.summons ADD CONSTRAINT summons_round_check
    CHECK (round IN ('review', 'jury', 'control', 'review_past', 'jury_past'));
ALTER TABLE core.votes DROP CONSTRAINT votes_round_check;
ALTER TABLE core.votes ADD CONSTRAINT votes_round_check
    CHECK (round IN ('review', 'jury', 'control', 'review_past', 'jury_past'));
-- Un vote de jury archivé garde ses règles (pas de motif obligatoire).
ALTER TABLE core.votes DROP CONSTRAINT votes_reasons_match;
ALTER TABLE core.votes ADD CONSTRAINT votes_reasons_match CHECK (
    cardinality(reasons) BETWEEN (CASE WHEN round IN ('jury', 'jury_past') THEN 0 ELSE 1 END) AND 9
    AND CASE verdict
        WHEN 'valid' THEN reasons <@ ARRAY['intervention_visible', 'context_consistent', 'authentic', 'category_matches']
        WHEN 'invalid' THEN reasons <@ ARRAY['wrong_category', 'old_or_reused', 'misleading_edit', 'nothing_visible',
                                             'context_inconsistent']
        ELSE reasons <@ ARRAY['intervention_visible', 'context_consistent', 'authentic', 'category_matches',
                              'wrong_category', 'old_or_reused', 'misleading_edit', 'nothing_visible', 'context_inconsistent']
    END) NOT VALID;
-- Un même relecteur peut être tiré de nouveau après une relance : l'unicité ne vaut que pour les tours en cours.
DROP INDEX core.summons_once;
CREATE UNIQUE INDEX summons_once ON core.summons (video_id, account_id, round)
    WHERE account_id IS NOT NULL AND round IN ('review', 'jury', 'control');

CREATE OR REPLACE FUNCTION core.admin_decide(p_admin uuid, p_video uuid, p_decision text, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v      record;
    statut text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.accounts WHERE id = p_admin AND is_superadmin AND status = 'active') THEN
        RAISE EXCEPTION 'argos:reserve_super_admin';
    END IF;
    IF p_decision NOT IN ('publish', 'reject', 'debate', 'review') THEN
        RAISE EXCEPTION 'argos:decision_inconnue';
    END IF;
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:motif';
    END IF;
    SELECT id, status, is_control INTO v FROM core.videos WHERE id = p_video FOR UPDATE;
    IF NOT FOUND OR v.is_control
       OR v.status NOT IN ('in_review', 'jury', 'published', 'rejected', 'under_debate', 'no_decision', 'awaiting_osint')
       -- Relancer la relecture : seulement une vidéo déjà tranchée.
       OR (p_decision = 'review' AND v.status NOT IN ('published', 'rejected', 'under_debate', 'no_decision')) THEN
        RAISE EXCEPTION 'argos:video_hors_decision';
    END IF;
    statut := CASE p_decision WHEN 'publish' THEN 'published' WHEN 'reject' THEN 'rejected'
                              WHEN 'debate' THEN 'under_debate' ELSE 'in_review' END;
    IF v.status = statut THEN
        RAISE EXCEPTION 'argos:deja_ainsi';
    END IF;

    UPDATE core.summons SET outcome = 'cancelled' WHERE video_id = p_video AND outcome = 'pending';
    IF p_decision = 'review' THEN
        UPDATE core.summons SET round = round || '_past' WHERE video_id = p_video AND round IN ('review', 'jury');
        UPDATE core.votes SET round = round || '_past' WHERE video_id = p_video AND round IN ('review', 'jury');
        UPDATE core.videos SET status = 'in_review', decided_at = NULL, decided_by_stage = NULL, extra_seats = 0,
                               first_round_ratio = NULL
         WHERE id = p_video;
    ELSE
        UPDATE core.videos SET status = statut, decided_at = now(), decided_by_stage = 'admin' WHERE id = p_video;
    END IF;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', CASE p_decision WHEN 'review' THEN 'review_restarted' ELSE 'decision' END,
        'video', p_video, 'from', v.status, 'to', statut, 'reason', btrim(p_reason)));
    RETURN (SELECT status FROM core.videos WHERE id = p_video);
END
$$;
