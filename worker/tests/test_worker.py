"""Tests du worker vidéo : vraies vidéos fabriquées par ffmpeg, vraie base argos_test.

    cd worker && .venv/bin/python -m unittest
"""
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

RACINE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(RACINE / "db"))
import migrate  # noqa: E402

import base64
import os


from argos_worker import boucle, chiffrement, ffmpeg, traitement  # noqa: E402
from argos_worker.config import Config, lire_fichier_env  # noqa: E402


def fabriquer(chemin: Path, *options: str, duree: float = 1, taille: str = "320x240", son: bool = True, fmt=None):
    cmd = ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"testsrc=duration={duree}:size={taille}:rate=10"]
    if son:
        cmd += ["-f", "lavfi", "-i", f"sine=duration={duree}", "-c:a", "aac"]
    cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-shortest", *options]
    if fmt:
        cmd += ["-f", fmt]
    subprocess.run([*cmd, str(chemin)], check=True)
    return chemin


def sonder_sortie(chemin: Path) -> dict:
    r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(chemin)],
                       capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


class TestVerification(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="argos-worker-"))
        cls.normale = fabriquer(cls.tmp / "normale.mp4")
        cls.mov = fabriquer(cls.tmp / "normale.mov")
        cls.webm = cls.tmp / "normale.webm"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=10",
                        "-c:v", "libvpx-vp9", "-deadline", "realtime", str(cls.webm)], check=True)

    def test_videos_acceptees(self):
        for f in (self.normale, self.mov, self.webm):
            with self.subTest(f=f.name):
                i = ffmpeg.sonder(f, 1200)
                self.assertEqual((i.largeur, i.hauteur), (320, 240))
                self.assertAlmostEqual(i.duree, 1, delta=0.2)

    def test_video_tournee_dimensions_inversees(self):
        tournee = self.tmp / "tournee.mp4"   # rotation de 90° indiquée dans le conteneur, comme un téléphone en portrait
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-display_rotation", "90", "-i", str(self.normale),
                        "-c", "copy", str(tournee)], check=True)
        i = ffmpeg.sonder(tournee, 1200)
        self.assertEqual((i.largeur, i.hauteur), (240, 320))

    def _refus(self, chemin: Path, raison: str, duree_max: int = 1200):
        with self.assertRaises(ffmpeg.FichierRefuse) as ctx:
            ffmpeg.sonder(chemin, duree_max)
        self.assertEqual(ctx.exception.raison, raison, str(ctx.exception))

    def test_fichiers_refuses(self):
        texte = self.tmp / "texte.video"
        texte.write_text("#!/bin/sh\nrm -rf /\n")
        self._refus(texte, "not_a_video")
        # Liste de lecture HLS qui tenterait de lire un fichier du serveur : refusée avant même ffprobe.
        piege = self.tmp / "piege.video"
        piege.write_text("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n")
        self._refus(piege, "not_a_video")
        concat = self.tmp / "concat.video"
        concat.write_text("ffconcat version 1.0\nfile /etc/passwd\n")
        self._refus(concat, "not_a_video")
        # Signature MP4 suivie de n'importe quoi.
        faux_mp4 = self.tmp / "faux.video"
        faux_mp4.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"\xff" * 5000)
        self._refus(faux_mp4, "unreadable")
        faux_mkv = self.tmp / "faux.mkv"
        faux_mkv.write_bytes(b"\x1a\x45\xdf\xa3" + b"\x00" * 5000)
        self._refus(faux_mkv, "unreadable")

    def test_son_seul_refuse(self):
        son = self.tmp / "son.m4a"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac",
                        str(son)], check=True)
        self._refus(son, "not_a_video")

    def test_trop_longue_ou_trop_grande(self):
        longue = fabriquer(self.tmp / "longue.mp4", duree=3, son=False)
        self._refus(longue, "too_long", duree_max=1)
        geante = fabriquer(self.tmp / "geante.mp4", taille="4112x16", son=False)
        self._refus(geante, "too_large")

    def test_boite_de_sortie(self):
        i = ffmpeg.Infos(duree=1, largeur=3840, hauteur=2160, codec_video="h264", audio=True)
        self.assertEqual(ffmpeg.boite(i, 1080), (1920, 1080))
        self.assertEqual(ffmpeg.boite(i, 480), (854, 480))
        portrait = ffmpeg.Infos(duree=1, largeur=1080, hauteur=1920, codec_video="h264", audio=True)
        self.assertEqual(ffmpeg.boite(portrait, 480), (480, 854))
        petite = ffmpeg.Infos(duree=1, largeur=320, hauteur=240, codec_video="h264", audio=True)
        self.assertEqual(ffmpeg.boite(petite, 1080), (320, 240))   # jamais agrandie


class TestTraitement(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="argos-worker-"))
        cls.source = fabriquer(cls.tmp / "source.mov", "-metadata", "location=+48.8566+002.3522/",
                               "-metadata", "creation_time=2026-11-03T14:12:00Z", "-metadata", "title=Mon nom de famille",
                               "-metadata", "make=Apple", "-metadata", "model=iPhone 16", taille="1920x1080", duree=2)

    def test_sorties_sans_metadonnees(self):
        d = self.tmp / "sortie"
        r = traitement.traiter(self.source, d, True, 1200)
        for f in (r.apercu, r.video):
            with self.subTest(f=f.name):
                s = sonder_sortie(f)
                # Seule étiquette technique qui reste : le nom générique de NOTRE encodeur (champ imposé
                # par le format MP4), identique pour toutes les vidéos, sans version.
                for x in s["streams"]:
                    self.assertIn(x.get("tags", {}).get("encoder"), (None, "Lavc libx264"))
                textes = json.dumps(s["format"].get("tags", {})) + json.dumps([x.get("tags", {}) for x in s["streams"]])
                for interdit in ("48.8566", "location", "creation_time", "Mon nom", "iPhone", "Apple", "Lavf", "Lavc6"):
                    self.assertNotIn(interdit, textes, f"{f.name} : {interdit}")
        dims = lambda f: next((x["width"], x["height"]) for x in sonder_sortie(f)["streams"] if x["codec_type"] == "video")
        self.assertEqual(dims(r.apercu), (854, 480))
        self.assertEqual(dims(r.video), (1920, 1080))
        self.assertEqual(sorted(f.name for f in d.iterdir()), ["apercu.mp4", "video.mp4"])   # rien d'autre
        with open(r.video, "rb") as f:   # « faststart » : l'index (moov) est en tête, lecture immédiate en ligne
            self.assertIn(b"moov", f.read(4096))
        self.assertEqual(r.sha256, hashlib.sha256(r.video.read_bytes()).digest())

    def test_son_garde_ou_coupe(self):
        avec = traitement.traiter(self.source, self.tmp / "avec", True, 1200)
        sans = traitement.traiter(self.source, self.tmp / "sans", False, 1200)
        pistes = lambda f: sorted(x["codec_type"] for x in sonder_sortie(f)["streams"])
        self.assertEqual(pistes(avec.video), ["audio", "video"])
        self.assertEqual(pistes(sans.video), ["video"])
        self.assertEqual(pistes(sans.apercu), ["video"])

    def test_avancement(self):
        etapes = []
        traitement.traiter(self.source, self.tmp / "avancement", True, 1200, etapes.append)
        self.assertEqual(etapes[-1], 1.0)
        self.assertEqual(etapes, sorted(etapes))


def base_disponible() -> bool:
    return migrate.psql("argos_test", "SELECT 1").returncode == 0


@unittest.skipUnless(base_disponible(), "base argos_test non joignable")
class TestBoucle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        migrate.migrer("argos_test")
        env = lire_fichier_env(RACINE / "worker" / ".env")
        cls.tmp = Path(tempfile.mkdtemp(prefix="argos-worker-"))
        cls.config = Config(pg_host="127.0.0.1", pg_port=5432, pg_base="argos_test",
                            pg_mot_de_passe=env["ARGOS_PG_WORKER_PASSWORD"],
                            quarantaine=cls.tmp / "quarantaine", floutees=cls.tmp / "floutees",
                            copies=cls.tmp / "copies", redis_url=env["ARGOS_REDIS_URL"], duree_max=1200)
        cls.config.quarantaine.mkdir()
        cls.r = boucle.redis_cles(cls.config)
        cls.video = fabriquer(cls.tmp / "v.mp4")
        cls.cx = boucle.connexion(cls.config)

    @classmethod
    def tearDownClass(cls):
        cls.cx.close()
        cls.r.close()

    def setUp(self):
        # Les vidéos « processing » laissées par d'autres tests ne doivent pas être prises ici.
        migrate.psql("argos_test", "UPDATE core.videos SET processing_started_at = now() WHERE status = 'processing'")
        # De même pour les demandes de re-floutage laissées par les tests de l'API.
        migrate.psql("argos_test", "UPDATE core.reblur_requests SET failed_at = now() WHERE done_at IS NULL AND failed_at IS NULL")

    def _video(self, contenu: bytes | None = None, garder_son=True) -> str:
        vid = str(uuid.uuid4())
        migrate.psql("argos_test", f"INSERT INTO core.videos (id, status, keep_audio) VALUES ('{vid}', 'processing', {garder_son})")
        (self.config.quarantaine / f"{vid}.video").write_bytes(contenu if contenu is not None else self.video.read_bytes())
        return vid

    def _etat(self, vid: str) -> str:
        return migrate.psql("argos_test", f"""SELECT status || '|' || coalesce(failure_reason, '-') || '|' ||
            coalesce(processing_progress::text, '-') || '|' || coalesce(r2_blurred_key, '-') || '|' ||
            coalesce(r2_preview_key, '-') || '|' || (blurred_sha256 IS NOT NULL) FROM core.videos WHERE id = '{vid}'""").stdout.strip()

    def test_video_traitee_puis_a_verifier(self):
        vid = self._video()
        self.assertTrue(boucle.traiter_une(self.cx, self.config))
        self.assertEqual(self._etat(vid), f"awaiting_author|-|100|floutees/{vid}|floutees/{vid}/apercu.mp4|true")
        self.assertFalse((self.config.quarantaine / f"{vid}.video").exists())   # copie de travail effacée
        self.assertTrue((self.config.floutees / vid / "video.mp4").exists())

    def test_refloutage_par_l_administration(self):
        """Zones ajoutées sur la version floutée actuelle : nouvelle version, nouvelle empreinte, source effacée."""
        vid = self._video()
        self.assertTrue(boucle.traiter_une(self.cx, self.config))
        migrate.psql("argos_test", f"UPDATE core.videos SET status = 'published' WHERE id = '{vid}'")
        avant = migrate.psql("argos_test", f"SELECT encode(blurred_sha256, 'hex') FROM core.videos WHERE id = '{vid}'").stdout.strip()
        zones = '[{"debut": 0, "fin": 1, "de": [0.1, 0.1, 0.5, 0.5], "a": [0.1, 0.1, 0.5, 0.5]}]'
        rid = migrate.psql("argos_test", f"""INSERT INTO core.reblur_requests (video_id, zones, reason, source_ready_at)
            VALUES ('{vid}', '{zones}', 'Visage oublié signalé.', now()) RETURNING id""").stdout.strip().splitlines()[0]
        self.assertTrue(boucle.traiter_refloutage(self.cx, self.config))
        apres = migrate.psql("argos_test", f"SELECT encode(blurred_sha256, 'hex') FROM core.videos WHERE id = '{vid}'").stdout.strip()
        self.assertNotEqual(avant, apres)
        self.assertEqual(migrate.psql("argos_test", f"SELECT done_at IS NOT NULL FROM core.reblur_requests WHERE id = '{rid}'").stdout.strip(), "t")
        self.assertFalse((self.config.floutees / vid / boucle.SOURCE_REFLOUTAGE).exists())
        self.assertTrue((self.config.floutees / vid / "apercu.mp4").exists())
        self.assertFalse(boucle.traiter_refloutage(self.cx, self.config))   # plus rien à faire

    def test_fichier_refuse_echec_et_copie_effacee(self):
        vid = self._video(b"pas une video du tout")
        boucle.traiter_une(self.cx, self.config)
        self.assertEqual(self._etat(vid), "failed|not_a_video|-|-|-|false")
        self.assertFalse((self.config.quarantaine / f"{vid}.video").exists())
        self.assertFalse((self.config.floutees / vid).exists())

    def test_rien_a_traiter(self):
        self.assertFalse(boucle.traiter_une(self.cx, self.config))

    def test_deux_workers_ne_prennent_pas_la_meme_video(self):
        a, b = self._video(), self._video()
        autre = boucle.connexion(self.config)
        try:
            pris = {boucle.prendre(self.cx)[0], boucle.prendre(autre)[0]}
        finally:
            autre.close()
        self.assertEqual(pris, {a, b})

    def test_trop_de_tentatives_echec(self):
        vid = self._video()
        migrate.psql("argos_test", f"UPDATE core.videos SET processing_attempts = 3 WHERE id = '{vid}'")
        boucle.traiter_une(self.cx, self.config)
        self.assertEqual(self._etat(vid).split("|")[:2], ["failed", "processing_error"])

    def test_panne_imprevue_nouvel_essai_plus_tard(self):
        vid = self._video()
        with mock.patch.object(boucle, "traiter", side_effect=RuntimeError("panne")):
            boucle.traiter_une(self.cx, self.config)
        self.assertEqual(self._etat(vid).split("|")[0], "processing")
        self.assertTrue((self.config.quarantaine / f"{vid}.video").exists())   # gardée pour le nouvel essai
        self.assertTrue(boucle.traiter_une(self.cx, self.config))              # reprise immédiate possible
        self.assertEqual(self._etat(vid).split("|")[0], "awaiting_author")

    def test_video_retiree_pendant_le_traitement(self):
        vid = self._video()
        vrai = boucle.traiter

        def retrait_pendant(*a, **k):
            r = vrai(*a, **k)
            migrate.psql("argos_test", f"UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '{vid}'")
            return r
        with mock.patch.object(boucle, "traiter", side_effect=retrait_pendant):
            boucle.traiter_une(self.cx, self.config)
        self.assertEqual(self._etat(vid).split("|")[0], "withdrawn")
        self.assertFalse((self.config.floutees / vid).exists())   # sorties effacées
        self.assertFalse((self.config.quarantaine / f"{vid}.video").exists())

    def test_copie_chiffree_avec_la_cle_de_la_source(self):
        vid = self._video()
        cle = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
        self.r.set(f"argos:cle-copie:{vid}", cle, ex=3600)
        boucle.traiter_une(self.cx, self.config, self.r)
        self.assertEqual(self._etat(vid).split("|")[0], "awaiting_author")
        self.assertIsNone(self.r.get(f"argos:cle-copie:{vid}"))                   # clé oubliée aussitôt
        copie = self.config.copies / vid / "copie.enc"
        self.assertNotEqual(copie.read_bytes()[16:64], self.video.read_bytes()[:48])   # pas en clair
        self.assertEqual(copie.stat().st_mode & 0o777, 0o660)   # groupe argos (API + worker), jamais les autres
        clair = self.tmp / f"{vid}.clair"
        chiffrement.dechiffrer_fichier(copie, clair, cle)
        self.assertEqual(clair.read_bytes(), self.video.read_bytes())          # la source retrouve sa copie
        pistes = json.loads((self.config.copies / vid / "pistes.json").read_text())
        self.assertIsInstance(pistes, list)                                      # mire de test : aucun visage
        self.assertFalse((self.config.quarantaine / f"{vid}.video").exists())   # rien en clair ne reste

    def test_sans_cle_rien_n_est_garde(self):
        vid = self._video()
        boucle.traiter_une(self.cx, self.config, self.r)
        self.assertEqual(self._etat(vid).split("|")[0], "awaiting_author")
        self.assertFalse((self.config.copies / vid).exists())

    def test_cle_illisible_rien_n_est_garde(self):
        vid = self._video()
        self.r.set(f"argos:cle-copie:{vid}", "trop-courte", ex=3600)
        boucle.traiter_une(self.cx, self.config, self.r)
        self.assertEqual(self._etat(vid).split("|")[0], "awaiting_author")
        self.assertFalse((self.config.copies / vid).exists())
        self.assertIsNone(self.r.get(f"argos:cle-copie:{vid}"))

    def test_echec_cle_oubliee(self):
        vid = self._video(b"pas une video du tout")
        self.r.set(f"argos:cle-copie:{vid}", "x" * 43, ex=3600)
        boucle.traiter_une(self.cx, self.config, self.r)
        self.assertIsNone(self.r.get(f"argos:cle-copie:{vid}"))
        self.assertFalse((self.config.copies / vid).exists())

    def test_retiree_pendant_le_traitement_pas_de_copie(self):
        vid = self._video()
        self.r.set(f"argos:cle-copie:{vid}", base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode(), ex=3600)
        vrai = boucle.traiter

        def retrait_pendant(*a, **k):
            r = vrai(*a, **k)
            migrate.psql("argos_test", f"UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '{vid}'")
            return r
        with mock.patch.object(boucle, "traiter", side_effect=retrait_pendant):
            boucle.traiter_une(self.cx, self.config, self.r)
        self.assertFalse((self.config.copies / vid).exists())
        self.assertIsNone(self.r.get(f"argos:cle-copie:{vid}"))

    # --- Retouches (6c-2) ---------------------------------------------------------

    def _image(self, video: Path, t: float = 0.5):
        import numpy as np
        brut = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", str(t), "-i", str(video), "-frames:v", "1",
                               "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
        i = sonder_sortie(video)["streams"][0]
        return np.frombuffer(brut, np.uint8).reshape(int(i["height"]), int(i["width"]))

    def _prete_a_retoucher(self):
        vid = self._video()
        cle = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
        self.r.set(f"argos:cle-copie:{vid}", cle, ex=3600)
        boucle.traiter_une(self.cx, self.config, self.r)
        self.assertEqual((self.config.copies / vid / "verif").read_text(), hashlib.sha256(cle.encode()).hexdigest())
        return vid, cle

    def _demander(self, vid: str, cle: str | None, demande: dict, n: int = 1):
        (self.config.copies / vid / "demande.json").write_text(json.dumps(demande))
        if cle:
            self.r.set(f"argos:cle-copie:{vid}", cle, ex=3600)
        migrate.psql("argos_test", f"""UPDATE core.videos SET status = 'processing', retouches = {n}, processing_attempts = 0,
                                        processing_started_at = NULL WHERE id = '{vid}'""")

    def _sha(self, vid: str) -> str:
        return migrate.psql("argos_test", f"SELECT encode(blurred_sha256, 'hex') FROM core.videos WHERE id = '{vid}'").stdout.strip()

    def test_retouche_zone_ajoutee_floutee(self):
        vid, cle = self._prete_a_retoucher()
        avant = self._image(self.config.floutees / vid / "video.mp4")
        sha = self._sha(vid)
        zone = [0.25, 0.25, 0.5, 0.5]
        self._demander(vid, cle, {"retirees": [], "zones": [{"debut": 0, "fin": 1, "de": zone, "a": zone}]})
        self.assertTrue(boucle.traiter_une(self.cx, self.config, self.r))
        self.assertEqual(self._etat(vid).split("|")[0], "awaiting_author")
        self.assertNotEqual(self._sha(vid), sha)
        apres = self._image(self.config.floutees / vid / "video.mp4")
        h, l = apres.shape
        centre = (slice(int(h * 0.35), int(h * 0.65)), slice(int(l * 0.35), int(l * 0.65)))
        import cv2
        detail = lambda img, zone: float(cv2.Laplacian(img, cv2.CV_64F)[zone].std())   # contours fins
        self.assertLess(detail(apres, centre), detail(avant, centre) * 0.3)   # le centre de la mire est flouté
        coin = (slice(0, int(h * 0.15)), slice(0, int(l * 0.15)))
        self.assertGreater(detail(apres, coin), detail(avant, coin) * 0.8)    # le reste de l'image est intact
        self.assertTrue((self.config.copies / vid / "retouche.json").exists())
        self.assertFalse((self.config.copies / vid / "demande.json").exists())
        self.assertTrue((self.config.copies / vid / "copie.enc").exists())          # gardée pour d'autres retouches
        self.assertIsNone(self.r.get(f"argos:cle-copie:{vid}"))
        self.assertFalse((self.config.quarantaine / f"{vid}.video").exists())      # rien en clair
        self.assertEqual(sorted(p.name for p in self.config.floutees.iterdir() if p.name.startswith(vid)), [vid])

    def test_retouche_sans_cle_ou_mauvaise_cle_rien_ne_change(self):
        for cle_donnee in (None, base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()):
            with self.subTest(cle=cle_donnee is not None):
                vid, _ = self._prete_a_retoucher()
                sha = self._sha(vid)
                self._demander(vid, cle_donnee, {"retirees": [], "zones": []})
                boucle.traiter_une(self.cx, self.config, self.r)
                self.assertEqual(self._etat(vid).split("|")[0], "awaiting_author")
                self.assertEqual(self._sha(vid), sha)
                self.assertFalse((self.config.copies / vid / "demande.json").exists())
                self.assertFalse((self.config.quarantaine / f"{vid}.video").exists())
                self.assertIsNone(self.r.get(f"argos:cle-copie:{vid}"))

    def test_retouche_panne_garde_l_ancienne_version(self):
        vid, cle = self._prete_a_retoucher()
        sha = self._sha(vid)
        self._demander(vid, cle, {"retirees": [], "zones": []})
        with mock.patch.object(traitement.detection, "rendre", side_effect=RuntimeError("panne")):
            boucle.traiter_une(self.cx, self.config, self.r)
        self.assertEqual(self._etat(vid).split("|")[0], "processing")             # nouvel essai plus tard
        self.assertTrue((self.config.floutees / vid / "video.mp4").exists())       # ancienne version intacte
        self.assertFalse((self.config.quarantaine / f"{vid}.video").exists())
        self.assertFalse((self.config.floutees / f"{vid}.retouche").exists())
        self.assertEqual(self._sha(vid), sha)
        boucle.traiter_une(self.cx, self.config, self.r)
        self.assertEqual(self._etat(vid).split("|")[0], "awaiting_author")

    def test_retouche_retiree_pendant_le_traitement(self):
        vid, cle = self._prete_a_retoucher()
        self._demander(vid, cle, {"retirees": [], "zones": []})
        vrai = boucle.retoucher

        def retrait_pendant(*a, **k):
            r = vrai(*a, **k)
            migrate.psql("argos_test", f"UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '{vid}'")
            return r
        with mock.patch.object(boucle, "retoucher", side_effect=retrait_pendant):
            boucle.traiter_une(self.cx, self.config, self.r)
        self.assertFalse((self.config.floutees / vid).exists())
        self.assertFalse((self.config.copies / vid).exists())


class TestChiffrement(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="argos-chiffrement-"))
        cls.cle = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
        cls.clair = cls.tmp / "clair"
        cls.clair.write_bytes(os.urandom(2 * chiffrement.MORCEAU + 1234))   # 3 morceaux, le dernier incomplet
        cls.chiffre = cls.tmp / "chiffre"
        chiffrement.chiffrer_fichier(cls.clair, cls.chiffre, cls.cle)

    def _dechiffrer(self, source: Path, cle=None) -> bytes:
        sortie = self.tmp / "sortie"
        chiffrement.dechiffrer_fichier(source, sortie, cle or self.cle)
        return sortie.read_bytes()

    def test_aller_retour(self):
        self.assertEqual(self._dechiffrer(self.chiffre), self.clair.read_bytes())
        vide = self.tmp / "vide"
        vide.write_bytes(b"")
        chiffrement.chiffrer_fichier(vide, self.tmp / "vide.enc", self.cle)
        self.assertEqual(self._dechiffrer(self.tmp / "vide.enc"), b"")

    def test_mauvaise_cle(self):
        autre = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
        with self.assertRaises(chiffrement.CleInvalide):
            self._dechiffrer(self.chiffre, autre)

    def test_alterations_detectees(self):
        o = self.chiffre.read_bytes()
        pas = chiffrement.MORCEAU + chiffrement.ETIQUETTE
        modifie = bytearray(o)
        modifie[100] ^= 1
        cas = {
            "octet modifié": bytes(modifie),
            "dernier morceau retiré": o[:16 + 2 * pas],
            "morceaux échangés": o[:16] + o[16 + pas:16 + 2 * pas] + o[16:16 + pas] + o[16 + 2 * pas:],
            "en-tête changé": o[:8] + os.urandom(8) + o[16:],
        }
        for nom, contenu in cas.items():
            with self.subTest(nom):
                f = self.tmp / "altere"
                f.write_bytes(contenu)
                with self.assertRaises(chiffrement.CleInvalide):
                    self._dechiffrer(f)

    def test_cles_refusees(self):
        for cle in ("", "court", "!" * 43, base64.urlsafe_b64encode(os.urandom(16)).decode()):
            with self.subTest(cle=cle), self.assertRaises(chiffrement.CleInvalide):
                chiffrement.chiffrer_fichier(self.clair, self.tmp / "x", cle)


if __name__ == "__main__":
    unittest.main()
