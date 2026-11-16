-- Appareils connectés (8 novembre 2026, demande de l’administrateur) : « Mon compte » liste les sessions ouvertes et permet
-- d'en fermer une. Seule une description approximative de l'appareil est gardée (« Firefox sous Linux »), jamais
-- l'en-tête complet du navigateur ni l'adresse IP. Elle disparaît avec la session.
ALTER TABLE core.sessions ADD COLUMN device_label text
    CHECK (device_label IS NULL OR length(device_label) BETWEEN 1 AND 60);
GRANT INSERT (device_label) ON core.sessions TO argos_app;
