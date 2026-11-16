-- Vidéos, pseudonymes par vidéo et événements.

CREATE TABLE core.videos (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submitted_at        timestamptz NOT NULL DEFAULT now(),
    status              text NOT NULL DEFAULT 'processing'
                        CHECK (status IN ('processing', 'awaiting_author', 'in_review', 'jury',
                                          'published', 'rejected', 'under_debate', 'no_decision',
                                          'hidden', 'removed')),
    -- Vidéo de contrôle : bonne réponse connue, jamais visible du public.
    is_control          boolean NOT NULL DEFAULT false,
    control_truth       boolean,

    -- Contexte saisi par l'auteur
    occurred_at         timestamptz,
    location            geography(Point, 4326),
    location_precision  text CHECK (location_precision IN ('exact', 'approx_100m', 'municipality')),
    forces              text CHECK (forces IN ('national_police', 'gendarmerie', 'municipal_police', 'unknown')),
    situation           text CHECK (situation IN ('demonstration', 'stop', 'arrest', 'other')),
    description         text,
    language            text NOT NULL DEFAULT 'fr' CHECK (language IN ('fr', 'en')),
    description_mt      text,             -- traduction automatique, signalée comme telle

    -- Intégrité des preuves
    original_sha256     bytea,            -- calculé dans le navigateur, avant chiffrement
    blurred_sha256      bytea,
    timestamp_token     bytea,            -- horodatage certifié RFC 3161

    -- Stockage R2 (jamais d'original en clair)
    r2_blurred_key      text,
    r2_original_enc_key text,             -- original chiffré avec la clé de l'auteur, que le site n'a pas

    -- Décision
    enlargements        smallint NOT NULL DEFAULT 0,
    first_round_ratio   numeric(5, 4),
    decided_at          timestamptz,
    decided_by_stage    text CHECK (decided_by_stage IN ('review', 'jury', 'legal')),

    CHECK (NOT is_control OR control_truth IS NOT NULL),
    CHECK (NOT is_control OR status NOT IN ('published', 'under_debate')),
    CHECK (location IS NULL OR location_precision IS NOT NULL)
);
CREATE INDEX videos_status ON core.videos (status);
CREATE INDEX videos_location ON core.videos USING gist (location);
CREATE INDEX videos_occurred ON core.videos (occurred_at);

-- Un pseudonyme aléatoire différent par vidéo. Le lien avec le compte est interne :
-- le site public ne peut lire que la colonne pseudonym (droits par colonne, 0009).
CREATE TABLE core.pseudonyms (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id        uuid NOT NULL UNIQUE REFERENCES core.videos (id) ON DELETE CASCADE,
    account_id      uuid REFERENCES core.accounts (id) ON DELETE SET NULL,
    pseudonym       text NOT NULL UNIQUE,  -- forme « Heron-Ambre-4821 », généré par le site
    contact_allowed boolean NOT NULL DEFAULT false   -- le témoin accepte d'être contacté (non par défaut)
);

CREATE TABLE core.events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    title       text,
    location    geography(Point, 4326),
    started_at  timestamptz,
    ended_at    timestamptz
);
CREATE INDEX events_location ON core.events USING gist (location);

-- Lien entre une vidéo et un événement, validé par les relecteurs.
CREATE TABLE core.event_links (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id    uuid NOT NULL REFERENCES core.events (id) ON DELETE CASCADE,
    video_id    uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    proposed_at timestamptz NOT NULL DEFAULT now(),
    status      text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'validated', 'refused')),
    UNIQUE (event_id, video_id)
);
