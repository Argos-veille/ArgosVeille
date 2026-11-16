-- Administration (droits granulaires, groupes, sanctions, invitations) et signalements.

-- Droits délégables. regles.modifier et admins.gerer restent réservés au super-administrateur.
CREATE TABLE core.admin_rights (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    right_code  text NOT NULL CHECK (right_code IN (
                    'accounts.view', 'accounts.logout', 'accounts.suspend', 'accounts.ban',
                    'accounts.invite', 'groups.manage', 'verification.approve', 'reports.handle',
                    'content.hide', 'content.remove', 'dashboard.view')),
    scope       jsonb,                     -- par exemple {"groups": ["Journalistes"]} ; vide = sans restriction
    granted_by  uuid NOT NULL REFERENCES core.accounts (id),
    granted_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz,
    revoked_at  timestamptz,
    daily_cap   integer CHECK (daily_cap > 0),   -- plafond anti-dérapage pour les actions destructrices
    CHECK (expires_at IS NULL OR expires_at > granted_at)
);
CREATE INDEX admin_rights_active ON core.admin_rights (account_id) WHERE revoked_at IS NULL;

CREATE TABLE core.groups (
    id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE
);
INSERT INTO core.groups (name) VALUES
    ('Journalistes'), ('Avocats'), ('Associations'),
    ('Modérateurs d''urgence'), ('Vérificateurs'), ('Bêta-testeurs');

CREATE TABLE core.group_members (
    group_id   uuid NOT NULL REFERENCES core.groups (id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    added_by   uuid REFERENCES core.accounts (id),
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, account_id)
);

CREATE TABLE core.sanctions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('logout', 'suspend', 'ban')),
    reason_code text NOT NULL,             -- motif choisi dans une liste
    starts_at   timestamptz NOT NULL DEFAULT now(),
    ends_at     timestamptz,
    issued_by   uuid NOT NULL REFERENCES core.accounts (id),
    CHECK (kind <> 'suspend' OR ends_at IS NOT NULL)
);

CREATE TABLE core.invitations (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash  text NOT NULL UNIQUE,       -- code à usage unique, haché
    purpose    text NOT NULL CHECK (purpose IN ('beta', 'verified')),
    created_by uuid NOT NULL REFERENCES core.accounts (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_by    uuid REFERENCES core.accounts (id),
    used_at    timestamptz
);

-- Signalements. Un signalement grave masque la vidéo tout de suite, avant tout vote.
CREATE TABLE core.reports (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id    uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    severity    text NOT NULL CHECK (severity IN ('serious', 'normal')),
    reason_code text NOT NULL CHECK (reason_code IN (
                    'visible_identity', 'illegal_content', 'defamation', 'wrong_context', 'other')),
    details     text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'handled', 'dismissed')),
    handled_by  uuid REFERENCES core.accounts (id),
    handled_at  timestamptz
);
CREATE INDEX reports_open ON core.reports (severity, created_at) WHERE status = 'open';

-- Droit de réponse.
CREATE TABLE core.replies (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id   uuid NOT NULL REFERENCES core.videos (id) ON DELETE CASCADE,
    content    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'refused'))
);
