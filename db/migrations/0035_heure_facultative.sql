-- Heure des faits facultative (5 novembre 2026, demande de l’administrateur).
--
-- La date reste obligatoire ; la source peut indiquer qu'elle ne connaît pas l'heure précise. La date
-- est alors gardée seule (à midi, heure de Paris, par convention) et aucune heure n'est jamais affichée.
ALTER TABLE core.videos ADD COLUMN occurred_time_known boolean NOT NULL DEFAULT true;
GRANT SELECT (occurred_time_known), INSERT (occurred_time_known) ON core.videos TO argos_app;
