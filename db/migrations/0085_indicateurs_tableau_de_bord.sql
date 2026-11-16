-- Tableau de bord : indicateurs de relecture et d'envoi (13 novembre 2026, demande de l’administrateur).
-- Les envois par lien ne sont pas comptés à part : le lien est effacé dès la récupération (0078).

CREATE FUNCTION core.admin_dashboard_indicators(p_admin uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    p jsonb;
    relecture jsonb;
    envois jsonb;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    SELECT params INTO p FROM core.settings ORDER BY version DESC LIMIT 1;

    WITH anciens AS (   -- même vivier que core.jury_pool, sans les filtres propres à une vidéo
        SELECT a.id FROM core.accounts a
         WHERE a.status = 'active' AND NOT a.suspect AND NOT a.review_opt_out
           AND a.created_at <= now() - ((p ->> 'jury_min_age_days')::numeric * interval '1 day')
           AND EXISTS (SELECT 1 FROM core.mfa_factors f WHERE f.account_id = a.id AND f.revoked_at IS NULL)
    ), conv AS (
        SELECT outcome FROM core.summons WHERE round = 'review' AND sent_at > now() - interval '30 days'
    ), decidees AS (
        SELECT status, decided_at - review_started_at AS duree FROM core.videos
         WHERE NOT is_control AND decided_at > now() - interval '30 days' AND review_started_at IS NOT NULL
           AND status IN ('published', 'rejected', 'under_debate', 'no_decision')
    ), doyenne AS (
        SELECT min(review_started_at) AS depuis FROM core.videos WHERE status = 'in_review' AND NOT is_control
    )
    SELECT jsonb_build_object(
        'disponibles', (SELECT count(*) FROM core.accounts a
                         WHERE a.status = 'active' AND NOT a.review_opt_out
                           AND (SELECT count(*) FROM core.votes vo WHERE vo.account_id = a.id AND vo.cast_at > now() - interval '24 hours')
                               < (p ->> 'reviews_per_day')::int),
        'vivierJury', ceil((SELECT count(*) FROM anciens) * (p ->> 'jury_pool_share')::numeric)::int,
        'jurySize', (p ->> 'jury_size')::int,
        'convocations30j', jsonb_build_object(
            'votees', (SELECT count(*) FROM conv WHERE outcome = 'voted'),
            'passees', (SELECT count(*) FROM conv WHERE outcome = 'passed'),
            'expirees', (SELECT count(*) FROM conv WHERE outcome = 'expired'),
            'enAttente', (SELECT count(*) FROM conv WHERE outcome = 'pending')),
        'dureeMoyenneHeures', (SELECT round((extract(epoch FROM avg(duree)) / 3600)::numeric, 1) FROM decidees),
        'plusAncienne', (SELECT CASE WHEN depuis IS NULL THEN NULL ELSE jsonb_build_object(
                             'depuis', depuis,
                             'fin', depuis + ((p ->> 'max_review_days')::numeric * interval '1 day')) END FROM doyenne),
        'decisions30j', jsonb_build_object(
            'publiees', (SELECT count(*) FROM decidees WHERE status = 'published'),
            'rejetees', (SELECT count(*) FROM decidees WHERE status = 'rejected'),
            'enDebat', (SELECT count(*) FROM decidees WHERE status = 'under_debate'),
            'sansDecision', (SELECT count(*) FROM decidees WHERE status = 'no_decision'))
    ) INTO relecture;

    WITH recues AS (
        SELECT v.id, v.status, v.submitted_at, v.awaiting_since,
               EXISTS (SELECT 1 FROM core.video_owners o WHERE o.video_id = v.id) AS avec_compte
          FROM core.videos v
         WHERE NOT v.is_control AND v.status <> 'uploading' AND v.submitted_at > now() - interval '7 days'
    )
    SELECT jsonb_build_object(
        'recues24h', (SELECT count(*) FROM recues WHERE submitted_at > now() - interval '24 hours'),
        'recues7j', (SELECT count(*) FROM recues),
        'avecCompte7j', (SELECT count(*) FROM recues WHERE avec_compte),
        'echecs7j', (SELECT count(*) FROM recues WHERE status = 'failed'),
        'traitementMoyenMinutes', (SELECT round((extract(epoch FROM avg(awaiting_since - submitted_at)) / 60)::numeric, 1)
                                     FROM recues WHERE awaiting_since IS NOT NULL),
        'doublons7j', (SELECT count(*) FROM core.video_matches WHERE detected_at > now() - interval '7 days')
    ) INTO envois;

    RETURN jsonb_build_object('relecture', relecture, 'envois', envois);
END $$;
REVOKE ALL ON FUNCTION core.admin_dashboard_indicators(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_dashboard_indicators(uuid) TO argos_app;
