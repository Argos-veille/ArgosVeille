-- Rôles applicatifs et schémas.
--
-- Chaque service a son propre rôle, avec seulement les droits dont il a besoin :
--   argos_app       site public et API (aucun accès à l'identité, ne lit pas les votes)
--   argos_identity  inscription : empreintes du téléphone et du mail, données de connexion légales
--   argos_worker    traitement vidéo (ne voit aucun compte)
--   argos_scoring   calcul des décisions et des scores (seul à relier votes et comptes)
--   argos_admin     administration (sanctions, rôles, signalements)
-- Les rôles sont NOLOGIN : en production, des rôles de connexion en hériteront.

DO $$
DECLARE
    r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['argos_app', 'argos_identity', 'argos_worker', 'argos_scoring', 'argos_admin']
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', r);
        END IF;
        -- Le propriétaire peut endosser chaque rôle (tests de droits), sans en hériter les droits.
        EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT FALSE, SET TRUE', r);
    END LOOP;
END
$$;

-- identity : données d'identité isolées ; core : le site ; ledger : journal public infalsifiable
CREATE SCHEMA identity;
CREATE SCHEMA core;
CREATE SCHEMA ledger;

-- Personne n'a de droit par défaut ; chaque accès est accordé explicitement (0009_privileges.sql).
REVOKE ALL ON SCHEMA identity, core, ledger FROM PUBLIC;
