"""Empreintes d'une vidéo, pour repérer les doublons.

Choix mesurés le 9 novembre 2026 sur de vraies vidéos et leurs copies abîmées : l'empreinte visuelle et
le son se complètent (69 copies retrouvées sur 72), le mouvement de la caméra sert de secours quand le
son manque et que l'image est recadrée. On ne reconnaît personne et rien ne permet de revoir la vidéo.
"""
import logging
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from . import ffmpeg

journal = logging.getLogger("argos_worker")
VERSION = 1
VISUEL_PAR_SECONDE = 4
COTE_VISUEL = 32
CAMERA_PAR_SECONDE = 10
CAMERA_L, CAMERA_H = 160, 90
DEPLACEMENT_MAX = 40.0   # pixels entre deux images : au-delà, c'est une coupure, pas un mouvement


@dataclass(frozen=True)
class Empreintes:
    visuel: bytes                # 8 octets par image analysée
    visuel_miroir: bytes         # idem, image retournée
    son: bytes | None            # Chromaprint, entiers 32 bits (absent : pas de son, ou son retiré par la source)
    camera: bytes | None         # déplacement (x, y) entre deux images, flottants 32 bits


def _hash_perceptuel(image: np.ndarray) -> bytes:
    """Compare les basses fréquences de l'image à leur médiane (63 bits, sans la composante continue)."""
    frequences = cv2.dct(image.astype(np.float32))[:8, :8].ravel()[1:]
    return np.packbits(frequences > np.median(frequences)).tobytes()


def _visuel(source: Path) -> tuple[bytes, bytes]:
    normal, miroir = [], []
    for brut in ffmpeg.images_grises(source, VISUEL_PAR_SECONDE, COTE_VISUEL, COTE_VISUEL):
        image = np.frombuffer(brut, np.uint8).reshape(COTE_VISUEL, COTE_VISUEL)
        normal.append(_hash_perceptuel(image))
        miroir.append(_hash_perceptuel(image[:, ::-1]))
    return b"".join(normal), b"".join(miroir)


def _camera(source: Path) -> bytes | None:
    fenetre = cv2.createHanningWindow((CAMERA_L, CAMERA_H), cv2.CV_32F)
    precedente = None
    deplacements = []
    for brut in ffmpeg.images_grises(source, CAMERA_PAR_SECONDE, CAMERA_L, CAMERA_H):
        image = np.frombuffer(brut, np.uint8).reshape(CAMERA_H, CAMERA_L).astype(np.float32)
        if precedente is not None:
            deplacements.append(cv2.phaseCorrelate(precedente, image, fenetre)[0])
        precedente = image
    if not deplacements:
        return None
    return np.clip(np.array(deplacements, "<f4"), -DEPLACEMENT_MAX, DEPLACEMENT_MAX).tobytes()


def calculer(source: Path, avec_son: bool) -> Empreintes | None:
    """Renvoie None en cas d'échec : une empreinte manquante ne doit jamais bloquer le traitement."""
    try:
        visuel, miroir = _visuel(source)
        if not visuel:
            return None
        return Empreintes(visuel, miroir, ffmpeg.son_chromaprint(source) if avec_son else None, _camera(source))
    except Exception:
        journal.exception("calcul des empreintes impossible")
        return None


def enregistrer(cx, video: str, e: Empreintes, origine: str) -> bool:
    return bool(cx.execute("SELECT core.save_fingerprints(%s, %s::smallint, %s, %s, %s, %s, %s)",
                           (video, VERSION, origine, e.visuel, e.visuel_miroir, e.son, e.camera)).fetchone()[0])
