-- Nature des faits : violences physiques ou abus non violents, avec une sous-catégorie.
-- Les libellés affichés restent neutres (« interpellation contestée », jamais « arrestation arbitraire »),
-- toujours avec la mention « faits allégués, non jugés ».

ALTER TABLE core.videos
    ADD COLUMN category    text CHECK (category IN ('violence', 'abuse')),
    ADD COLUMN subcategory text,
    ADD CONSTRAINT videos_subcategory_matches CHECK (
        (category IS NULL AND subcategory IS NULL)
        OR (category = 'violence' AND subcategory IN (
                'strikes',                 -- coups
                'disproportionate_force',  -- usage disproportionné de la force
                'weapons',                 -- LBD, grenades, taser
                'chokehold',               -- clé d'étranglement, plaquage ventral
                'other_violence'))
        OR (category = 'abuse' AND subcategory IN (
                'contested_arrest',        -- interpellation contestée
                'discriminatory_stop',     -- contrôle signalé comme discriminatoire ou répété
                'insults',                 -- propos insultants ou discriminatoires
                'intimidation',            -- intimidation, menaces
                'filming_obstruction',     -- entrave au droit de filmer
                'property_destruction',    -- destruction de téléphone ou de biens
                'complaint_refused',       -- refus de prendre une plainte
                'other_abuse'))
    );
CREATE INDEX videos_category ON core.videos (category, subcategory);

-- Le site public saisit et lit la nature des faits ; les autres rôles n'en ont pas besoin.
GRANT SELECT (category, subcategory), INSERT (category, subcategory), UPDATE (category, subcategory)
      ON core.videos TO argos_app;
