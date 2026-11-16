"""Vidéos simulées, dont la vraie nature est connue du simulateur seulement."""
import random
from dataclasses import dataclass, field
from typing import Optional

# Nature -> bonne réponse (True = la vidéo devrait être publiée, None = cas ambigu,
# où la bonne issue est « contestée »).
NATURES = {
    "authentique": True,
    "fausse": False,
    "ancienne": False,
    "ambigue": None,
}

STATUTS_FINAUX = ("publiee", "rejetee", "contestee", "sans_decision")


@dataclass
class Vote:
    uid: int
    valide: bool
    poids: float  # poids au moment du vote


@dataclass
class Video:
    id: int
    nature: str
    difficulte: float
    auteur: int
    jour_arrivee: int
    places: int
    est_controle: bool = False
    cible: bool = False   # visée par les attaquants (leurs fausses, ou une vraie à faire tomber)
    relecteurs: set = field(default_factory=set)
    votes: list = field(default_factory=list)
    elargissements: int = 0
    statut: str = "en_attente"
    jour_decision: Optional[int] = None
    ratio_final: Optional[float] = None
    etape: str = "relecture"          # puis "jury" si la vidéo est contestée
    convocations: dict = field(default_factory=dict)  # uid -> jour d'expiration
    votes_jury: list = field(default_factory=list)
    votes_jury_precedents: list = field(default_factory=list)  # premier jury, en cas de double jury
    jour_jury: Optional[int] = None
    ratio_premier_tour: Optional[float] = None

    @property
    def verite(self) -> Optional[bool]:
        return NATURES[self.nature]

    def poids_total(self) -> float:
        return sum(v.poids for v in self.votes)

    def ratio_valide(self) -> float:
        total = self.poids_total()
        if total == 0:
            return 0.5
        return sum(v.poids for v in self.votes if v.valide) / total


def creer_video(vid: int, nature: str, auteur: int, jour: int, places: int,
                rng: random.Random, est_controle: bool = False, cible: bool = False) -> Video:
    # Une vidéo ambiguë est indécidable même pour un relecteur parfait.
    difficulte = 1.0 if nature == "ambigue" else rng.uniform(0.0, 0.6)
    if est_controle:
        difficulte = rng.uniform(0.0, 0.3)  # contrôles choisis sans ambiguïté
    return Video(id=vid, nature=nature, difficulte=difficulte, auteur=auteur,
                 jour_arrivee=jour, places=places, est_controle=est_controle, cible=cible)
