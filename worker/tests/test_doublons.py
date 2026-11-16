"""Comparaison des empreintes : niveaux, scores, et enregistrement des ressemblances par le worker."""
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

import numpy as np

from argos_worker import boucle, doublons
from argos_worker.config import Config, lire_fichier_env
from .test_worker import RACINE, base_disponible, fabriquer, migrate


class TestScores(unittest.TestCase):
    def test_cles_d_index(self):
        from argos_worker.doublons import cles
        k = cles(np.array([0x0001_0002_0003_0004], dtype="<u8"), np.array([0x0005_0006], dtype="<u4"))
        self.assertEqual(k, [4, 65536 + 3, 2 * 65536 + 2, 3 * 65536 + 1, 4 * 65536 + 6, 5 * 65536 + 5])

    def test_niveaux(self):
        self.assertEqual(doublons.niveau(True, 0, None, None), "exact")
        self.assertEqual(doublons.niveau(False, 0.9, None, None), "strong")
        self.assertEqual(doublons.niveau(False, 0.2, 0.9, None), "strong")
        self.assertEqual(doublons.niveau(False, 0.2, None, None), "possible")
        self.assertEqual(doublons.niveau(False, 0.0, 0.95, None), "possible")   # une même musique ne suffit pas
        self.assertEqual(doublons.niveau(False, 0.0, None, 0.9), "possible")
        self.assertIsNone(doublons.niveau(False, 0.05, 0.7, 0.5))

    def test_visuel_retrouve_un_extrait_decale(self):
        r = np.random.default_rng(1).integers(0, 2**63, 200, dtype=np.uint64)
        self.assertEqual(doublons.score_visuel(r[50:120], np.zeros(70, np.uint64), r), 1.0)

    def test_visuel_sans_rapport(self):
        g = np.random.default_rng(2)
        a, b = g.integers(0, 2**63, 100, dtype=np.uint64), g.integers(0, 2**63, 100, dtype=np.uint64)
        self.assertLess(doublons.score_visuel(a, a, b), 0.1)

    def test_son_trop_court(self):
        self.assertIsNone(doublons.score_son(np.zeros(5, np.uint32), np.zeros(50, np.uint32)))

    def test_camera_immobile_ne_dit_rien(self):
        self.assertIsNone(doublons.score_camera(np.zeros((100, 2)), np.zeros((100, 2))))

    def test_camera_miroir(self):
        g = np.random.default_rng(3)
        q = g.normal(0, 5, (200, 2))
        m = q * np.array([-1.0, 1.0])
        self.assertGreater(doublons.score_camera(q, m), 0.99)


def autre_scene(chemin: Path) -> Path:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "mandelbrot=size=320x240:rate=10", "-t", "5",
                    "-pix_fmt", "yuv420p", str(chemin)], check=True)
    return chemin


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestRecherche(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")
        # Les empreintes laissées par les autres tests sont les mêmes mires : on repart de zéro.
        migrate.psql("argos_test", "DELETE FROM core.video_fingerprints")
        env = lire_fichier_env(RACINE / "worker" / ".env")
        cls.tmp = Path(tempfile.mkdtemp(prefix="argos-doublons-"))
        cls.config = Config(pg_host="127.0.0.1", pg_port=5432, pg_base="argos_test",
                            pg_mot_de_passe=env["ARGOS_PG_WORKER_PASSWORD"],
                            quarantaine=cls.tmp / "quarantaine", floutees=cls.tmp / "floutees",
                            copies=cls.tmp / "copies", redis_url=env["ARGOS_REDIS_URL"], duree_max=1200)
        cls.config.quarantaine.mkdir()
        cls.video = fabriquer(cls.tmp / "v.mp4", duree=5)
        cls.compressee = cls.tmp / "c.mp4"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(cls.video), "-vf", "scale=160:120", "-crf", "36", str(cls.compressee)], check=True)
        cls.autre = autre_scene(cls.tmp / "a.mp4")
        cls.cx = boucle.connexion(cls.config)

    @classmethod
    def tearDownClass(cls):
        cls.cx.close()

    def setUp(self):
        migrate.psql("argos_test", "UPDATE core.videos SET processing_started_at = now() WHERE status = 'processing'")

    def _traiter(self, fichier: Path, sha: str = "NULL") -> str:
        vid = str(uuid.uuid4())
        migrate.psql("argos_test", f"INSERT INTO core.videos (id, status, original_sha256) VALUES ('{vid}', 'processing', {sha})")
        (self.config.quarantaine / f"{vid}.video").write_bytes(fichier.read_bytes())
        self.assertTrue(boucle.traiter_une(self.cx, self.config))
        return vid

    def _niveau(self, a: str, b: str) -> str:
        return migrate.psql("argos_test", f"SELECT level FROM core.video_matches WHERE video_id = '{a}' AND other_video_id = '{b}'").stdout.strip()

    def test_copie_compressee_puis_scene_differente(self):
        a = self._traiter(self.video)
        b = self._traiter(self.compressee)
        c = self._traiter(self.autre)
        self.assertEqual(self._niveau(b, a), "strong")
        self.assertEqual(self._niveau(c, a), "")
        self.assertEqual(self._niveau(c, b), "")

    def test_index_retrouve_la_copie_au_dela_du_seuil(self):
        # Au-delà du seuil, seules les candidates de l'index sont comparées (0095) : la copie doit en faire partie.
        from unittest import mock
        from argos_worker import doublons
        with mock.patch.object(doublons, "SEUIL_INDEX", 0):
            a = self._traiter(self.video)
            b = self._traiter(self.compressee)
            c = self._traiter(self.autre)
        self.assertEqual(self._niveau(b, a), "strong")
        self.assertEqual(self._niveau(c, a), "")
        n = migrate.psql("argos_test", f"SELECT count(*) FROM core.fingerprint_keys WHERE video_id IN ('{a}', '{b}')").stdout.strip()
        self.assertGreater(int(n), 0)

    def test_meme_fichier_original_avec_index(self):
        from unittest import mock
        from argos_worker import doublons
        sha = "'\\x" + uuid.uuid4().hex * 2 + "'"
        with mock.patch.object(doublons, "SEUIL_INDEX", 0):
            a = self._traiter(self.autre, sha)
            b = self._traiter(self.autre, sha)
        self.assertEqual(self._niveau(b, a), "exact")

    def test_meme_fichier_original(self):
        sha = "'\\x" + uuid.uuid4().hex * 2 + "'"
        a = self._traiter(self.autre, sha)
        b = self._traiter(self.autre, sha)
        self.assertEqual(self._niveau(b, a), "exact")

    def test_retrait_efface_les_ressemblances(self):
        a = self._traiter(self.autre)
        b = self._traiter(self.autre)
        self.assertNotEqual(self._niveau(b, a), "")
        migrate.psql("argos_test", f"UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '{a}'")
        self.assertEqual(self._niveau(b, a), "")
