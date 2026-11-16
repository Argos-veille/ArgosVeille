"""Audit H4 (0120) : codes de comptes vérifiés avec motif et journal, sans le nom du code."""
import unittest
import uuid

try:
    from .test_osint import admin
    from .test_schema import base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_osint import admin
    from test_schema import base_disponible, migrate, sql, valeur


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestCodesComptes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_motif_et_journal_sans_nom(self):
        a, nom = admin(), f"Maître {uuid.uuid4().hex[:6]}"
        creer = lambda motif: sql(f"""SELECT core.admin_create_account_code('{a}', '\\x{uuid.uuid4().hex * 2}', '{nom}', 'lawyer',
                                       NULL, NULL, '{motif}')""", "argos_administration")
        self.assertIn("motif", creer("court").stderr)
        r = creer("Avocat de victimes, vérifié au barreau.")
        self.assertEqual(r.returncode, 0, r.stderr)
        cid = r.stdout.strip()
        self.assertIn("motif", sql(f"SELECT core.admin_revoke_account_code('{a}', '{cid}', 'x')", "argos_administration").stderr)
        valeur(f"SELECT core.admin_revoke_account_code('{a}', '{cid}', 'Code envoyé à la mauvaise adresse.')", "argos_administration")
        journal = valeur("""SELECT string_agg(payload::text, ' ') FROM ledger.entries
                             WHERE kind = 'admin_action' AND payload ->> 'action' IN ('account_code_created', 'account_code_revoked')""")
        self.assertIn("vérifié au barreau", journal)
        self.assertNotIn(nom, journal)   # le nom du code (la personne) n'est jamais au journal
        self.assertIn("42501", sql(f"SELECT core.admin_create_account_code('{a}', '\\x00', 'x', 'lawyer', NULL, NULL, 'Motif assez long.')",
                                   "argos_app").stderr)


if __name__ == "__main__":
    unittest.main()
