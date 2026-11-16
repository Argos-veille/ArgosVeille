-- Comptes, authentification et données d'identité.

-- Aucun champ personnel ici : ni nom, ni mail, ni téléphone.
CREATE TABLE core.accounts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'banned', 'deleted')),
    suspended_until timestamptz,
    score           numeric(6, 3) NOT NULL DEFAULT 1.0 CHECK (score BETWEEN 0.2 AND 10),
    last_vote_at    timestamptz,
    suspect         boolean NOT NULL DEFAULT false,  -- alerte de collusion : exclu du jury
    is_superadmin   boolean NOT NULL DEFAULT false,
    CHECK (status <> 'suspended' OR suspended_until IS NOT NULL)
);

-- Un seul super-administrateur.
CREATE UNIQUE INDEX accounts_one_superadmin ON core.accounts (is_superadmin) WHERE is_superadmin;

CREATE TABLE core.credentials (
    account_id    uuid PRIMARY KEY REFERENCES core.accounts (id) ON DELETE CASCADE,
    password_hash text NOT NULL,          -- Argon2id, format PHC
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.sessions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    is_admin   boolean NOT NULL DEFAULT false   -- session d'administration (courte, ouverte par VPN)
);
CREATE INDEX sessions_account ON core.sessions (account_id) WHERE revoked_at IS NULL;

-- Double authentification : application (TOTP) ou clé de sécurité / passkey (WebAuthn). Jamais de SMS.
CREATE TABLE core.mfa_factors (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id       uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    kind             text NOT NULL CHECK (kind IN ('totp', 'webauthn')),
    totp_secret_enc  bytea,                -- chiffré par l'application, jamais en clair
    credential_id    bytea UNIQUE,
    public_key       bytea,
    sign_count       bigint,
    created_at       timestamptz NOT NULL DEFAULT now(),
    last_used_at     timestamptz,
    CHECK ((kind = 'totp' AND totp_secret_enc IS NOT NULL)
        OR (kind = 'webauthn' AND credential_id IS NOT NULL AND public_key IS NOT NULL))
);

CREATE TABLE core.backup_codes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    code_hash  text NOT NULL,              -- haché, jamais en clair
    used_at    timestamptz
);

-- Identité isolée : seules les empreintes HMAC (clé secrète hors base) du téléphone et du mail.
-- L'empreinte survit à la suppression du compte : un compte banni ne peut pas se réinscrire.
CREATE TABLE identity.account_identities (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  uuid UNIQUE REFERENCES core.accounts (id) ON DELETE SET NULL,
    phone_hmac  bytea NOT NULL UNIQUE,
    email_hmac  bytea NOT NULL UNIQUE,
    banned      boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Données de connexion imposées par la loi (décret 2021-1362), purgées à l'échéance.
CREATE TABLE identity.legal_connection_logs (
    id          bigserial PRIMARY KEY,
    account_id  uuid,                      -- pas de clé étrangère : les journaux survivent au compte
    occurred_at timestamptz NOT NULL DEFAULT now(),
    action      text NOT NULL CHECK (action IN ('signup', 'login', 'upload', 'vote', 'message')),
    ip          inet NOT NULL,
    source_port integer
);
CREATE INDEX legal_logs_time ON identity.legal_connection_logs (occurred_at);
