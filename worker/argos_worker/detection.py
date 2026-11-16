"""Détection des visages (YuNet) et calcul des masques.

Règle du projet (décidée le 4 novembre 2026, après essai sur de vraies vidéos de manifestation) :
on ne masque QUE les visages directement identifiables, proches de la caméra. Les foules en plan
large ne sont pas masquées : un visage de quelques pixels n'identifie personne, et masquer toute une
foule rend la vidéo illisible. Les matricules RIO et les plaques ne sont jamais masqués.

Comment :
- un visage est « proche » s'il fait au moins 5 % du petit côté de l'image (≈ 36 px en 720p) ;
- chaque visage est SUIVI dans le temps (une « piste ») : relié d'une analyse à l'autre, avec des trous
  tolérés jusqu'à 1 s (tête qui tourne, flou) : le masque ne clignote pas ;
- une piste n'est gardée que si le visage est vu au moins 3 fois, ou une fois avec une très forte
  confiance : un « visage » vu une seule fois dans un fond flou est écarté (faux positif) ;
- une piste est masquée sur toute sa durée dès que le visage dépasse le seuil de taille une fois ;
- un « visage » de plus d'un tiers du petit côté n'est retenu qu'avec une très forte confiance ;
- FLOU DESTRUCTEUR en ellipse (décision du 4 novembre 2026 : les ovales opaques cachaient bien mais
  cassaient la lecture de la scène) : la zone est réduite à 5 × 5 pixels — le détail est détruit, il
  n'y a rien à « déflouter » — puis ré-agrandie et lissée, avec des bords fondus ;
- ellipse ajustée à la tête, de taille lissée (elle ne tremble pas), avec une marge
  proportionnée (plus grande pour un petit visage que pour un gros plan) et une marge de mouvement ;
- les images analysées sont exactement celles du rendu, et la position d'un visage est prévue
  d'après sa vitesse pour le suivre quand la caméra balaie vite.
"""
import bisect
import hashlib
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from . import ffmpeg

MODELE = Path(__file__).resolve().parent.parent / "modeles" / "face_detection_yunet_2023mar.onnx"
EMPREINTE_MODELE = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
SEUIL = 0.7                  # confiance minimale d'une détection (mesuré sur 75 images réelles annotées : à 0,6 autant de visages masqués mais 50 % de masques en trop de plus)
SEUIL_SUR = 0.9              # confiance « très forte »
TAILLE_MIN = 0.05            # visage masqué s'il atteint 5 % du petit côté de l'image
TAILLE_MAX = 1 / 3           # au-delà : seulement avec une très forte confiance
ANALYSES_PAR_SECONDE = 10.0
COTE_ANALYSE_MAX = 1280      # pas besoin d'agrandir : les petits visages lointains ne sont pas masqués
TROU_MAX_S = 1.0             # trou toléré dans une piste
VUES_MIN = 3                 # vues nécessaires pour garder une piste (sauf très forte confiance)
MARGE_S = 0.3                # masque posé un peu avant la première vue et gardé un peu après la dernière
GRAIN = 5                    # le visage est réduit à GRAIN × GRAIN pixels : tout détail est détruit
FONDU = 0.15                 # part du rayon de l'ellipse fondue vers l'extérieur


def _fermer(*processus: subprocess.Popen) -> dict[int, str]:
    """Arrête si besoin et referme proprement les processus ffmpeg ; renvoie leurs messages d'erreur."""
    erreurs = {}
    for p in processus:
        if p.poll() is None:
            p.kill()
            p.wait()
        erreurs[p.pid] = ffmpeg.lire_erreurs(p)
        for flux in (p.stdin, p.stdout, p.stderr):
            if flux and not flux.closed:
                flux.close()
    return erreurs


@dataclass(frozen=True)
class Boite:
    """Zone en coordonnées relatives (0 à 1), indépendantes de la résolution de sortie."""
    x: float
    y: float
    l: float
    h: float
    rect: bool = False   # zone dessinée par la source : rectangle (les visages : ellipse)


@dataclass(frozen=True)
class Detection:
    t: float
    boite: Boite
    score: float
    taille: float   # largeur du visage rapportée au petit côté de l'image


def charger_detecteur() -> "cv2.FaceDetectorYN":
    contenu = MODELE.read_bytes()
    if hashlib.sha256(contenu).hexdigest() != EMPREINTE_MODELE:
        raise RuntimeError("le modèle de détection des visages a été modifié ou abîmé")
    cv2.setNumThreads(int(ffmpeg.FILS))
    return cv2.FaceDetectorYN.create(str(MODELE), "", (320, 320), SEUIL, 0.3, 5000)


def dimensions_analyse(infos: ffmpeg.Infos) -> tuple[int, int]:
    """Taille réelle, réduite si besoin à 1280 px de long (les visages à masquer sont assez grands)."""
    e = min(1.0, COTE_ANALYSE_MAX / max(infos.largeur, infos.hauteur))
    pair = lambda v: max(2, int(round(v * e / 2)) * 2)
    return pair(infos.largeur), pair(infos.hauteur)


def analyser(source: Path, infos: ffmpeg.Infos, avancement=lambda x: None) -> list[tuple[float, list[Detection]]]:
    """Renvoie, pour chaque instant analysé (en secondes), les visages trouvés."""
    detecteur = charger_detecteur()
    l, h = dimensions_analyse(infos)
    detecteur.setInputSize((l, h))
    # Les images analysées sont EXACTEMENT celles du rendu (même décodage, même cadence), une sur
    # `pas` : leur instant est connu sans ambiguïté. (Le filtre « fps » de ffmpeg à 10 images/s choisit
    # parfois l'image voisine : les masques étaient alors en retard d'une image sur un visage rapide.)
    pas = max(1, round(infos.cadence / ANALYSES_PAR_SECONDE))
    taille = l * h * 3
    petit = min(l, h)
    p = ffmpeg.decoder(source, l, h, infos.cadence)
    resultats: list[tuple[float, list[Detection]]] = []
    try:
        i = 0
        k = -1
        while True:
            brut = p.stdout.read(taille)
            if len(brut) < taille:
                break
            k += 1
            if k % pas:
                continue
            image = np.frombuffer(brut, np.uint8).reshape(h, l, 3)
            _, visages = detecteur.detect(image)
            t = k / infos.cadence
            trouves = []
            for v in ([] if visages is None else visages):
                score, rel = float(v[-1]), float(v[2]) / petit
                if rel > TAILLE_MAX and score < SEUIL_SUR:
                    continue   # « visage » géant peu sûr : fond flou, motif…
                trouves.append(Detection(t, Boite(float(v[0]) / l, float(v[1]) / h, float(v[2]) / l, float(v[3]) / h),
                                         score, rel))
            resultats.append((t, trouves))
            i += 1
            if i % 10 == 0:
                avancement(min(1.0, t / infos.duree))
        p.wait(timeout=60)
    finally:
        erreurs = _fermer(p)
    if p.returncode != 0:
        raise RuntimeError(f"décodage pour l'analyse : {erreurs.get(p.pid)!r}")
    avancement(1.0)
    return resultats


def _centre(b: Boite) -> tuple[float, float]:
    return b.x + b.l / 2, b.y + b.h / 2


def _recouvrement(a: Boite, b: Boite) -> float:
    x0, y0 = max(a.x, b.x), max(a.y, b.y)
    x1, y1 = min(a.x + a.l, b.x + b.l), min(a.y + a.h, b.y + b.h)
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = a.l * a.h + b.l * b.h - inter
    return inter / union if union > 0 else 0.0


def _distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


@dataclass
class Piste:
    vues: list[Detection] = field(default_factory=list)

    @property
    def fin(self) -> float:
        return self.vues[-1].t

    def gardee(self) -> bool:
        assez = len(self.vues) >= VUES_MIN or max(v.score for v in self.vues) >= SEUIL_SUR
        return assez and max(v.taille for v in self.vues) >= TAILLE_MIN

    def prevision(self, t: float) -> tuple[float, float]:
        """Centre attendu à l'instant t, d'après la vitesse des deux dernières vues."""
        c = _centre(self.vues[-1].boite)
        if len(self.vues) < 2:
            return c
        a, b = self.vues[-2], self.vues[-1]
        ca, dt = _centre(a.boite), b.t - a.t
        if dt <= 0:
            return c
        f = (t - b.t) / dt
        return c[0] + (c[0] - ca[0]) * f, c[1] + (c[1] - ca[1]) * f

    def accepte(self, d: Detection) -> float | None:
        """Le visage d est-il la suite de cette piste ? Renvoie un écart (plus petit = plus sûr), ou None.
        On cherche autour de la position PRÉVUE (un visage balayé par la caméra peut parcourir plus que
        sa largeur entre deux analyses), avec une tolérance plus large tant que la vitesse est inconnue
        ou en cas de demi-tour, et une taille comparable."""
        der = self.vues[-1].boite
        if not 0.5 <= d.boite.l / der.l <= 2:
            return None
        l = max(der.l, d.boite.l)
        cd = _centre(d.boite)
        ecart_prevu = _distance(self.prevision(d.t), cd)
        ecart_brut = _distance(_centre(der), cd)
        if ecart_prevu <= 1.2 * l or _recouvrement(der, d.boite) >= 0.1:
            return ecart_prevu
        if ecart_brut <= 2.5 * l:   # vitesse inconnue, demi-tour, changement brusque
            return ecart_brut + 1.0
        return None


def pistes(detections: list[tuple[float, list[Detection]]]) -> list[Piste]:
    """Relie les détections en pistes (une par visage), trous de 1 s au plus tolérés."""
    actives: list[Piste] = []
    finies: list[Piste] = []
    for t, trouves in detections:
        encore = []
        for p in actives:
            (finies if t - p.fin > TROU_MAX_S else encore).append(p)
        actives = encore
        couples = sorted((e, i, j) for i, p in enumerate(actives) for j, d in enumerate(trouves)
                         if (e := p.accepte(d)) is not None)
        prises_p, prises_d = set(), set()
        for _, i, j in couples:
            if i not in prises_p and j not in prises_d:
                actives[i].vues.append(trouves[j])
                prises_p.add(i)
                prises_d.add(j)
        actives += [Piste([d]) for j, d in enumerate(trouves) if j not in prises_d]
    return [p for p in finies + actives if p.gardee()]


def _lisser(vues: list[Detection]) -> list[tuple[float, Boite]]:
    """Lisse la TAILLE du masque sur 3 vues (c'est elle qui tremble d'une détection à l'autre), jamais sa
    position : une moyenne des positions décalerait le masque quand le visage change de direction."""
    r = []
    for i, v in enumerate(vues):
        voisins = [w.boite for w in vues[max(0, i - 1):i + 2]]
        l = sum(b.l for b in voisins) / len(voisins)
        h = sum(b.h for b in voisins) / len(voisins)
        cx, cy = _centre(v.boite)
        r.append((v.t, Boite(cx - l / 2, cy - h / 2, l, h)))
    return r


def ajuster(b: Boite, taille: float) -> Boite:
    """Zone du masque autour du visage : marge de 40 % pour un petit visage, 15 % pour un gros plan
    (variation continue entre les deux), un peu plus vers le haut (cheveux, front)."""
    k = max(0.0, min(1.0, (taille - TAILLE_MIN) / (0.25 - TAILLE_MIN)))   # 0 : petit, 1 : gros plan
    m = 0.40 + (0.15 - 0.40) * k
    return Boite(b.x - m * b.l / 2, b.y - m * b.h * 0.7, b.l * (1 + m), b.h * (1 + m))


class Masques:
    """Masques à appliquer à un instant donné : chaque piste gardée, de sa première à sa dernière vue
    (plus une petite marge), avec une position interpolée entre deux vues — même séparées par un trou.
    S'y ajoutent les zones dessinées à la main par la source (étape 6c)."""

    def __init__(self, detections: list[tuple[float, list[Detection]]],
                 zones: list[tuple[float, float, Boite, Boite]] = ()):
        """zones : (début, fin, rectangle au début, rectangle à la fin), le flou glissant de l'un à l'autre."""
        self.trajets = []
        for p in pistes(detections):
            points = _lisser(p.vues)
            taille = max(v.taille for v in p.vues)
            boites = [ajuster(b, taille) for _, b in points]
            # Déplacement de chaque intervalle entre deux vues, pour la marge de mouvement.
            dep = [(abs(b.x - a.x), abs(b.y - a.y)) for a, b in zip(boites, boites[1:])]
            self.trajets.append(([t for t, _ in points], boites, dep))
        self.zones = list(zones)

    @classmethod
    def depuis_pistes(cls, pistes: list[dict], retirees: set[int] = frozenset(),
                      zones: list[tuple[float, float, Boite, Boite]] = ()) -> "Masques":
        """Masques d'une retouche : les pistes enregistrées au premier traitement (sans refaire la
        détection), moins celles que la source a retirées, plus les zones qu'elle a ajoutées."""
        m = cls([], zones)
        for p in pistes:
            if p["id"] in retirees:
                continue
            boites = [Boite(*z) for z in p["zones"]]
            dep = [(abs(b.x - a.x), abs(b.y - a.y)) for a, b in zip(boites, boites[1:])]
            m.trajets.append((list(p["instants"]), boites, dep))
        return m

    def exporter(self) -> list[dict]:
        """Pistes de visages telles que masquées (instants et zones), pour la vérification par la source."""
        return [{"id": i, "instants": [round(t, 3) for t in instants],
                 "zones": [[round(b.x, 5), round(b.y, 5), round(b.l, 5), round(b.h, 5)] for b in boites]}
                for i, (instants, boites, _) in enumerate(self.trajets)]

    def a(self, t: float) -> list[Boite]:
        r = []
        for instants, boites, dep in self.trajets:
            if not instants[0] - MARGE_S <= t <= instants[-1] + MARGE_S:
                continue
            n = len(instants)
            i = bisect.bisect_right(instants, t) - 1
            if n == 1:
                r.append(boites[0])
                continue
            # Avant la première vue / après la dernière : sur sa lancée ; entre deux vues : interpolé.
            i = min(max(i, 0), n - 2)
            t0, t1 = instants[i], instants[i + 1]
            f = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
            a, b = boites[i], boites[i + 1]
            m = lambda u, v: u + (v - u) * f
            # Marge de mouvement : la moitié du plus grand déplacement de cet intervalle et de ses voisins
            # (au demi-tour, les deux vues encadrantes sont au même endroit alors que le visage est allé
            # jusqu'au bord entre les deux), au plus la moitié de la taille du masque.
            voisins = dep[max(0, i - 1):i + 2]
            mx = min(max(d[0] for d in voisins), a.l) * 0.5
            my = min(max(d[1] for d in voisins), a.h) * 0.5
            r.append(Boite(m(a.x, b.x) - mx / 2, m(a.y, b.y) - my / 2, m(a.l, b.l) + mx, m(a.h, b.h) + my))
        for t0, t1, b0, b1 in self.zones:
            if t0 <= t <= t1:
                f = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
                m = lambda u, v: u + (v - u) * f
                r.append(Boite(m(b0.x, b1.x), m(b0.y, b1.y), m(b0.l, b1.l), m(b0.h, b1.h), rect=True))
        return r


def dessiner(image: np.ndarray, boites: list[Boite]) -> None:
    """Floute chaque zone directement dans l'image : réduction à GRAIN × GRAIN pixels (destruction du
    détail), ré-agrandissement lissé, puis fusion par une ellipse au cœur entièrement remplacé et aux
    bords fondus (rectangle aux bords fondus pour les zones dessinées par la source)."""
    h, l = image.shape[:2]
    for b in boites:
        x0, y0 = max(0, int(b.x * l)), max(0, int(b.y * h))
        x1, y1 = min(l, int((b.x + b.l) * l) + 1), min(h, int((b.y + b.h) * h) + 1)
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        zone = image[y0:y1, x0:x1]
        zh, zl = zone.shape[:2]
        reduit = cv2.resize(zone, (GRAIN, GRAIN), interpolation=cv2.INTER_AREA)
        flou = cv2.resize(reduit, (zl, zh), interpolation=cv2.INTER_CUBIC)
        k = max(3, (min(zl, zh) // 4) | 1)
        flou = cv2.GaussianBlur(flou, (k, k), 0)
        # Ellipse inscrite dans la zone (positions relatives à l'ellipse réelle, qui peut déborder de l'image).
        cx, cy = (b.x + b.l / 2) * l - x0, (b.y + b.h / 2) * h - y0
        ax, ay = max(1.0, b.l * l / 2), max(1.0, b.h * h / 2)
        yy, xx = np.mgrid[0:zh, 0:zl]
        if b.rect:   # rectangle : « rayon » = distance relative au bord le plus proche
            r = np.maximum(np.abs(xx + 0.5 - cx) / ax, np.abs(yy + 0.5 - cy) / ay)
        else:
            r = np.sqrt(((xx + 0.5 - cx) / ax) ** 2 + ((yy + 0.5 - cy) / ay) ** 2)
        # alpha = 1 jusqu'à (1 - FONDU) du rayon, puis décroît jusqu'à 0 au bord de l'ellipse.
        alpha = np.clip((1.0 - r) / FONDU, 0.0, 1.0)[..., None]
        zone[:] = (flou * alpha + zone * (1.0 - alpha)).astype(np.uint8)


def rendre(source: Path, sortie: Path, infos: ffmpeg.Infos, petit_cote: int, crf: int, preset: str,
           garder_son: bool, masques: Masques, avancement=lambda x: None) -> None:
    """Décode, applique les masques sur chaque image, réencode (sans métadonnées)."""
    l, h = ffmpeg.boite(infos, petit_cote)
    taille = l * h * 3
    lecteur = ffmpeg.decoder(source, l, h, infos.cadence)
    ecrivain = ffmpeg.encodeur(source, sortie, l, h, infos.cadence, crf, preset, garder_son, infos)
    try:
        i = 0
        while True:
            brut = lecteur.stdout.read(taille)
            if len(brut) < taille:
                break
            image = np.frombuffer(brut, np.uint8).reshape(h, l, 3).copy()
            dessiner(image, masques.a(i / infos.cadence))
            ecrivain.stdin.write(image.tobytes())
            i += 1
            if i % 30 == 0:
                avancement(min(1.0, i / infos.cadence / infos.duree))
        ecrivain.stdin.close()
        ecrivain.wait(timeout=600)
        lecteur.wait(timeout=60)
    finally:
        erreurs = _fermer(lecteur, ecrivain)
    if lecteur.returncode != 0:
        raise RuntimeError(f"décodage : {erreurs.get(lecteur.pid)!r}")
    if ecrivain.returncode != 0:
        raise RuntimeError(f"encodage : {erreurs.get(ecrivain.pid)!r}")
    if i == 0:
        raise ffmpeg.FichierRefuse("unreadable", "aucune image décodée")
    avancement(1.0)
