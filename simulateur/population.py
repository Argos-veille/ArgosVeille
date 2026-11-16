"""Utilisateurs simulés et profils de comportement."""
import random
from dataclasses import dataclass
from typing import Optional

from .parametres import Parametres
from .videos import Video

# fiabilite : probabilité de bien juger une vidéo facile
# connexion : probabilité de se connecter un jour donné
# biais     : côté choisi en cas de doute (True = valide, False = invalide)
PROFILS = {
    "attentif":        {"fiabilite": (0.85, 0.95), "connexion": (0.05, 0.40)},
    "distrait":        {"fiabilite": (0.60, 0.75), "connexion": (0.05, 0.40)},
    "hasard":          {"fiabilite": (0.50, 0.50), "connexion": (0.05, 0.40)},
    "partisan_pour":   {"fiabilite": (0.70, 0.85), "connexion": (0.05, 0.40), "biais": True},
    "partisan_contre": {"fiabilite": (0.70, 0.85), "connexion": (0.05, 0.40), "biais": False},
    "robot":           {"fiabilite": (0.50, 0.50), "connexion": (0.90, 0.90)},
    "brigade":         {"fiabilite": (0.85, 0.95), "connexion": (0.50, 0.80)},
    "dormant":         {"fiabilite": (0.90, 0.97), "connexion": (0.60, 0.90)},
    "infiltre":        {"fiabilite": (0.88, 0.96), "connexion": (0.50, 0.80)},
    # Analystes OSINT vérifiés par l'administrateur : score de départ plus élevé, pas de période de novice.
    "osint":           {"fiabilite": (0.92, 0.98), "connexion": (0.30, 0.60), "osint": True},
    # Les mêmes, compromis (piratés ou retournés) : irréprochables puis attaquent tous au jour donné.
    "osint_compromis": {"fiabilite": (0.92, 0.98), "connexion": (0.30, 0.60), "osint": True},
}

ATTAQUANTS = ("robot", "brigade", "dormant", "infiltre", "osint_compromis")


@dataclass
class Utilisateur:
    id: int
    profil: str
    fiabilite: float
    p_connexion: float
    jour_inscription: int
    score: float
    dernier_vote: int
    biais: Optional[bool] = None
    jour_attaque: Optional[int] = None   # dormants : jour où ils passent à l'attaque
    suspect: bool = False                # signalé par la détection de collusion
    bonnes: float = 0.0                  # mode « precision » : bonnes réponses observées (pondérées)
    evalues: float = 0.0                 # mode « precision » : votes évalués (pondérés)
    osint: bool = False                  # analyste OSINT vérifié : sans période de novice

    def poids(self, jour: int, p: Parametres) -> float:
        novice = not self.osint and jour - self.jour_inscription < p.jours_novice
        poids = self.score * (p.facteur_novice if novice else 1.0)
        return poids * p.facteur_suspect if self.suspect else poids

    def probabilite_correcte(self, difficulte: float) -> float:
        """Plus la vidéo est difficile, plus le jugement se rapproche du hasard."""
        return 0.5 + (self.fiabilite - 0.5) * (1.0 - difficulte)

    def voter(self, v: Video, jour: int, rng: random.Random) -> bool:
        """Renvoie True pour « valide »."""
        verite = v.verite
        # Ce que veulent les attaquants : faire passer leurs fausses vidéos,
        # faire tomber les vraies qu'ils visent, et sinon semer l'erreur.
        if v.cible:
            objectif = v.nature == "fausse"
        else:
            objectif = None if verite is None else not verite
        if objectif is None:
            objectif = rng.random() < 0.5

        if self.profil == "robot":
            return objectif
        if self.profil == "brigade" and v.cible:
            return objectif
        if self.profil in ("dormant", "osint_compromis") and jour >= (self.jour_attaque or 10**9):
            return objectif
        if self.profil == "infiltre" and v.etape == "jury" and v.cible:
            return objectif  # irréprochable au premier tour, n'attaque qu'au jury

        # Comportement honnête, éventuellement penché d'un côté
        if verite is None:
            if self.biais is not None:
                return self.biais if rng.random() < 0.8 else not self.biais
            return rng.random() < 0.5
        if rng.random() < self.probabilite_correcte(v.difficulte):
            return verite
        return self.biais if self.biais is not None else not verite


def creer_utilisateur(uid: int, profil: str, jour: int, p: Parametres,
                      rng: random.Random, jour_attaque: Optional[int] = None) -> Utilisateur:
    d = PROFILS[profil]
    return Utilisateur(
        id=uid,
        profil=profil,
        fiabilite=rng.uniform(*d["fiabilite"]),
        p_connexion=rng.uniform(*d["connexion"]),
        jour_inscription=jour,
        score=p.score_osint if d.get("osint") else p.score_initial,
        dernier_vote=jour,
        osint=bool(d.get("osint")),
        biais=d.get("biais"),
        jour_attaque=jour_attaque,
    )
