"""Applique les migrations SQL dans l'ordre.

    python3 db/migrate.py [--db argos_dev] [--reset]

Connexion : rôle argos_owner sur 127.0.0.1, mot de passe lu dans .db_password à la racine du dépôt.
--reset efface les schémas d'Argos avant de tout réappliquer ; refusé sur argos_dev sans --force.
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
MIGRATIONS = Path(__file__).resolve().parent / "migrations"


def environnement(db: str) -> dict:
    env = dict(os.environ)
    env.update({
        "PGHOST": "127.0.0.1",
        "PGPORT": "5432",
        "PGUSER": "argos_owner",
        "PGDATABASE": db,
        # Production : mot de passe du propriétaire dans un fichier réservé à root (ARGOS_PROPRIETAIRE_MDP_FICHIER).
        "PGPASSWORD": Path(os.environ.get("ARGOS_PROPRIETAIRE_MDP_FICHIER") or RACINE / ".db_password").read_text().strip(),
        "PGOPTIONS": "-c client_min_messages=warning",
    })
    return env


def psql(db: str, sql: str | None = None, fichier: Path | None = None,
         transaction: bool = False) -> subprocess.CompletedProcess:
    # VERBOSITY=verbose : chaque erreur affiche son code SQLSTATE, identique quelle que soit la langue.
    cmd = ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At"]
    if transaction:
        cmd.append("-1")
    cmd += ["-f", str(fichier)] if fichier else ["-c", sql]
    return subprocess.run(cmd, env=environnement(db), capture_output=True, text=True)


def psql_variables(db: str, sql: str, variables: dict[str, str]) -> subprocess.CompletedProcess:
    """Exécute un script psql lu sur l'entrée standard, avec des variables (\\set) qui n'apparaissent
    jamais dans la ligne de commande (utile pour les mots de passe)."""
    entete = "".join(f"\\set {k} '{v}'\n" for k, v in variables.items() if "'" not in v and "\\" not in v)
    if len(entete.splitlines()) != len(variables):
        raise ValueError("valeur de variable non prise en charge (apostrophe ou antislash)")
    cmd = ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At", "-f", "-"]
    return subprocess.run(cmd, env=environnement(db), input=entete + sql, capture_output=True, text=True)


def reinitialiser(db: str) -> None:
    r = psql(db, "DROP SCHEMA IF EXISTS identity, core, ledger CASCADE; "
                 "DROP TABLE IF EXISTS public.schema_migrations;")
    if r.returncode:
        sys.exit(r.stderr)


def migrer(db: str) -> list[str]:
    r = psql(db, "CREATE TABLE IF NOT EXISTS public.schema_migrations "
                 "(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
    if r.returncode:
        sys.exit(r.stderr)
    deja = set(psql(db, "SELECT name FROM public.schema_migrations").stdout.split())
    appliquees = []
    for f in sorted(MIGRATIONS.glob("*.sql")):
        if f.name in deja:
            continue
        # Migration et enregistrement dans la même transaction : tout ou rien.
        tmp = Path(f"/tmp/argos-migration-{os.getpid()}.sql")
        tmp.write_text(f.read_text() + f"\nINSERT INTO public.schema_migrations (name) VALUES ('{f.name}');\n")
        try:
            r = psql(db, fichier=tmp, transaction=True)
        finally:
            tmp.unlink(missing_ok=True)
        if r.returncode:
            sys.exit(f"Échec de {f.name} :\n{r.stderr}")
        appliquees.append(f.name)
    return appliquees


def main() -> None:
    ap = argparse.ArgumentParser(description="Migrations de la base Argos")
    ap.add_argument("--db", default="argos_dev")
    ap.add_argument("--reset", action="store_true")
    ap.add_argument("--force", action="store_true", help="autorise --reset sur argos_dev")
    args = ap.parse_args()
    if args.reset:
        if args.db not in ("argos_test", "argos_dev"):
            sys.exit("--reset est interdit sur cette base (production) : il effacerait toutes les données")
        if args.db != "argos_test" and not args.force:
            sys.exit("--reset efface les données : ajoute --force pour le faire sur une autre base que argos_test")
        reinitialiser(args.db)
    faites = migrer(args.db)
    print(f"{len(faites)} migration(s) appliquée(s) sur {args.db}" + (f" : {', '.join(faites)}" if faites else ""))


if __name__ == "__main__":
    main()
