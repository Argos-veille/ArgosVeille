"""Certification et expiration annuelle des statuts (0116)."""
import unittest
import uuid

try:
    from .test_schema import base_disponible, migrate, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import base_disponible, migrate, valeur


def compte(certifie: bool = True) -> str:
    c = str(uuid.uuid4())
    valeur(f"INSERT INTO core.accounts (id, username, status, certified) VALUES ('{c}', 'c_{c[:8]}', 'active', {str(certifie).lower()})")
    return c


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestCertificationExpiree(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_statut_expire_retire_la_certification(self):
        expire, valable, confiance = compte(), compte(), compte()
        valeur(f"""INSERT INTO core.verifications (account_id, category, verified_at, expires_at)
                   VALUES ('{expire}', 'journalist', now() - interval '13 months', now() - interval '1 month'),
                          ('{valable}', 'lawyer', now(), now() + interval '11 months')""")
        valeur("SELECT core.expire_certifications()", "argos_scoring")
        etat = lambda c: valeur(f"SELECT certified FROM core.accounts WHERE id = '{c}'")
        self.assertEqual(etat(expire), "f")
        self.assertEqual(etat(valable), "t")
        self.assertEqual(etat(confiance), "t")   # « confiance » seule : jamais touchée
        # Confiance redonnée ensuite à l'ancien journaliste : le tour suivant ne la retire pas.
        valeur(f"UPDATE core.accounts SET certified = true WHERE id = '{expire}'")
        valeur("SELECT core.expire_certifications()", "argos_scoring")
        self.assertEqual(etat(expire), "t")


if __name__ == "__main__":
    unittest.main()
