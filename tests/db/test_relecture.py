"""Vote, décision et scores (0026) sur la base argos_test : les règles validées par le simulateur,
appliquées par la base elle-même."""
import unittest
import uuid

try:
    from .test_schema import REFUSE, base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import REFUSE, base_disponible, migrate, sql, valeur

VALIDE = "ARRAY['intervention_visible']"
INVALIDE = "ARRAY['nothing_visible']"
PARTIEL = "ARRAY['intervention_visible', 'old_or_reused']"


def nouveaux_comptes(n: int, age_jours: int = 100, score: str = "1.0") -> list[str]:
    ids = [str(uuid.uuid4()) for _ in range(n)]
    valeurs = ", ".join(f"('{i}', 'R_{i[:8]}_{i[9:13]}', now() - interval '{age_jours} days', {score})" for i in ids)
    valeur(f"INSERT INTO core.accounts (id, username, created_at, score) VALUES {valeurs}")
    return ids


def video(controle: str | None = None, depuis: str = "1 minute") -> str:
    vid = str(uuid.uuid4())
    if controle is None:
        valeur(f"INSERT INTO core.videos (id, status, review_started_at) VALUES ('{vid}', 'in_review', now() - interval '{depuis}')")
    else:
        valeur(f"""INSERT INTO core.videos (id, status, is_control, control_truth, review_started_at)
                   VALUES ('{vid}', 'in_review', true, {controle}, now() - interval '{depuis}')""")
    return vid


def convoquer(vid: str, compte: str) -> str:
    sid = str(uuid.uuid4())
    valeur(f"""INSERT INTO core.summons (id, video_id, account_id, round, expires_at)
               VALUES ('{sid}', '{vid}', '{compte}', 'review', now() + interval '2 days')""")
    return sid


def voter(vid: str, compte: str, verdict: str, raisons: str | None = None, visage: bool = False, role: str | None = None):
    sid = convoquer(vid, compte)
    raisons = raisons or {"valid": VALIDE, "invalid": INVALIDE, "partly": PARTIEL}[verdict]
    return sql(f"""INSERT INTO core.votes (summons_id, video_id, account_id, round, verdict, reasons, answers, weight)
                   VALUES ('{sid}', '{vid}', '{compte}', 'review', '{verdict}', {raisons},
                           '{{"face_identifiable": {str(visage).lower()}}}', 0)""", role)


def votes(vid: str, verdicts: list[str], comptes: list[str] | None = None) -> list[str]:
    comptes = comptes or nouveaux_comptes(len(verdicts))
    for c, v in zip(comptes, verdicts):
        r = voter(vid, c, v)
        if r.returncode:
            raise AssertionError(r.stderr)
    return comptes


def decider() -> None:
    valeur("SELECT core.decide_reviews()", "argos_scoring")


def etat(vid: str) -> str:
    return valeur(f"""SELECT status || '|' || coalesce(decided_by_stage, '-') || '|' || coalesce(first_round_ratio::text, '-')
                             || '|' || enlargements || '|' || extra_seats FROM core.videos WHERE id = '{vid}'""")


def score(compte: str) -> float:
    return float(valeur(f"SELECT score FROM core.accounts WHERE id = '{compte}'"))


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestRelecture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def setUp(self):
        # Les vidéos en relecture laissées par d'autres tests ne doivent pas être tranchées ici.
        valeur("UPDATE core.videos SET review_started_at = now() WHERE status = 'in_review'")

    # --- Vote ---------------------------------------------------------------------------

    def test_raisons_propres_au_verdict(self):
        vid = video()
        c = nouveaux_comptes(5)
        self.assertIn("23514", voter(vid, c[0], "valid", INVALIDE).stderr)        # raison du « non » avec un « oui »
        self.assertIn("23514", voter(vid, c[1], "invalid", VALIDE).stderr)
        self.assertIn("23514", voter(vid, c[2], "valid", "ARRAY[]::text[]").stderr)   # au moins une raison
        self.assertIn("23514", voter(vid, c[3], "partly", "ARRAY['inventee']").stderr)
        self.assertEqual(voter(vid, c[4], "partly").returncode, 0)                 # « en partie » : les deux listes
        self.assertEqual(valeur(f"SELECT coalesce(is_valid::text, 'null') FROM core.votes WHERE account_id = '{c[4]}'"), "null")

    def test_raisons_contradictoires_refusees(self):
        vid = video()
        c = nouveaux_comptes(3)
        self.assertIn("23514", voter(vid, c[0], "partly", "ARRAY['context_consistent', 'old_or_reused']").stderr)
        self.assertIn("23514", voter(vid, c[1], "partly", "ARRAY['authentic', 'misleading_edit']").stderr)
        self.assertEqual(voter(vid, c[2], "partly", "ARRAY['intervention_visible', 'old_or_reused']").returncode, 0)   # compatibles

    def test_poids_calcule_par_la_base(self):
        vid = video()
        ancien, = nouveaux_comptes(1, score="4.0")
        novice, = nouveaux_comptes(1, age_jours=3, score="2.0")
        votes(vid, ["valid", "valid"], [ancien, novice])
        self.assertEqual(valeur(f"SELECT weight FROM core.votes WHERE account_id = '{ancien}'"), "4.000")
        self.assertEqual(valeur(f"SELECT weight FROM core.votes WHERE account_id = '{novice}'"), "1.000")   # moitié : novice

    def test_places_prises_convocations_annulees(self):
        vid = video()
        votes(vid, ["valid"] * 14)
        retard, encore = nouveaux_comptes(2)
        en_attente = convoquer(vid, encore)
        votes(vid, ["valid"])   # 15e place
        self.assertEqual(valeur(f"SELECT outcome FROM core.summons WHERE id = '{en_attente}'"), "cancelled")
        self.assertIn("argos:places_prises", voter(vid, retard, "valid").stderr)

    def test_plafond_de_cinq_votes_par_jour(self):
        compte, = nouveaux_comptes(1)
        for _ in range(5):
            votes(video(), ["valid"], [compte])
        self.assertIn("argos:plafond_journalier", voter(video(), compte, "valid").stderr)

    def test_vote_apres_la_relecture_refuse(self):
        vid = video()
        compte, = nouveaux_comptes(1)
        sid = convoquer(vid, compte)
        valeur(f"UPDATE core.videos SET status = 'jury' WHERE id = '{vid}'")
        r = sql(f"""INSERT INTO core.votes (summons_id, video_id, account_id, round, verdict, reasons, answers, weight)
                    VALUES ('{sid}', '{vid}', '{compte}', 'review', 'valid', {VALIDE}, '{{}}', 0)""")
        self.assertIn("argos:relecture_terminee", r.stderr)

    def test_visage_identifiable_ouvre_un_signalement(self):
        vid = video()
        compte, = nouveaux_comptes(1)
        voter(vid, compte, "valid", visage=True)
        self.assertEqual(valeur(f"""SELECT reason_code || ' ' || severity || ' ' || status FROM core.reports
                                     WHERE video_id = '{vid}'"""), "visible_identity normal open")

    # --- Décision -----------------------------------------------------------------------

    def test_publication_et_scores_sur_consensus(self):
        vid = video()
        comptes = votes(vid, ["valid"] * 13 + ["invalid"] * 2)
        decider()
        self.assertEqual(etat(vid), "published|review|0.8667|0|0")
        self.assertAlmostEqual(score(comptes[0]), 1.1, places=3)    # majorité : +0,1 (au départ)
        self.assertAlmostEqual(score(comptes[-1]), 0.7, places=3)   # minorité : -0,3
        self.assertEqual(valeur(f"""SELECT count(*) FROM ledger.entries WHERE kind = 'decision'
                                     AND payload ->> 'video' = '{vid}'"""), "1")

    def test_rejet(self):
        vid = video()
        votes(vid, ["invalid"] * 12 + ["valid"] * 3)
        decider()
        self.assertEqual(etat(vid).split("|")[:3], ["rejected", "review", "0.2000"])

    def test_vote_serre_elargissement_puis_jury(self):
        vid = video()
        comptes = votes(vid, ["valid"] * 8 + ["invalid"] * 7)
        decider()
        self.assertEqual(etat(vid), "in_review|-|-|1|0")             # 15 relecteurs de plus
        self.assertEqual(int(valeur(f"SELECT core.review_seats('{vid}')")), 30)
        votes(vid, ["valid"] * 8 + ["invalid"] * 7)
        decider()
        self.assertEqual(etat(vid).split("|")[:3], ["jury", "-", "0.5333"])
        self.assertAlmostEqual(score(comptes[0]), 1.0)                # pas de consensus : rien ne bouge

    def test_en_partie_compte_pour_moitie_sans_toucher_aux_scores(self):
        vid = video()
        comptes = votes(vid, ["partly"] * 10 + ["valid"] * 5)
        decider()
        self.assertEqual(etat(vid).split("|")[:3], ["published", "review", "0.6667"])
        self.assertAlmostEqual(score(comptes[0]), 1.0)
        self.assertAlmostEqual(score(comptes[-1]), 1.0)   # consensus < 80 % : aucun score ne bouge

    def test_poids_insuffisant_recrutement(self):
        vid = video()
        votes(vid, ["valid"] * 15, nouveaux_comptes(15, age_jours=3))   # novices : 15 × 0,5 = 7,5
        decider()
        self.assertEqual(etat(vid), "in_review|-|-|0|15")

    def test_sept_jours_sans_assez_de_poids(self):
        vid = video(depuis="7 days 1 minute")
        votes(vid, ["valid"] * 4)
        decider()
        self.assertEqual(etat(vid).split("|")[:2], ["no_decision", "review"])

    def test_sept_jours_avec_assez_de_poids_tranche(self):
        vid = video(depuis="7 days 1 minute")
        votes(vid, ["valid"] * 10, nouveaux_comptes(10, score="2.0"))   # 10 votes, poids 20
        decider()
        self.assertEqual(etat(vid).split("|")[0], "published")

    def test_video_de_controle(self):
        vid = video(controle="true")
        juste, faux, entre = nouveaux_comptes(1), nouveaux_comptes(1), nouveaux_comptes(1)
        votes(vid, ["valid"] * 12 + ["invalid", "invalid", "partly"], nouveaux_comptes(12) + faux + nouveaux_comptes(1) + entre)
        valeur(f"DELETE FROM core.votes WHERE video_id = '{vid}' AND account_id = (SELECT account_id FROM core.votes WHERE video_id = '{vid}' LIMIT 1)")
        votes(vid, ["valid"], juste)
        decider()
        self.assertEqual(etat(vid).split("|")[0], "no_decision")   # jamais publiée
        self.assertAlmostEqual(score(juste[0]), 1.1, places=3)
        self.assertAlmostEqual(score(faux[0]), 0.2, places=3)      # erreur sur un contrôle : -1 (plancher 0,2)
        self.assertAlmostEqual(score(entre[0]), 0.5, places=3)     # « en partie » : -0,5
        self.assertEqual(valeur(f"SELECT count(*) FROM ledger.entries WHERE payload ->> 'video' = '{vid}'"), "0")

    def test_minoritaires_ensemble_signales(self):
        a, b = nouveaux_comptes(2)
        for _ in range(3):
            vid = video()
            votes(vid, ["valid"] * 13 + ["invalid", "invalid"], nouveaux_comptes(13, score="2.0") + [a, b])
            decider()
        self.assertEqual(valeur(f"SELECT bool_and(suspect) FROM core.accounts WHERE id IN ('{a}', '{b}')"), "t")

    def test_le_site_ne_peut_pas_decider(self):
        for f in ("core.decide_reviews()", "core.decay_scores()"):
            self.assertIn(REFUSE, sql(f"SELECT {f}", "argos_app").stderr)

    def test_retour_progressif_vers_un(self):
        inactif, = nouveaux_comptes(1, age_jours=100, score="5.0")
        valeur(f"UPDATE core.accounts SET last_vote_at = now() - interval '20 days' WHERE id = '{inactif}'")
        valeur("DELETE FROM core.engine_state WHERE name = 'decay'")
        valeur("SELECT core.decay_scores()", "argos_scoring")
        self.assertAlmostEqual(score(inactif), 4.96, places=3)     # 1 % de l'écart par jour
        valeur("SELECT core.decay_scores()", "argos_scoring")
        self.assertAlmostEqual(score(inactif), 4.96, places=3)     # une fois par jour seulement

    # --- Décision du super-administrateur -------------------------------------------------

    def test_decision_du_super_administrateur(self):
        admin = valeur("SELECT id FROM core.accounts WHERE is_superadmin")
        if not admin:
            admin, = nouveaux_comptes(1)
            valeur(f"UPDATE core.accounts SET is_superadmin = true WHERE id = '{admin}'")
        autre, = nouveaux_comptes(1)
        vid = video()
        comptes = votes(vid, ["invalid"] * 3)
        attente = convoquer(vid, nouveaux_comptes(1)[0])
        decide = lambda qui, d, motif: sql(f"SELECT core.admin_decide('{qui}', '{vid}', '{d}', '{motif}')", "argos_administration")
        # Revue de sécurité (A1, 0099) : le site public ne peut plus appeler les fonctions d'administration.
        self.assertIn(REFUSE, sql(f"SELECT core.admin_decide('{admin}', '{vid}', 'publish', 'Vidéo vérifiée par mes soins.')", "argos_app").stderr)
        self.assertIn("argos:reserve_super_admin", decide(autre, "publish", "Vidéo vérifiée par mes soins.").stderr)
        self.assertIn("argos:motif", decide(admin, "publish", "court").stderr)
        self.assertIn("argos:decision_inconnue", decide(admin, "hide", "Vidéo vérifiée par mes soins.").stderr)
        self.assertEqual(decide(admin, "publish", "Vidéo vérifiée par mes soins.").returncode, 0)
        self.assertEqual(etat(vid).split("|")[:2], ["published", "admin"])
        self.assertEqual(valeur(f"SELECT outcome FROM core.summons WHERE id = '{attente}'"), "cancelled")
        self.assertEqual(valeur(f"""SELECT payload ->> 'reason' FROM ledger.entries WHERE kind = 'admin_action'
                                     AND payload ->> 'video' = '{vid}'"""), "Vidéo vérifiée par mes soins.")
        self.assertIn("argos:deja_ainsi", decide(admin, "publish", "Vidéo vérifiée par mes soins.").stderr)
        decider()
        self.assertAlmostEqual(score(comptes[0]), 1.0)   # tranchée avant la communauté : aucun score ne bouge
        self.assertEqual(decide(admin, "reject", "Erreur constatée après publication.").returncode, 0)   # retour possible
        self.assertEqual(etat(vid).split("|")[0], "rejected")
        ctrl = video(controle="false")
        self.assertIn("argos:video_hors_decision",
                      sql(f"SELECT core.admin_decide('{admin}', '{ctrl}', 'publish', 'Vidéo vérifiée par mes soins.')",
                          "argos_administration").stderr)
        self.assertIn(REFUSE, sql(f"UPDATE core.videos SET decided_by_stage = 'admin' WHERE id = '{ctrl}'", "argos_app").stderr)
        # Mettre en débat, puis relancer la relecture (0097) : anciens votes archivés, plus comptés.
        self.assertEqual(decide(admin, "debate", "Doute sérieux sur le contexte.").returncode, 0)
        self.assertEqual(etat(vid).split("|")[:2], ["under_debate", "admin"])
        self.assertEqual(decide(admin, "review", "Élément nouveau : nouvelle relecture.").returncode, 0)
        self.assertEqual(valeur(f"SELECT status || '|' || (decided_at IS NULL) FROM core.videos WHERE id = '{vid}'"), "in_review|true")
        self.assertEqual(valeur(f"""SELECT string_agg(round || ':' || n, ',' ORDER BY round) FROM (
                                       SELECT round, count(*) AS n FROM core.votes WHERE video_id = '{vid}' GROUP BY round) x"""),
                         "review_past:3")
        self.assertIn("argos:video_hors_decision", decide(admin, "review", "Élément nouveau : nouvelle relecture.").stderr)
        valeur("SELECT core.draw_summons()", "argos_scoring")   # nouveau tirage possible, mêmes relecteurs compris
        self.assertEqual(valeur(f"SELECT count(*) > 0 FROM core.summons WHERE video_id = '{vid}' AND round = 'review' AND outcome = 'pending'"), "t")


if __name__ == "__main__":
    unittest.main()
