-- Clés de sécurité et passkeys (étape 4e-2, 4 novembre 2026) : moyens de transport de la clé
-- (USB, NFC, Bluetooth, interne…), pour que le navigateur propose la bonne lors de la connexion.

ALTER TABLE core.mfa_factors
    ADD COLUMN transports text[] CHECK (transports IS NULL OR (
        cardinality(transports) <= 6
        AND transports <@ ARRAY['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card', 'cable']::text[]));
