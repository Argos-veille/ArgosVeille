-- Modération : convocations, votes, détection de collusion, règles versionnées.

-- Convocation d'un compte à relire une vidéo (premier tour) ou à siéger au jury.
CREATE TABLE core.summons (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id    uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    account_id  uuid REFERENCES core.accounts (id) ON DELETE SET NULL,   -- coupé après 6 mois
    round       text NOT NULL CHECK (round IN ('review', 'jury')),
    sent_at     timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    answered_at timestamptz,
    outcome     text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'voted', 'passed', 'expired')),
    unlinked_at timestamptz,
    CHECK (expires_at > sent_at)
);
CREATE INDEX summons_pending ON core.summons (account_id) WHERE outcome = 'pending';
CREATE UNIQUE INDEX summons_once ON core.summons (video_id, account_id, round) WHERE account_id IS NOT NULL;

-- Vote. Le lien avec le compte sert au score et à la collusion ; il est coupé après 6 mois
-- (core.unlink_old_votes) : le vote reste dans les statistiques, sans auteur.
CREATE TABLE core.votes (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    summons_id  uuid NOT NULL UNIQUE REFERENCES core.summons (id) ON DELETE CASCADE,
    video_id    uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    account_id  uuid REFERENCES core.accounts (id) ON DELETE SET NULL,
    round       text NOT NULL CHECK (round IN ('review', 'jury')),
    cast_at     timestamptz NOT NULL DEFAULT now(),
    is_valid    boolean NOT NULL,          -- verdict global « valide »
    answers     jsonb NOT NULL,            -- réponses aux questions factuelles
    weight      numeric(6, 3) NOT NULL CHECK (weight >= 0),   -- poids au moment du vote
    unlinked_at timestamptz
);
CREATE INDEX votes_video ON core.votes (video_id, round);
CREATE INDEX votes_to_unlink ON core.votes (cast_at) WHERE account_id IS NOT NULL;

-- Paires de comptes retrouvées ensemble dans la minorité (alerte de collusion).
CREATE TABLE core.collusion_pairs (
    account_a          uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    account_b          uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    shared_minorities  integer NOT NULL DEFAULT 0,
    last_seen_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_a, account_b),
    CHECK (account_a < account_b)
);

-- Règles de modération versionnées. Chaque changement est inscrit au journal public.
CREATE TABLE core.settings (
    version        serial PRIMARY KEY,
    effective_from timestamptz NOT NULL DEFAULT now(),
    params         jsonb NOT NULL,
    changed_by     uuid REFERENCES core.accounts (id)
);

-- Règles validées par le simulateur (3 novembre 2026).
INSERT INTO core.settings (params) VALUES ('{
    "score_initial": 1.0, "score_min": 0.2, "score_max": 10.0,
    "novice_days": 30, "novice_factor": 0.5,
    "sample_size": 15, "enlargement_size": 15, "max_enlargements": 1, "max_review_days": 7,
    "summons_per_seat": 3, "summons_days": 2, "reviews_per_day": 5,
    "publish_threshold": 0.65, "reject_threshold": 0.35, "min_total_weight": 15.0,
    "consensus_threshold": 0.80, "gain": 0.1, "loss": 0.3,
    "inactivity_days": 14, "decay": 0.01,
    "control_rate": 0.15, "control_loss": 1.0,
    "jury_size": 11, "jury_majority": 8, "jury_min_votes": 8, "jury_pool_share": 0.30,
    "jury_min_age_days": 60, "jury_max_per_week": 2, "jury_days": 5, "jury_publish_floor": 0.5,
    "collusion_threshold": 3, "vote_unlink_months": 6
}');
