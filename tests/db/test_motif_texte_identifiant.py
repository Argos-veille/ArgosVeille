"""Nouveau motif de signalement (0112) : « Le texte identifie quelqu'un », grave."""
import unittest
import uuid

try:
    from .test_schema import base_disponible, migrate, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import base_disponible, migrate, valeur


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestMotifTexteIdentifiant(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_signalement_grave(self):
        vid, compte = str(uuid.uuid4()), str(uuid.uuid4())
        valeur(f"""INSERT INTO core.videos (id, status) VALUES ('{vid}', 'published');
                   INSERT INTO core.accounts (id, username, status) VALUES ('{compte}', 's_{compte[:8]}', 'active')""")
        rid = valeur(f"SELECT core.report_video('{compte}', '{vid}', 'identifying_text', 'Nom de famille dans la description.')", "argos_app")
        self.assertEqual(valeur(f"SELECT severity || '|' || reason_code FROM core.reports WHERE id = '{rid}'"), "serious|identifying_text")


if __name__ == "__main__":
    unittest.main()
