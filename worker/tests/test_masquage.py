"""Le test qui compte : chaque visage PROCHE est-il flouté, image par image ?

Règle du projet : on masque les visages directement identifiables, proches de la caméra (au moins
5 % du petit côté de l'image), pas les visages lointains d'une foule.

On fabrique une vidéo où des visages (découpés dans des photos du domaine public de la NASA, voir
photos/SOURCES.md) se déplacent, à des tailles allant d'un gros plan à un visage lointain. On connaît
donc leur position exacte à chaque image. Après traitement, on compare la vidéo produite à la source :
le détail de chaque visage proche doit avoir disparu (flou destructeur), celui des visages lointains
doit être resté.

    cd worker && .venv/bin/python -m unittest tests.test_masquage -v
"""
import subprocess
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

from argos_worker import detection, traitement

PHOTOS = Path(__file__).resolve().parent / "photos"
L, H, CADENCE, DUREE = 1280, 720, 30, 3


def visages_de_reference() -> list[np.ndarray]:
    """Visages nets découpés dans les portraits (détection à pleine résolution, confiance élevée)."""
    det = cv2.FaceDetectorYN.create(str(detection.MODELE), "", (320, 320), 0.9, 0.3, 50)
    r = []
    for nom in ("josh-cassada-portrait_52232657797_o.jpg", "iss074-s-002.jpg", "jsc2025e041955.jpg"):
        img = cv2.imread(str(PHOTOS / nom))
        det.setInputSize((img.shape[1], img.shape[0]))
        _, v = det.detect(img)
        for x, y, w, h in (v[:, :4] if v is not None else []):
            m = 0.15   # un peu de marge autour du visage
            x0, y0 = int(max(0, x - m * w)), int(max(0, y - m * h))
            r.append(img[y0:int(y + h * (1 + m)), x0:int(x + w * (1 + m))].copy())
    return r


def fabriquer_video(chemin: Path, visages: list[np.ndarray], tailles: list[int], allers: float = 1):
    """Fond texturé ; chaque visage traverse l'image. Renvoie, par image, les zones exactes des visages."""
    rng = np.random.default_rng(7)
    fond = cv2.GaussianBlur(rng.integers(60, 200, (H, L, 3), dtype=np.uint8), (0, 0), 6)
    verite: list[list[tuple[int, int, int, int, int]]] = []
    p = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{L}x{H}",
                          "-framerate", str(CADENCE), "-i", "pipe:0", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16",
                          "-pix_fmt", "yuv420p", str(chemin)], stdin=subprocess.PIPE)
    n = CADENCE * DUREE
    for i in range(n):
        image = fond.copy()
        zones = []
        for k, taille in enumerate(tailles):
            v = visages[k % len(visages)]
            hv = int(taille * v.shape[0] / v.shape[1])
            phase = (i / n * allers) % 2
            phase = phase if phase <= 1 else 2 - phase                                # va-et-vient
            x = int(40 + (L - taille - 80) * (phase if k % 2 == 0 else 1 - phase))
            y = int(30 + k * (H - 60) / len(tailles))
            y = min(y, H - hv - 1)
            image[y:y + hv, x:x + taille] = cv2.resize(v, (taille, hv), interpolation=cv2.INTER_AREA)
            zones.append((k, x, y, taille, hv))
        verite.append(zones)
        p.stdin.write(image.tobytes())
    p.stdin.close()
    p.wait()
    return verite


def images(chemin: Path):
    p = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-i", str(chemin), "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"],
                         stdout=subprocess.PIPE)
    try:
        while len(b := p.stdout.read(L * H * 3)) == L * H * 3:
            yield np.frombuffer(b, np.uint8).reshape(H, L, 3)
    finally:
        p.stdout.close()
        p.wait()


def detail(image: np.ndarray) -> np.ndarray:
    """Détail fin d'une image : ce qu'il reste une fois retiré son propre flou (grain, contours, traits)."""
    g = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(float)
    return g - cv2.GaussianBlur(g, (0, 0), 2)


def detail_restant(sortie: np.ndarray, source: np.ndarray, x: int, y: int, l: int, h: int) -> float:
    """Part du détail fin de l'ovale du visage qui subsiste dans la sortie (≈ 1 : intact, ≈ 0 : détruit).
    L'image collée contient une marge de 15 % : l'ovale du visage occupe les 70 % centraux."""
    cx0, cy0, lz, hz = x + int(0.15 * l), y + int(0.15 * h), int(0.7 * l), int(0.7 * h)
    zs, zo = sortie[cy0:cy0 + hz, cx0:cx0 + lz], source[cy0:cy0 + hz, cx0:cx0 + lz]
    yy, xx = np.mgrid[0:zo.shape[0], 0:zo.shape[1]]
    ovale = ((xx - lz / 2) / (lz / 2)) ** 2 + ((yy - hz / 2) / (hz / 2)) ** 2 <= 1
    ref = detail(zo)[ovale].std()
    return float(detail(zs)[ovale].std() / ref) if ref > 0 else 0.0


class TestMasquage(unittest.TestCase):
    def test_tous_les_visages_recouverts_a_chaque_image(self):
        """Visages qui traversent l'image en 3 s."""
        self._scenario(allers=1)

    def test_camera_qui_balaie_vite(self):
        """Visages qui traversent l'image en 1,5 s, dans un sens puis dans l'autre (≈ 800 px/s)."""
        self._scenario(allers=2)

    def _scenario(self, allers: float):
        visages = visages_de_reference()
        self.assertGreaterEqual(len(visages), 8)
        tmp = Path(tempfile.mkdtemp(prefix="argos-masquage-"))
        # Largeur des images collées (visage + 15 % de marge de chaque côté). Seuil de masquage : visage de
        # 36 px en 720p, soit une image collée d'environ 47 px. 60 px et plus : visages proches, à masquer ;
        # 30 px : visage lointain (23 px), à laisser.
        tailles = [220, 140, 90, 60, 30]
        verite = fabriquer_video(tmp / "source.mp4", visages, tailles, allers)
        r = traitement.traiter(tmp / "source.mp4", tmp / "sortie", False, 1200)

        seuil = detection.TAILLE_MIN * H * 1.3   # visage de 36 px en 720p, plus la marge de l'image collée
        rates: dict[int, int] = {t: 0 for t in tailles}
        nb = 0
        for i, (sortie, source) in enumerate(zip(images(r.video), images(tmp / "source.mp4"))):
            nb += 1
            for k, x, y, l, h in verite[i]:
                reste = detail_restant(sortie, source, x, y, l, h)
                if tailles[k] >= seuil and reste > 0.3:
                    rates[tailles[k]] += 1       # visage proche resté net
                if tailles[k] < seuil and reste < 0.6:
                    rates[tailles[k]] += 1       # visage lointain flouté alors qu'il ne devait pas l'être
        self.assertEqual(nb, CADENCE * DUREE)
        rapport = ", ".join(f"{t} px : {rates[t]}/{nb} images en erreur" for t in tailles)
        print(f"\n  {rapport}")
        for t in tailles:
            self.assertEqual(rates[t], 0, f"visage de {t} px : {rates[t]} image(s) en erreur — {rapport}")

    def test_flou_irreversible(self):
        """Deux « visages » différents, de mêmes couleurs moyennes par grandes zones, donnent exactement le
        même cœur flouté : le détail est détruit, il n'y a rien à « déflouter »."""
        rng = np.random.default_rng(1)
        base = cv2.resize(rng.integers(60, 196, (5, 5, 3), dtype=np.uint8), (100, 100), interpolation=cv2.INTER_NEAREST)
        # Damier fin (±40 d'un pixel à l'autre) : de moyenne nulle sur toute zone un peu étendue.
        yy, xx = np.mgrid[0:100, 0:100]
        motif = np.where((xx + yy) % 2 == 0, 40, -40)[..., None].repeat(3, axis=2)
        a = np.full((200, 300, 3), 128, np.uint8)
        b = a.copy()
        a[50:150, 100:200] = base
        b[50:150, 100:200] = np.clip(base.astype(int) + motif, 0, 255).astype(np.uint8)
        self.assertGreater(np.abs(a.astype(int) - b.astype(int)).max(), 20)   # deux visages bien différents
        boite = [detection.Boite(100 / 300, 50 / 200, 100 / 300, 100 / 200)]
        detection.dessiner(a, boite)
        detection.dessiner(b, boite)
        coeur = (slice(85, 115), slice(135, 165))
        self.assertLessEqual(np.abs(a[coeur].astype(int) - b[coeur].astype(int)).max(), 2)   # arrondis près
        self.assertTrue((a[0:20, 0:20] == 128).all())   # rien n'est touché hors de la zone

    def test_bords_fondus(self):
        image = np.zeros((100, 200, 3), np.uint8)
        image[:, 100:] = 255   # moitié noire, moitié blanche
        detection.dessiner(image, [detection.Boite(0.25, 0.1, 0.5, 0.8)])
        ligne = image[50, 50:150, 0].astype(int)
        self.assertLess(np.abs(np.diff(ligne)).max(), 60)   # pas de contour net : transition progressive

    @staticmethod
    def _vue(t, x, taille=0.1, score=0.8, y=0.4):
        return detection.Detection(t, detection.Boite(x, y, taille * 0.5625, taille), score, taille)

    def test_pas_de_clignotement_quand_le_visage_est_perdu_un_instant(self):
        # Visage vu de 0 à 1 s, perdu 0,7 s (tête tournée), revu de 1,8 à 3 s.
        vues = [(i / 10, [self._vue(i / 10, 0.3 + i / 100)]) for i in range(31) if not 10 < i < 18]
        m = detection.Masques(vues)
        for i in range(0, 31):
            self.assertEqual(len(m.a(i / 10)), 1, f"pas de masque à t={i / 10}")
        trou = m.a(1.4)[0]
        self.assertTrue(0.3 + 0.10 < trou.x + trou.l / 2 < 0.3 + 0.18 + 0.1)   # glissé entre les deux positions

    def test_faux_positif_isole_ecarte(self):
        unique = [(0.0, []), (0.1, [self._vue(0.1, 0.5, score=0.7)]), (0.2, [])]
        self.assertEqual(detection.Masques(unique).a(0.1), [])
        sur = [(0.0, []), (0.1, [self._vue(0.1, 0.5, score=0.95)]), (0.2, [])]
        self.assertEqual(len(detection.Masques(sur).a(0.1)), 1)   # vu une fois mais avec une très forte confiance

    def test_visage_lointain_non_masque_visage_proche_masque_toute_la_piste(self):
        loin = [(i / 10, [self._vue(i / 10, 0.2, taille=0.03)]) for i in range(10)]
        self.assertEqual(detection.Masques(loin).a(0.5), [])
        # Une personne qui s'approche : petite au début, proche ensuite. Masquée dès le début de sa piste.
        approche = [(i / 10, [self._vue(i / 10, 0.2, taille=0.02 + i * 0.01)]) for i in range(10)]
        m = detection.Masques(approche)
        self.assertEqual(len(m.a(0.0)), 1)
        self.assertEqual(len(m.a(0.9)), 1)

    def test_deux_visages_voisins_restent_deux_pistes(self):
        vues = [(i / 10, [self._vue(i / 10, 0.2), self._vue(i / 10, 0.6)]) for i in range(10)]
        m = detection.Masques(vues)
        masques = m.a(0.5)
        self.assertEqual(len(masques), 2)
        self.assertTrue(all(b.l < 0.15 for b in masques))   # aucun masque étiré entre les deux visages

    def test_marge_proportionnee(self):
        b = detection.Boite(0.4, 0.4, 0.1, 0.1)
        petit, gros = detection.ajuster(b, detection.TAILLE_MIN), detection.ajuster(b, 0.3)
        self.assertAlmostEqual(petit.l, 0.14)
        self.assertAlmostEqual(gros.l, 0.115)
        self.assertLess(petit.y, b.y)   # plus de marge vers le haut

    def test_modele_verifie(self):
        detection.charger_detecteur()   # empreinte correcte
        with unittest.mock.patch.object(detection, "EMPREINTE_MODELE", "0" * 64):
            with self.assertRaises(RuntimeError):
                detection.charger_detecteur()


import unittest.mock  # noqa: E402

class TestRetouches(unittest.TestCase):
    PISTES = [{"id": 0, "instants": [0.0, 1.0], "zones": [[0.1, 0.1, 0.2, 0.2], [0.3, 0.1, 0.2, 0.2]]},
              {"id": 1, "instants": [0.0, 1.0], "zones": [[0.6, 0.6, 0.1, 0.1], [0.6, 0.6, 0.1, 0.1]]}]

    def test_pistes_retirees(self):
        m = detection.Masques.depuis_pistes(self.PISTES, {1})
        boites = m.a(0.5)
        self.assertEqual(len(boites), 1)
        self.assertAlmostEqual(boites[0].x + boites[0].l / 2, 0.3, delta=0.05)   # interpolée à mi-chemin
        self.assertEqual(len(detection.Masques.depuis_pistes(self.PISTES).a(0.5)), 2)

    def test_zone_qui_glisse(self):
        de, a = detection.Boite(0.0, 0.0, 0.2, 0.2), detection.Boite(0.8, 0.4, 0.2, 0.2)
        m = detection.Masques.depuis_pistes([], set(), [(2.0, 4.0, de, a)])
        self.assertEqual(m.a(1.9), [])
        self.assertEqual(m.a(4.1), [])
        milieu = m.a(3.0)[0]
        self.assertAlmostEqual(milieu.x, 0.4)
        self.assertAlmostEqual(milieu.y, 0.2)
        self.assertTrue(milieu.rect)

    def test_rectangle_floute_jusqu_aux_coins(self):
        rng = np.random.default_rng(1)
        image = rng.integers(0, 255, (200, 200, 3), dtype=np.uint8)
        rect, ellipse = image.copy(), image.copy()
        detection.dessiner(rect, [detection.Boite(0.25, 0.25, 0.5, 0.5, rect=True)])
        detection.dessiner(ellipse, [detection.Boite(0.25, 0.25, 0.5, 0.5)])
        coin = (slice(55, 65), slice(55, 65))   # coin intérieur du rectangle, hors de l'ellipse
        self.assertLess(rect[coin].std(), image[coin].std() * 0.5)
        self.assertGreater(ellipse[coin].std(), image[coin].std() * 0.8)


if __name__ == "__main__":
    unittest.main()


class TestRobustesseFfmpeg(unittest.TestCase):
    """B5/B6 : ffmpeg ne peut ni bloquer le worker par ses messages d'erreur, ni décoder hors de la liste fermée."""

    def test_options(self):
        from argos_worker import ffmpeg
        with tempfile.TemporaryDirectory() as d:
            v = Path(d) / "v.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=d=1:s=64x48", "-c:v", "libx264", str(v)], check=True)
            entree = ffmpeg.entree(v)
            self.assertEqual(entree[entree.index("-codec_whitelist") + 1], ffmpeg.DECODEURS)
            p = ffmpeg.decoder(v, 64, 48, 5.0)
            self.assertIsNone(p.stderr)                       # messages dans un fichier, jamais dans un tuyau
            while p.stdout.read(64 * 48 * 3):
                pass
            p.wait(timeout=30)
            p.stdout.close()
            self.assertEqual(ffmpeg.lire_erreurs(p), "")
            self.assertIn("-t", p.args)
