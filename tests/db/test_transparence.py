"""Point bas de la revue (0110) : les règles d'anonymat du rapport de transparence appliquées par la base."""
import unittest

try:
    from .test_schema import base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import base_disponible, migrate, sql, valeur


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestTransparence(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_trimestre_entier_et_termine_seulement(self):
        encours = "date_trunc('quarter', now() AT TIME ZONE 'Europe/Paris')::date"
        for du, au in [(encours, f"({encours} + interval '3 months')::date"),   # trimestre en cours
                       ("'2026-07-01'", "'2026-07-02'"),                       # une journée
                       ("'2026-07-15'", "'2026-10-15'")]:                      # à cheval
            self.assertIn("periode_invalide", sql(f"SELECT core.transparency_report({du}, {au})", "argos_app").stderr)
            self.assertIn("periode_invalide", sql(f"SELECT core.transparency_authority({du}, {au})", "argos_app").stderr)
        self.assertEqual(sql("SELECT core.transparency_report('2026-07-01', '2026-10-01')", "argos_app").returncode, 0)
        # Les comptages bruts ne sont plus accessibles au site.
        self.assertIn("42501", sql("SELECT core.transparency_report_raw('2026-07-01', '2026-07-02')", "argos_app").stderr)

    def test_masquage(self):
        self.assertEqual(valeur("""SELECT core.transparency_mask_split('{"a": 5, "b": 1, "c": 0, "d": 9}')::text"""),
                         '{"a": "<5", "b": "<5", "c": 0, "d": 9}')
        self.assertEqual(valeur("""SELECT core.transparency_mask_split('{"a": 3, "b": 2, "c": 12}')::text"""),
                         '{"a": "<5", "b": "<5", "c": 12}')


if __name__ == "__main__":
    unittest.main()
