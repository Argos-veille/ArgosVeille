"""Audit H5 (0121) : conversation « Administration » réservée à l'API d'administration."""
import unittest
import uuid

try:
    from .test_osint import admin
    from .test_schema import base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_osint import admin
    from test_schema import base_disponible, migrate, sql, valeur


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestMessagerieAdmin(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_conversation_admin_reservee(self):
        a, vid = admin(), str(uuid.uuid4())
        k = lambda: '\\x04' + uuid.uuid4().hex * 4   # point de 65 octets
        prive = '\\x' + '00' * 40
        valeur(f"""INSERT INTO core.videos (id, status) VALUES ('{vid}', 'published');
                   INSERT INTO core.pseudonyms (video_id, pseudonym, tracking_code_hash) VALUES ('{vid}', 'm{vid[:8]}', '\\x{uuid.uuid4().hex * 2}');
                   INSERT INTO core.public_keys (pseudonym_id, public_key, wrapped_private)
                     SELECT id, '{k()}', '{prive}' FROM core.pseudonyms WHERE video_id = '{vid}';
                   INSERT INTO core.public_keys (account_id, public_key, wrapped_private, kdf_salt, kdf_iterations)
                     VALUES ('{a}', '{k()}', '{prive}', '\\x{'00' * 16}', 100000) ON CONFLICT DO NOTHING""")
        ouvrir = f"""INSERT INTO core.conversations (pseudonym_id, verified_account_id, with_admin)
                     SELECT id, '{a}', true FROM core.pseudonyms WHERE video_id = '{vid}'"""
        self.assertIn("reserve_super_admin", sql(ouvrir, "argos_app").stderr)
        self.assertEqual(sql(ouvrir, "argos_administration").returncode, 0)
        # Contre-vérification (0124) : un message côté « Administration » ne vient que de l'API d'administration.
        conv = valeur(f"SELECT id FROM core.conversations WHERE with_admin AND verified_account_id = '{a}' ORDER BY created_at DESC LIMIT 1")
        ecrire = f"INSERT INTO core.messages (conversation_id, sender, ciphertext) VALUES ('{conv}', 'verified', '\\x00')"
        self.assertIn("reserve_super_admin", sql(ecrire, "argos_app").stderr)
        self.assertEqual(sql(ecrire, "argos_administration").returncode, 0)


if __name__ == "__main__":
    unittest.main()
