-- Purges prévues dès 0008 mais jamais déclenchées (constaté le 7 novembre 2026 en rédigeant la page de
-- confidentialité) :
--   - core.unlink_old_votes() : le lien vote ↔ compte est coupé après 6 mois → appelée par le moteur ;
--   - identity.purge_legal_logs() : journaux de connexion imposés par la loi, effacés après 1 an → appelée
--     par l'API (tâche horaire), qui doit donc pouvoir l'exécuter avec son rôle « identity ».
GRANT EXECUTE ON FUNCTION identity.purge_legal_logs(interval) TO argos_identity;
