-- La douane devient une force de l'ordre au choix (14 novembre 2026, demande de l’administrateur : « c'est une force de police »).
ALTER TABLE core.videos DROP CONSTRAINT videos_forces_check;
ALTER TABLE core.videos ADD CONSTRAINT videos_forces_check
    CHECK (forces IN ('national_police', 'gendarmerie', 'municipal_police', 'customs', 'unknown'));
