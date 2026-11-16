-- Vérification de la vidéo floutée par sa source (étape 6c, 4 novembre 2026).
--
-- awaiting_since : début de l'attente de vérification, posé par la base dès que la vidéo passe à
-- « awaiting_author » ; au bout de 7 jours sans validation, la vidéo part en relecture d'elle-même.
-- retouches : nombre de nouveaux rendus demandés par la source (10 au plus).

ALTER TABLE core.videos
    ADD COLUMN awaiting_since timestamptz,
    ADD COLUMN retouches      smallint NOT NULL DEFAULT 0 CHECK (retouches BETWEEN 0 AND 10);

CREATE FUNCTION core.mark_awaiting_since() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'awaiting_author' AND OLD.status IS DISTINCT FROM 'awaiting_author' THEN
        NEW.awaiting_since := now();
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER videos_mark_awaiting_since BEFORE UPDATE OF status ON core.videos
    FOR EACH ROW EXECUTE FUNCTION core.mark_awaiting_since();
REVOKE ALL ON FUNCTION core.mark_awaiting_since() FROM PUBLIC;

CREATE INDEX videos_awaiting ON core.videos (awaiting_since) WHERE status = 'awaiting_author';

GRANT SELECT (awaiting_since, retouches) ON core.videos TO argos_app;
GRANT UPDATE (retouches) ON core.videos TO argos_app;
