"""Scénarios de simulation : population honnête, puis attaques."""
from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class Vague:
    """Groupe de comptes qui arrive d'un coup (attaquants)."""
    profil: str
    nombre: int
    jour: int = 0
    jour_attaque: Optional[int] = None


@dataclass(frozen=True)
class Scenario:
    nom: str
    description: str
    jours: int = 180
    population_initiale: int = 2000
    inscriptions_par_jour: int = 10
    videos_par_jour: int = 20
    taux_passe: float = 0.15           # relecteur qui passe son tour
    profils: dict = field(default_factory=lambda: {
        "attentif": 0.60, "distrait": 0.30, "hasard": 0.10})
    natures: dict = field(default_factory=lambda: {
        "authentique": 0.60, "fausse": 0.15, "ancienne": 0.15, "ambigue": 0.10})
    vagues: tuple = ()
    fausses_attaquants_par_jour: int = 0
    jour_debut_fausses: int = 0
    taux_cible_authentiques: float = 0.0   # part des vraies vidéos que les attaquants veulent faire tomber


SCENARIOS = {
    "honnetes": Scenario(
        nom="honnetes",
        description="Lancement avec une population honnête : attentifs, distraits, votants au hasard.",
    ),
    "robots": Scenario(
        nom="robots",
        description="Jour 60 : 500 comptes robots créés d'un coup votent systématiquement à l'envers "
                    "et soumettent 5 fausses vidéos par jour.",
        vagues=(Vague("robot", 500, jour=60),),
        fausses_attaquants_par_jour=5, jour_debut_fausses=60,
    ),
    "brigade": Scenario(
        nom="brigade",
        description="200 comptes coordonnés dès le lancement (environ 5 %), honnêtes sauf sur leurs cibles : "
                    "30 % des vraies vidéos et leurs propres fausses (5 par jour dès le jour 30).",
        vagues=(Vague("brigade", 200, jour=0),),
        fausses_attaquants_par_jour=5, jour_debut_fausses=30, taux_cible_authentiques=0.30,
    ),
    "dormants": Scenario(
        nom="dormants",
        description="200 comptes très fiables et très actifs dès le lancement, qui passent tous à l'attaque "
                    "au jour 120 et soumettent alors 10 fausses vidéos par jour.",
        vagues=(Vague("dormant", 200, jour=0, jour_attaque=120),),
        fausses_attaquants_par_jour=10, jour_debut_fausses=120,
    ),
    "partisans": Scenario(
        nom="partisans",
        description="Aucun attaquant, mais 30 % d'honnêtes qui penchent d'un côté en cas de doute : "
                    "20 % vers « invalide », 10 % vers « valide ».",
        profils={"attentif": 0.40, "distrait": 0.20, "hasard": 0.10,
                 "partisan_contre": 0.20, "partisan_pour": 0.10},
    ),
    "tout": Scenario(
        nom="tout",
        description="Partisans, brigade, robots et dormants en même temps.",
        profils={"attentif": 0.40, "distrait": 0.20, "hasard": 0.10,
                 "partisan_contre": 0.20, "partisan_pour": 0.10},
        vagues=(Vague("brigade", 200, jour=0), Vague("dormant", 200, jour=0, jour_attaque=120),
                Vague("robot", 500, jour=60)),
        fausses_attaquants_par_jour=10, jour_debut_fausses=30, taux_cible_authentiques=0.30,
    ),
    "infiltres": Scenario(
        nom="infiltres",
        description="300 infiltrés irréprochables au premier tour, qui n'attaquent qu'au jury ; "
                    "cibles : 30 % des vraies vidéos et leurs fausses (5 par jour dès le jour 30).",
        vagues=(Vague("infiltre", 300, jour=0),),
        fausses_attaquants_par_jour=5, jour_debut_fausses=30, taux_cible_authentiques=0.30,
    ),
    "tout+infiltres": Scenario(
        nom="tout+infiltres",
        description="Toutes les attaques, plus 300 infiltrés.",
        profils={"attentif": 0.40, "distrait": 0.20, "hasard": 0.10,
                 "partisan_contre": 0.20, "partisan_pour": 0.10},
        vagues=(Vague("brigade", 200, jour=0), Vague("dormant", 200, jour=0, jour_attaque=120),
                Vague("robot", 500, jour=60), Vague("infiltre", 300, jour=0)),
        fausses_attaquants_par_jour=10, jour_debut_fausses=30, taux_cible_authentiques=0.30,
    ),
}
