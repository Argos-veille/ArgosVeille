"""Point bas de la revue (0111) : toute fonction SECURITY DEFINER nomme pg_temp en dernier dans son search_path."""
import unittest

try:
    from .test_schema import base_disponible, migrate, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import base_disponible, migrate, valeur


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestSecurityDefiner(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_pg_temp_en_dernier(self):
        fautives = valeur("""
            SELECT coalesce(string_agg(p.oid::regprocedure::text, ', '), '')
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE p.prosecdef AND n.nspname IN ('core', 'identity', 'ledger', 'public')
               AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c
                                WHERE c LIKE 'search_path=%' AND c ~ 'pg_temp"?$')""")
        self.assertEqual(fautives, "")


if __name__ == "__main__":
    unittest.main()
