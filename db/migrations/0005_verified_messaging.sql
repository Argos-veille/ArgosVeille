-- Comptes vérifiés (journalistes, avocats, associations) et messagerie chiffrée.

-- Aucun justificatif conservé : seulement la catégorie et les dates.
CREATE TABLE core.verifications (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    category    text NOT NULL CHECK (category IN ('journalist', 'lawyer', 'association')),
    verified_at timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,      -- renouvellement annuel
    verified_by uuid REFERENCES core.accounts (id),
    revoked_at  timestamptz,
    CHECK (expires_at > verified_at)
);
CREATE INDEX verifications_active ON core.verifications (account_id) WHERE revoked_at IS NULL;

-- Clés publiques pour le chiffrement de bout en bout (générées dans le navigateur).
-- Un témoin a une clé par pseudonyme, pour que ses conversations restent cloisonnées par vidéo.
CREATE TABLE core.public_keys (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pseudonym_id uuid REFERENCES core.pseudonyms (id) ON DELETE CASCADE,
    account_id   uuid REFERENCES core.accounts (id) ON DELETE CASCADE,
    public_key   bytea NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CHECK ((pseudonym_id IS NULL) <> (account_id IS NULL))
);

-- Conversation entre un compte vérifié et le témoin d'une vidéo (connu seulement par son pseudonyme).
CREATE TABLE core.conversations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pseudonym_id        uuid NOT NULL REFERENCES core.pseudonyms (id) ON DELETE CASCADE,
    verified_account_id uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    created_at          timestamptz NOT NULL DEFAULT now(),
    closed_at           timestamptz,
    UNIQUE (pseudonym_id, verified_account_id)
);

-- Messages stockés uniquement chiffrés : le serveur ne peut pas les lire.
CREATE TABLE core.messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES core.conversations (id) ON DELETE CASCADE,
    sender          text NOT NULL CHECK (sender IN ('witness', 'verified')),
    ciphertext      bytea NOT NULL,
    sent_at         timestamptz NOT NULL DEFAULT now(),
    reported_at     timestamptz,
    revealed_text   text,                  -- rempli seulement si le destinataire signale et révèle le message
    CHECK (revealed_text IS NULL OR reported_at IS NOT NULL)
);
CREATE INDEX messages_conversation ON core.messages (conversation_id, sent_at);
