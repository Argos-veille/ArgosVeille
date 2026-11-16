-- Contexte d'une vidéo verrouillé (5 novembre 2026).
--
-- Le site avait encore le droit de modifier la date, le lieu et la nature d'une vidéo (prévu au départ
-- pour une édition par la source, jamais utilisé). Depuis les corrections des analystes (0036), le
-- contexte ne change plus que par une correction tracée (core.osint_correct_context), inscrite au journal.
REVOKE UPDATE (occurred_at, location, location_precision, forces, situation, description, language, category, subcategory)
       ON core.videos FROM argos_app;
