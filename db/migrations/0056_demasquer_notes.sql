-- Notes d'analystes masquées (8 novembre 2026, demande de l’administrateur) : l'administration peut les revoir (contenu et
-- motif du masquage, sur la fiche d'administration de la vidéo) et les démasquer, avec un motif et la clé physique.
-- Le démasquage est inscrit au journal public, comme le masquage.

CREATE FUNCTION core.admin_unmask_note(p_admin uuid, p_note uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 10 AND 2000 THEN
        RAISE EXCEPTION 'argos:motif';
    END IF;
    UPDATE core.osint_notes SET masked_at = NULL, mask_reason = NULL
     WHERE id = p_note AND masked_at IS NOT NULL AND withdrawn_at IS NULL
    RETURNING video_id INTO v;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:note_introuvable';
    END IF;
    PERFORM ledger.append('admin_action', jsonb_build_object(
        'action', 'unmask_note', 'note', p_note, 'video', v, 'reason', btrim(p_reason)));
END
$$;

REVOKE ALL ON FUNCTION core.admin_unmask_note(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.admin_unmask_note(uuid, uuid, text) TO argos_app;
