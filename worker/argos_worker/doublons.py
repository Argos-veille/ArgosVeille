"""Comparaison des empreintes : repère les vidéos qui se ressemblent.

Seuils prudents, tirés de l'essai du 9 novembre 2026 (72 copies abîmées de 8 vidéos, 4 134 paires de
vidéos différentes : visuel au plus 0,03, son au plus 0,65, caméra au plus 0,82), à ajuster sur de
vrais cas. Le son seul ne suffit jamais pour une forte ressemblance : deux vidéos peuvent partager
une musique. La caméra ne sert que si le son manque d'un côté.
"""
import logging
import os

import numpy as np

from . import empreintes as em

journal = logging.getLogger("argos_worker")
ECART_MAX = 12            # bits sur 63 : au-delà, deux images sont considérées différentes
VISUEL_FORT = 0.50
VISUEL_POSSIBLE = 0.15
SON_POSSIBLE = 0.85
CAMERA_POSSIBLE = 0.85
PAGE = 200
# Index (0095) : au-delà de ce nombre d'empreintes, on ne compare plus qu'aux vidéos candidates de l'index.
SEUIL_INDEX = int(os.environ.get("ARGOS_DOUBLONS_SEUIL_INDEX", "2000"))
CANDIDATS = 200            # vidéos comparées en détail, celles qui partagent le plus de clés
PART_FREQUENTE = 0.02      # une clé présente dans plus de 2 % des vidéos (image noire…) ne compte pas


def score_visuel(q: np.ndarray, m: np.ndarray, r: np.ndarray) -> float:
    """Part la plus élevée d'images identiques, au meilleur décalage dans le temps (normal ou en miroir)."""
    if not len(q) or not len(r):
        return 0.0
    n, p = len(q), len(r)
    minimum = max(4, int(0.5 * min(n, p)))
    meilleur = 0.0
    for images in (q, m):
        egales = np.bitwise_count(images[:, None] ^ r[None, :]) <= ECART_MAX
        if not egales.any():
            continue
        for k in range(-(n - 1), p):
            recouvrement = min(n, p - k) if k >= 0 else min(n + k, p)
            if recouvrement >= minimum:
                meilleur = max(meilleur, float(np.trace(egales, k)) / recouvrement)
    return meilleur


def score_son(q: np.ndarray, r: np.ndarray) -> float | None:
    """Part des bits identiques (0,5 pour deux sons sans rapport), au meilleur décalage."""
    n, p = len(q), len(r)
    if min(n, p) < 15:
        return None
    minimum = max(15, int(0.5 * min(n, p)))
    meilleur = 0.0
    for k in range(-(n - minimum), p - minimum + 1):
        i, j = max(0, -k), max(0, k)
        recouvrement = min(n - i, p - j)
        if recouvrement >= minimum:
            meilleur = max(meilleur, 1 - float(np.bitwise_count(q[i:i + recouvrement] ^ r[j:j + recouvrement]).mean()) / 32)
    return meilleur


def _robuste(s: np.ndarray) -> np.ndarray:
    """Écrête les à-coups isolés, qui suffiraient sinon à faire ressembler deux mouvements."""
    centre = np.median(s, 0)
    ecart = 1.4826 * np.median(np.abs(s - centre), 0) + 0.2
    return np.clip(s - centre, -3 * ecart, 3 * ecart)


def score_camera(q: np.ndarray, r: np.ndarray) -> float | None:
    """Corrélation des déplacements de la caméra au meilleur décalage (normal ou en miroir)."""
    if min(len(q), len(r)) < 50:
        return None
    a, b = _robuste(q), _robuste(r)
    n, p = len(a), len(b)
    minimum = max(50, int(0.5 * min(n, p)))
    meilleur = None
    for sens in (1.0, -1.0):
        A = a * np.array([sens, 1.0])
        for k in range(-(n - minimum), p - minimum + 1):
            i, j = max(0, -k), max(0, k)
            recouvrement = min(n - i, p - j)
            if recouvrement < minimum:
                continue
            u, v = A[i:i + recouvrement].ravel(), b[j:j + recouvrement].ravel()
            u, v = u - u.mean(), v - v.mean()
            nu, nv = float(np.linalg.norm(u)), float(np.linalg.norm(v))
            if nu >= 3 and nv >= 3:   # une caméra immobile ne dit rien
                x = float(u @ v) / (nu * nv)
                meilleur = x if meilleur is None else max(meilleur, x)
    return meilleur


def niveau(exact: bool, visuel: float, son: float | None, camera: float | None) -> str | None:
    if exact:
        return "exact"
    s = son is not None and son >= SON_POSSIBLE
    if visuel >= VISUEL_FORT or (visuel >= VISUEL_POSSIBLE and s):
        return "strong"
    if visuel >= VISUEL_POSSIBLE or s or (camera is not None and camera >= CAMERA_POSSIBLE):
        return "possible"
    return None


def _tableaux(visuel, miroir, son, camera):
    c = np.frombuffer(camera, "<f4").reshape(-1, 2).astype(float) if camera else None
    return (np.frombuffer(visuel, "<u8"), np.frombuffer(miroir, "<u8"),
            np.frombuffer(son, "<u4") if son else None, c)


def comparer(a, b, exact: bool) -> tuple[str, float, float | None, float | None] | None:
    """a et b : (visuel, miroir, son, caméra). Renvoie (niveau, scores) ou None si rien de ressemblant."""
    visuel = score_visuel(a[0], a[1], b[0])
    son = score_son(a[2], b[2]) if a[2] is not None and b[2] is not None else None
    camera = None if son is not None or a[3] is None or b[3] is None else score_camera(a[3], b[3])
    n = niveau(exact, visuel, son, camera)
    return None if n is None else (n, visuel, son, camera)


def cles(visuel: np.ndarray, son: np.ndarray | None) -> list[int]:
    """Clés d'index : 4 tranches de 16 bits par image, 2 moitiés de 16 bits par mot sonore (voir 0095)."""
    v = np.unique(visuel.astype(np.uint64))
    k = [((v >> np.uint64(16 * t)) & np.uint64(0xFFFF)).astype(np.int64) + t * 65536 for t in range(4)]
    if son is not None and len(son):
        s = np.unique(son.astype(np.uint32))
        k += [((s >> np.uint32(16 * h)) & np.uint32(0xFFFF)).astype(np.int64) + (4 + h) * 65536 for h in range(2)]
    return sorted({int(x) for t in k for x in t})


def indexer(cx, video: str, visuel: bytes, son: bytes | None) -> None:
    v, _m, s, _c = _tableaux(visuel, visuel, son, None)
    cx.execute("SELECT core.save_fingerprint_keys(%s, %s::integer[])", (video, cles(v, s)))


def rattraper(cx) -> int:
    """Indexe les empreintes qui ne le sont pas encore (vidéos d'avant l'index). Renvoie leur nombre."""
    n = 0
    while True:
        lot = cx.execute("SELECT * FROM core.fingerprints_unindexed(%s)", (PAGE,)).fetchall()
        for autre, version, visuel, son in lot:
            indexer(cx, autre, visuel, son)
            n += 1
        if len(lot) < PAGE:
            return n


def _toutes(cx, video: str):
    apres = None
    while True:
        page = cx.execute("SELECT * FROM core.fingerprints_page(%s, %s, %s)", (apres, PAGE, video)).fetchall()
        yield from page
        if len(page) < PAGE:
            return
        apres = page[-1][0]


def _candidates(cx, video: str, a) -> list:
    requete = cles(np.concatenate([a[0], a[1]]), a[2])
    lignes = cx.execute("SELECT * FROM core.fingerprint_candidates(%s, %s::integer[], %s, %s::real)",
                        (video, requete, CANDIDATS, PART_FREQUENTE)).fetchall()
    lignes += cx.execute("SELECT * FROM core.fingerprints_same_original(%s)", (video,)).fetchall()
    vues, uniques = set(), []
    for ligne in lignes:
        if ligne[0] not in vues:
            vues.add(ligne[0])
            uniques.append(ligne)
    return uniques


def chercher(cx, video: str) -> int:
    """Compare la vidéo aux autres empreintes (toutes, ou les candidates de l'index au-delà de SEUIL_INDEX) et
    enregistre les ressemblances. Renvoie leur nombre."""
    moi = cx.execute("SELECT * FROM core.fingerprint_of(%s)", (video,)).fetchone()
    if moi is None or moi[0] != em.VERSION:
        return 0
    indexer(cx, video, moi[1], moi[3])
    rattraper(cx)
    a = _tableaux(*moi[1:5])
    total = cx.execute("SELECT core.fingerprints_count()").fetchone()[0]
    autres = _toutes(cx, video) if total <= SEUIL_INDEX else _candidates(cx, video, a)
    trouvees = 0
    for autre, version, visuel, miroir, son, camera, sha in autres:
        if version != em.VERSION:
            continue
        r = comparer(a, _tableaux(visuel, miroir, son, camera), moi[5] is not None and moi[5] == sha)
        if r:
            cx.execute("SELECT core.save_match(%s, %s, %s, %s::real, %s::real, %s::real)", (video, autre, *r))
            trouvees += 1
    return trouvees


def apres_enregistrement(cx, video: str) -> None:
    """Ne fait jamais échouer le traitement de la vidéo."""
    try:
        n = chercher(cx, video)
        if n:
            journal.info("vidéo %s : %d ressemblance(s)", video, n)
    except Exception:
        journal.exception("recherche de doublons impossible pour %s", video)
