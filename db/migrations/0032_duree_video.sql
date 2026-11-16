-- Durée de la version floutée (5 novembre 2026), mesurée par le worker.
--
-- Les notes d'analystes s'ouvrent à la fin du premier visionnage (90 % de la vidéo, compté par le
-- navigateur). Garde-fou côté serveur : pas de notes avant que la moitié de la durée se soit écoulée
-- depuis l'ouverture de la vidéo (la moitié, pour laisser regarder en accéléré).
ALTER TABLE core.videos ADD COLUMN duration_s numeric(8, 2) CHECK (duration_s > 0 AND duration_s <= 7200);
GRANT UPDATE (duration_s) ON core.videos TO argos_worker;
GRANT SELECT (duration_s) ON core.videos TO argos_app;
