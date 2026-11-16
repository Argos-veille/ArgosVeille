"""Réglages du système de confiance.

Valeurs de départ du document de conception : le simulateur sert justement
à vérifier qu'elles tiennent, et à les ajuster sinon.
"""
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Parametres:
    # Score de confiance caché
    score_initial: float = 1.0
    score_min: float = 0.2
    score_max: float = 10.0
    score_osint: float = 3.0        # score de départ des analystes OSINT vérifiés par l'administrateur
    jours_novice: int = 30          # durée pendant laquelle le poids est réduit
    facteur_novice: float = 0.5     # poids multiplié par ce facteur pendant cette durée

    # Relecture
    taille_echantillon: int = 15    # relecteurs tirés au sort au départ
    taille_elargissement: int = 15  # relecteurs ajoutés quand il en faut plus
    elargissements_max: int = 1     # élargissements pour un vote serré
    delai_max_jours: int = 7        # au-delà, la vidéo est tranchée ou reste sans décision

    # Décision (part du poids des votes « valide »)
    seuil_publication: float = 0.70
    seuil_rejet: float = 0.30
    poids_min_decision: float = 15.0

    # Évolution du score
    seuil_consensus: float = 0.80   # en dessous, aucun score ne bouge
    gain: float = 0.1               # gain de base, qui ralentit en approchant du plafond
    perte: float = 0.3
    jours_avant_decroissance: int = 14
    decroissance: float = 0.01      # part de l'écart au score initial résorbée par jour d'inactivité

    # Mode de calcul du score
    mode_score: str = "cumul"       # "cumul" : gains et pertes ; "precision" : taux de bonnes réponses estimé
    prior_bonnes: float = 7.0       # hypothèse de départ : 7 bonnes réponses...
    prior_total: float = 10.0       # ...sur 10 (fiabilité supposée 70 %)
    memoire: float = 1.0            # < 1 : les votes anciens s'effacent (0,98 ≈ mémoire de 50 votes)
    poids_controle: float = 3.0     # une vidéo de contrôle compte comme 3 observations

    # Vidéos de contrôle (bonne réponse connue)
    taux_controle: float = 0.05
    perte_controle: float = 0.3     # sanction d'une erreur sur un contrôle

    # Tirage des relecteurs
    tirage: str = "connectes"       # "connectes" : parmi les présents ; "tous" : convocation de n'importe quel compte
    delai_convocation: int = 2      # jours laissés à un compte convoqué avant de tirer quelqu'un d'autre
    surconvocation: float = 3.0     # convocations envoyées par place à pourvoir (beaucoup ne répondent pas)
    relectures_max_par_jour: int = 5
    plafond_reputation: bool = False  # si vrai, le plafond monte avec le score jusqu'à plafond_max
    plafond_max: int = 5

    # Jury de second examen pour les vidéos contestées
    jury_actif: bool = False
    jury_taille: int = 7
    jury_majorite: float = 6 / 7    # part des votes du jury nécessaire pour trancher
    jury_votes_min: int = 5
    jury_part_eligible: float = 0.10  # les comptes les mieux notés...
    jury_anciennete_jours: int = 60   # ...ayant au moins cette ancienneté
    jury_max_par_fenetre: int = 2     # jurys par juré...
    jury_fenetre_jours: int = 7       # ...sur cette période glissante
    jury_delai_jours: int = 5
    jury_surconvocation: float = 3.0  # convocations par place de juré (1 = pas de course à la réponse)
    jury_delai_convocation: int = 2   # jours laissés à un juré convoqué
    jury_plancher_publication: float = 0.0  # le jury ne publie que si le premier tour a atteint ce ratio
    jury_double_publication: bool = False   # une publication par le jury doit être confirmée par un second jury

    # Détection des comptes qui se retrouvent minoritaires ensemble à répétition
    detection_collusion: bool = False
    collusion_seuil: int = 3        # nombre de minorités partagées par une paire avant signalement
    facteur_suspect: float = 0.25   # poids d'un compte signalé (et exclu du jury)

    def en_dict(self) -> dict:
        return asdict(self)
