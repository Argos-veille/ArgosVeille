"""Point bas de la revue (0107, 0117) : l'heure d'envoi n'est gardée à la seconde que pendant le traitement, puis arrondie au jour."""
import unittest
import uuid

try:
    from .test_schema import base_disponible, migrate, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import base_disponible, migrate, valeur


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestDatesArrondies(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_arrondi_a_la_sortie_du_traitement(self):
        vid = str(uuid.uuid4())
        valeur(f"""INSERT INTO core.videos (id, status, submitted_at, processing_started_at)
                   VALUES ('{vid}', 'processing', '2026-11-15 14:03:27+01', now())""")
        valeur(f"INSERT INTO core.release_consents (video_id, envelope, granted_at) VALUES ('{vid}', '{{}}', '2026-11-15 14:03:28+01')")
        # Pendant le traitement : l'heure exacte reste (ordre d'arrivée de la file).
        self.assertEqual(valeur(f"SELECT to_char(submitted_at AT TIME ZONE 'Europe/Paris', 'HH24:MI:SS') FROM core.videos WHERE id = '{vid}'"),
                         "14:03:27")
        valeur(f"UPDATE core.videos SET status = 'awaiting_author' WHERE id = '{vid}'")
        ligne = valeur(f"""SELECT to_char(submitted_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI:SS'), processing_started_at IS NULL,
                                  awaiting_since = date_trunc('day', awaiting_since, 'Europe/Paris'),
                                  review_deadline = date_trunc('day', review_deadline, 'Europe/Paris') AND review_deadline >= now() + interval '7 days'
                             FROM core.videos WHERE id = '{vid}'""")
        self.assertEqual(ligne, "2026-11-15 00:00:00|t|t|t")
        self.assertEqual(valeur(f"SELECT to_char(granted_at AT TIME ZONE 'Europe/Paris', 'HH24:MI:SS') FROM core.release_consents WHERE video_id = '{vid}'"),
                         "00:00:00")

    def test_empreintes_datees_a_l_heure(self):
        self.assertEqual(valeur("SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = 'core.video_matches'::regclass "
                                "AND adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = 'core.video_matches'::regclass AND attname = 'detected_at')"),
                         "date_trunc('day'::text, now(), 'Europe/Paris'::text)")


if __name__ == "__main__":
    unittest.main()
