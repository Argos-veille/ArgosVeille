"""Crée (ou renouvelle) les rôles de connexion de l'API en développement.

    python3 db/roles_connexion.py

Les rôles applicatifs (argos_app, argos_identity…) sont NOLOGIN. L'API se connecte avec deux
rôles qui en héritent, chacun avec son propre mot de passe aléatoire :
  argos_api           -> argos_app       (le site, sans accès à l'identité)
  argos_api_identity  -> argos_identity  (inscription : empreintes et journaux légaux uniquement)
Le worker vidéo a son propre rôle, et ses réglages dans worker/.env :
  argos_worker_conn   -> argos_worker    (traitement vidéo : champs techniques des vidéos uniquement)
Le moteur de relecture (convocations, puis décisions et scores) a le sien, dans api/.env.moteur :
  argos_scoring_conn  -> argos_scoring   (seul rôle qui relie votes et comptes ; jamais dans le site)

Les mots de passe sont écrits dans api/.env et worker/.env (gitignorés), jamais affichés.
Les rôles PostgreSQL sont communs à tout le serveur : ils servent pour argos_dev comme pour argos_test.
"""
import re
import secrets
import sys
from pathlib import Path

import migrate

ENV = migrate.RACINE / "api" / ".env"
ENV_WORKER = migrate.RACINE / "worker" / ".env"
ENV_MOTEUR = migrate.RACINE / "api" / ".env.moteur"
ROLES = {
    "argos_api": ("argos_app", "ARGOS_PG_APP_PASSWORD", ENV),
    "argos_api_identity": ("argos_identity", "ARGOS_PG_IDENTITY_PASSWORD", ENV),
    "argos_api_admin": ("argos_administration", "ARGOS_PG_ADMIN_PASSWORD", ENV),
    "argos_worker_conn": ("argos_worker", "ARGOS_PG_WORKER_PASSWORD", ENV_WORKER),
    "argos_scoring_conn": ("argos_scoring", "ARGOS_PG_SCORING_PASSWORD", ENV_MOTEUR),
}
MODELE_MOTEUR = """\
# Réglages locaux du moteur de relecture (gitignoré). Généré par db/roles_connexion.py
ARGOS_PG_HOST=127.0.0.1
ARGOS_PG_PORT=5432
ARGOS_PG_DATABASE=argos_dev
ARGOS_PG_SCORING_PASSWORD=
"""
MODELE_WORKER = f"""\
# Réglages locaux du worker vidéo (gitignoré). Généré par db/roles_connexion.py
ARGOS_PG_HOST=127.0.0.1
ARGOS_PG_PORT=5432
ARGOS_PG_DATABASE=argos_dev
ARGOS_PG_WORKER_PASSWORD=
ARGOS_QUARANTAINE={migrate.RACINE / "api" / ".stockage" / "quarantaine"}
ARGOS_FLOUTEES={migrate.RACINE / "api" / ".stockage" / "floutees"}
ARGOS_COPIES={migrate.RACINE / "api" / ".stockage" / "copies"}
ARGOS_REDIS_URL=redis://127.0.0.1:6379/1
ARGOS_DUREE_MAX=1200
"""
MODELE = """\
# Réglages locaux de l'API (gitignoré). Généré par db/roles_connexion.py, modèle : api/.env.example
ARGOS_PG_HOST=127.0.0.1
ARGOS_PG_PORT=5432
ARGOS_PG_DATABASE=argos_dev
ARGOS_PG_APP_PASSWORD=
ARGOS_PG_IDENTITY_PASSWORD=
ARGOS_REDIS_URL=redis://127.0.0.1:6379/1
ARGOS_HOST=127.0.0.1
ARGOS_PORT=3000
ARGOS_CLE_HMAC=.secrets/hmac.key
ARGOS_CLE_MAIL=.secrets/mail.key
ARGOS_CLE_MFA=.secrets/mfa.key
# Clé secrète de TEST de Cloudflare : accepte toujours (à remplacer en production)
ARGOS_TURNSTILE_SECRET=1x0000000000000000000000000000000AA
ARGOS_URL_PUBLIQUE=http://localhost:5173
# Faux envoi local des SMS et mails, écrits dans ARGOS_BOITE (interdit en production)
ARGOS_FACTEUR=fichier
ARGOS_BOITE=.boite
ARGOS_SMS_PLAFOND_JOUR=200
ARGOS_STOCKAGE=.stockage/originaux
ARGOS_QUARANTAINE=.stockage/quarantaine
ARGOS_FLOUTEES=.stockage/floutees
ARGOS_COPIES=.stockage/copies
ARGOS_ENVOIS_PAR_HEURE=60
"""


def main() -> None:
    textes = {ENV: ENV.read_text() if ENV.exists() else MODELE,
              ENV_WORKER: ENV_WORKER.read_text() if ENV_WORKER.exists() else MODELE_WORKER,
              ENV_MOTEUR: ENV_MOTEUR.read_text() if ENV_MOTEUR.exists() else MODELE_MOTEUR}
    for role, (parent, cle, fichier) in ROLES.items():
        texte = textes[fichier]
        mdp = secrets.token_urlsafe(32)
        # Le mot de passe passe par une variable psql, jamais dans la ligne de commande.
        sql = f"""
            SELECT format(CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}')
                               THEN 'ALTER ROLE {role} LOGIN PASSWORD %L'
                               ELSE 'CREATE ROLE {role} LOGIN PASSWORD %L' END, :'mdp') \\gexec
            GRANT {parent} TO {role};
        """
        r = migrate.psql_variables("argos_dev", sql, {"mdp": mdp})
        if r.returncode:
            sys.exit(f"Échec pour {role} :\n{r.stderr}")
        ligne = f"{cle}={mdp}"
        texte, n = re.subn(rf"^{cle}=.*$", ligne, texte, flags=re.M)
        if not n:
            texte += ligne + "\n"
        textes[fichier] = texte
    for fichier, texte in textes.items():
        fichier.write_text(texte)
        fichier.chmod(0o600)
    print(f"Rôles {', '.join(ROLES)} prêts, mots de passe écrits dans {ENV}, {ENV_WORKER} et {ENV_MOTEUR}")


if __name__ == "__main__":
    main()
