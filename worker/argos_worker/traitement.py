"""Traitement d'une vidéo : vérification, détection des visages, aperçu rapide, version définitive.

Tous les visages sont masqués (masques pleins et opaques), y compris ceux des policiers ; les
matricules RIO et les plaques ne le sont jamais automatiquement. Les sorties ne contiennent aucune
métadonnée. Produit, dans <floutees>/<id>/ :
  apercu.mp4   480p, encodé vite : la source vérifie dessus sans attendre
  video.mp4    1080p au plus, version définitive (son empreinte SHA-256 est enregistrée)
Les deux sont des MP4 « faststart », lus directement par le navigateur (requêtes partielles) : pas de
découpage HLS, inutile avec une seule qualité et qui doublerait le stockage.
"""
import hashlib
import shutil
from dataclasses import dataclass
from pathlib import Path

from . import detection, empreintes, ffmpeg

UUID_LONGUEUR = 36


@dataclass(frozen=True)
class Resultat:
    sha256: bytes
    apercu: Path
    video: Path
    pistes: list   # pistes de visages floutés (detection.Masques.exporter)
    duree: float   # secondes
    signes: empreintes.Empreintes | None = None   # empreintes pour repérer les doublons


def traiter(source: Path, dossier: Path, garder_son: bool, duree_max: int, avancement=lambda x: None,
            masquer: bool = True) -> Resultat:
    """Lève ffmpeg.FichierRefuse si le fichier n'est pas acceptable."""
    infos = ffmpeg.sonder(source, duree_max)
    dossier.mkdir(parents=True, exist_ok=True)
    apercu, video = dossier / "apercu.mp4", dossier / "video.mp4"
    # Détection (0 → 40 %), aperçu (40 → 55 %), puis version définitive (55 → 100 %). Les mêmes
    # masques servent aux deux sorties.
    # Sans masquage (choix de la source : vidéo déjà floutée ou déjà publique), pas de détection.
    masques = detection.Masques(detection.analyser(source, infos, lambda x: avancement(0.40 * x)) if masquer else [])
    detection.rendre(source, apercu, infos, 480, crf=28, preset="veryfast", garder_son=garder_son, masques=masques,
                     avancement=lambda x: avancement(0.40 + 0.15 * x))
    detection.rendre(source, video, infos, 1080, crf=23, preset="faster", garder_son=garder_son, masques=masques,
                     avancement=lambda x: avancement(0.55 + 0.45 * x))
    # Empreintes sur la version FLOUTÉE (second audit, E1, décision de l’administrateur) : plus rien n'est calculé sur la copie non
    # floutée. Le son de la version floutée est celui de l'envoi, sauf si la source l'a retiré.
    signes = empreintes.calculer(video, avec_son=garder_son and infos.audio)
    avancement(1.0)
    h = hashlib.sha256()
    with open(video, "rb") as f:
        for bloc in iter(lambda: f.read(1024 * 1024), b""):
            h.update(bloc)
    return Resultat(sha256=h.digest(), apercu=apercu, video=video, pistes=masques.exporter(), duree=infos.duree,
                    signes=signes)


def retoucher(source: Path, dossier: Path, garder_son: bool, duree_max: int, masques: detection.Masques,
              avancement=lambda x: None) -> Resultat:
    """Nouveau rendu après une retouche de la source, sans refaire la détection. Les nouvelles versions
    sont produites à côté, puis remplacent les anciennes d'un coup : un échec laisse les anciennes."""
    infos = ffmpeg.sonder(source, duree_max)
    neuf = dossier.with_name(dossier.name + ".retouche")
    effacer(neuf)
    neuf.mkdir(parents=True)
    try:
        detection.rendre(source, neuf / "apercu.mp4", infos, 480, crf=28, preset="veryfast", garder_son=garder_son,
                         masques=masques, avancement=lambda x: avancement(0.25 * x))
        detection.rendre(source, neuf / "video.mp4", infos, 1080, crf=23, preset="faster", garder_son=garder_son,
                         masques=masques, avancement=lambda x: avancement(0.25 + 0.75 * x))
        h = hashlib.sha256()
        with open(neuf / "video.mp4", "rb") as f:
            for bloc in iter(lambda: f.read(1024 * 1024), b""):
                h.update(bloc)
        dossier.mkdir(parents=True, exist_ok=True)
        for nom in ("apercu.mp4", "video.mp4"):
            (neuf / nom).replace(dossier / nom)
    finally:
        effacer(neuf)
    avancement(1.0)
    return Resultat(sha256=h.digest(), apercu=dossier / "apercu.mp4", video=dossier / "video.mp4", pistes=[],
                    duree=infos.duree)


def refluter(source: Path, dossier: Path, garder_son: bool, duree_max: int,
             zones: list[tuple[float, float, detection.Boite, detection.Boite]], avancement=lambda x: None) -> Resultat:
    """Re-floutage par l'administration : la version floutée actuelle (`source`) réencodée avec des zones de flou
    en plus (jamais en moins : il n'y a plus d'image nette). Même remplacement d'un coup que la retouche."""
    return retoucher(source, dossier, garder_son, duree_max, detection.Masques([], zones), avancement)


def effacer(dossier: Path) -> None:
    shutil.rmtree(dossier, ignore_errors=True)
