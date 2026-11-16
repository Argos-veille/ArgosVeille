"""Empreintes des vidéos (0064) : illisibles par le site, effacées au retrait par la source, gardées au retrait légal."""
import unittest
import uuid

try:
    from .test_schema import REFUSE, base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import REFUSE, base_disponible, migrate, sql, valeur

OCTETS = r"'\x0011223344556677'"


def video(statut: str = "awaiting_author") -> str:
    vid = str(uuid.uuid4())
    valeur(f"INSERT INTO core.videos (id, status) VALUES ('{vid}', '{statut}')")
    return vid


def sauver(vid: str, role: str = "argos_worker") -> str:
    return valeur(f"""SELECT core.save_fingerprints('{vid}', 1::smallint, 'working_copy', {OCTETS}, {OCTETS}, NULL, NULL)""", role)


def nombre(vid: str) -> str:
    return valeur(f"SELECT count(*) FROM core.video_fingerprints WHERE video_id = '{vid}'")


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestEmpreintes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_illisibles_par_le_site(self):
        for role in ("argos_app", "argos_identity", "argos_scoring", "argos_admin"):
            r = sql("SELECT * FROM core.video_fingerprints", role)
            self.assertIn(REFUSE, r.stderr, role)

    def test_site_ne_peut_pas_ecrire(self):
        r = sql(f"""SELECT core.save_fingerprints('{video()}', 1::smallint, 'working_copy', {OCTETS}, {OCTETS}, NULL, NULL)""", "argos_app")
        self.assertIn(REFUSE, r.stderr)

    def test_effacees_au_retrait_par_la_source(self):
        vid = video()
        self.assertEqual(sauver(vid), "t")
        self.assertEqual(nombre(vid), "1")
        valeur(f"UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '{vid}'")
        self.assertEqual(nombre(vid), "0")

    def test_gardees_au_retrait_legal(self):
        vid = video("published")
        sauver(vid)
        valeur(f"UPDATE core.videos SET status = 'removed' WHERE id = '{vid}'")
        self.assertEqual(nombre(vid), "1")

    def test_refusees_si_deja_retiree(self):
        vid = video()
        valeur(f"UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '{vid}'")
        self.assertEqual(sauver(vid), "f")
        self.assertEqual(nombre(vid), "0")

    def test_contrainte_de_taille(self):
        r = sql(f"""SELECT core.save_fingerprints('{video()}', 1::smallint, 'working_copy', '\\x0011', '\\x0011', NULL, NULL)""", "argos_worker")
        self.assertIn("23514", r.stderr)
