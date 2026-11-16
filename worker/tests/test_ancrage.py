"""Ancrage du journal public dans Bitcoin (OpenTimestamps) : une ancre par jour, preuve immuable une fois
confirmée, format de preuve vérifié avec des calendriers factices (aucun appel réseau)."""
import hashlib
import io
import sys
import unittest
from datetime import date, datetime, timedelta
import random
from pathlib import Path
from unittest import mock

RACINE = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(RACINE / "db"))
sys.path.insert(0, str(RACINE / "worker"))
import migrate  # noqa: E402
from argos_worker import ancrage, boucle  # noqa: E402
from argos_worker.config import Config, lire_fichier_env  # noqa: E402
from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation  # noqa: E402
from opentimestamps.core.op import OpAppend, OpSHA256  # noqa: E402
from opentimestamps.core.serialize import BytesDeserializationContext  # noqa: E402
from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp  # noqa: E402


class FauxCalendrier:
    """Calendrier OpenTimestamps factice : engagement en attente, puis confirmation dans un bloc."""
    confirme = False

    def __init__(self, url):
        self.url = url

    def submit(self, empreinte, timeout=None):
        t = Timestamp(empreinte)
        engagement = t.ops.add(OpAppend(b"\x01" * 8)).ops.add(OpSHA256())
        engagement.attestations.add(PendingAttestation(self.url))
        return t

    def get_timestamp(self, engagement, timeout=None):
        if not FauxCalendrier.confirme:
            raise KeyError("pas encore confirmé")
        t = Timestamp(engagement)
        t.attestations.add(BitcoinBlockHeaderAttestation(921_000))
        return t


class TestPreuve(unittest.TestCase):
    def test_preuve_en_attente_puis_confirmee(self):
        empreinte = hashlib.sha256(b"tete de chaine").digest()
        FauxCalendrier.confirme = False
        with mock.patch("opentimestamps.calendar.RemoteCalendar", FauxCalendrier):
            preuve = ancrage.horodater(empreinte, ("https://a.exemple", "https://b.exemple"))
            fichier = DetachedTimestampFile.deserialize(BytesDeserializationContext(preuve))
            self.assertEqual(fichier.file_digest, empreinte)   # la preuve porte bien sur cette empreinte
            self.assertEqual(len([a for _, a in fichier.timestamp.all_attestations() if isinstance(a, PendingAttestation)]), 2)
            _, bloc = ancrage.completer(preuve, ("https://a.exemple", "https://b.exemple"))
            self.assertIsNone(bloc)                            # pas encore dans Bitcoin
            FauxCalendrier.confirme = True
            complete, bloc = ancrage.completer(preuve, ("https://a.exemple", "https://b.exemple"))
            self.assertEqual(bloc, 921_000)
            self.assertGreater(len(complete), len(preuve))
            # Calendriers configurés ailleurs : les adresses de la preuve ne sont pas contactées.
            _, bloc = ancrage.completer(preuve, ("https://autre.exemple-bis",))
            self.assertIsNone(bloc)

    def test_adresses_permises(self):
        domaines = ancrage.domaines_permis(("https://a.pool.opentimestamps.org", "https://a.pool.eternitywall.com"))
        self.assertEqual(domaines, {"opentimestamps.org", "eternitywall.com"})
        for bonne in ("https://alice.btc.calendar.opentimestamps.org", "https://finney.calendar.eternitywall.com"):
            self.assertTrue(ancrage.adresse_permise(bonne, domaines), bonne)
        for mauvaise in ("http://alice.btc.calendar.opentimestamps.org", "https://127.0.0.1", "https://10.0.0.1:8080",
                         "https://opentimestamps.org.attaque.fr", "https://evilopentimestamps.org",
                         "https://alice.opentimestamps.org:8080", "file:///etc/passwd"):
            self.assertFalse(ancrage.adresse_permise(mauvaise, domaines), mauvaise)

    def test_aucun_calendrier_joignable(self):
        class Panne(FauxCalendrier):
            def submit(self, empreinte, timeout=None):
                raise OSError("injoignable")
        with mock.patch("opentimestamps.calendar.RemoteCalendar", Panne):
            with self.assertRaises(RuntimeError):
                ancrage.horodater(b"\x00" * 32, ("https://a.exemple",))


def base_disponible() -> bool:
    return migrate.psql("argos_test", "SELECT 1").returncode == 0


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestAncrage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")
        env = lire_fichier_env(RACINE / "worker" / ".env")
        c = Config(pg_host="127.0.0.1", pg_port=5432, pg_base="argos_test", pg_mot_de_passe=env["ARGOS_PG_WORKER_PASSWORD"],
                   quarantaine=Path("/tmp"), floutees=Path("/tmp"), copies=Path("/tmp"), redis_url=env["ARGOS_REDIS_URL"], duree_max=60)
        cls.cx = boucle.connexion(c)

    @classmethod
    def tearDownClass(cls):
        cls.cx.close()

    def jour(self, j: str) -> float:
        return datetime.fromisoformat(f"{j}T12:00:00+01:00").timestamp()

    @staticmethod
    def jours_libres(n: int = 2) -> list[str]:
        """Jours lointains tirés au hasard : une ancre ne s'efface jamais, chaque passage des tests prend les siens."""
        d = date(2040, 1, 1) + timedelta(days=random.randrange(0, 365 * 50))
        return [(d + timedelta(days=i)).isoformat() for i in range(n)]

    def test_une_ancre_simulee_par_jour_sur_la_tete_de_chaine(self):
        migrate.psql("argos_test", "SELECT ledger.append('rule_change', '{\"essai\": \"ancrage\"}')")
        tete = self.cx.execute("SELECT seq, hash FROM ledger.entries ORDER BY seq DESC LIMIT 1").fetchone()
        jour, lendemain = self.jours_libres()
        ancrage.tour(self.cx, "simule", (), self.jour(jour))
        a = self.cx.execute("SELECT last_seq, root_hash, simulated, ots_proof FROM ledger.anchors WHERE day = %s", (jour,)).fetchone()
        self.assertEqual((a[0], bytes(a[1]), a[2], bytes(a[3])), (tete[0], bytes(tete[1]), True, ancrage.SIMULATION))
        ancrage.tour(self.cx, "simule", (), self.jour(jour) + 3600)   # même jour : rien de plus
        self.assertEqual(self.cx.execute("SELECT count(*) FROM ledger.anchors WHERE day = %s", (jour,)).fetchone()[0], 1)
        ancrage.tour(self.cx, "simule", (), self.jour(lendemain))    # lendemain sans nouvelle entrée : pas d'ancre
        self.assertIsNone(self.cx.execute("SELECT 1 FROM ledger.anchors WHERE day = %s", (lendemain,)).fetchone())

    def test_une_ancre_ne_change_plus(self):
        migrate.psql("argos_test", "SELECT ledger.append('rule_change', '{\"essai\": \"ancre immuable\"}')")
        j = self.jours_libres(1)[0]
        ancrage.tour(self.cx, "simule", (), self.jour(j))
        jour = (j,)
        for requete in ("UPDATE ledger.anchors SET root_hash = '\\x00' WHERE day = '{j}'",
                        "DELETE FROM ledger.anchors WHERE day = '{j}'"):
            r = migrate.psql("argos_test", requete.format(j=jour[0]))
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("ancre du journal", r.stderr)


if __name__ == "__main__":
    unittest.main()
