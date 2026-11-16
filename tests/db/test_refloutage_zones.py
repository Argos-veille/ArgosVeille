"""Re-floutage (0080) : une zone à points de passage produit de nombreux segments, 500 au plus."""
import json
import unittest
import uuid

try:
    from .test_schema import CONTRAINTE, base_disponible, migrate, sql, valeur
except ImportError:   # lancé avec « discover -s tests/db »
    from test_schema import CONTRAINTE, base_disponible, migrate, sql, valeur

ZONE = {"debut": 0, "fin": 1, "de": [0.1, 0.1, 0.2, 0.2], "a": [0.1, 0.1, 0.2, 0.2]}


def demande(n: int):
    vid = str(uuid.uuid4())
    valeur(f"INSERT INTO core.videos (id, status) VALUES ('{vid}', 'published')")
    return sql(f"""INSERT INTO core.reblur_requests (video_id, zones, reason)
                   VALUES ('{vid}', '{json.dumps([ZONE] * n)}', 'Visage oublié signalé.')""")


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestZones(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")

    def test_limite(self):
        self.assertEqual(demande(500).returncode, 0)
        self.assertIn(CONTRAINTE, demande(501).stderr)


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestRetraitPendantRefloutage(unittest.TestCase):
    """B7 : un re-floutage ne fait jamais réapparaître une vidéo retirée."""

    def _demande(self):
        vid = str(uuid.uuid4())
        valeur(f"INSERT INTO core.videos (id, status) VALUES ('{vid}', 'published')")
        rid = valeur(f"""INSERT INTO core.reblur_requests (video_id, zones, reason, source_ready_at)
                         VALUES ('{vid}', '{json.dumps([ZONE])}', 'Visage oublié signalé.', now()) RETURNING id""").split("\n")[0]
        return vid, rid

    def test_retrait_avant_ou_pendant(self):
        # Retirée avant d'être prise : la demande est abandonnée, le worker ne la prend pas.
        vid, rid = self._demande()
        valeur(f"UPDATE core.videos SET status = 'removed' WHERE id = '{vid}'")
        self.assertEqual(valeur(f"SELECT failed_at IS NOT NULL FROM core.reblur_requests WHERE id = '{rid}'"), "t")
        self.assertNotIn(rid, valeur("SELECT coalesce(string_agg(id::text, ','), '') FROM core.take_reblur()", "argos_worker"))
        # Retirée pendant : le résultat est refusé (le worker efface alors ses fichiers).
        vid2, rid2 = self._demande()
        valeur(f"UPDATE core.reblur_requests SET started_at = now(), attempts = 1 WHERE id = '{rid2}'")
        valeur(f"UPDATE core.videos SET status = 'removed' WHERE id = '{vid2}'")
        self.assertEqual(valeur(f"SELECT core.finish_reblur('{rid2}', '\\x00')", "argos_worker"), "f")
        self.assertEqual(valeur(f"SELECT blurred_sha256 IS NULL FROM core.videos WHERE id = '{vid2}'"), "t")
        # Vidéo toujours en ligne : accepté.
        vid3, rid3 = self._demande()
        self.assertEqual(valeur(f"SELECT core.finish_reblur('{rid3}', '\\x01')", "argos_worker"), "t")
