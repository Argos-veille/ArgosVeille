-- Versions sur la fiche (9 novembre 2026, phase D5) : un doublon confirmé et publié ne crée ni nouvelle fiche
-- ni nouveau point sur la carte ; il apparaît dans « Autres versions » de la fiche d'origine. Inscrit au journal,
-- annulable par le super-administrateur (clé + motif).
GRANT SELECT (duplicate_of) ON core.videos TO argos_app;

-- Une fiche désignée qui est elle-même une version renvoie vers sa fiche d'origine.
CREATE OR REPLACE FUNCTION core.resolve_published(p_reference text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT coalesce(m.id, v.id) FROM core.videos v
      LEFT JOIN core.pseudonyms p ON p.video_id = v.id
      LEFT JOIN core.videos m ON m.id = v.duplicate_of AND m.status = 'published'
     WHERE v.status = 'published' AND NOT v.is_control
       AND (v.id::text = lower(substring(p_reference FROM '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'))
            OR lower(p.pseudonym) = lower(btrim(p_reference)))
     LIMIT 1;
$$;

CREATE FUNCTION core.ledger_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM ledger.append('event_link', jsonb_build_object('video', NEW.id, 'version_of', NEW.duplicate_of));
    RETURN NULL;
END $$;
CREATE TRIGGER videos_ledger_version AFTER UPDATE OF status ON core.videos
    FOR EACH ROW WHEN (NEW.status = 'published' AND NEW.duplicate_of IS NOT NULL AND OLD.status IS DISTINCT FROM 'published')
    EXECUTE FUNCTION core.ledger_version();

CREATE FUNCTION core.public_versions(p_video uuid) RETURNS TABLE (id uuid, pseudonym text, decided_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT v.id, p.pseudonym, v.decided_at FROM core.videos v LEFT JOIN core.pseudonyms p ON p.video_id = v.id
     WHERE v.duplicate_of = p_video AND v.status = 'published' AND NOT v.is_control
     ORDER BY v.decided_at;
$$;

CREATE FUNCTION core.admin_detach_version(p_admin uuid, p_video uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    fiche uuid;
BEGIN
    PERFORM core.require_superadmin(p_admin);
    IF char_length(btrim(p_reason)) NOT BETWEEN 10 AND 2000 THEN RAISE EXCEPTION 'argos:motif'; END IF;
    SELECT duplicate_of INTO fiche FROM core.videos WHERE id = p_video FOR UPDATE;
    IF fiche IS NULL THEN RAISE EXCEPTION 'argos:introuvable'; END IF;
    UPDATE core.videos SET duplicate_of = NULL WHERE id = p_video;
    PERFORM ledger.append('admin_action', jsonb_build_object('action', 'detach_version', 'video', p_video,
                                                             'version_of', fiche, 'reason', btrim(p_reason)));
END $$;

REVOKE ALL ON FUNCTION core.ledger_version(), core.public_versions(uuid), core.admin_detach_version(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.public_versions(uuid), core.admin_detach_version(uuid, uuid, text) TO argos_app;
