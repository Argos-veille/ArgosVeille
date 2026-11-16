"""Score du masquage sur un jeu d'images annotées à la main (vidéos réelles, gardées hors du dépôt).

    cd worker
    .venv/bin/python -m outils.evaluer_masquage essais-reels/annotation

Le dossier d'annotation contient :
  candidats.json : pour chaque image (vidéo, instant), les candidats d'un détecteur très sensible ;
  etiquettes.py  : E = {image: {"F": [faux positifs], "N": [neutres], "manques": [[x, y, l, h], ...]}}.
Vérité : un candidat examiné (≥ 4 % du petit côté) qui n'est ni F ni N est un vrai visage ; il est
« proche » (à masquer) s'il fait au moins 5 % du petit côté. S'y ajoutent les visages manqués.

La détection tourne une fois par vidéo (seuil très bas, rien filtré) et est mise en cache ; chaque
réglage est ensuite rejoué en quelques secondes sur ces détections brutes.
"""
import importlib.util
import json
import pickle
import sys
from dataclasses import replace
from pathlib import Path

from argos_worker import detection, ffmpeg

RACINE_ESSAIS = Path("essais-reels")


def charger(dossier: Path):
    c = json.load(open(dossier / "candidats.json"))
    spec = importlib.util.spec_from_file_location("etiquettes", dossier / "etiquettes.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return c, m.E


def detections_brutes(dossier: Path, video: str):
    """Détections de toute la vidéo, seuil 0,3, sans filtre de taille (cache)."""
    cache = dossier / f"cache-{abs(hash(video)) % 10**8}.pkl"
    if cache.exists():
        return pickle.load(open(cache, "rb"))
    src = RACINE_ESSAIS / video
    infos = ffmpeg.sonder(src, 1200)
    seuil, tmax = detection.SEUIL, detection.TAILLE_MAX
    detection.SEUIL, detection.TAILLE_MAX = 0.3, 10.0
    try:
        brutes = detection.analyser(src, infos)
    finally:
        detection.SEUIL, detection.TAILLE_MAX = seuil, tmax
    pickle.dump(brutes, open(cache, "wb"))
    return brutes


def recouvre(masques: list, boite: tuple[float, float, float, float], l: int, h: int) -> float:
    """Part de l'ovale de la boîte (pixels) couverte par l'union des ellipses de masque."""
    import numpy as np
    x, y, bw, bh = boite
    yy, xx = np.mgrid[0:max(1, int(bh)), 0:max(1, int(bw))]
    px, py = x + xx + 0.5, y + yy + 0.5
    ovale = ((xx + 0.5 - bw / 2) / (bw / 2)) ** 2 + ((yy + 0.5 - bh / 2) / (bh / 2)) ** 2 <= 1
    couvert = np.zeros_like(ovale)
    for m in masques:
        cx, cy, ax, ay = (m.x + m.l / 2) * l, (m.y + m.h / 2) * h, m.l * l / 2, m.h * h / 2
        couvert |= ((px - cx) / ax) ** 2 + ((py - cy) / ay) ** 2 <= 1
    return float(couvert[ovale].mean()) if ovale.any() else 0.0


def evaluer(dossier: Path, reglage: dict) -> dict:
    c, E = charger(dossier)
    anciens = {k: getattr(detection, k) for k in reglage}
    for k, v in reglage.items():
        setattr(detection, k, v)
    try:
        par_video = {}
        for cle, x in c.items():
            par_video.setdefault(x["video"], []).append(cle)
        proches = couverts = masques_total = masques_faux = 0
        for video, cles in par_video.items():
            brutes = detections_brutes(dossier, video)
            filtrees = [(t, [d for d in ds if d.score >= detection.SEUIL
                             and not (d.taille > detection.TAILLE_MAX and d.score < detection.SEUIL_SUR)])
                        for t, ds in brutes]
            m = detection.Masques(filtrees)
            for cle in cles:
                x, e = c[cle], E.get(cle, {})
                l, h = x["largeur"], x["hauteur"]
                petit = min(l, h)
                exclus = set(e.get("F", [])) | set(e.get("N", []))
                vrais = [b for i, b in enumerate(x["candidats"]) if i in x["a_examiner"] and i not in exclus]
                cibles = [b[:4] for b in vrais if b[2] / petit >= detection.TAILLE_MIN] + e.get("manques", [])
                ms = m.a(x["t"])
                for b in cibles:
                    proches += 1
                    couverts += recouvre(ms, b, l, h) >= 0.8
                # Masque en trop : son centre ne tombe sur aucun visage (candidat non F, toutes tailles,
                # ou neutre, ou manqué).
                visages = [b for i, b in enumerate(x["candidats"]) if i not in set(e.get("F", []))] + \
                          [b + [1] for b in e.get("manques", [])]
                for mk in ms:
                    masques_total += 1
                    cx, cy = (mk.x + mk.l / 2) * l, (mk.y + mk.h / 2) * h
                    if not any(b[0] - 0.25 * b[2] <= cx <= b[0] + 1.25 * b[2] and b[1] - 0.25 * b[3] <= cy <= b[1] + 1.25 * b[3]
                               for b in visages):
                        masques_faux += 1
        return {"visages_proches": proches, "masques": couverts, "taux": couverts / proches if proches else 1.0,
                "masques_total": masques_total, "masques_en_trop": masques_faux}
    finally:
        for k, v in anciens.items():
            setattr(detection, k, v)


if __name__ == "__main__":
    dossier = Path(sys.argv[1] if len(sys.argv) > 1 else "essais-reels/annotation")
    r = evaluer(dossier, {})
    print(f"réglage actuel : {r['masques']}/{r['visages_proches']} visages proches masqués ({100 * r['taux']:.0f} %), "
          f"{r['masques_en_trop']} masques en trop sur {r['masques_total']}")
