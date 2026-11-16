-- Jugement des notes d'analyse OSINT (étape 7d-2, 5 novembre 2026).
--
-- Après avoir voté sur une vidéo, le relecteur ou le juré peut juger chaque note : « cette note
-- est-elle pertinente ? oui / en partie / non », avec des raisons propres au oui et au non (« en
-- partie » propose les deux). Il peut changer d'avis. Il ne juge jamais sa propre note.
--
-- Mise en avant « à la manière des notes de communauté » (bridging) : une note est mise en avant
-- seulement si elle est jugée pertinente à la fois par des votants qui ont dit oui à la vidéo et par
-- des votants qui ont dit non : au moins 3 jugements de chaque camp, et 2/3 de « pertinente » de
-- chaque côté (« en partie » compte pour moitié). Elle est « peu utile » si, avec autant de
-- jugements, les deux camps la jugent pertinente à 1/3 au plus. Sinon : « à évaluer ». Les votes
-- « en partie » sur la vidéo ne donnent pas de camp : leurs jugements sont gardés mais ne comptent
-- pas pour la mise en avant. Le jugement n'a aucun effet sur le score de l'analyste.
--
-- Le site ne lit jamais les votes : le camp est retrouvé et gardé par la base, rattaché à la
-- convocation (dont le lien avec le compte est coupé au bout de 6 mois, comme pour les votes) ;
-- le site n'obtient que l'état de chaque note et le jugement de celui qui le demande.
--
-- Fiche publique : une note y paraît si son auteur l'a choisi, si la vidéo est publiée, si la note
-- n'est ni retirée, ni masquée, ni « peu utile ».

CREATE TABLE core.note_ratings (
    note_id    uuid NOT NULL REFERENCES core.osint_notes (id) ON DELETE CASCADE,
    summons_id uuid NOT NULL REFERENCES core.summons (id) ON DELETE CASCADE,
    side       text CHECK (side IN ('valid', 'invalid')),   -- camp sur la vidéo ; NULL si « en partie »
    helpful    text NOT NULL CHECK (helpful IN ('yes', 'somewhat', 'no')),
    reasons    text[] NOT NULL,
    rated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (note_id, summons_id),
    CHECK (cardinality(reasons) BETWEEN 1 AND 9 AND CASE helpful
        WHEN 'yes' THEN reasons <@ ARRAY['reliable_sources', 'clear', 'adds_context', 'verifiable']
        WHEN 'no' THEN reasons <@ ARRAY['dubious_sources', 'off_topic', 'opinion', 'incorrect', 'dead_links']
        ELSE reasons <@ ARRAY['reliable_sources', 'clear', 'adds_context', 'verifiable',
                              'dubious_sources', 'off_topic', 'opinion', 'incorrect', 'dead_links']
    END)
);
REVOKE ALL ON core.note_ratings FROM PUBLIC;   -- ni le site, ni personne d'autre que les fonctions ci-dessous

-- --- État d'une note ------------------------------------------------------------------------------

CREATE FUNCTION core.note_state(p_note uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    WITH p AS (
        SELECT coalesce((params ->> 'note_min_per_side')::int, 3) AS mini,
               coalesce((params ->> 'note_featured_share')::numeric, 2.0 / 3) AS haut,
               coalesce((params ->> 'note_unhelpful_share')::numeric, 1.0 / 3) AS bas
          FROM core.settings ORDER BY version DESC LIMIT 1
    ), camps AS (
        SELECT side, count(*) AS n,
               avg(CASE helpful WHEN 'yes' THEN 1 WHEN 'somewhat' THEN 0.5 ELSE 0 END) AS part
          FROM core.note_ratings WHERE note_id = p_note AND side IS NOT NULL
         GROUP BY side
    ), o AS (SELECT * FROM camps WHERE side = 'valid'), x AS (SELECT * FROM camps WHERE side = 'invalid')
    SELECT CASE
        WHEN o.n >= p.mini AND x.n >= p.mini AND o.part >= p.haut AND x.part >= p.haut THEN 'featured'
        WHEN o.n >= p.mini AND x.n >= p.mini AND o.part <= p.bas AND x.part <= p.bas THEN 'unhelpful'
        ELSE 'needs_ratings' END
      FROM p LEFT JOIN o ON true LEFT JOIN x ON true
$$;

-- Notes mises en avant d'un analyste (simple mention, sans effet sur son score).
CREATE FUNCTION core.analyst_featured_notes(p_account uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT count(*)::int FROM core.osint_notes
     WHERE author_id = p_account AND withdrawn_at IS NULL AND masked_at IS NULL
       AND core.note_state(id) = 'featured'
$$;

-- --- Juger une note ---------------------------------------------------------------------------------

CREATE FUNCTION core.rate_note(p_account uuid, p_summons uuid, p_note uuid, p_helpful text, p_reasons text[])
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    s  record;
    n  record;
    vo text;
BEGIN
    SELECT * INTO s FROM core.summons WHERE id = p_summons AND account_id = p_account AND outcome = 'voted';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:sans_vote';
    END IF;
    SELECT * INTO n FROM core.osint_notes WHERE id = p_note AND video_id = s.video_id
                                            AND withdrawn_at IS NULL AND masked_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'argos:note_introuvable';
    END IF;
    IF n.author_id = p_account THEN
        RAISE EXCEPTION 'argos:propre_note';
    END IF;
    SELECT verdict INTO vo FROM core.votes WHERE summons_id = p_summons;
    INSERT INTO core.note_ratings (note_id, summons_id, side, helpful, reasons)
    VALUES (p_note, p_summons, CASE WHEN vo IN ('valid', 'invalid') THEN vo END, p_helpful, p_reasons)
    ON CONFLICT (note_id, summons_id) DO UPDATE
       SET helpful = EXCLUDED.helpful, reasons = EXCLUDED.reasons, rated_at = now();
    RETURN core.note_state(p_note);
END
$$;

-- Ses propres jugements, pour une convocation à soi.
CREATE FUNCTION core.my_note_ratings(p_account uuid, p_summons uuid)
RETURNS TABLE (note_id uuid, helpful text, reasons text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT r.note_id, r.helpful, r.reasons
      FROM core.note_ratings r JOIN core.summons s ON s.id = r.summons_id
     WHERE r.summons_id = p_summons AND s.account_id = p_account
$$;

-- --- Fiche publique ---------------------------------------------------------------------------------

CREATE FUNCTION core.public_notes(p_video uuid)
RETURNS TABLE (note_id uuid, author text, analyst boolean, created_at timestamptz, version integer,
               finding text, explanation text, links text[], state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT n.id, a.username, coalesce(core.is_osint_analyst(n.author_id), false), n.created_at, n.version,
           n.finding, n.explanation, n.links, core.note_state(n.id)
      FROM core.osint_notes n
      JOIN core.videos v ON v.id = n.video_id AND v.status = 'published'
      LEFT JOIN core.accounts a ON a.id = n.author_id
     WHERE n.video_id = p_video AND n.wants_public AND n.withdrawn_at IS NULL AND n.masked_at IS NULL
       AND core.note_state(n.id) <> 'unhelpful'
     ORDER BY core.note_state(n.id) = 'featured' DESC, n.created_at
$$;

REVOKE ALL ON FUNCTION core.note_state(uuid), core.analyst_featured_notes(uuid),
                       core.rate_note(uuid, uuid, uuid, text, text[]), core.my_note_ratings(uuid, uuid),
                       core.public_notes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.note_state(uuid), core.analyst_featured_notes(uuid),
                          core.rate_note(uuid, uuid, uuid, text, text[]), core.my_note_ratings(uuid, uuid),
                          core.public_notes(uuid) TO argos_app;
