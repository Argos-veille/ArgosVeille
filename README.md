# Argos Veille

Code source d'[argos-veille.fr](https://argos-veille.fr) : recensement citoyen des vidéos de violences policières,
relues par la communauté et publiées sur une carte.

## Contenu

| Dossier | Rôle |
|---|---|
| `web` | Site (SvelteKit) |
| `api` | API (Node.js, Fastify) |
| `worker` | Traitement des vidéos : floutage, empreintes (Python) |
| `db` | Base PostgreSQL : migrations et rôles |
| `navigateur` | Chiffrement côté navigateur |
| `simulateur`, `tests` | Simulation des règles de relecture, tests de la base |
| `cartes`, `logo` | Fonds de carte, identité visuelle |

## Installer une copie de développement

Prérequis : PostgreSQL avec PostGIS sur 127.0.0.1:5432, Redis, Node.js (version dans `api/.nvmrc`), Python 3.

1. Mot de passe du propriétaire de la base : `openssl rand -hex 24 > .db_password` (à la racine).
2. Bases `argos_dev` et `argos_test` : `sudo -u postgres psql -v pw="$(cat .db_password)" < db/setup_dev.sql`.
3. Migrations : `python3 db/migrate.py`.
4. Rôles de connexion et fichiers `.env` (API, moteur, worker) : `python3 db/roles_connexion.py`.
5. Chiffrement côté navigateur (utilisé par l'API et ses tests) : `cd navigateur && npm ci`.
6. API : `cd api && npm ci && node scripts/generer_cles.ts && npm run dev`.
7. Site : `cd web && npm ci && npm run dev`.
8. Worker : `cd worker && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`.

Tests :
- `npm test` dans `api`, `web` et `navigateur` ;
- `python3 -m unittest discover -s tests -t .` à la racine ;
- `.venv/bin/python -m unittest` dans `worker`.

Les tests de la base sont sautés si `argos_test` n'est pas joignable : vérifiez qu'ils ont bien tourné.

## Signaler une faille

Testez librement votre propre copie. Sur le site en ligne, pas de test d'intrusion : signalez toute faille en privé
par le rapport de bug du site, sans la publier avant sa correction.

## Licence

GNU AGPL 3.0 ou ultérieure (voir `LICENSE`) : une copie modifiée mise en ligne doit publier son code source.
