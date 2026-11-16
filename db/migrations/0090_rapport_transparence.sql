-- Rapport de transparence (14 novembre 2026, demande de l’administrateur) : comptes bruts d'un trimestre terminé.
-- Seulement des nombres, une dimension à la fois : ni lieu, ni forces, ni compte, ni heure, ni administrateur.
-- L'API masque ensuite les petits nombres (1 à 4 → « moins de 5 ») et ne sert que les trimestres terminés.
-- Les décisions, retraits, corrections, règles et transmissions viennent du journal public (recomptables par tous) ;
-- les envois, signalements et sanctions viennent de la base.
CREATE FUNCTION core.transparency_report(p_from date, p_to date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, public
AS $$
WITH bornes AS (
    SELECT (p_from::timestamp AT TIME ZONE 'Europe/Paris') AS debut, (p_to::timestamp AT TIME ZONE 'Europe/Paris') AS fin
), journal AS (
    SELECT e.kind, e.payload, e.recorded_at FROM ledger.entries e, bornes b WHERE e.recorded_at >= b.debut AND e.recorded_at < b.fin
), decisions AS (
    SELECT j.payload->>'status' AS statut, coalesce(j.payload->>'stage', 'legal') AS etape, j.recorded_at,
           (SELECT v.submitted_at FROM core.videos v WHERE v.id = (j.payload->>'video')::uuid) AS recue_le
      FROM journal j
     WHERE j.kind = 'decision' AND j.payload->>'status' IN ('published', 'rejected', 'under_debate', 'no_decision')
)
SELECT jsonb_build_object(
    'envois', jsonb_build_object(
        'recues', (SELECT count(*) FROM core.videos v, bornes b
                    WHERE v.submitted_at >= b.debut AND v.submitted_at < b.fin AND NOT v.is_control AND v.status <> 'uploading'),
        'echecs', (SELECT count(*) FROM core.videos v, bornes b
                    WHERE v.submitted_at >= b.debut AND v.submitted_at < b.fin AND NOT v.is_control AND v.status = 'failed'),
        'retireesParLaSource', (SELECT count(*) FROM journal WHERE kind = 'withdrawal')),
    'decisions', jsonb_build_object(
        'parResultat', coalesce((SELECT jsonb_object_agg(statut, n) FROM (SELECT statut, count(*) AS n FROM decisions GROUP BY 1) x), '{}'),
        'parQui', coalesce((SELECT jsonb_object_agg(qui, n) FROM (
                     SELECT CASE etape WHEN 'review' THEN 'communaute' WHEN 'jury' THEN 'jury' ELSE 'administration' END AS qui,
                            count(*) AS n FROM decisions GROUP BY 1) x), '{}'),
        'delaiMedianJours', (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM recorded_at - recue_le)) / 86400)
                               FROM decisions WHERE recue_le IS NOT NULL),
        'delaiNombre', (SELECT count(*) FROM decisions WHERE recue_le IS NOT NULL)),
    'signalements', jsonb_build_object(
        'parMotif', coalesce((SELECT jsonb_object_agg(reason_code, n) FROM (
                       SELECT r.reason_code, count(*) AS n FROM core.reports r, bornes b
                        WHERE r.created_at >= b.debut AND r.created_at < b.fin GROUP BY 1) x), '{}'),
        'parSuite', coalesce((SELECT jsonb_object_agg(status, n) FROM (
                       SELECT r.status, count(*) AS n FROM core.reports r, bornes b
                        WHERE r.created_at >= b.debut AND r.created_at < b.fin GROUP BY 1) x), '{}')),
    'retraits', coalesce((SELECT jsonb_object_agg(statut, n) FROM (
                    SELECT payload->>'status' AS statut, count(*) AS n FROM journal WHERE kind = 'removal' GROUP BY 1) x), '{}'),
    'corrections', (SELECT count(*) FROM journal WHERE kind = 'correction'),
    'changementsDeRegles', (SELECT count(*) FROM journal WHERE kind = 'rule_change'),
    'sanctions', coalesce((SELECT jsonb_object_agg(kind, n) FROM (
                    SELECT s.kind, count(*) AS n FROM core.sanctions s, bornes b
                     WHERE s.starts_at >= b.debut AND s.starts_at < b.fin AND s.kind IN ('suspend', 'ban') GROUP BY 1) x), '{}'),
    'originaux', jsonb_build_object(
        'parAdministration', coalesce((SELECT jsonb_object_agg(d, n) FROM (
                       SELECT payload->>'recipient' AS d, count(*) AS n FROM journal
                        WHERE kind = 'admin_action' AND payload->>'action' = 'original_released' GROUP BY 1) x), '{}'),
        'parLaSource', coalesce((SELECT jsonb_object_agg(d, n) FROM (
                       SELECT payload->>'recipient' AS d, count(*) AS n FROM journal WHERE kind = 'original_shared' GROUP BY 1) x), '{}'),
        'ouverturesParAdministration', (SELECT count(*) FROM journal
                                         WHERE kind = 'admin_action' AND payload->>'action' = 'original_downloaded')),
    'premiereEntree', (SELECT to_char(min(recorded_at) AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') FROM ledger.entries)
)
$$;

REVOKE ALL ON FUNCTION core.transparency_report(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.transparency_report(date, date) TO argos_app;
