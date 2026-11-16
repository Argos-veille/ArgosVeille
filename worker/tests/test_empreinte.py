"""H10 : empreinte clée de l'original, même vecteur que navigateur/test/empreinte.test.ts."""
import hashlib
import tempfile
import unittest
from pathlib import Path

from argos_worker import chiffrement

CLE_BRUTE = bytes(range(1, 33))
CLE_EMPREINTE = "9301c2416686e1b2b9b43d31a6e26949ad3c453942919808a0ba5a1dfbeb145d"
CONTENU = b"contenu de la video" * 1000
EMPREINTE = "d428d0f532ba0f438322421e811aecffbdde41b9cc38377e6f8c668447d0615e"


class TestEmpreinte(unittest.TestCase):
    def test_vecteur_commun(self):
        self.assertEqual(chiffrement.cle_empreinte(CLE_BRUTE).hex(), CLE_EMPREINTE)
        with self.assertRaises(ValueError):
            chiffrement.cle_empreinte(b"\x00" * 31)

    def test_original_par_lien(self):
        import base64
        cle_b64 = base64.urlsafe_b64encode(CLE_BRUTE).decode().rstrip("=")
        with tempfile.TemporaryDirectory() as d:
            source, sortie = Path(d) / "source", Path(d) / "original.argos"
            source.write_bytes(CONTENU)
            clair, _ = chiffrement.chiffrer_original(source, sortie, cle_b64)
        self.assertEqual(clair.hex(), EMPREINTE)                          # empreinte clée
        self.assertNotEqual(clair, hashlib.sha256(CONTENU).digest())      # jamais le SHA-256 simple du clair


if __name__ == "__main__":
    unittest.main()
