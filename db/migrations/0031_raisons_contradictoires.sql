-- Raisons contradictoires (5 novembre 2026, remarque de l’administrateur).
--
-- « En partie » propose les raisons du oui et du non : on ne peut pas cocher deux raisons qui se
-- contredisent (« le lieu et la date sont cohérents » et « vidéo ancienne », par exemple). L'écran
-- grise la raison contraire, l'API refuse, et la base a le dernier mot. NOT VALID : vérifié pour tout
-- nouveau vote ou jugement (aucune donnée réelle n'existe avant cette migration).

CREATE FUNCTION core.vote_reasons_contradict(r text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
    SELECT (r @> ARRAY['intervention_visible', 'nothing_visible'])
        OR (r @> ARRAY['context_consistent', 'context_inconsistent'])
        OR (r @> ARRAY['context_consistent', 'old_or_reused'])
        OR (r @> ARRAY['authentic', 'misleading_edit'])
        OR (r @> ARRAY['category_matches', 'wrong_category'])
$$;

CREATE FUNCTION core.note_reasons_contradict(r text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
    SELECT (r @> ARRAY['reliable_sources', 'dubious_sources'])
        OR (r @> ARRAY['verifiable', 'dead_links'])
        OR (r @> ARRAY['adds_context', 'off_topic'])
$$;

ALTER TABLE core.votes ADD CONSTRAINT votes_reasons_coherent
    CHECK (NOT core.vote_reasons_contradict(reasons)) NOT VALID;
ALTER TABLE core.note_ratings ADD CONSTRAINT note_ratings_reasons_coherent
    CHECK (NOT core.note_reasons_contradict(reasons)) NOT VALID;
