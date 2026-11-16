-- Sessions : la base ne garde que l'empreinte du jeton de session (étape 4c, 4 novembre 2026).
--
-- Le cookie du relecteur contient un jeton aléatoire de 32 octets ; la base n'en garde que le
-- SHA-256. Quelqu'un qui lirait la base ne pourrait donc pas se faire passer pour un relecteur.
-- last_seen_at permet de fermer une session restée 7 jours sans activité (en plus de expires_at,
-- la durée maximale de 30 jours).

ALTER TABLE core.sessions
    ADD COLUMN token_hash   bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE core.sessions
    ADD CONSTRAINT sessions_expire_after_creation CHECK (expires_at > created_at);

-- Le site enregistre l'empreinte à la création et met à jour la dernière activité.
-- Il ne peut toujours ni créer de session d'administration, ni réactiver une session révoquée (0011).
GRANT INSERT (token_hash) ON core.sessions TO argos_app;
GRANT UPDATE (last_seen_at) ON core.sessions TO argos_app;
GRANT INSERT (token_hash) ON core.sessions TO argos_admin;

-- Le site inscrit les connexions au journal légal par le rôle d'identité, qui a déjà le droit
-- d'écrire dans identity.legal_connection_logs (0009), sans pouvoir le relire.
