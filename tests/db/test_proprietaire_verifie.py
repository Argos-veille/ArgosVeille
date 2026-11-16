"""Point bas de la revue (0108) : la base vérifie le lien avec la vidéo visée."""
import json
import unittest
import uuid

try:
    from .test_schema import base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import base_disponible, migrate, sql, valeur

ENVELOPPE = json.dumps({"v": "1", "destinataires": []})


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestProprietaireVerifie(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def _video(self):
        vid, empreinte = str(uuid.uuid4()), uuid.uuid4().hex * 2
        valeur(f"INSERT INTO core.videos (id, status) VALUES ('{vid}', 'in_review')")
        valeur(f"""INSERT INTO core.pseudonyms (video_id, pseudonym, tracking_code_hash)
                   VALUES ('{vid}', 'p{vid[:8]}', '\\x{empreinte}')""")
        return vid, empreinte

    def test_accord_avec_la_bonne_empreinte_seulement(self):
        vid, empreinte = self._video()
        autre = uuid.uuid4().hex * 2
        self.assertIn("introuvable", sql(f"SELECT core.grant_release('{vid}', '\\x{autre}', '{ENVELOPPE}')", "argos_app").stderr)
        self.assertEqual(sql(f"SELECT core.grant_release('{vid}', '\\x{empreinte}', '{ENVELOPPE}')", "argos_app").returncode, 0)
        self.assertEqual(valeur(f"SELECT core.revoke_release('{vid}', '\\x{autre}')", "argos_app"), "f")
        self.assertEqual(valeur(f"SELECT core.revoke_release('{vid}', '\\x{empreinte}')", "argos_app"), "t")

    def test_cle_de_copie_pour_le_proprietaire_seulement(self):
        vid, _ = self._video()
        compte = str(uuid.uuid4())
        valeur(f"""INSERT INTO core.accounts (id, username, status) VALUES ('{compte}', 'p_{compte[:8]}', 'active');
                   INSERT INTO core.video_owners (video_id, account_id) VALUES ('{vid}', '{compte}')""")
        self.assertEqual(valeur(f"SELECT core.set_owner_copy_key('{vid}', '{uuid.uuid4()}', '\\x01')", "argos_app"), "f")
        self.assertEqual(valeur(f"SELECT core.set_owner_copy_key('{vid}', '{compte}', '\\x01')", "argos_app"), "t")


if __name__ == "__main__":
    unittest.main()
