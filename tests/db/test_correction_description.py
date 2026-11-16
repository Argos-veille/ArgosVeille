"""Correction de la description par l'administration seule, sans aucune copie du texte remplacé (0113, 0114)."""
import unittest
import uuid

try:
    from .test_osint import admin
    from .test_schema import base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_osint import admin
    from test_schema import base_disponible, migrate, sql, valeur

ORIGINE = "Contrôle rue Victor Hugo, Jean Dupont filme depuis son balcon au 12."
JUSTIF = "Nom et adresse d'un témoin retirés."


def corriger(vid: str, texte: str, qui: str | None = None, justif: str = JUSTIF):
    return sql(f"SELECT core.admin_correct_description('{qui or admin()}', '{vid}', $t${texte}$t$, $t${justif}$t$)",
               "argos_administration")


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestCorrectionDescription(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def _video(self):
        vid = str(uuid.uuid4())
        valeur(f"INSERT INTO core.videos (id, status, description) VALUES ('{vid}', 'published', $t${ORIGINE}$t$)")
        return vid

    def test_corriger_sans_garder_l_ancien_texte(self):
        vid = self._video()
        r = corriger(vid, "Contrôle rue Victor Hugo, [retiré] filme depuis [retiré].")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(valeur(f"SELECT description FROM core.videos WHERE id = '{vid}'"),
                         "Contrôle rue Victor Hugo, [retiré] filme depuis [retiré].")
        # « Jean Dupont » ne reste nulle part : ni dans la vidéo, ni dans les corrections, ni au journal.
        self.assertEqual(valeur(f"""SELECT count(*) FROM core.videos v WHERE v.id = '{vid}' AND v::text LIKE '%Dupont%'"""), "0")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.description_corrections c WHERE c::text LIKE '%Dupont%'"), "0")
        self.assertEqual(valeur(f"""SELECT count(*) FROM ledger.entries WHERE kind = 'admin_action' AND payload ->> 'video' = '{vid}'
                                     AND payload ->> 'action' = 'description_corrected' AND payload::text NOT LIKE '%Dupont%'"""), "1")
        self.assertEqual(valeur(f"SELECT count(*) FROM ledger.pending WHERE payload::text LIKE '%Dupont%'"), "0")
        h = valeur(f"SELECT core.admin_description_corrections('{admin()}', '{vid}')::text", "argos_administration")
        self.assertIn(JUSTIF.replace("'", "'"), h)
        self.assertNotIn("Dupont", h)

    def test_reserve_a_l_administration(self):
        vid = self._video()
        self.assertIn("42501", sql(f"SELECT core.admin_correct_description('{admin()}', '{vid}', 'x', $t${JUSTIF}$t$)", "argos_app").stderr)
        autre = valeur(f"INSERT INTO core.accounts (id, username, status) VALUES (gen_random_uuid(), 'd_{vid[:8]}', 'active') RETURNING id").split("\n")[0]
        self.assertIn("reserve_super_admin", corriger(vid, "Autre texte.", qui=autre).stderr)
        self.assertIn("justification", corriger(vid, "Autre texte.", justif="court").stderr)
        self.assertIn("deja_ainsi", corriger(vid, ORIGINE).stderr)
        self.assertIn("42501", sql("SELECT 1 FROM core.description_corrections", "argos_app").stderr)

    def test_retrait_efface_les_corrections(self):
        vid = self._video()
        corriger(vid, "Contrôle rue Victor Hugo, [retiré].")
        valeur(f"UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now(), description = NULL WHERE id = '{vid}'")
        self.assertEqual(valeur(f"SELECT count(*) FROM core.description_corrections WHERE video_id = '{vid}'"), "0")


if __name__ == "__main__":
    unittest.main()
