-- « Ne pas me redemander pendant 30 jours » (8 novembre 2026, demande de l’administrateur) : à la connexion, après la double
-- authentification, la personne peut faire confiance à CET appareil (reconnu par son témoin, voir 0017) pendant
-- 30 jours : la connexion ne demande alors que le mot de passe. Jamais pour le super-administrateur. La confiance est
-- effacée par un changement de mot de passe, « se déconnecter partout » et tout changement des méthodes de double
-- authentification. Ce qui revérifie la double authentification (vote au jury…) n'est pas concerné.
ALTER TABLE core.known_devices ADD COLUMN mfa_trusted_until timestamptz;
GRANT UPDATE (mfa_trusted_until) ON core.known_devices TO argos_app;
