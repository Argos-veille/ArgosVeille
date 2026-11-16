"""Calcule les empreintes manquantes des vidéos déjà traitées, à partir de leur version floutée.

    cd worker && .venv/bin/python -m outils.rattraper_empreintes

Ne traite que les versions présentes sur le disque du worker (floutees/<id>/video.mp4).
"""
import logging
import os
from pathlib import Path

from argos_worker import boucle, doublons, empreintes
from argos_worker.config import lire_config, lire_fichier_env


def rattraper(cx, floutees: Path) -> tuple[int, int]:
    faites = absentes = 0
    for (vid,) in cx.execute("SELECT v::text FROM core.fingerprints_missing(1000) v").fetchall():
        video = floutees / vid / "video.mp4"
        if not video.exists():
            absentes += 1
            continue
        e = empreintes.calculer(video, avec_son=True)
        if e is not None and empreintes.enregistrer(cx, vid, e, "blurred"):
            doublons.apres_enregistrement(cx, vid)
            faites += 1
    return faites, absentes


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    env = {**lire_fichier_env(Path(__file__).resolve().parent.parent / ".env"), **os.environ}
    config = lire_config(env)
    with boucle.connexion(config) as cx:
        faites, absentes = rattraper(cx, config.floutees)
    print(f"{faites} empreinte(s) calculée(s), {absentes} vidéo(s) absente(s) du disque")
