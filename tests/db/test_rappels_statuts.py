"""Statuts annuels : rappels 30 et 7 jours avant l'échéance, renouvellement (0118)."""
import unittest
import uuid

try:
    from .test_osint import admin
    from .test_schema import base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_osint import admin
    from test_schema import base_disponible, migrate, sql, valeur


def compte_avec_statut(dans: str) -> str:
    c = str(uuid.uuid4())
    valeur(f"""INSERT INTO core.accounts (id, username, status, certified) VALUES ('{c}', 'r_{c[:8]}', 'active', true);
               INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('{c}', 'totp', '\\x00');
               INSERT INTO core.verifications (account_id, category, expires_at) VALUES ('{c}', 'journalist', now() + interval '{dans}')""")
    return c


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestRappelsStatuts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def rappels(self, c: str) -> list[str]:
        r = valeur("SELECT coalesce(string_agg(account_id::text || ':' || palier, ','), '') FROM core.take_status_reminders()", "argos_app")
        return [x.split(":")[1] for x in r.split(",") if x.startswith(c)]

    def test_paliers_une_seule_fois(self):
        loin, mois, semaine = compte_avec_statut('90 days'), compte_avec_statut('20 days'), compte_avec_statut('3 days')
        r = valeur("SELECT coalesce(string_agg(account_id::text || ':' || palier, ','), '') FROM core.take_status_reminders()", "argos_app")
        self.assertNotIn(loin, r)
        self.assertIn(f"{mois}:30", r)
        self.assertIn(f"{semaine}:7", r)
        self.assertEqual(self.rappels(mois) + self.rappels(semaine), [])   # jamais deux fois le même palier
        # Le statut à 20 jours passe sous les 7 jours : second rappel.
        valeur(f"UPDATE core.verifications SET expires_at = now() + interval '5 days' WHERE account_id = '{mois}'")
        self.assertEqual(self.rappels(mois), ["7"])

    def test_renouvellement_dans_les_30_jours(self):
        proche, loin = compte_avec_statut('10 days'), compte_avec_statut('200 days')
        renouveler = lambda c: sql(f"SELECT core.admin_set_status('{admin()}', '{c}', 'journalist', true)", "argos_administration")
        r = renouveler(proche)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(valeur(f"""SELECT expires_at > now() + interval '370 days' AND reminded_30_at IS NULL
                                     FROM core.verifications WHERE account_id = '{proche}' AND revoked_at IS NULL"""), "t")
        self.assertIn("deja_ainsi", renouveler(loin).stderr)   # trop tôt pour renouveler


if __name__ == "__main__":
    unittest.main()
