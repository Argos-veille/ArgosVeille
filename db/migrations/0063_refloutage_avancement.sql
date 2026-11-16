-- Re-floutage : avancement affiché sur la fiche d'administration (8 novembre 2026, demande de l’administrateur).
ALTER TABLE core.reblur_requests ADD COLUMN progress integer CHECK (progress BETWEEN 0 AND 100);

CREATE FUNCTION core.reblur_progress(p_id uuid, p_progress integer) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    UPDATE core.reblur_requests SET progress = least(100, greatest(0, p_progress)) WHERE id = p_id AND done_at IS NULL;
$$;
REVOKE ALL ON FUNCTION core.reblur_progress(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.reblur_progress(uuid, integer) TO argos_worker;

-- État : en préparation (version actuelle pas encore prête), en attente du worker, ou en cours (avec %).
CREATE OR REPLACE FUNCTION core.reblur_state(p_video uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT jsonb_build_object(
        'enCours', c.id IS NOT NULL,
        'etape', CASE WHEN c.id IS NULL THEN NULL WHEN c.source_ready_at IS NULL THEN 'preparation'
                      WHEN c.started_at IS NULL THEN 'attente' ELSE 'rendu' END,
        'avancement', c.progress,
        'derniere', (SELECT jsonb_build_object('le', coalesce(done_at, failed_at, created_at), 'echec', failed_at IS NOT NULL,
                                               'faite', done_at IS NOT NULL)
                       FROM core.reblur_requests WHERE video_id = p_video ORDER BY created_at DESC LIMIT 1))
      FROM (SELECT 1) x
      LEFT JOIN core.reblur_requests c ON c.video_id = p_video AND c.done_at IS NULL AND c.failed_at IS NULL;
$$;
