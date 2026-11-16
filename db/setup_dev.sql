-- Installation unique de la base de développement d'Argos (à lancer en superutilisateur PostgreSQL).
--
--   sudo -u postgres psql -v pw="$(cat ~/dev/argos/.db_password)" < ~/dev/argos/db/setup_dev.sql
--
-- Crée le propriétaire argos_owner, les bases argos_dev et argos_test, et les extensions
-- PostGIS (coordonnées GPS) et pgcrypto (empreintes du journal). Les autres rôles sont créés
-- par les migrations.

CREATE ROLE argos_owner LOGIN CREATEROLE PASSWORD :'pw';
CREATE DATABASE argos_dev OWNER argos_owner;
CREATE DATABASE argos_test OWNER argos_owner;

\c argos_dev
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

\c argos_test
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
