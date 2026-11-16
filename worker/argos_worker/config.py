"""Réglages du worker, lus dans l'environnement (worker/.env). Un réglage manquant arrête le worker."""
import os
from dataclasses import dataclass
from pathlib import Path


class ErreurConfig(Exception):
    pass


@dataclass(frozen=True)
class Config:
    pg_host: str
    pg_port: int
    pg_base: str
    pg_mot_de_passe: str
    quarantaine: Path   # copies de travail en clair (volume chiffré à clé jetable en production)
    floutees: Path      # versions floutées produites par le worker
    copies: Path        # copies de travail chiffrées (clé de copie) et pistes, gardées 7 jours, privées
    redis_url: str      # pour récupérer la clé de copie le temps d'un traitement
    duree_max: int      # secondes
    # Ancrage du journal public dans Bitcoin : « reel » (production) ou « simule » (développement, par défaut).
    ancrage: str = "simule"
    # Originaux chiffrés par le worker (envois par lien) ; par défaut, à côté de la quarantaine.
    originaux: Path | None = None
    calendriers: tuple[str, ...] = ("https://a.pool.opentimestamps.org", "https://b.pool.opentimestamps.org",
                                    "https://a.pool.eternitywall.com")
    redis_mot_de_passe: str | None = None   # production : fichier systemd ; développement : aucun
    # « traitement » (floutage, dans l'ordre d'arrivée), « recuperation » (liens) ou « tout » (développement, tests).
    role: str = "tout"
    proxy_bluesky: str | None = None   # A9 : Tor pour les vidéos Bluesky (socks5h://127.0.0.1:9050) ; absent : Bluesky refusé


def _role(valeur: str) -> str:
    v = valeur.strip() or "tout"
    if v not in ("tout", "traitement", "recuperation"):
        raise ErreurConfig(f"ARGOS_WORKER_ROLE inconnu : {v}")
    return v


def lire_fichier_env(chemin: Path) -> dict[str, str]:
    """Lit un fichier KEY=VALUE (lignes vides et commentaires ignorés)."""
    valeurs = {}
    if chemin.exists():
        for ligne in chemin.read_text().splitlines():
            ligne = ligne.strip()
            if ligne and not ligne.startswith("#") and "=" in ligne:
                cle, _, val = ligne.partition("=")
                valeurs[cle.strip()] = val.strip()
    return valeurs


def lire_config(env: dict[str, str] | None = None) -> Config:
    env = dict(os.environ) if env is None else env

    def requis(cle: str) -> str:
        v = env.get(cle, "").strip()
        if not v:
            raise ErreurConfig(f"réglage manquant : {cle}")
        return v

    def secret(cle: str) -> str:
        """Lu dans le fichier CLE_FICHIER (systemd, production) s'il est indiqué, sinon dans CLE."""
        f = env.get(f"{cle}_FICHIER", "").strip()
        if f:
            v = Path(f).read_text().strip()
            if not v:
                raise ErreurConfig(f"fichier de secret vide : {cle}_FICHIER")
            return v
        return requis(cle)

    return Config(
        pg_host=requis("ARGOS_PG_HOST"),
        pg_port=int(requis("ARGOS_PG_PORT")),
        pg_base=requis("ARGOS_PG_DATABASE"),
        pg_mot_de_passe=secret("ARGOS_PG_WORKER_PASSWORD"),
        quarantaine=Path(requis("ARGOS_QUARANTAINE")),
        floutees=Path(requis("ARGOS_FLOUTEES")),
        copies=Path(requis("ARGOS_COPIES")),
        redis_url=requis("ARGOS_REDIS_URL"),
        duree_max=int(requis("ARGOS_DUREE_MAX")),
        ancrage=_ancrage(env.get("ARGOS_ANCRAGE", "simule")),
        originaux=Path(env["ARGOS_ORIGINAUX"]) if env.get("ARGOS_ORIGINAUX", "").strip() else None,
        proxy_bluesky=env.get("ARGOS_PROXY_BLUESKY", "").strip() or None,
        role=_role(env.get("ARGOS_WORKER_ROLE", "tout")),
        # Mot de passe Redis (production : fichier systemd ; développement : aucun).
        redis_mot_de_passe=secret("ARGOS_REDIS_PASSWORD") if (env.get("ARGOS_REDIS_PASSWORD_FICHIER", "").strip()
                                                         or env.get("ARGOS_REDIS_PASSWORD", "").strip()) else None,
    )


def _ancrage(v: str) -> str:
    if v not in ("reel", "simule"):
        raise ErreurConfig(f"ARGOS_ANCRAGE doit valoir « reel » ou « simule » : {v}")
    return v
