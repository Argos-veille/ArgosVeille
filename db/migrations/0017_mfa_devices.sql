-- Double authentification et appareils connus (étape 4e-1, 4 novembre 2026).

-- Méthodes de double authentification : un nom choisi, un retrait daté plutôt qu'une suppression
-- (trace conservée), et une seule application TOTP active par compte.
ALTER TABLE core.mfa_factors
    ADD COLUMN label      text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 40),
    ADD COLUMN revoked_at timestamptz;

CREATE UNIQUE INDEX mfa_one_active_totp ON core.mfa_factors (account_id)
    WHERE kind = 'totp' AND revoked_at IS NULL;

-- Le site ajoute une méthode, met à jour sa dernière utilisation (et le compteur d'une clé de
-- sécurité) et la retire. Il ne modifie jamais une méthode existante, ni ne la réactive.
REVOKE UPDATE ON core.mfa_factors FROM argos_app;
GRANT UPDATE (last_used_at, sign_count, revoked_at) ON core.mfa_factors TO argos_app;

CREATE FUNCTION core.forbid_mfa_unrevoke() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'une méthode de double authentification retirée ne peut pas être réactivée';
    END IF;
    RETURN NEW;
END
$$;
CREATE TRIGGER mfa_forbid_unrevoke BEFORE UPDATE ON core.mfa_factors
    FOR EACH ROW EXECUTE FUNCTION core.forbid_mfa_unrevoke();
REVOKE ALL ON FUNCTION core.forbid_mfa_unrevoke() FROM PUBLIC;

-- Appareils connus : sert seulement à prévenir le relecteur d'une connexion depuis un nouvel
-- appareil. Le cookie de l'appareil contient un jeton aléatoire ; la base n'en garde que le
-- SHA-256. Ni navigateur, ni système, ni adresse IP ne sont enregistrés.
CREATE TABLE core.known_devices (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    uuid NOT NULL REFERENCES core.accounts (id) ON DELETE CASCADE,
    device_hash   bytea NOT NULL CHECK (length(device_hash) = 32),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, device_hash)
);

REVOKE ALL ON core.known_devices FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON core.known_devices TO argos_app;   -- DELETE : oubli après un an d'inactivité
GRANT UPDATE (last_seen_at) ON core.known_devices TO argos_app;
