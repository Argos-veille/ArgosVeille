"""Audit H2 (0119) : la session d'administration est en base, hors de portée du site public."""
import unittest
import uuid

try:
    from .test_osint import admin
    from .test_schema import REFUSE, base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_osint import admin
    from test_schema import REFUSE, base_disponible, migrate, sql, valeur


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestSessionAdmin(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_reservee_a_l_administration(self):
        a = admin()
        sid = valeur(f"""INSERT INTO core.sessions (account_id, expires_at, token_hash)
                         VALUES ('{a}', now() + interval '1 day', '\\x{uuid.uuid4().hex * 2}') RETURNING id""").split("\n")[0]
        # Le site public : ni ouvrir, ni lire, ni écrire la table.
        self.assertIn(REFUSE, sql(f"SELECT core.admin_session_open('{a}', '{sid}')", "argos_app").stderr)
        self.assertIn(REFUSE, sql(f"SELECT core.admin_session_remaining('{sid}', true)", "argos_app").stderr)
        self.assertIn(REFUSE, sql(f"INSERT INTO core.admin_sessions (session_id) VALUES ('{sid}')", "argos_app").stderr)
        # L'administration : ouverte, 10 minutes au plus restantes, fermée.
        valeur(f"SELECT core.admin_session_open('{a}', '{sid}')", "argos_administration")
        ms = int(valeur(f"SELECT core.admin_session_remaining('{sid}', true)", "argos_administration"))
        self.assertTrue(590_000 <= ms <= 600_000, ms)
        valeur(f"SELECT core.admin_session_close('{sid}')", "argos_administration")
        self.assertEqual(valeur(f"SELECT core.admin_session_remaining('{sid}', false)", "argos_administration"), "0")
        # Une session d'un autre compte ne peut pas devenir session d'administration.
        autre = valeur(f"""INSERT INTO core.sessions (account_id, expires_at, token_hash)
                           SELECT id, now() + interval '1 day', '\\x{uuid.uuid4().hex * 2}' FROM core.accounts
                            WHERE NOT is_superadmin AND status = 'active' LIMIT 1 RETURNING id""").split("\n")[0]
        self.assertIn("reserve_super_admin", sql(f"SELECT core.admin_session_open('{a}', '{autre}')", "argos_administration").stderr)


if __name__ == "__main__":
    unittest.main()
