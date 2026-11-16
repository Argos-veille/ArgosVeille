"""Empreintes pour repérer les doublons : calcul, enregistrement par le worker, rattrapage."""
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

import numpy as np

from argos_worker import boucle, empreintes
from argos_worker.config import Config, lire_fichier_env
from outils.rattraper_empreintes import rattraper
from .test_worker import RACINE, base_disponible, fabriquer, migrate


def copie(source: Path, sortie: Path, *options: str) -> Path:
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(source), *options, str(sortie)], check=True)
    return sortie


def ecart_moyen(a: bytes, b: bytes) -> float:
    x, y = np.frombuffer(a, np.uint64), np.frombuffer(b, np.uint64)
    n = min(len(x), len(y))
    return float(np.bitwise_count(x[:n] ^ y[:n]).mean())


class TestCalcul(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="argos-empreintes-"))
        cls.video = fabriquer(cls.tmp / "v.mp4", duree=6)
        cls.e = empreintes.calculer(cls.video, avec_son=True)

    def test_tailles(self):
        self.assertEqual(len(self.e.visuel) / 8, 24)   # 4 images/s × 6 s
        self.assertEqual(len(self.e.visuel_miroir), len(self.e.visuel))
        self.assertEqual(len(self.e.camera) % 8, 0)
        self.assertGreater(len(self.e.son), 0)

    def test_copie_compressee_proche(self):
        e = empreintes.calculer(copie(self.video, self.tmp / "c.mp4", "-vf", "scale=160:120", "-crf", "38"), True)
        self.assertLess(ecart_moyen(self.e.visuel, e.visuel), 8)

    def test_miroir_retrouve(self):
        e = empreintes.calculer(copie(self.video, self.tmp / "m.mp4", "-vf", "hflip"), True)
        self.assertLess(ecart_moyen(self.e.visuel_miroir, e.visuel), 8)
        self.assertGreater(ecart_moyen(self.e.visuel, e.visuel), 8)

    def test_son_retire_par_la_source(self):
        self.assertIsNone(empreintes.calculer(self.video, avec_son=False).son)

    def test_video_sans_son(self):
        self.assertIsNone(empreintes.calculer(fabriquer(self.tmp / "s.mp4", duree=2, son=False), True).son)

    def test_fichier_illisible_sans_exception(self):
        mauvais = self.tmp / "x.mp4"
        mauvais.write_bytes(b"ceci n'est pas une video")
        with self.assertLogs("argos_worker", "ERROR"):
            self.assertIsNone(empreintes.calculer(mauvais, True))


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestEnregistrement(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")
        env = lire_fichier_env(RACINE / "worker" / ".env")
        cls.tmp = Path(tempfile.mkdtemp(prefix="argos-empreintes-"))
        cls.config = Config(pg_host="127.0.0.1", pg_port=5432, pg_base="argos_test",
                            pg_mot_de_passe=env["ARGOS_PG_WORKER_PASSWORD"],
                            quarantaine=cls.tmp / "quarantaine", floutees=cls.tmp / "floutees",
                            copies=cls.tmp / "copies", redis_url=env["ARGOS_REDIS_URL"], duree_max=1200)
        cls.config.quarantaine.mkdir()
        cls.video = fabriquer(cls.tmp / "v.mp4", duree=5)   # le son demande quelques secondes
        cls.cx = boucle.connexion(cls.config)

    @classmethod
    def tearDownClass(cls):
        cls.cx.close()

    def setUp(self):
        migrate.psql("argos_test", "UPDATE core.videos SET processing_started_at = now() WHERE status = 'processing'")

    def _video(self, garder_son=True) -> str:
        vid = str(uuid.uuid4())
        migrate.psql("argos_test", f"INSERT INTO core.videos (id, status, keep_audio) VALUES ('{vid}', 'processing', {garder_son})")
        (self.config.quarantaine / f"{vid}.video").write_bytes(self.video.read_bytes())
        return vid

    def _ligne(self, vid: str) -> str:
        return migrate.psql("argos_test", f"""SELECT origin || '|' || (octet_length(visual) > 0) || '|' || (audio IS NOT NULL)
                                                 FROM core.video_fingerprints WHERE video_id = '{vid}'""").stdout.strip()

    def test_video_traitee_a_ses_empreintes(self):
        vid = self._video()
        self.assertTrue(boucle.traiter_une(self.cx, self.config))
        self.assertEqual(self._ligne(vid), "blurred|true|true")

    def test_son_retire_pas_d_empreinte_audio(self):
        vid = self._video(garder_son=False)
        self.assertTrue(boucle.traiter_une(self.cx, self.config))
        self.assertEqual(self._ligne(vid), "blurred|true|false")

    def test_echec_du_calcul_ne_bloque_pas_la_video(self):
        vid = self._video()
        with mock.patch.object(empreintes, "calculer", return_value=None):
            self.assertTrue(boucle.traiter_une(self.cx, self.config))
        self.assertEqual(migrate.psql("argos_test", f"SELECT status FROM core.videos WHERE id = '{vid}'").stdout.strip(), "awaiting_author")
        self.assertEqual(self._ligne(vid), "")

    def test_rattrapage_depuis_la_version_floutee(self):
        vid = self._video()
        with mock.patch.object(empreintes, "calculer", return_value=None):
            boucle.traiter_une(self.cx, self.config)
        rattraper(self.cx, self.config.floutees)
        self.assertEqual(self._ligne(vid), "blurred|true|true")
