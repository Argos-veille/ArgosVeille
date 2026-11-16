"""Lancement : .venv/bin/python -m argos_worker (depuis worker/, réglages dans worker/.env)."""
import logging
import os
from pathlib import Path

from . import journaux
from .boucle import tourner
from .config import lire_config, lire_fichier_env

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
journaux.installer()   # aucun identifiant de vidéo dans les journaux (audit H9)
env = {**lire_fichier_env(Path(__file__).resolve().parent.parent / ".env"), **os.environ}
tourner(lire_config(env))
