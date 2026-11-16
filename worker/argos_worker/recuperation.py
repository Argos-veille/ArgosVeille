"""Récupération d'une vidéo depuis son lien (X, Bluesky, Facebook, TikTok, Instagram, YouTube), avec yt-dlp.

Une liste fermée de sites, contrôlée deux fois (API et ici), et seulement leurs extracteurs : le serveur ne suit jamais un
lien quelconque. Le lien lui-même n'est ni journalisé ni conservé après la récupération.

Revue de sécurité A9 : une vidéo Bluesky est servie par le serveur personnel (PDS) de son auteur, qui peut être n'importe
quel domaine. La récupérer en direct donnerait l'adresse réelle du serveur d'Argos à qui l'héberge. Elle passe donc par
Tor (`proxy_bluesky`, production) ; sans proxy configuré, Bluesky est refusé. Les autres plateformes servent leurs vidéos
depuis leurs propres serveurs (et beaucoup bloquent Tor) : récupérées en direct. Les adresses privées sont de toute façon
bloquées pour le worker (systemd, A8).

Contre-vérification du second audit (15 novembre) : la liste des extracteurs était commune à tous les liens. Un post X
renvoyant vers Bluesky (ou un lien t.co) faisait tourner l'extracteur Bluesky EN DIRECT, sans Tor. Chaque site n'a
désormais que SES extracteurs (noms exacts : yt-dlp les compare en entier), et un extracteur qui en désigne un autre
non autorisé est refusé par yt-dlp. Raccourcisseurs (twitter:shortener) et redirections (FacebookRedirectURL) exclus.
"""
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

from . import ffmpeg

YTDLP = Path(sys.executable).parent / "yt-dlp"
NODE = Path("/opt/node/bin/node")
# Domaine → extracteurs autorisés (expressions comparées en entier par yt-dlp, sans tenir compte de la casse).
EXTRACTEURS_PAR_SITE = {
    "x.com": "twitter", "twitter.com": "twitter",
    "bsky.app": "bluesky",
    "facebook.com": "facebook,facebook:reel",   # fb.watch : aucun extracteur (seul generic le suivrait)
    "tiktok.com": r"tiktok,vm\.tiktok",
    "instagram.com": "instagram",
    "youtube.com": "youtube", "youtu.be": "youtube,youtubeytbe",
}
SITES = tuple(EXTRACTEURS_PAR_SITE)
FORMAT = "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b"
DUREE_LIMITE_S = 300   # 5 min : une vidéo Bluesky de 3 min arrive en 2 min par Tor ; au-delà, il y a un problème (et la file du worker est bloquée)


class Impossible(Exception):
    """La vidéo ne peut pas être récupérée : inutile de réessayer."""


def site_autorise(url: str) -> bool:
    try:
        u = urlsplit(url)
        port = u.port
    except ValueError:
        return False
    hote = (u.hostname or "").lower()
    return u.scheme == "https" and port is None and not u.username and not u.password \
        and any(hote == d or hote.endswith("." + d) for d in SITES)


def extracteurs(url: str) -> str:
    hote = (urlsplit(url).hostname or "").lower()
    for d, e in EXTRACTEURS_PAR_SITE.items():
        if hote == d or hote.endswith("." + d):
            return e
    raise Impossible("site non pris en charge")


def bluesky(url: str) -> bool:
    hote = (urlsplit(url).hostname or "").lower()
    return hote == "bsky.app" or hote.endswith(".bsky.app")


def telecharger(url: str, sortie: Path, duree_max: int, proxy_bluesky: str | None = None) -> None:
    """Écrit la vidéo dans `sortie`. Les messages de yt-dlp ne sont jamais recopiés : ils contiennent le lien."""
    if not site_autorise(url):
        raise Impossible("site non pris en charge")
    if bluesky(url) and not proxy_bluesky:
        raise Impossible("Bluesky indisponible")
    travail = sortie.with_name(sortie.name + ".recup")
    shutil.rmtree(travail, ignore_errors=True)
    travail.mkdir(mode=0o700)
    try:
        cmd = [str(YTDLP), "--ignore-config", "--no-cache-dir", "--no-playlist", "--no-exec", "--no-mtime", "--no-progress", "--quiet",
               "--no-warnings", "--use-extractors", extracteurs(url), "--socket-timeout", "30", "--retries", "2", "--max-filesize", "2G",
               "--match-filters", f"duration<=?{duree_max}", "--format", FORMAT, "--merge-output-format", "mp4",
               "--output", str(travail / "video.%(ext)s")]
        if NODE.exists():
            cmd += ["--js-runtimes", f"node:{NODE}"]
        if bluesky(url):
            cmd += ["--proxy", proxy_bluesky]   # socks5h : les noms aussi sont résolus par Tor
        cmd += ["--", url]
        try:
            r = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=DUREE_LIMITE_S, preexec_fn=ffmpeg._limites(4096))
        except subprocess.TimeoutExpired:
            raise Impossible("récupération trop longue")
        fichiers = [f for f in travail.iterdir() if f.is_file() and not f.name.endswith(".part")]
        if r.returncode != 0 or len(fichiers) != 1:
            raise Impossible("récupération impossible")
        fichiers[0].replace(sortie)
    finally:
        shutil.rmtree(travail, ignore_errors=True)
