-- Administration, phase A2-1 (5 novembre 2026) : liste et fiche d'administration des vidéos.
--
-- Le site lit déjà le contexte des vidéos ; ces fonctions ajoutent, pour le super-administrateur
-- seulement, ce qu'il ne lit pas : l'avancement des votes (des totaux, jamais qui a voté quoi), les
-- signalements et l'historique de la vidéo au journal.

CREATE FUNCTION core.admin_videos(p_admin uuid, p_status text)
RETURNS TABLE (id uuid, status text, submitted_at timestamptz, decided_at timestamptz, category text, subcategory text,
               occurred_at timestamptz, description text, pseudonym text, open_reports integer, legal_hold boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM core.require_superadmin(p_admin);
    RETURN QUERY
        SELECT v.id, v.status, v.submitted_at, v.decided_at, v.category, v.subcategory, v.occurred_at,
               left(v.description, 200), p.pseudonym,
               (SELECT count(*)::int FROM core.reports r WHERE r.video_id = v.id AND r.status = 'open'),
               v.legal_hold
          FROM core.videos v LEFT JOIN core.pseudonyms p ON p.video_id = v.id
         WHERE NOT v.is_control AND v.status <> 'uploading' AND (p_status IS NULL OR v.status = p_status)
         ORDER BY coalesce(v.decided_at, v.submitted_at) DESC
         LIMIT 300;
END $$;

CREATE FUNCTION core.admin_video(p_admin uuid, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    r jsonb;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    SELECT jsonb_build_object(
        'statut', v.status, 'envoyeeLe', v.submitted_at, 'relectureDepuis', v.review_started_at, 'juryDepuis', v.jury_since,
        'decideeLe', v.decided_at, 'decideePar', v.decided_by_stage, 'retireeLe', v.withdrawn_at, 'gelLegal', v.legal_hold,
        'elargissements', v.enlargements, 'premierTour', v.first_round_ratio, 'duree', v.duration_s,
        'echec', v.failure_reason, 'retouches', v.retouches,
        'votes', (SELECT coalesce(jsonb_object_agg(t.round, t.o), '{}'::jsonb) FROM (
                    SELECT vo.round, jsonb_build_object(
                        'nombre', count(*), 'oui', count(*) FILTER (WHERE vo.verdict = 'valid'),
                        'enPartie', count(*) FILTER (WHERE vo.verdict = 'partly'),
                        'non', count(*) FILTER (WHERE vo.verdict = 'invalid'),
                        'poids', round(sum(vo.weight), 2),
                        'partOui', round(sum(vo.weight) FILTER (WHERE vo.verdict = 'valid') / nullif(sum(vo.weight), 0), 4),
                        'visageSignale', count(*) FILTER (WHERE coalesce((vo.answers ->> 'face_identifiable')::boolean, false))) AS o
                      FROM core.votes vo WHERE vo.video_id = v.id GROUP BY vo.round) t),
        'convocations', (SELECT coalesce(jsonb_object_agg(t.round, t.o), '{}'::jsonb) FROM (
                    SELECT s.round, jsonb_build_object(
                        'envoyees', count(*), 'repondues', count(*) FILTER (WHERE s.answered_at IS NOT NULL),
                        'enAttente', count(*) FILTER (WHERE s.answered_at IS NULL AND s.outcome IS NULL AND s.expires_at > now()),
                        'expirees', count(*) FILTER (WHERE s.answered_at IS NULL AND (s.outcome IS NOT NULL OR s.expires_at <= now()))) AS o
                      FROM core.summons s WHERE s.video_id = v.id GROUP BY s.round) t),
        'signalements', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                            'id', rp.id, 'gravite', rp.severity, 'motif', rp.reason_code, 'details', rp.details,
                            'le', rp.created_at, 'statut', rp.status, 'traiteLe', rp.handled_at) ORDER BY rp.created_at DESC), '[]'::jsonb)
                           FROM core.reports rp WHERE rp.video_id = v.id),
        'notesMasquees', (SELECT count(*) FROM core.osint_notes n WHERE n.video_id = v.id AND n.masked_at IS NOT NULL),
        'journal', (SELECT coalesce(jsonb_agg(jsonb_build_object('numero', e.seq, 'type', e.kind, 'le', e.recorded_at,
                                                                   'contenu', e.payload) ORDER BY e.seq), '[]'::jsonb)
                      FROM ledger.entries e WHERE e.payload ->> 'video' = v.id::text)
    ) INTO r
      FROM core.videos v WHERE v.id = p_id AND NOT v.is_control;
    IF r IS NULL THEN
        RAISE EXCEPTION 'argos:introuvable';
    END IF;
    RETURN r;
END $$;

REVOKE ALL ON FUNCTION core.admin_videos(uuid, text), core.admin_video(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_videos(uuid, text), core.admin_video(uuid, uuid) TO argos_app;
