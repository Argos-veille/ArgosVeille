"""Vidéos de contrôle (0072) : lot, seuil de 30, tirage, vote, score différé, retrait."""
import unittest
import uuid

try:
    from .test_schema import REFUSE, base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import REFUSE, base_disponible, migrate, sql, valeur


def video(statut: str = "published", ratio: str = "0.90", etape: str = "review") -> str:
    v = str(uuid.uuid4())
    valeur(f"""INSERT INTO core.videos (id, status, first_round_ratio, decided_by_stage, r2_blurred_key, decided_at)
               VALUES ('{v}', '{statut}', {ratio}, '{etape}', 'floutees/{v}', now())""")
    return v


def compte(score: str = "3") -> str:
    a = str(uuid.uuid4())
    valeur(f"INSERT INTO core.accounts (id, username, status, score) VALUES ('{a}', 'c_{a[:12]}', 'active', {score})")
    return a


def convoquer(video_id: str, a: str, tour: str = "review", depuis: str = "now()") -> str:
    s = str(uuid.uuid4())
    valeur(f"""INSERT INTO core.summons (id, video_id, account_id, round, sent_at, expires_at)
               VALUES ('{s}', '{video_id}', '{a}', '{tour}', {depuis}, now() + interval '2 days')""")
    return s


def tirer() -> str:
    return valeur("SELECT core.draw_controls()", "argos_scoring")


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestControles(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    @staticmethod
    def vider():
        # Les vidéos laissées par d'autres tests ne doivent pas remplir le lot, ni déclencher des contrôles ailleurs.
        valeur("""UPDATE core.videos SET first_round_ratio = 0.5 WHERE decided_by_stage = 'review' AND first_round_ratio IS NOT NULL;
                  DELETE FROM core.summons WHERE round = 'control'; DELETE FROM core.control_videos""")

    def setUp(self):
        self.vider()

    @classmethod
    def tearDownClass(cls):
        cls.vider()

    def lot(self, n: int = 30) -> None:
        for i in range(n):
            video("published" if i % 2 else "rejected", "0.90" if i % 2 else "0.05")

    def relecteur_pret(self) -> str:
        a = compte()
        for _ in range(6):   # 1 contrôle pour 7 convocations : sous les 15 %
            convoquer(video("in_review", "NULL"), a)
        return a

    def controle_de(self, a: str) -> str:
        return valeur(f"SELECT count(*) FROM core.summons WHERE account_id = '{a}' AND round = 'control'")

    def test_seules_les_videos_nettes_entrent_dans_le_lot(self):
        nette, serree, jury = video(), video(ratio="0.70"), video(etape="jury")
        rejet, rejet_serre = video("rejected", "0.10"), video("rejected", "0.30")
        tirer()
        entrees = valeur("SELECT video_id FROM core.control_videos").splitlines()
        self.assertIn(nette, entrees)
        self.assertIn(rejet, entrees)
        for v in (serree, jury, rejet_serre):
            self.assertNotIn(v, entrees)
        self.assertEqual(valeur(f"SELECT truth FROM core.control_videos WHERE video_id = '{rejet}'"), "f")

    def test_inactif_sous_30_videos(self):
        a = self.relecteur_pret()
        self.lot(10)
        self.assertEqual(tirer(), "0")
        self.assertEqual(self.controle_de(a), "0")

    def test_tirage_proportion_et_analyste_exclu(self):
        self.lot()
        a = self.relecteur_pret()
        trop_peu = compte()
        convoquer(video("in_review", "NULL"), trop_peu)
        analyste = self.relecteur_pret()
        valeur(f"INSERT INTO core.verifications (account_id, category, expires_at) VALUES ('{analyste}', 'osint_analyst', now() + interval '1 year')")
        tirer()
        self.assertEqual(self.controle_de(a), "1")
        self.assertEqual(self.controle_de(trop_peu), "0")
        self.assertEqual(self.controle_de(analyste), "0")
        tirer()
        self.assertEqual(self.controle_de(a), "1")   # une seule en attente à la fois

    def test_jamais_une_video_deja_vue(self):
        self.lot()
        a = self.relecteur_pret()
        tirer()
        vues = valeur("SELECT video_id FROM core.control_videos").splitlines()
        pris = valeur(f"SELECT video_id FROM core.summons WHERE account_id = '{a}' AND round = 'control'")
        self.assertIn(pris, vues)
        valeur(f"UPDATE core.summons SET outcome = 'expired' WHERE account_id = '{a}' AND round = 'control'")
        for _ in range(6):
            convoquer(video("in_review", "NULL"), a)
        tirer()
        self.assertEqual(valeur(f"SELECT count(DISTINCT video_id) FROM core.summons WHERE account_id = '{a}' AND round = 'control'"), "2")

    def voter(self, v: str, a: str, verdict: str, raison: str) -> str:
        s = convoquer(v, a, "control")
        valeur(f"""INSERT INTO core.control_videos (video_id, truth, display_pseudonym) VALUES ('{v}', true, 'Loup-Ambre-{v[:6]}')
                   ON CONFLICT DO NOTHING""")
        r = sql(f"""INSERT INTO core.votes (summons_id, video_id, account_id, round, verdict, reasons, answers, weight)
                    VALUES ('{s}', '{v}', '{a}', 'control', '{verdict}', '{{{raison}}}', '{{}}', 0)""", "argos_app")
        self.assertEqual(r.returncode, 0, r.stderr)
        return s

    def test_score_applique_deux_jours_apres(self):
        v, a = video(), compte("3")
        self.voter(v, a, "invalid", "nothing_visible")
        valeur("SELECT core.score_controls()", "argos_scoring")
        self.assertEqual(float(valeur(f"SELECT score FROM core.accounts WHERE id = '{a}'")), 3.0)
        valeur(f"UPDATE core.votes SET cast_at = now() - interval '3 days' WHERE account_id = '{a}'")
        valeur("SELECT core.score_controls()", "argos_scoring")
        self.assertLess(float(valeur(f"SELECT score FROM core.accounts WHERE id = '{a}'")), 3.0)
        avant = valeur(f"SELECT score FROM core.accounts WHERE id = '{a}'")
        valeur("SELECT core.score_controls()", "argos_scoring")
        self.assertEqual(valeur(f"SELECT score FROM core.accounts WHERE id = '{a}'"), avant)   # une seule fois

    def test_vote_sans_effet_sur_la_video(self):
        v, a = video(), compte()
        self.voter(v, a, "invalid", "nothing_visible")
        self.assertEqual(valeur(f"SELECT status FROM core.videos WHERE id = '{v}'"), "published")

    def test_retiree_par_la_source_sort_du_lot(self):
        v = video()
        tirer()
        self.assertEqual(valeur(f"SELECT core.control_active('{v}')"), "t")
        valeur(f"UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '{v}'")
        self.assertEqual(valeur(f"SELECT core.control_active('{v}')"), "f")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.control_videos WHERE video_id = '{v}'"), "0")

    def test_gel_legal_et_masquage_sortent_du_lot(self):
        a, b = video(), video()
        tirer()
        valeur(f"UPDATE core.videos SET legal_hold = true WHERE id = '{a}'; UPDATE core.videos SET status = 'hidden' WHERE id = '{b}'")
        self.assertEqual(valeur(f"SELECT core.control_active('{a}')"), "f")
        self.assertEqual(valeur(f"SELECT core.control_active('{b}')"), "f")

    def test_le_site_ne_lit_pas_la_bonne_reponse(self):
        self.assertIn(REFUSE, sql("SELECT truth FROM core.control_videos", "argos_app").stderr)
        self.assertEqual(sql("SELECT display_pseudonym FROM core.control_videos LIMIT 1", "argos_app").returncode, 0)
