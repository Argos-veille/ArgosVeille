-- Choix de la source : masquer automatiquement les visages proches (décision du 4 novembre 2026).
-- Coché par défaut, pour protéger les personnes filmées ; la source peut le décocher (vidéo déjà
-- floutée par son auteur, ou déjà publique ailleurs).

ALTER TABLE core.videos ADD COLUMN mask_faces boolean NOT NULL DEFAULT true;

GRANT INSERT (mask_faces), SELECT (mask_faces) ON core.videos TO argos_app;
GRANT SELECT (mask_faces) ON core.videos TO argos_worker;
