-- Journal légal (15 novembre 2026, recherche juridique, question 19) : tant que l'injonction du Premier ministre est en
-- vigueur (décret 2026-920, jusqu'au 21 octobre 2027), le décret 2021-1362 (art. 5 2°, 6 2° et 7) impose, pour chaque
-- création, modification ou suppression d'un contenu : l'identifiant de connexion (IP, port), l'identifiant du contenu,
-- la nature de l'opération et la date et l'heure EXACTES. Gardé un an (purge existante), jamais lisible par le site.
--   upload  : création d'une vidéo (identifiant de la vidéo) ;
--   modify  : retouche du floutage par la source ;
--   delete  : retrait par la source.
-- L'heure reste exacte ici seulement ; ailleurs (vidéos, fiches publiques), elle est arrondie (0107, 0117).
ALTER TABLE identity.legal_connection_logs ADD COLUMN content_id uuid;   -- pas de clé étrangère : le journal survit au retrait
ALTER TABLE identity.legal_connection_logs DROP CONSTRAINT legal_connection_logs_action_check;
ALTER TABLE identity.legal_connection_logs ADD CONSTRAINT legal_connection_logs_action_check
    CHECK (action IN ('signup', 'login', 'upload', 'modify', 'delete', 'vote', 'message'));
ALTER TABLE identity.legal_connection_logs ADD CONSTRAINT legal_connection_logs_contenu
    CHECK (action NOT IN ('upload', 'modify', 'delete') OR content_id IS NOT NULL) NOT VALID;   -- lignes d'avant : sans identifiant
