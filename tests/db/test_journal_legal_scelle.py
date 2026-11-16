"""Journal légal scellé (0125) : chiffré pour des clés publiques OpenPGP dont la partie privée n'est pas sur le serveur."""
import json
import os
import subprocess
import tempfile
import unittest
import uuid

try:
    from .test_schema import REFUSE, base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import REFUSE, base_disponible, migrate, sql, valeur


def cle(algo: str = "rsa2048") -> tuple[str, str, str]:
    """Clé de test sans phrase : clé principale + sous-clé de chiffrement ; renvoie (publique, privée, empreinte)."""
    with tempfile.TemporaryDirectory() as d:
        os.chmod(d, 0o700)
        env = {**os.environ, "GNUPGHOME": d}
        principale = "ed25519" if algo == "cv25519" else algo
        subprocess.run(["gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key",
                        "Argos journal légal (test)", principale, "sign", "never"], env=env, check=True, capture_output=True)
        fpr = subprocess.run(["gpg", "--batch", "--with-colons", "--list-keys"], env=env, check=True,
                             capture_output=True, text=True).stdout.split("fpr:::::::::")[1].split(":")[0]
        subprocess.run(["gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-add-key",
                        fpr, algo, "encr", "never"], env=env, check=True, capture_output=True)
        pub = subprocess.run(["gpg", "--batch", "--export"], env=env, check=True, capture_output=True).stdout
        sec = subprocess.run(["gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--export-secret-keys"],
                             env=env, check=True, capture_output=True).stdout
        return pub.hex(), sec.hex(), fpr


def poser(n: int, pub: str, fpr: str = ""):
    return sql(f"SELECT identity.set_legal_seal_key({n}::smallint, '\\x{pub}')")


def ouvrir(colonne: str, sec: str, condition: str = "TRUE") -> dict:
    return json.loads(valeur(f"""SELECT public.pgp_pub_decrypt({colonne}, '\\x{sec}') FROM identity.legal_connection_logs
                                  WHERE {condition} ORDER BY id DESC LIMIT 1"""))


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestJournalLegalScelle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")
        cls.k1, cls.k2 = cle(), cle()

    def tearDown(self):
        # Les autres tests écrivent en clair.
        valeur("DELETE FROM identity.legal_seal_key; UPDATE identity.legal_seal_settings SET required = false; "
               "DELETE FROM identity.legal_connection_logs WHERE sceau IS NOT NULL")

    def test_une_cle_suffit(self):
        pub, sec, fpr = self.k1
        self.assertEqual(poser(1, pub, fpr).returncode, 0)
        compte, video = str(uuid.uuid4()), str(uuid.uuid4())
        valeur(f"SELECT identity.log_legal('{compte}', 'upload', '203.0.113.7', 4242, '{video}')", "argos_identity")
        ligne = valeur("""SELECT coalesce(ip::text, '-') || '|' || coalesce(account_id::text, '-') || '|'
                           || coalesce(content_id::text, '-') || '|' || action || '|' || (sceau_2 IS NULL)
                           || '|' || (occurred_at = date_trunc('day', occurred_at, 'Europe/Paris'))
                           FROM identity.legal_connection_logs ORDER BY id DESC LIMIT 1""")
        self.assertEqual(ligne, "-|-|-|upload|true|true")   # rien en clair, hors l'opération et son jour
        clair = ouvrir("sceau", sec)
        self.assertEqual((clair["ip"], clair["port"], clair["compte"], clair["contenu"]), ("203.0.113.7", 4242, compte, video))
        # Le site n'écrit plus directement, ne lit ni le journal ni les clés, et ne peut pas poser de clé.
        self.assertIn(REFUSE, sql("INSERT INTO identity.legal_connection_logs (action, ip) VALUES ('login', '1.2.3.4')", "argos_identity").stderr)
        self.assertIn(REFUSE, sql("SELECT 1 FROM identity.legal_seal_key", "argos_identity").stderr)
        self.assertIn(REFUSE, sql("UPDATE identity.legal_seal_settings SET required = false", "argos_identity").stderr)
        self.assertIn(REFUSE, sql(f"SELECT identity.set_legal_seal_key(1::smallint, '\\x{pub}')", "argos_identity").stderr)
        # L'identifiant enregistré est calculé sur la clé : celui de la sous-clé de chiffrement.
        self.assertEqual(valeur("SELECT fingerprint = upper(public.pgp_key_id(public_key)) FROM identity.legal_seal_key"), "t")
        self.assertEqual(len(valeur("SELECT fingerprint FROM identity.legal_seal_key")), 16)

    def test_double_sceau_chaque_cle_ouvre_seule(self):
        (p1, s1, f1), (p2, s2, f2) = self.k1, self.k2
        poser(1, p1, f1); poser(2, p2, f2)
        video = str(uuid.uuid4())
        valeur(f"SELECT identity.log_legal(NULL, 'login', '2001:db8::1', 1, NULL)", "argos_identity")
        valeur(f"SELECT identity.log_legal(NULL, 'upload', '198.51.100.9', 1, '{video}')", "argos_identity")
        self.assertEqual(ouvrir("sceau", s1)["contenu"], video)
        self.assertEqual(ouvrir("sceau_2", s2)["contenu"], video)
        self.assertNotEqual(sql(f"SELECT public.pgp_pub_decrypt(sceau, '\\x{s2}') FROM identity.legal_connection_logs ORDER BY id DESC LIMIT 1").returncode, 0)
        # Même taille avec ou sans compte, en IPv4 ou en IPv6.
        self.assertEqual(valeur("SELECT count(DISTINCT length(sceau)) FROM (SELECT sceau FROM identity.legal_connection_logs ORDER BY id DESC LIMIT 2) t"), "1")

    def test_cle_obligatoire_une_fois_posee(self):
        pub, _, fpr = self.k1
        poser(1, pub, fpr)
        valeur("DELETE FROM identity.legal_seal_key")
        r = sql("SELECT identity.log_legal(NULL, 'login', '192.0.2.1', 1, NULL)", "argos_identity")
        self.assertIn("argos:journal_legal_sans_cle", r.stderr)
        # Pas plus par un autre chemin (propriétaire) : le déclencheur refuse toute ligne en clair.
        r = sql("INSERT INTO identity.legal_connection_logs (action, ip) VALUES ('login', '192.0.2.2')")
        self.assertIn("argos:journal_legal_sans_cle", r.stderr)

    def test_ouverture_en_heure_de_paris(self):
        """00:30 à Paris = la veille en UTC : l'outil du PC doit filtrer et afficher l'heure de Paris."""
        racine = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        outil = os.path.join(racine, "deploiement", "admin", "ouvrir-journal-legal.py")
        if not os.path.exists(outil):  # copie publique du code, sans deploiement/
            self.skipTest("outil de l'administration absent")
        pub, sec, fpr = self.k1
        poser(1, pub, fpr)
        video = str(uuid.uuid4())
        valeur(f"""INSERT INTO identity.legal_connection_logs (occurred_at, action, sceau)
                   SELECT '2026-11-16 00:00+01', 'upload', identity.legal_seal('203.0.113.30', 1, NULL, '{video}',
                          '2026-11-15 23:30:05+00', 1::smallint)""")
        self.assertTrue(valeur("SELECT public.pgp_pub_decrypt(sceau, '\\x" + sec + "') FROM identity.legal_connection_logs ORDER BY id DESC LIMIT 1").startswith('{'))
        with tempfile.TemporaryDirectory() as d:
            export, prive = os.path.join(d, "e.csv"), os.path.join(d, "k.asc")
            b64 = valeur("SELECT replace(encode(sceau, 'base64'), E'\\n', '') FROM identity.legal_connection_logs ORDER BY id DESC LIMIT 1")
            with open(export, "w") as f:
                f.write(f"id,jour,action,sceau,sceau_2\n1,2026-11-16,upload,{b64},\n")
            with open(prive, "wb") as f:
                f.write(bytes.fromhex(sec))
            r = subprocess.run(["python3", outil, export, prive, "--de", "00:00", "--a", "01:00", "--terminal"], capture_output=True, text=True, input="\n")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("16/11/2026 00:30:05 (Paris)", r.stdout)
            self.assertIn(video, r.stdout)
            r = subprocess.run(["python3", outil, export, prive, "--de", "23:00", "--a", "23:59", "--terminal"], capture_output=True, text=True, input="\n")
            self.assertNotIn(video, r.stdout)

    def test_cle_ecc_refusee(self):
        pub, _, fpr = cle("cv25519")
        self.assertNotEqual(poser(1, pub, fpr).returncode, 0)
        self.assertEqual(valeur("SELECT count(*) FROM identity.legal_seal_key"), "0")

    def test_sans_cle_en_clair_puis_scelle_a_la_pose(self):
        video = str(uuid.uuid4())
        valeur(f"SELECT identity.log_legal(NULL, 'upload', '198.51.100.9', 1, '{video}')", "argos_identity")
        self.assertEqual(valeur(f"SELECT count(*) FROM identity.legal_connection_logs WHERE content_id = '{video}'"), "1")
        pub, sec, fpr = self.k1
        poser(1, pub, fpr)
        self.assertNotEqual(valeur("SELECT identity.seal_existing_legal_logs()"), "0")
        self.assertEqual(valeur("SELECT count(*) FROM identity.legal_connection_logs WHERE ip IS NOT NULL OR sceau IS NULL"), "0")
        self.assertEqual(ouvrir("sceau", sec, f"occurred_at = date_trunc('day', now(), 'Europe/Paris')")["ip"] is not None, True)

    def test_purge_au_lendemain_du_premier_anniversaire(self):
        valeur("""INSERT INTO identity.legal_connection_logs (occurred_at, action, ip) VALUES
                  (date_trunc('day', now(), 'Europe/Paris') - interval '1 year', 'login', '192.0.2.50'),
                  (date_trunc('day', now(), 'Europe/Paris') - interval '1 year 1 day', 'login', '192.0.2.51')""")
        valeur("SELECT identity.purge_legal_logs()", "argos_identity")
        self.assertEqual(valeur("SELECT string_agg(host(ip), ',') FROM identity.legal_connection_logs WHERE ip << '192.0.2.48/29'"), "192.0.2.50")
        valeur("DELETE FROM identity.legal_connection_logs WHERE ip << '192.0.2.48/29'")


if __name__ == "__main__":
    unittest.main()
