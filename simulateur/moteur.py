"""Moteur de simulation : applique jour après jour les règles du document de conception."""
import math
import random

from .parametres import Parametres
from .population import ATTAQUANTS, Utilisateur, creer_utilisateur
from .scenarios import Scenario
from .videos import Video, Vote, creer_video


def _tirer(repartition: dict, rng: random.Random) -> str:
    cles = list(repartition)
    return rng.choices(cles, weights=[repartition[c] for c in cles])[0]


class Simulation:
    def __init__(self, params: Parametres, scenario: Scenario, graine: int = 42):
        self.p = params
        self.sc = scenario
        self.rng = random.Random(graine)
        self.jour = 0
        self.utilisateurs: list[Utilisateur] = []
        self.par_id: dict[int, Utilisateur] = {}
        self.en_attente: list[Video] = []
        self.terminees: list[Video] = []
        self.historique: list[dict] = []   # instantanés des scores par profil
        self.attaquants: list[Utilisateur] = []
        self._prochain_vid = 0
        self._jurys: dict[int, list[int]] = {}   # uid -> jours où il a siégé
        self._jures_eligibles: list[Utilisateur] = []
        self._jures_set: set[int] = set()
        self._minorites_partagees: dict[tuple[int, int], int] = {}
        for _ in range(scenario.population_initiale):
            self._inscrire()

    # --- Population et vidéos -------------------------------------------------

    def _inscrire(self, profil: str | None = None, jour_attaque: int | None = None) -> Utilisateur:
        profil = profil or _tirer(self.sc.profils, self.rng)
        u = creer_utilisateur(len(self.utilisateurs), profil, self.jour, self.p, self.rng,
                              jour_attaque)
        self.utilisateurs.append(u)
        self.par_id[u.id] = u
        if profil in ATTAQUANTS:
            self.attaquants.append(u)
        return u

    def _soumettre(self, nature: str, est_controle: bool = False, cible: bool = False,
                   auteurs: list | None = None) -> None:
        auteur = self.rng.choice(auteurs or self.utilisateurs).id
        v = creer_video(self._prochain_vid, nature, auteur, self.jour,
                        self.p.taille_echantillon, self.rng, est_controle, cible)
        self._prochain_vid += 1
        self.en_attente.append(v)

    # --- Score ----------------------------------------------------------------

    def _gagner(self, u: Utilisateur) -> None:
        p = self.p
        gain = p.gain * max(0.0, p.score_max - u.score) / (p.score_max - p.score_initial)
        u.score = min(p.score_max, u.score + gain)

    def _perdre(self, u: Utilisateur, montant: float | None = None) -> None:
        u.score = max(self.p.score_min, u.score - (self.p.perte if montant is None else montant))

    def _juger(self, u: Utilisateur, correct: bool, controle: bool = False) -> None:
        """Met à jour le score après un vote dont la bonne réponse est connue ou établie."""
        p = self.p
        if p.mode_score == "cumul":
            if correct:
                self._gagner(u)
            else:
                self._perdre(u, p.perte_controle if controle else None)
            return
        poids = p.poids_controle if controle else 1.0
        u.bonnes = u.bonnes * p.memoire + (poids if correct else 0.0)
        u.evalues = u.evalues * p.memoire + poids
        u.score = self._score_precision(u)

    def _score_precision(self, u: Utilisateur) -> float:
        """Poids optimal d'un votant de fiabilité p : log(p / (1 - p)), ramené à 1 pour un nouveau compte."""
        p = self.p
        fiab = (p.prior_bonnes + u.bonnes) / (p.prior_total + u.evalues)
        fiab = min(fiab, 0.999)
        ref = p.prior_bonnes / p.prior_total
        if fiab <= 0.5:
            return p.score_min
        score = math.log(fiab / (1 - fiab)) / math.log(ref / (1 - ref))
        return min(p.score_max, max(p.score_min, score))

    def _plafond(self, u: Utilisateur) -> int:
        p = self.p
        if not p.plafond_reputation:
            return p.relectures_max_par_jour
        part = (u.score - p.score_initial) / (p.score_max - p.score_initial)
        part = min(1.0, max(0.0, part))
        return p.relectures_max_par_jour + round((p.plafond_max - p.relectures_max_par_jour) * part)

    # --- Jury -----------------------------------------------------------------

    def _calculer_jures(self, connectes: set[int]) -> None:
        p = self.p
        anciens = [u for u in self.utilisateurs
                   if self.jour - u.jour_inscription >= p.jury_anciennete_jours and not u.suspect]
        anciens.sort(key=lambda u: (-u.score, self.rng.random()))
        self._jures_eligibles = anciens[:math.ceil(len(anciens) * p.jury_part_eligible)]
        self._jures_set = {u.id for u in self._jures_eligibles}
        self._jures_connectes = [u for u in self._jures_eligibles if u.id in connectes]

    def _peut_jurer(self, u: Utilisateur) -> bool:
        if u.id not in self._jures_set:
            return False
        recents = [j for j in self._jurys.get(u.id, []) if self.jour - j < self.p.jury_fenetre_jours]
        return len(recents) < self.p.jury_max_par_fenetre

    # --- Tirage des relecteurs ------------------------------------------------

    def _echantillon(self, pool: list, n: int, accepte) -> list:
        """Tire jusqu'à n comptes distincts acceptables (tirage par rejet, rapide sur grand pool)."""
        choisis, vus = [], set()
        essais, limite = 0, n * 30 + 50
        while len(choisis) < n and essais < limite and pool:
            essais += 1
            u = self.rng.choice(pool)
            if u.id in vus:
                continue
            vus.add(u.id)
            if accepte(u):
                choisis.append(u)
        return choisis

    def _pourvoir(self, v: Video, connectes: set[int], capacite: dict) -> None:
        p = self.p
        jury = v.etape == "jury"

        def reste(u):
            if u.id not in capacite:
                capacite[u.id] = self._plafond(u)
            return capacite[u.id]

        def eligible(u):
            if u.id == v.auteur or u.id in v.relecteurs:
                return False
            return self._peut_jurer(u) if jury else True

        if p.tirage == "connectes":
            pool = self._jures_connectes if jury else self._connectes
            for u in self._echantillon(pool, v.places, lambda u: eligible(u) and reste(u) > 0):
                v.relecteurs.add(u.id)
                self._agir(u, v, capacite)
            return

        # Convocation : n'importe quel compte peut être tiré, et a quelques jours pour répondre.
        for uid, expiration in list(v.convocations.items()):
            if self.jour > expiration:
                del v.convocations[uid]
        facteur = p.jury_surconvocation if jury else p.surconvocation
        manque = math.ceil(v.places * facteur) - len(v.convocations)
        if manque > 0:
            pool = self._jures_eligibles if jury else self.utilisateurs
            for u in self._echantillon(pool, manque, eligible):
                v.relecteurs.add(u.id)
                delai = p.jury_delai_convocation if jury else p.delai_convocation
                v.convocations[u.id] = self.jour + delai - 1
        for uid in list(v.convocations):
            if v.places <= 0:
                break  # places remplies : les convocations restantes attendent un éventuel élargissement
            u = self.par_id[uid]
            if uid in connectes and reste(u) > 0 and (not jury or self._peut_jurer(u)):
                del v.convocations[uid]
                self._agir(u, v, capacite)

    def _agir(self, u: Utilisateur, v: Video, capacite: dict) -> None:
        capacite[u.id] -= 1
        if v.etape == "jury":
            self._jurys.setdefault(u.id, []).append(self.jour)
            v.relecteurs.add(u.id)
        if self.rng.random() < self.sc.taux_passe:
            return  # passe son tour : la place reste ouverte
        if v.etape == "jury":
            v.votes_jury.append(Vote(u.id, u.voter(v, self.jour, self.rng), 1.0))
            v.places -= 1
            u.dernier_vote = self.jour
        else:
            self._voter(u, v)

    # --- Un jour --------------------------------------------------------------

    def tour(self) -> None:
        rng, p, sc = self.rng, self.p, self.sc

        for _ in range(sc.inscriptions_par_jour):
            self._inscrire()
        for vague in sc.vagues:
            if vague.jour == self.jour:
                for _ in range(vague.nombre):
                    self._inscrire(vague.profil, vague.jour_attaque)

        for _ in range(sc.videos_par_jour):
            nature = _tirer(sc.natures, rng)
            cible = nature == "authentique" and rng.random() < sc.taux_cible_authentiques
            self._soumettre(nature, cible=cible)
            if rng.random() < p.taux_controle:
                self._soumettre(rng.choice(["authentique", "fausse"]), est_controle=True)
        if self.attaquants and self.jour >= sc.jour_debut_fausses:
            for _ in range(sc.fausses_attaquants_par_jour):
                self._soumettre("fausse", cible=True, auteurs=self.attaquants)

        self._connectes = [u for u in self.utilisateurs if rng.random() < u.p_connexion]
        connectes = {u.id for u in self._connectes}
        capacite: dict[int, int] = {}
        if p.jury_actif:
            self._calculer_jures(connectes)

        for v in list(self.en_attente):
            if v.places > 0:
                self._pourvoir(v, connectes, capacite)

        for v in list(self.en_attente):
            if v.etape == "jury":
                if v.places <= 0 or self.jour - v.jour_jury >= p.jury_delai_jours:
                    self._evaluer_jury(v)
                continue
            age = self.jour - v.jour_arrivee
            if v.places <= 0 or age >= p.delai_max_jours:
                self._evaluer(v, age)

        self._decroissance()
        if self.jour % 10 == 0:
            self._instantane()
        self.jour += 1

    def _voter(self, u: Utilisateur, v: Video) -> None:
        verite = v.verite
        valide = u.voter(v, self.jour, self.rng)
        v.votes.append(Vote(u.id, valide, u.poids(self.jour, self.p)))
        v.places -= 1
        u.dernier_vote = self.jour
        if v.est_controle:  # bonne réponse connue : score mis à jour tout de suite
            self._juger(u, valide == verite, controle=True)

    def _evaluer(self, v: Video, age: int) -> None:
        p = self.p
        fin = age >= p.delai_max_jours
        if v.est_controle:
            if v.places <= 0 or fin:
                self._clore(v, "controle")
            return

        r = v.ratio_valide()
        if v.poids_total() >= p.poids_min_decision:
            if r >= p.seuil_publication:
                self._clore(v, "publiee", r)
            elif r <= p.seuil_rejet:
                self._clore(v, "rejetee", r)
            elif v.elargissements < p.elargissements_max and not fin:
                v.elargissements += 1
                v.places += p.taille_elargissement
            else:
                self._contester(v, r)
        elif fin:
            self._clore(v, "sans_decision", r)
        else:
            v.places += p.taille_elargissement  # poids insuffisant : on recrute

    def _contester(self, v: Video, r: float) -> None:
        if not self.p.jury_actif:
            self._clore(v, "contestee", r)
            return
        v.etape = "jury"
        v.ratio_premier_tour = r
        v.places = self.p.jury_taille
        v.convocations = {}
        v.jour_jury = self.jour

    def _evaluer_jury(self, v: Video) -> None:
        p = self.p
        n = len(v.votes_jury)
        if n < p.jury_votes_min:
            self._clore(v, "contestee", v.ratio_premier_tour)
            return
        r = sum(1 for vote in v.votes_jury if vote.valide) / n
        if r >= p.jury_majorite:
            if (v.ratio_premier_tour or 0.0) < p.jury_plancher_publication:
                self._clore(v, "contestee", v.ratio_premier_tour)  # trop peu soutenue au premier tour
            elif p.jury_double_publication and not v.votes_jury_precedents:
                # second jury indépendant (les premiers jurés sont déjà dans v.relecteurs)
                v.votes_jury_precedents = v.votes_jury
                v.votes_jury = []
                v.places = p.jury_taille
                v.convocations = {}
                v.jour_jury = self.jour
            else:
                self._clore(v, "publiee", r, verdict=True)
        elif r <= 1 - p.jury_majorite:
            self._clore(v, "rejetee", r, verdict=False)
        else:
            self._clore(v, "contestee", v.ratio_premier_tour)  # reste « en débat »

    def _clore(self, v: Video, statut: str, r: float | None = None,
               verdict: bool | None = None) -> None:
        v.statut = statut
        v.jour_decision = self.jour
        v.ratio_final = r
        v.convocations = {}
        self.en_attente.remove(v)
        self.terminees.append(v)
        if statut not in ("publiee", "rejetee", "contestee"):
            return
        if verdict is not None:
            # Le jury a tranché nettement : son verdict sert de référence pour tous les votants.
            tous_votes = v.votes + v.votes_jury_precedents + v.votes_jury
            for vote in tous_votes:
                self._juger(self.par_id[vote.uid], vote.valide == verdict)
            self._noter_minorite([vote.uid for vote in tous_votes if vote.valide != verdict])
            return
        # Sinon, seul un consensus net du premier tour fait bouger les scores.
        if r >= self.p.seuil_consensus:
            majorite = True
        elif r <= 1 - self.p.seuil_consensus:
            majorite = False
        else:
            return
        for vote in v.votes:
            self._juger(self.par_id[vote.uid], vote.valide == majorite)
        self._noter_minorite([vote.uid for vote in v.votes if vote.valide != majorite])

    def _noter_minorite(self, uids: list[int]) -> None:
        """Des honnêtes se trompent indépendamment ; une brigade se retrouve minoritaire ensemble."""
        p = self.p
        if not p.detection_collusion:
            return
        uids = sorted(set(uids))[:40]
        for i, a in enumerate(uids):
            for b in uids[i + 1:]:
                n = self._minorites_partagees.get((a, b), 0) + 1
                self._minorites_partagees[(a, b)] = n
                if n >= p.collusion_seuil:
                    self.par_id[a].suspect = True
                    self.par_id[b].suspect = True

    def _decroissance(self) -> None:
        p = self.p
        for u in self.utilisateurs:
            if self.jour - u.dernier_vote > p.jours_avant_decroissance:
                if p.mode_score == "cumul":
                    u.score += (p.score_initial - u.score) * p.decroissance
                else:  # les observations s'effacent : retour vers l'hypothèse de départ
                    u.bonnes *= 1 - p.decroissance
                    u.evalues *= 1 - p.decroissance
                    u.score = self._score_precision(u)

    def _instantane(self) -> None:
        profils = {}
        poids_total = sum(u.poids(self.jour, self.p) for u in self.utilisateurs)
        for nom in self.ordre_profils():
            groupe = [u for u in self.utilisateurs if u.profil == nom]
            if not groupe:
                continue
            profils[nom] = {
                "score_moyen": sum(u.score for u in groupe) / len(groupe),
                "part_poids": sum(u.poids(self.jour, self.p) for u in groupe) / poids_total,
            }
        self.historique.append({"jour": self.jour, "profils": profils})

    def ordre_profils(self) -> list[str]:
        ordre = list(self.sc.profils)
        for vague in self.sc.vagues:
            if vague.profil not in ordre:
                ordre.append(vague.profil)
        return ordre

    # --- Lancement ------------------------------------------------------------

    def executer(self) -> "Simulation":
        for _ in range(self.sc.jours):
            self.tour()
        self._instantane()
        return self
