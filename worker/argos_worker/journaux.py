"""Journaux du worker sans identifiant de vidéo (audit du 15 novembre 2026, H9).

journald garde chaque ligne avec son heure à la seconde : un identifiant de vidéo à côté, rapproché du journal légal
(adresse IP de chaque envoi, à la seconde), relierait une adresse IP à une vidéo publiée. Le filtre remplace tout
identifiant (UUID) par « <vidéo> », dans le message, ses arguments et la trace d'une erreur (chemins de fichiers compris).
"""
import logging
import re

# Avec ou sans tirets (32 chiffres hexadécimaux d'affilée : un identifiant écrit sans ses tirets).
UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|(?<![0-9a-fA-F])[0-9a-fA-F]{32}(?![0-9a-fA-F])")


def sans_identifiant(texte: str) -> str:
    return UUID.sub("<vidéo>", texte)


class SansIdentifiant(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = sans_identifiant(record.getMessage())
        record.args = None
        if record.exc_info:
            record.exc_text = sans_identifiant(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        if record.stack_info:
            record.stack_info = sans_identifiant(record.stack_info)
        return True


def installer() -> None:
    """À appeler après logging.basicConfig : chaque sortie du worker passe par le filtre, y compris les exceptions non
    rattrapées (processus et fils d'exécution) et les avertissements Python (relecture croisée)."""
    import sys
    import threading
    for h in logging.getLogger().handlers:
        h.addFilter(SansIdentifiant())
    logging.captureWarnings(True)
    racine = logging.getLogger("argos_worker")

    def non_rattrapee(type_, valeur, trace):
        racine.error("exception non rattrapée", exc_info=(type_, valeur, trace))

    sys.excepthook = non_rattrapee
    threading.excepthook = lambda a: non_rattrapee(a.exc_type, a.exc_value, a.exc_traceback)
    # Exceptions « ignorées » (dans __del__, au ramasse-miettes) : sinon écrites telles quelles sur la sortie d'erreur.
    sys.unraisablehook = lambda u: racine.error("exception ignorée", exc_info=(u.exc_type, u.exc_value, u.exc_traceback))
