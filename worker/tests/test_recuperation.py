"""Envoi par lien : sites autorisés, récupération, original chiffré, lien effacé, échec net."""
import hashlib
import hmac
import struct
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from argos_worker import boucle, chiffrement, recuperation
from argos_worker.config import Config, lire_fichier_env
from .test_worker import RACINE, base_disponible, fabriquer, migrate

CLE = "A" * 43
VRAI_RUN = subprocess.run


def faux_ytdlp(video: Path, code: int = 0):
    def run(cmd, **options):
        if "--use-extractors" not in cmd:   # ffmpeg et ffprobe restent les vrais
            return VRAI_RUN(cmd, **options)
        if code == 0:
            (Path(cmd[cmd.index("--output") + 1]).parent / "video.mp4").write_bytes(video.read_bytes())
        return subprocess.CompletedProcess(cmd, code, b"", b"")
    return run


def lire_original(f: Path, cle: bytes) -> bytes:
    donnees = f.read_bytes()
    entete, corps, sortie = donnees[:20], donnees[20:], b""
    (morceau,) = struct.unpack(">I", entete[8:12])
    pas, n = morceau + 16, max(1, -(-len(corps) // (morceau + 16)))
    aes = AESGCM(cle)
    for i in range(n):
        sortie += aes.decrypt(entete[12:] + struct.pack(">I", i), corps[i * pas:(i + 1) * pas], entete + struct.pack(">I", i) + bytes([i == n - 1]))
    return sortie


class TestSites(unittest.TestCase):
    def test_sites_autorises(self):
        for bon in ("https://x.com/a/status/1", "https://www.tiktok.com/@a/video/1", "https://youtu.be/abc", "https://bsky.app/profile/a/post/b"):
            self.assertTrue(recuperation.site_autorise(bon), bon)

    def test_liens_refuses(self):
        for mauvais in ("http://x.com/a", "https://evilx.com/a", "https://x.com.evil.fr/a", "https://x.com:8443/a", "https://user:pw@x.com/a",
                        "https://127.0.0.1/a", "file:///etc/passwd", "pas un lien"):
            self.assertFalse(recuperation.site_autorise(mauvais), mauvais)


class TestExtracteurs(unittest.TestCase):
    """Contre-vérification du second audit : chaque site n'a que ses extracteurs (Bluesky jamais hors de bsky.app)."""
    def autorises(self, url):
        from yt_dlp.extractor import gen_extractor_classes
        from yt_dlp.utils import orderedSet_from_options
        noms = [ie.IE_NAME for ie in gen_extractor_classes()]
        return set(orderedSet_from_options(recuperation.extracteurs(url).split(","), {"all": noms}, use_regex=True))

    def test_par_site(self):
        self.assertEqual(self.autorises("https://x.com/a/status/1"), {"twitter"})
        self.assertEqual(self.autorises("https://mobile.twitter.com/a/status/1"), {"twitter"})
        self.assertEqual(self.autorises("https://bsky.app/profile/a/post/b"), {"Bluesky"})
        self.assertEqual(self.autorises("https://vm.tiktok.com/abc"), {"TikTok", "vm.tiktok"})
        self.assertEqual(self.autorises("https://youtu.be/abc"), {"youtube", "YoutubeYtBe"})
        tous = set().union(*(self.autorises(f"https://{d}/a") for d in recuperation.SITES))
        self.assertNotIn("twitter:shortener", tous)
        self.assertNotIn("FacebookRedirectURL", tous)
        self.assertNotIn("generic", {n.lower() for n in tous})
        for d in recuperation.SITES:
            if d != "bsky.app":
                self.assertNotIn("Bluesky", self.autorises(f"https://{d}/a"), d)

    def test_liste_passee_a_ytdlp(self):
        with tempfile.TemporaryDirectory() as d:
            video = Path(d) / "v"
            video.write_bytes(b"x")
            with mock.patch.object(recuperation.subprocess, "run", side_effect=faux_ytdlp(video)) as run:
                recuperation.telecharger("https://x.com/a/status/1", Path(d) / "s", 1200, "socks5h://127.0.0.1:9050")
            cmd = run.call_args[0][0]
            self.assertEqual(cmd[cmd.index("--use-extractors") + 1], "twitter")
            self.assertNotIn("--proxy", cmd)


class TestChiffrement(unittest.TestCase):
    def test_format_de_l_original_relu(self):
        with tempfile.TemporaryDirectory() as d:
            clair = Path(d) / "c"
            contenu = bytes(range(256)) * 40000   # plus d'un morceau de 4 Mio
            clair.write_bytes(contenu)
            sortie = Path(d) / "o.argos"
            sha, sha_chiffre = chiffrement.chiffrer_original(clair, sortie, CLE)
            # Empreinte clée (H10) : jamais le SHA-256 simple du clair.
            self.assertEqual(sha, hmac.new(chiffrement.cle_empreinte(chiffrement._cle(CLE)), contenu, hashlib.sha256).digest())
            self.assertNotEqual(sha, hashlib.sha256(contenu).digest())
            self.assertEqual(sha_chiffre, hashlib.sha256(sortie.read_bytes()).digest())
            self.assertEqual(sortie.read_bytes()[:8], b"ARGOS-O1")
            self.assertEqual(lire_original(sortie, chiffrement._cle(CLE)), contenu)


class TestTelechargement(unittest.TestCase):
    def test_options_de_securite_et_lien_en_dernier(self):
        with tempfile.TemporaryDirectory() as d:
            video = Path(d) / "v"
            video.write_bytes(b"x")
            with mock.patch.object(recuperation.subprocess, "run", side_effect=faux_ytdlp(video)) as run:
                recuperation.telecharger("https://x.com/a/status/1", Path(d) / "s", 1200)
            cmd = run.call_args[0][0]
            for option in ("--ignore-config", "--no-exec", "--no-playlist", "--use-extractors"):
                self.assertIn(option, cmd)
            self.assertEqual(cmd[-2:], ["--", "https://x.com/a/status/1"])
            self.assertEqual((Path(d) / "s").read_bytes(), b"x")

    def test_bluesky_seulement_par_tor(self):
        # A9 : sans proxy, Bluesky est refusé sans lancer yt-dlp ; avec, toute la récupération passe par lui.
        with mock.patch.object(recuperation.subprocess, "run") as run, self.assertRaises(recuperation.Impossible):
            recuperation.telecharger("https://bsky.app/profile/a/post/b", Path("/nulle/part"), 1200)
        run.assert_not_called()
        with tempfile.TemporaryDirectory() as d:
            video = Path(d) / "v"
            video.write_bytes(b"x")
            with mock.patch.object(recuperation.subprocess, "run", side_effect=faux_ytdlp(video)) as run:
                recuperation.telecharger("https://bsky.app/profile/a/post/b", Path(d) / "s", 1200, "socks5h://127.0.0.1:9050")
                cmd = run.call_args[0][0]
                self.assertEqual(cmd[cmd.index("--proxy") + 1], "socks5h://127.0.0.1:9050")
                recuperation.telecharger("https://x.com/a/status/1", Path(d) / "s2", 1200, "socks5h://127.0.0.1:9050")
                self.assertNotIn("--proxy", run.call_args[0][0])   # les autres plateformes : en direct

    def test_site_interdit_sans_lancer_ytdlp(self):
        with mock.patch.object(recuperation.subprocess, "run") as run, self.assertRaises(recuperation.Impossible):
            recuperation.telecharger("https://exemple.fr/v", Path("/nulle/part"), 1200)
        run.assert_not_called()

    def test_echec_sans_fichier_restant(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(recuperation.subprocess, "run", side_effect=faux_ytdlp(Path(d), code=1)), self.assertRaises(recuperation.Impossible):
                recuperation.telecharger("https://x.com/a", Path(d) / "s", 1200)
            self.assertEqual([f.name for f in Path(d).iterdir()], [])


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestBoucle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")
        env = lire_fichier_env(RACINE / "worker" / ".env")
        cls.tmp = Path(tempfile.mkdtemp(prefix="argos-lien-"))
        cls.config = Config(pg_host="127.0.0.1", pg_port=5432, pg_base="argos_test", pg_mot_de_passe=env["ARGOS_PG_WORKER_PASSWORD"],
                            quarantaine=cls.tmp / "quarantaine", floutees=cls.tmp / "floutees", copies=cls.tmp / "copies",
                            redis_url=env["ARGOS_REDIS_URL"], duree_max=1200)
        cls.config.quarantaine.mkdir()
        cls.video = fabriquer(cls.tmp / "v.mp4", duree=2)
        cls.cx = boucle.connexion(cls.config)
        cls.r = boucle.redis_cles(cls.config)

    @classmethod
    def tearDownClass(cls):
        cls.cx.close()
        cls.r.close()

    def setUp(self):
        migrate.psql("argos_test", "UPDATE core.videos SET processing_started_at = now() WHERE status = 'processing'; "
                                   "UPDATE core.video_fetches SET started_at = now()")

    def _video(self, cle=True) -> str:
        vid = str(uuid.uuid4())
        migrate.psql("argos_test", f"""INSERT INTO core.videos (id, status) VALUES ('{vid}', 'processing');
                                       INSERT INTO core.video_fetches (video_id, url) VALUES ('{vid}', 'https://x.com/a/status/1')""")
        if cle:
            self.r.set(f"argos:cle-original:{vid}", CLE)
        return vid

    def _sql(self, requete: str) -> str:
        return migrate.psql("argos_test", requete).stdout.strip()

    def test_recuperee_chiffree_floutee_et_lien_efface(self):
        vid = self._video()
        with mock.patch.object(recuperation.subprocess, "run", side_effect=faux_ytdlp(self.video)):
            self.assertTrue(boucle.traiter_une(self.cx, self.config, self.r))
        self.assertEqual(self._sql(f"SELECT status FROM core.videos WHERE id = '{vid}'"), "awaiting_author")
        self.assertEqual(self._sql(f"SELECT count(*) FROM core.video_fetches WHERE video_id = '{vid}'"), "0")
        original = self.tmp / "originaux" / f"{vid}.argos"
        self.assertEqual(lire_original(original, chiffrement._cle(CLE)), self.video.read_bytes())
        attendue = hmac.new(chiffrement.cle_empreinte(chiffrement._cle(CLE)), self.video.read_bytes(), hashlib.sha256).hexdigest()
        self.assertEqual(self._sql(f"SELECT encode(original_sha256, 'hex') || '|' || original_hash_scheme || '|' || r2_original_enc_key "
                                   f"FROM core.videos WHERE id = '{vid}'"),
                         f"{attendue}|1|originaux/{vid}.argos")   # empreinte clée, schéma 1 (0123)
        self.assertIsNone(self.r.get(f"argos:cle-original:{vid}"))
        self.assertFalse((self.config.quarantaine / f"{vid}.video").exists())

    def test_recuperation_impossible_echec_net_et_lien_efface(self):
        vid = self._video()
        with mock.patch.object(recuperation.subprocess, "run", side_effect=faux_ytdlp(self.video, code=1)):
            self.assertTrue(boucle.traiter_une(self.cx, self.config, self.r))
        self.assertEqual(self._sql(f"SELECT status || '|' || failure_reason FROM core.videos WHERE id = '{vid}'"), "failed|fetch_failed")
        self.assertEqual(self._sql(f"SELECT count(*) FROM core.video_fetches WHERE video_id = '{vid}'"), "0")

    def test_workers_separes_recuperation_puis_traitement(self):
        # 0105 : le worker de traitement laisse le lien en attente ; un worker de récupération le télécharge ; le
        # traitement le prend ensuite, dans l'ordre d'arrivée.
        import dataclasses
        traitement = dataclasses.replace(self.config, role="traitement")
        recup = dataclasses.replace(self.config, role="recuperation")
        vid = self._video()
        with mock.patch.object(recuperation.subprocess, "run") as run:
            boucle.traiter_une(self.cx, traitement, self.r)
        run.assert_not_called()
        self.assertEqual(self._sql(f"SELECT status || '|' || (processing_started_at IS NULL) FROM core.videos WHERE id = '{vid}'"),
                         "processing|true")
        with mock.patch.object(recuperation.subprocess, "run", side_effect=faux_ytdlp(self.video)):
            self.assertTrue(boucle.recuperer_une(self.cx, recup, self.r))
        self.assertEqual(self._sql(f"SELECT count(*) FROM core.video_fetches WHERE video_id = '{vid}'"), "0")
        self.assertTrue((self.config.quarantaine / f"{vid}.video").exists())
        self.assertFalse(boucle.recuperer_une(self.cx, recup, self.r))   # plus rien à récupérer
        self.assertTrue(boucle.traiter_une(self.cx, traitement, self.r))
        self.assertEqual(self._sql(f"SELECT status FROM core.videos WHERE id = '{vid}'"), "awaiting_author")

    def test_recuperation_impossible_par_le_worker_dedie(self):
        import dataclasses
        recup = dataclasses.replace(self.config, role="recuperation")
        vid = self._video()
        with mock.patch.object(recuperation.subprocess, "run", side_effect=faux_ytdlp(self.video, code=1)):
            self.assertTrue(boucle.recuperer_une(self.cx, recup, self.r))
        self.assertEqual(self._sql(f"SELECT status || '|' || failure_reason FROM core.videos WHERE id = '{vid}'"), "failed|fetch_failed")
        self.assertIsNone(self.r.get(f"argos:cle-original:{vid}"))

    def test_sans_cle_echec_net(self):
        vid = self._video(cle=False)
        with mock.patch.object(recuperation.subprocess, "run") as run:
            self.assertTrue(boucle.traiter_une(self.cx, self.config, self.r))
        run.assert_not_called()
        self.assertEqual(self._sql(f"SELECT failure_reason FROM core.videos WHERE id = '{vid}'"), "fetch_failed")
