import unittest
from dataclasses import replace

from simulateur.moteur import Simulation
from simulateur.parametres import Parametres
from simulateur.scenarios import SCENARIOS
from simulateur.videos import Vote, creer_video


def petite_sim(**kw):
    sc = replace(SCENARIOS["honnetes"], population_initiale=50, jours=0, **kw)
    return Simulation(Parametres(), sc, graine=1)


class TestScore(unittest.TestCase):
    def test_gain_ralentit_et_plafonne(self):
        sim = petite_sim()
        u = sim.utilisateurs[0]
        u.score = 1.0
        sim._gagner(u)
        gain_bas = u.score - 1.0
        u.score = 9.0
        sim._gagner(u)
        self.assertLess(u.score - 9.0, gain_bas)
        u.score = 10.0
        sim._gagner(u)
        self.assertEqual(u.score, 10.0)

    def test_perte_bornee(self):
        sim = petite_sim()
        u = sim.utilisateurs[0]
        u.score = 0.3
        sim._perdre(u)
        self.assertEqual(u.score, sim.p.score_min)


class TestDecision(unittest.TestCase):
    def _video(self, sim, votes_valides, votes_invalides, poids=1.0):
        v = creer_video(0, "authentique", auteur=999, jour=0, places=0, rng=sim.rng)
        uid = 0
        for valide, n in ((True, votes_valides), (False, votes_invalides)):
            for _ in range(n):
                v.votes.append(Vote(uid, valide, poids))
                uid += 1
        sim.en_attente.append(v)
        return v

    def test_publication(self):
        sim = petite_sim()
        v = self._video(sim, 16, 4)
        sim._evaluer(v, age=1)
        self.assertEqual(v.statut, "publiee")

    def test_rejet(self):
        sim = petite_sim()
        v = self._video(sim, 3, 17)
        sim._evaluer(v, age=1)
        self.assertEqual(v.statut, "rejetee")

    def test_vote_serre_elargi_puis_conteste(self):
        sim = petite_sim()
        v = self._video(sim, 10, 10)
        sim._evaluer(v, age=1)
        self.assertEqual(v.statut, "en_attente")
        self.assertEqual(v.elargissements, 1)
        v.places = 0
        sim._evaluer(v, age=2)
        self.assertEqual(v.statut, "contestee")

    def test_poids_insuffisant_recrute_puis_sans_decision(self):
        sim = petite_sim()
        v = self._video(sim, 10, 0, poids=0.5)  # poids total 5 < 15
        sim._evaluer(v, age=1)
        self.assertEqual(v.statut, "en_attente")
        self.assertGreater(v.places, 0)
        sim._evaluer(v, age=sim.p.delai_max_jours)
        self.assertEqual(v.statut, "sans_decision")

    def test_vote_serre_ne_change_aucun_score(self):
        sim = petite_sim()
        v = self._video(sim, 15, 5)  # 75 % : publiée, mais sous le seuil de consensus
        avant = [u.score for u in sim.utilisateurs[:20]]
        sim._evaluer(v, age=1)
        self.assertEqual(v.statut, "publiee")
        self.assertEqual([u.score for u in sim.utilisateurs[:20]], avant)


class TestSimulation(unittest.TestCase):
    def test_reproductible(self):
        sc = replace(SCENARIOS["honnetes"], population_initiale=300, jours=40)
        a = Simulation(Parametres(), sc, graine=7).executer()
        b = Simulation(Parametres(), sc, graine=7).executer()
        self.assertEqual([v.statut for v in a.terminees], [v.statut for v in b.terminees])

    def test_attentifs_depassent_votants_au_hasard(self):
        sc = replace(SCENARIOS["honnetes"], population_initiale=600, jours=90)
        sim = Simulation(Parametres(), sc, graine=3).executer()
        final = sim.historique[-1]["profils"]
        self.assertGreater(final["attentif"]["score_moyen"], final["hasard"]["score_moyen"])


class TestComportements(unittest.TestCase):
    def setUp(self):
        import random
        from simulateur.population import creer_utilisateur
        self.rng = random.Random(0)
        self.p = Parametres()
        self.creer = lambda profil, **kw: creer_utilisateur(0, profil, 0, self.p, self.rng, **kw)

    def _video(self, nature, cible=False):
        return creer_video(0, nature, auteur=1, jour=0, places=1, rng=self.rng, cible=cible)

    def test_robot_vote_a_l_envers(self):
        robot = self.creer("robot")
        self.assertFalse(robot.voter(self._video("authentique"), 0, self.rng))
        self.assertTrue(robot.voter(self._video("fausse", cible=True), 0, self.rng))

    def test_brigade_honnete_hors_cible(self):
        brigade = self.creer("brigade")
        brigade.fiabilite = 1.0
        v = self._video("authentique")
        v.difficulte = 0.0
        self.assertTrue(brigade.voter(v, 0, self.rng))
        v.cible = True
        self.assertFalse(brigade.voter(v, 0, self.rng))

    def test_dormant_bascule_au_jour_d_attaque(self):
        dormant = self.creer("dormant", jour_attaque=120)
        dormant.fiabilite = 1.0
        v = self._video("authentique")
        v.difficulte = 0.0
        self.assertTrue(dormant.voter(v, 119, self.rng))
        self.assertFalse(dormant.voter(v, 120, self.rng))

    def test_partisan_penche_en_cas_d_erreur(self):
        partisan = self.creer("partisan_contre")
        partisan.fiabilite = 0.5
        v = self._video("authentique")
        v.difficulte = 1.0
        votes = [partisan.voter(v, 0, self.rng) for _ in range(200)]
        self.assertGreater(votes.count(False), votes.count(True))


class TestScenarios(unittest.TestCase):
    def test_robots_perdent_du_score(self):
        sc = replace(SCENARIOS["robots"], population_initiale=2000, jours=120)
        sim = Simulation(Parametres(), sc, graine=5).executer()
        final = sim.historique[-1]["profils"]
        self.assertLess(final["robot"]["score_moyen"], 1.0)

    def test_tous_les_scenarios_tournent(self):
        for nom, sc in SCENARIOS.items():
            with self.subTest(nom=nom):
                Simulation(Parametres(), replace(sc, population_initiale=300, jours=20), 1).executer()



class TestEtape3(unittest.TestCase):
    def test_plafond_selon_reputation(self):
        p = replace(Parametres(), plafond_reputation=True, relectures_max_par_jour=3, plafond_max=5)
        sim = Simulation(p, replace(SCENARIOS["honnetes"], population_initiale=10, jours=0), 1)
        u = sim.utilisateurs[0]
        u.score = 1.0
        self.assertEqual(sim._plafond(u), 3)
        u.score = 10.0
        self.assertEqual(sim._plafond(u), 5)

    def test_verdict_du_jury_note_le_premier_tour(self):
        p = replace(Parametres(), jury_actif=True)
        sim = Simulation(p, replace(SCENARIOS["honnetes"], population_initiale=30, jours=0), 1)
        v = creer_video(0, "authentique", auteur=999, jour=0, places=0, rng=sim.rng)
        v.votes = [Vote(i, i < 5, 1.0) for i in range(10)]      # premier tour partagé
        v.etape, v.jour_jury, v.ratio_premier_tour = "jury", 0, 0.5
        v.votes_jury = [Vote(10 + i, True, 1.0) for i in range(7)]  # jury unanime
        sim.en_attente.append(v)
        sim._evaluer_jury(v)
        self.assertEqual(v.statut, "publiee")
        self.assertGreater(sim.par_id[0].score, 1.0)   # avait voté « valide »
        self.assertLess(sim.par_id[7].score, 1.0)      # avait voté « invalide »

    def test_convocation_et_jury_tournent(self):
        p = replace(Parametres(), tirage="tous", jury_actif=True, jury_anciennete_jours=5)
        sim = Simulation(p, replace(SCENARIOS["tout"], population_initiale=400, jours=40), 2).executer()
        self.assertTrue(any(v.jour_jury is not None for v in sim.terminees))
        self.assertTrue(any(v.statut == "publiee" for v in sim.terminees))


    def test_detection_signale_les_minorites_repetees(self):
        p = replace(Parametres(), detection_collusion=True, collusion_seuil=3)
        sim = Simulation(p, replace(SCENARIOS["honnetes"], population_initiale=20, jours=0), 1)
        for _ in range(2):
            sim._noter_minorite([3, 4])
        self.assertFalse(sim.par_id[3].suspect)
        sim._noter_minorite([3, 4, 9])
        self.assertTrue(sim.par_id[3].suspect and sim.par_id[4].suspect)
        self.assertFalse(sim.par_id[9].suspect)
        self.assertEqual(sim.par_id[3].poids(100, p), sim.par_id[3].score * p.facteur_suspect)



class TestScorePrecision(unittest.TestCase):
    def _sim(self, **kw):
        p = replace(Parametres(), mode_score="precision", **kw)
        return Simulation(p, replace(SCENARIOS["honnetes"], population_initiale=10, jours=0), 1)

    def test_nouveau_compte_vaut_un(self):
        sim = self._sim()
        self.assertAlmostEqual(sim._score_precision(sim.utilisateurs[0]), 1.0)

    def test_le_volume_ne_suffit_pas(self):
        """Deux comptes fiables à 90 % : celui qui vote 10 fois plus n'est pas 10 fois plus lourd."""
        sim = self._sim()
        a, b = sim.utilisateurs[0], sim.utilisateurs[1]
        for i in range(100):
            sim._juger(a, i % 10 != 0)
        for i in range(1000):
            sim._juger(b, i % 10 != 0)
        self.assertLess(b.score / a.score, 1.3)
        self.assertGreater(a.score, 1.5)

    def test_votant_au_hasard_sans_poids(self):
        sim = self._sim()
        u = sim.utilisateurs[0]
        for i in range(400):
            sim._juger(u, i % 2 == 0)
        self.assertLess(u.score, 0.3)

    def test_memoire_courte_repere_un_retournement(self):
        lent, rapide = self._sim(), self._sim(memoire=0.95)
        for sim in (lent, rapide):
            u = sim.utilisateurs[0]
            for _ in range(300):
                sim._juger(u, True)
            for _ in range(30):
                sim._juger(u, False)
        self.assertLess(rapide.utilisateurs[0].score, lent.utilisateurs[0].score)


if __name__ == "__main__":
    unittest.main()
