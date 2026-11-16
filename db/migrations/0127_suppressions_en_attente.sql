-- Contre-vérification du second audit (15 novembre 2026) : au retrait, si le stockage (R2) échouait, l'original chiffré et
-- les versions floutées restaient pour toujours (la vidéo est déjà « retirée » : un nouvel essai répond « déjà retirée »).
-- Chaque suppression qui échoue est inscrite ici et retentée chaque heure par l'API jusqu'à réussir.
CREATE TABLE core.pending_deletions (
    video_id   uuid NOT NULL,          -- pas de clé étrangère : la vidéo peut ne plus exister
    espace     text NOT NULL CHECK (espace IN ('originaux', 'floutees', 'quarantaine', 'copies')),
    created_on date NOT NULL DEFAULT (now() AT TIME ZONE 'Europe/Paris')::date,   -- au jour : l'heure d'un retrait n'est gardée nulle part
    PRIMARY KEY (video_id, espace)
);
REVOKE ALL ON core.pending_deletions FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON core.pending_deletions TO argos_app;
