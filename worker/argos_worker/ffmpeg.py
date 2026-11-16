"""Appels à ffprobe et ffmpeg, durcis : un fichier vidéo piégé est l'un des rares moyens d'attaquer
un serveur à travers un envoi.

- Le format d'entrée est IMPOSÉ d'après la signature du fichier (MP4/MOV ou Matroska/WebM) : ffmpeg
  ne choisit jamais lui-même un démultiplexeur (listes de lecture HLS, « concat »… qui pourraient
  lire d'autres fichiers ou le réseau).
- Seul le protocole « file » est autorisé en entrée.
- Chaque processus a des limites de mémoire, de taille de fichier et de nombre de fichiers ouverts,
  et un délai maximal.
"""
import json
import resource
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

MO = 1024 * 1024
CODECS_VIDEO = {"h264", "hevc", "vp8", "vp9", "av1", "mpeg4"}
CODECS_AUDIO = {"aac", "opus", "vorbis", "mp3", "pcm_s16le", "amr_nb", "amr_wb", "alac", "flac"}
# Revue de sécurité B6 : décodeurs permis (noms ffmpeg), imposés à ffprobe et ffmpeg ; toute autre piste reste fermée.
DECODEURS = "h264,hevc,vp8,vp9,av1,libdav1d,mpeg4,aac,alac,flac,mp3,mp3float,opus,libopus,vorbis,pcm_s16le,amrnb,amrwb"
# Revue de sécurité B5 : rien n'est décodé au-delà de cette durée, quoi qu'annonce le fichier (secondes).
DUREE_DECODAGE_MAX = 1800
# Temps de calcul maximal d'un processus ffmpeg (tous fils confondus) : au-delà, il est arrêté.
CPU_MAX_S = 4 * 3600
DIMENSION_MAX = 4096


class FichierRefuse(Exception):
    """Le fichier n'est pas une vidéo acceptable ; `raison` correspond à core.videos.failure_reason."""

    def __init__(self, raison: str, detail: str = ""):
        super().__init__(f"{raison} {detail}".strip())
        self.raison = raison


def _limites(memoire_mo: int):
    def appliquer():
        resource.setrlimit(resource.RLIMIT_AS, (memoire_mo * MO, memoire_mo * MO))
        resource.setrlimit(resource.RLIMIT_FSIZE, (4096 * MO, 4096 * MO))
        resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_MAX_S, CPU_MAX_S))
    return appliquer


def journal_erreurs():
    """Fichier temporaire pour les messages d'erreur de ffmpeg (B5) : un tuyau non lu se remplirait (64 Kio) et
    bloquerait ffmpeg, donc le worker, sur une vidéo piégée."""
    return tempfile.TemporaryFile()


def lire_erreurs(p: subprocess.Popen) -> str:
    """Fin des messages d'erreur d'un processus lancé avec journal_erreurs(), puis referme le fichier."""
    f = getattr(p, "journal_erreurs", None)
    if f is None or f.closed:
        return ""
    f.seek(0, 2)
    f.seek(max(0, f.tell() - 300))
    texte = f.read().decode("utf-8", "replace")
    f.close()
    return texte


def format_impose(chemin: Path) -> str:
    """Démultiplexeur à imposer d'après les premiers octets ; refuse tout le reste."""
    with open(chemin, "rb") as f:
        debut = f.read(12)
    if debut[:4] == b"\x1a\x45\xdf\xa3":
        return "matroska"
    if len(debut) >= 8 and debut[4:8] in (b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip"):
        return "mov"
    raise FichierRefuse("not_a_video", "signature inconnue")


FILS = "4"   # fils de calcul : prévisible quel que soit le nombre de cœurs du serveur


def entree(chemin: Path) -> list[str]:
    fmt = format_impose(chemin)
    return ["-threads", FILS, "-protocol_whitelist", "file", "-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm",
            "-codec_whitelist", DECODEURS, "-f", fmt, "-i", str(chemin)]


@dataclass(frozen=True)
class Infos:
    duree: float
    largeur: int    # après rotation
    hauteur: int
    codec_video: str
    audio: bool     # une piste audio utilisable
    cadence: float = 30.0   # images par seconde de la sortie (celle de la source, 60 au plus)


def sonder(chemin: Path, duree_max: int) -> Infos:
    """Vérifie le fichier avec ffprobe ; lève FichierRefuse s'il n'est pas acceptable."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", *entree(chemin)],
            capture_output=True, text=True, timeout=60, preexec_fn=_limites(1024), stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise FichierRefuse("unreadable", "ffprobe trop long")
    if r.returncode != 0:
        raise FichierRefuse("unreadable", r.stderr[-300:])
    try:
        d = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise FichierRefuse("unreadable", "sortie ffprobe illisible")
    flux = d.get("streams", [])
    video = next((s for s in flux if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    if video is None:
        raise FichierRefuse("not_a_video", "aucune piste vidéo")
    if video.get("codec_name") not in CODECS_VIDEO:
        raise FichierRefuse("unsupported_format", str(video.get("codec_name")))
    try:
        duree = float(d.get("format", {}).get("duration") or video.get("duration"))
    except (TypeError, ValueError):
        raise FichierRefuse("unreadable", "durée inconnue")
    if duree <= 0:
        raise FichierRefuse("unreadable", "durée nulle")
    if duree > duree_max + 1:
        raise FichierRefuse("too_long", f"{duree:.0f} s")
    l, h = int(video.get("width") or 0), int(video.get("height") or 0)
    if l <= 0 or h <= 0:
        raise FichierRefuse("unreadable", "dimensions inconnues")
    if l > DIMENSION_MAX or h > DIMENSION_MAX:
        raise FichierRefuse("too_large", f"{l}x{h}")
    rotation = 0
    for sd in video.get("side_data_list", []):
        if "rotation" in sd:
            rotation = abs(int(sd["rotation"])) % 180
    if rotation == 90:
        l, h = h, l
    audio = any(s.get("codec_type") == "audio" and s.get("codec_name") in CODECS_AUDIO for s in flux)
    return Infos(duree=duree, largeur=l, hauteur=h, codec_video=video["codec_name"], audio=audio,
                 cadence=_cadence(video.get("avg_frame_rate") or video.get("r_frame_rate")))


def _cadence(texte) -> float:
    """« 30000/1001 » → 29.97 ; bornée entre 1 et 60 (les téléphones filment parfois à cadence variable)."""
    try:
        n, _, d = str(texte).partition("/")
        valeur = float(n) / float(d or 1)
    except (ValueError, ZeroDivisionError):
        valeur = 30.0
    return min(60.0, max(1.0, valeur)) if valeur == valeur else 30.0


def boite(infos: Infos, petit_cote: int) -> tuple[int, int]:
    """Dimensions de sortie : le petit côté réduit à `petit_cote` (jamais agrandi), proportions gardées, pairs."""
    echelle = min(1.0, petit_cote / min(infos.largeur, infos.hauteur))
    pair = lambda x: max(2, int(round(x * echelle / 2)) * 2)
    return pair(infos.largeur), pair(infos.hauteur)


def decoder(source: Path, largeur: int, hauteur: int, cadence: float):
    """Lance ffmpeg qui décode la vidéo en images brutes BGR (largeur × hauteur, cadence constante),
    envoyées sur sa sortie standard. Renvoie le processus (lire `stdout` par blocs de l×h×3 octets)."""
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", *entree(source), "-map", "0:v:0",
           "-filter_threads", FILS, "-vf", f"fps={cadence:.6f},scale={largeur}:{hauteur}:flags=bicubic,setsar=1",
           "-t", str(DUREE_DECODAGE_MAX), "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
    journal = journal_erreurs()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=journal, preexec_fn=_limites(4096),
                         stdin=subprocess.DEVNULL, bufsize=largeur * hauteur * 3)
    p.journal_erreurs = journal
    return p


def images_grises(source: Path, cadence: int, largeur: int, hauteur: int):
    """Décode la vidéo en images brutes en niveaux de gris ; renvoie les images une par une."""
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", *entree(source), "-map", "0:v:0",
           "-filter_threads", FILS, "-vf", f"fps={cadence},scale={largeur}:{hauteur}",
           "-t", str(DUREE_DECODAGE_MAX), "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]
    taille = largeur * hauteur
    journal = journal_erreurs()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=journal, preexec_fn=_limites(4096),
                         stdin=subprocess.DEVNULL, bufsize=taille)
    p.journal_erreurs = journal
    try:
        while len(brut := p.stdout.read(taille)) == taille:
            yield brut
        p.wait(timeout=60)
        erreur = lire_erreurs(p)
    finally:
        if p.poll() is None:
            p.kill()
            p.wait()
        p.stdout.close()
        lire_erreurs(p)
    if p.returncode != 0:
        raise RuntimeError(f"décodage pour les empreintes : {erreur!r}")


def son_chromaprint(source: Path) -> bytes | None:
    """Empreinte du son (entiers 32 bits), ou None si elle ne peut pas être calculée."""
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", *entree(source), "-map", "0:a:0",
           "-ac", "1", "-ar", "44100", "-t", str(DUREE_DECODAGE_MAX), "-f", "chromaprint", "-fp_format", "raw", "pipe:1"]
    r = subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL, timeout=600, preexec_fn=_limites(4096))
    return r.stdout if r.returncode == 0 and r.stdout else None


def encodeur(source: Path, sortie: Path, largeur: int, hauteur: int, cadence: float, crf: int, preset: str,
             garder_son: bool, infos: Infos):
    """Lance ffmpeg qui encode les images brutes BGR reçues sur son entrée standard, avec le son de la
    source (ou sans), et AUCUNE métadonnée. Renvoie le processus (écrire dans `stdin`)."""
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{largeur}x{hauteur}", "-framerate", f"{cadence:.6f}", "-i", "pipe:0"]
    if garder_son and infos.audio:
        cmd += [*entree(source), "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "aac", "-b:a", "128k", "-ac", "2"]
    else:
        cmd += ["-map", "0:v:0", "-an"]
    cmd += ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p", "-threads", FILS,
            "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
            "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
            "-metadata:s", "handler_name=", "-t", str(DUREE_DECODAGE_MAX), "-movflags", "+faststart", str(sortie)]
    journal = journal_erreurs()
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=journal, preexec_fn=_limites(4096))
    p.journal_erreurs = journal
    return p
