-- Revue de sécurité du 14 novembre 2026, A5 : le mot de passe ne part plus au serveur. Le navigateur envoie à la place
-- un secret de connexion tiré du mot de passe (navigateur/src/connexion.ts) ; le mot de passe lui-même protège la clé de
-- messagerie et ne quitte plus l'appareil.
--   password_scheme = 0 : empreinte du mot de passe lui-même (comptes d'avant ce changement) ;
--   password_scheme = 1 : empreinte du secret de connexion.
-- Un compte passe de 0 à 1 à sa première connexion (une dernière fois avec le mot de passe), ou à tout changement de
-- mot de passe. Toutes les sessions ouvertes sont fermées : chacun se reconnecte, ce qui fait la bascule.
ALTER TABLE core.credentials ADD COLUMN password_scheme smallint NOT NULL DEFAULT 0 CHECK (password_scheme IN (0, 1));
ALTER TABLE core.credentials ALTER COLUMN password_scheme SET DEFAULT 1;
GRANT SELECT (password_scheme), UPDATE (password_scheme) ON core.credentials TO argos_app;
UPDATE core.sessions SET revoked_at = now() WHERE revoked_at IS NULL;
