"""Jury de second examen (0027) sur la base argos_test : vivier, tirage, vote oui/non, décision, scores."""
import unittest
import uuid

try:
    from .test_schema import REFUSE, base_disponible, migrate, sql, valeur
    from .test_relecture import nouveaux_comptes, score, votes
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import REFUSE, base_disponible, migrate, sql, valeur
    from test_relecture import nouveaux_comptes, score, votes

PARAMS = "(SELECT params FROM core.settings ORDER BY version DESC LIMIT 1)"


def jures(n: int, score: str = "5.0", age_jours: int = 100) -> list[str]:
    """Comptes anciens protégés par une double authentification."""
    ids = nouveaux_comptes(n, age_jours=age_jours, score=score)
    valeur("INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES "
           + ", ".join(f"('{i}', 'totp', '\\x00')" for i in ids))
    return ids


def video_jury(ratio: str = "0.55", premier_tour: list[str] | None = None,
               comptes: list[str] | None = None) -> str:
    """Vidéo passée au jury, éventuellement après des votes du premier tour."""
    vid = str(uuid.uuid4())
    valeur(f"INSERT INTO core.videos (id, status, review_started_at) VALUES ('{vid}', 'in_review', now())")
    if premier_tour:
        votes(vid, premier_tour, comptes)
    valeur(f"UPDATE core.videos SET status = 'jury', first_round_ratio = {ratio} WHERE id = '{vid}'")
    return vid


def tirer() -> int:
    return int(valeur("SELECT core.draw_jury()", "argos_scoring"))


def trancher() -> None:
    valeur("SELECT core.decide_juries()", "argos_scoring")


def convoques(vid: str) -> list[tuple[str, str]]:
    lignes = valeur(f"""SELECT id || ' ' || account_id FROM core.summons
                         WHERE video_id = '{vid}' AND round = 'jury' AND outcome = 'pending' ORDER BY sent_at, id""")
    return [tuple(l.split()) for l in lignes.splitlines() if l]


def voter_jury(vid: str, convocation: tuple[str, str], verdict: str, raisons: str = "ARRAY[]::text[]"):
    sid, compte = convocation
    return sql(f"""INSERT INTO core.votes (summons_id, video_id, account_id, round, verdict, reasons, answers, weight)
                   VALUES ('{sid}', '{vid}', '{compte}', 'jury', '{verdict}', {raisons}, '{{}}', 0)""")


def jury_vote(vid: str, verdicts: list[str]) -> list[str]:
    """Tire les jurés et fait voter les premiers convoqués ; renvoie leurs comptes."""
    tirer()
    c = convoques(vid)
    for conv, v in zip(c, verdicts):
        r = voter_jury(vid, conv, v)
        if r.returncode:
            raise AssertionError(r.stderr)
    return [compte for _, compte in c[:len(verdicts)]]


def etat(vid: str) -> str:
    return valeur(f"SELECT status || '|' || coalesce(decided_by_stage, '-') FROM core.videos WHERE id = '{vid}'")


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestJury(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def setUp(self):
        # Vivier vide au départ de chaque test (base de test) ; jurys d'autres tests mis de côté.
        valeur("UPDATE core.mfa_factors SET revoked_at = now() WHERE revoked_at IS NULL")
        valeur("UPDATE core.videos SET status = 'under_debate' WHERE status = 'jury'")

    def vivier(self, n: int = 120, score: str = "5.0") -> list[str]:
        return jures(n, score)

    # --- Vivier et tirage ---------------------------------------------------------------------

    def test_vivier_trop_petit_en_attente_puis_tirage(self):
        jures(60)                                    # 30 % de 60 = 18 jurés possibles < 33
        vid = video_jury()
        self.assertEqual(tirer(), 0)
        self.assertEqual(valeur(f"SELECT jury_started_at IS NULL FROM core.videos WHERE id = '{vid}'"), "t")
        self.assertEqual(valeur(f"""SELECT details ->> 'pool' FROM core.admin_alerts
                                     WHERE video_id = '{vid}' AND resolved_at IS NULL"""), "18")
        tirer()
        self.assertEqual(valeur(f"SELECT count(*) FROM core.admin_alerts WHERE video_id = '{vid}'"), "1")   # une seule alerte
        jures(60)                                    # 30 % de 120 = 36
        self.assertEqual(tirer(), 33)                # 11 places × 3
        self.assertEqual(valeur(f"SELECT jury_started_at IS NOT NULL FROM core.videos WHERE id = '{vid}'"), "t")
        self.assertEqual(valeur(f"""SELECT count(*) FROM core.admin_alerts
                                     WHERE video_id = '{vid}' AND resolved_at IS NULL"""), "0")
        self.assertEqual(tirer(), 0)                 # rien à compléter

    def test_qui_peut_sieger(self):
        self.vivier()
        bas, = jures(1, score="2.0")
        vid = video_jury()
        dans = lambda c: valeur(f"SELECT count(*) FROM core.jury_pool('{vid}', {PARAMS}) WHERE account_id = '{c}'") == "1"
        tete, = jures(1, score="9.0")
        self.assertTrue(dans(tete))
        self.assertFalse(dans(bas))                  # hors des 30 % meilleurs scores
        jeune, = jures(1, score="9.0", age_jours=30)
        self.assertFalse(dans(jeune))                # moins de 60 jours
        sans_2fa, = nouveaux_comptes(1, score="9.0")
        self.assertFalse(dans(sans_2fa))             # sans double authentification
        suspect, = jures(1, score="9.0")
        valeur(f"UPDATE core.accounts SET suspect = true WHERE id = '{suspect}'")
        self.assertFalse(dans(suspect))              # signalé pour collusion
        relecteur, = jures(1, score="9.0")
        valeur(f"""INSERT INTO core.summons (video_id, account_id, round, outcome, expires_at, sent_at)
                   VALUES ('{vid}', '{relecteur}', 'review', 'expired', now() - interval '1 day', now() - interval '3 days')""")
        self.assertFalse(dans(relecteur))            # convoqué au premier tour de la même vidéo
        occupe, = jures(1, score="9.0")
        for _ in range(2):
            autre = video_jury()
            valeur(f"""INSERT INTO core.summons (video_id, account_id, round, expires_at)
                       VALUES ('{autre}', '{occupe}', 'jury', now() + interval '2 days')""")
        self.assertFalse(dans(occupe))               # déjà 2 jurys sur 7 jours

    # --- Vote ---------------------------------------------------------------------------------

    def test_vote_du_jure(self):
        self.vivier()
        vid = video_jury()
        tirer()
        c = convoques(vid)
        self.assertIn("23514", voter_jury(vid, c[0], "partly").stderr)          # pas d'« en partie »
        self.assertEqual(voter_jury(vid, c[0], "valid").returncode, 0)          # raisons facultatives
        self.assertEqual(valeur(f"SELECT weight FROM core.votes WHERE summons_id = '{c[0][0]}'"), "1.000")   # une voix
        valeur(f"UPDATE core.mfa_factors SET revoked_at = now() WHERE account_id = '{c[1][1]}'")
        self.assertIn("argos:double_auth_requise", voter_jury(vid, c[1], "valid").stderr)
        for conv in c[2:12]:
            self.assertEqual(voter_jury(vid, conv, "invalid").returncode, 0)    # 11 votes en tout
        self.assertEqual(valeur(f"""SELECT count(*) FROM core.summons WHERE video_id = '{vid}'
                                     AND round = 'jury' AND outcome = 'pending'"""), "0")   # convocations en trop annulées

    def test_vote_avant_le_debut_du_jury_refuse(self):
        vid = video_jury()
        compte, = jures(1)
        sid = str(uuid.uuid4())
        valeur(f"""INSERT INTO core.summons (id, video_id, account_id, round, expires_at)
                   VALUES ('{sid}', '{vid}', '{compte}', 'jury', now() + interval '2 days')""")
        self.assertIn("argos:relecture_terminee", voter_jury(vid, (sid, compte), "valid").stderr)

    # --- Décision et scores -------------------------------------------------------------------

    def test_publication_par_le_jury_et_scores_de_tous(self):
        self.vivier()
        premier = nouveaux_comptes(4)
        vid = video_jury("0.55", ["valid", "valid", "invalid", "partly"], premier)
        jure_oui = jury_vote(vid, ["valid"] * 8 + ["invalid"] * 3)
        trancher()
        self.assertEqual(etat(vid), "published|jury")
        self.assertAlmostEqual(score(premier[0]), 1.1, places=3)    # avait vu juste au premier tour
        self.assertAlmostEqual(score(premier[2]), 0.7, places=3)    # minorité
        self.assertAlmostEqual(score(premier[3]), 1.0, places=3)    # « en partie » : neutre
        self.assertGreater(score(jure_oui[0]), 5.0)
        self.assertLess(score(jure_oui[-1]), 5.0)
        self.assertEqual(valeur(f"""SELECT payload ->> 'stage' FROM ledger.entries WHERE kind = 'decision'
                                     AND payload ->> 'video' = '{vid}'"""), "jury")

    def test_plancher_du_premier_tour(self):
        self.vivier()
        premier = nouveaux_comptes(2)
        vid = video_jury("0.45", ["valid", "invalid"], premier)
        jury_vote(vid, ["valid"] * 11)
        trancher()
        self.assertEqual(etat(vid), "under_debate|jury")             # trop peu soutenue au premier tour
        self.assertAlmostEqual(score(premier[1]), 1.0)               # en débat : aucun score ne bouge

    def test_rejet_par_le_jury(self):
        self.vivier()
        vid = video_jury("0.40")
        jury_vote(vid, ["invalid"] * 8 + ["valid"] * 3)
        trancher()
        self.assertEqual(etat(vid), "rejected|jury")

    def test_jury_partage_en_debat(self):
        self.vivier()
        vid = video_jury()
        jury_vote(vid, ["valid"] * 6 + ["invalid"] * 5)
        trancher()
        self.assertEqual(etat(vid), "under_debate|jury")

    def test_cinq_jours_sans_assez_de_votes(self):
        self.vivier()
        vid = video_jury()
        jury_vote(vid, ["valid"] * 7)
        trancher()
        self.assertEqual(etat(vid), "jury|-")                        # attend encore
        valeur(f"UPDATE core.videos SET jury_started_at = now() - interval '5 days 1 minute' WHERE id = '{vid}'")
        trancher()
        self.assertEqual(etat(vid), "under_debate|jury")
        self.assertEqual(valeur(f"""SELECT count(*) FROM core.summons WHERE video_id = '{vid}'
                                     AND round = 'jury' AND outcome = 'pending'"""), "0")

    def test_passage_au_jury_date(self):
        vid = video_jury()
        self.assertEqual(valeur(f"SELECT jury_since IS NOT NULL AND jury_started_at IS NULL FROM core.videos WHERE id = '{vid}'"), "t")

    def test_le_site_ne_peut_pas_tirer_ni_trancher(self):
        for f in ("core.draw_jury()", "core.decide_juries()"):
            self.assertIn(REFUSE, sql(f"SELECT {f}", "argos_app").stderr)
        self.assertIn(REFUSE, sql("INSERT INTO core.admin_alerts (kind) VALUES ('jury_waiting')", "argos_app").stderr)


if __name__ == "__main__":
    unittest.main()
