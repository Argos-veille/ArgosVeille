"""Boucle du worker : prend les vidéos « processing » une par une et les traite.

Plusieurs workers peuvent tourner en même temps : chaque vidéo est prise sous verrou (SKIP LOCKED).
Une vidéo dont le traitement a été interrompu (panne, redémarrage) est reprise au bout de 2 heures ;
au-delà de 3 tentatives, elle passe en échec.
"""
import hashlib
import json
import logging
import shutil
import time
from pathlib import Path

import psycopg
import redis

from . import ffmpeg
from . import detection
from . import doublons
from . import empreintes
from . import recuperation
from .chiffrement import CleInvalide, chiffrer_fichier, chiffrer_original, dechiffrer_fichier
from .config import Config
from .traitement import effacer, refluter, retoucher, traiter

journal = logging.getLogger("argos_worker")
TENTATIVES_MAX = 3


def redis_cles(c: Config) -> redis.Redis:
    return redis.Redis.from_url(c.redis_url, socket_timeout=5, password=c.redis_mot_de_passe)


def garder_copie(c: Config, r: redis.Redis, vid: str, source: Path, pistes: list) -> bool:
    """Chiffre la copie de travail avec la clé de copie de la source (récupérée puis effacée de Redis)
    et enregistre les pistes, pour 7 jours, dans un espace privé. Sans clé : rien n'est gardé."""
    cle = r.getdel(f"argos:cle-copie:{vid}")
    if not cle:
        return False
    dossier = c.copies / vid
    dossier.mkdir(parents=True, exist_ok=True, mode=0o770)
    try:
        chiffrer_fichier(source, dossier / "copie.enc", cle.decode())
    except CleInvalide:
        shutil.rmtree(dossier, ignore_errors=True)
        return False
    (dossier / "pistes.json").write_text(json.dumps(pistes))
    # Empreinte de la clé (aléatoire, 256 bits : l'empreinte ne révèle rien) : le site vérifie ainsi
    # la clé qu'on lui renvoie pour une retouche, avant de lancer un traitement voué à l'échec.
    (dossier / "verif").write_text(hashlib.sha256(cle).hexdigest())
    return True


def zones_demandees(demande: dict) -> list[tuple[float, float, detection.Boite, detection.Boite]]:
    return [(float(z["debut"]), float(z["fin"]), detection.Boite(*map(float, z["de"]), rect=True),
             detection.Boite(*map(float, z["a"]), rect=True)) for z in demande.get("zones", [])]


def traiter_retouche(cx: psycopg.Connection, c: Config, r: redis.Redis, vid: str, garder_son: bool, tentative: int) -> None:
    """Retouche demandée par la source : la copie chiffrée est déchiffrée avec la clé renvoyée par la
    source, rendue avec les flous corrigés, puis la copie en clair est effacée. En cas d'impossibilité,
    la vidéo revient « à vérifier » avec la version précédente (la retouche n'a pas eu lieu)."""
    copies = c.copies / vid
    demande_f = copies / "demande.json"
    source = c.quarantaine / f"{vid}.video"
    cle_redis = f"argos:cle-copie:{vid}"

    def abandon(raison: str) -> None:
        journal.warning("retouche de %s abandonnée : %s", vid, raison)
        cx.execute("""UPDATE core.videos SET status = 'awaiting_author', processing_progress = 100
                       WHERE id = %s AND status = 'processing'""", (vid,))
        demande_f.unlink(missing_ok=True)
        r.delete(cle_redis)

    try:
        if tentative > TENTATIVES_MAX:
            return abandon("trop de tentatives")
        cle = r.get(cle_redis)
        if not cle:
            return abandon("clé de copie absente")
        try:
            dechiffrer_fichier(copies / "copie.enc", source, cle.decode())
        except CleInvalide:
            return abandon("clé de copie refusée")
        demande = json.loads(demande_f.read_text())
        masques = detection.Masques.depuis_pistes(json.loads((copies / "pistes.json").read_text()),
                                                   set(demande.get("retirees", [])), zones_demandees(demande))
        dernier = [0.0]

        def avancement(x: float) -> None:
            if x - dernier[0] >= 0.05 or x >= 1.0:
                dernier[0] = x
                cx.execute("UPDATE core.videos SET processing_progress = %s WHERE id = %s", (int(x * 100), vid))

        try:
            resultat = retoucher(source, c.floutees / vid, garder_son, c.duree_max, masques, avancement)
        except ffmpeg.FichierRefuse as e:
            return abandon(e.raison)
        except Exception:
            journal.exception("échec de la retouche de %s (nouvel essai plus tard)", vid)
            cx.execute("UPDATE core.videos SET processing_started_at = now() - interval '2 hours' WHERE id = %s", (vid,))
            return
        fini = cx.execute("""
            UPDATE core.videos SET status = 'awaiting_author', processing_progress = 100, blurred_sha256 = %s,
                                   duration_s = %s
             WHERE id = %s AND status = 'processing' RETURNING id""", (resultat.sha256, round(resultat.duree, 2), vid)).fetchone()
        r.delete(cle_redis)
        if fini is None:   # retirée pendant la retouche : rien ne doit rester
            effacer(c.floutees / vid)
            effacer(copies)
            return
        demande_f.replace(copies / "retouche.json")   # retouche appliquée (montrée à la source)
        journal.info("vidéo %s retouchée", vid)
    finally:
        source.unlink(missing_ok=True)   # jamais de copie en clair qui traîne


def connexion(c: Config) -> psycopg.Connection:
    return psycopg.connect(host=c.pg_host, port=c.pg_port, dbname=c.pg_base, user="argos_worker_conn",
                           password=c.pg_mot_de_passe, application_name="argos-worker", autocommit=True)


def prendre(cx: psycopg.Connection, prets_seulement: bool = False) -> tuple[str, bool, int, bool] | None:
    """Réserve la plus ancienne vidéo à traiter (ordre d'arrivée). Renvoie (id, garder_son, tentative, masquer) ou None.
    `prets_seulement` (worker de traitement) : sans les vidéos dont le lien attend encore un worker de récupération."""
    attente = ("AND NOT EXISTS (SELECT 1 FROM core.video_fetches f WHERE f.video_id = core.videos.id)"
               if prets_seulement else "")
    r = cx.execute(f"""
        UPDATE core.videos SET processing_started_at = now(), processing_progress = 0,
                               processing_attempts = processing_attempts + 1
         WHERE id = (SELECT id FROM core.videos
                      WHERE status = 'processing'
                        AND (processing_started_at IS NULL OR processing_started_at < now() - interval '2 hours')
                        {attente}
                      ORDER BY submitted_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id::text, keep_audio, processing_attempts, mask_faces""").fetchone()
    return (r[0], r[1], r[2], r[3]) if r else None


def recuperer(cx: psycopg.Connection, c: Config, r: redis.Redis | None, vid: str, source: Path) -> bool:
    """Envoi par lien : récupère la vidéo, chiffre l'original avec la clé issue du code. False s'il n'y a pas de lien."""
    lien = cx.execute("SELECT core.take_fetch(%s)", (vid,)).fetchone()[0]
    if lien is None:
        return False
    cle = r.get(f"argos:cle-original:{vid}") if r is not None else None
    if not cle:
        raise recuperation.Impossible("clé de l'original absente")
    recuperation.telecharger(lien, source, c.duree_max, c.proxy_bluesky)
    dossier = c.originaux or c.quarantaine.parent / "originaux"
    dossier.mkdir(parents=True, exist_ok=True, mode=0o770)
    original = dossier / f"{vid}.argos"
    sha, sha_chiffre = chiffrer_original(source, original, cle.decode())
    # Version à 5 arguments (0123) : empreinte clée, schéma 1 (jamais l'ancienne version à 4 arguments, schéma 0).
    if not cx.execute("SELECT core.finish_fetch(%s, %s, %s, %s, 1::smallint)", (vid, sha, sha_chiffre, f"originaux/{vid}.argos")).fetchone()[0]:
        original.unlink(missing_ok=True)   # retirée pendant la récupération : rien ne doit rester
        source.unlink(missing_ok=True)
        raise recuperation.Impossible("vidéo retirée")
    r.delete(f"argos:cle-original:{vid}")
    return True


TENTATIVES_RECUPERATION = 3


def recuperer_une(cx: psycopg.Connection, c: Config, r: redis.Redis | None) -> bool:
    """Worker de récupération : télécharge la plus ancienne vidéo envoyée par lien, puis la laisse au worker de
    traitement (qui la prendra dans l'ordre d'arrivée). Renvoie True si une récupération a été prise."""
    t = cx.execute("SELECT video_id::text, attempts FROM core.take_fetch_job()").fetchone()
    if t is None:
        return False
    vid, essais = t
    if len(vid) != 36:
        raise ValueError("identifiant inattendu")
    source = c.quarantaine / f"{vid}.video"

    def echec() -> None:
        cx.execute("""UPDATE core.videos SET status = 'failed', failure_reason = 'fetch_failed', processing_progress = NULL
                       WHERE id = %s AND status = 'processing'""", (vid,))
        source.unlink(missing_ok=True)
        if r is not None:
            r.delete(f"argos:cle-copie:{vid}", f"argos:cle-original:{vid}")

    if essais > TENTATIVES_RECUPERATION:
        echec()
        return True
    journal.info("récupération de %s (essai %d)", vid, essais)
    try:
        if not recuperer(cx, c, r, vid, source):
            echec()
    except (recuperation.Impossible, CleInvalide):
        journal.warning("vidéo %s : récupération par lien impossible", vid)
        echec()
    except Exception:   # panne passagère : reprise dans 15 minutes ; le lien n'est jamais écrit au journal
        journal.warning("vidéo %s : récupération par lien interrompue (nouvel essai plus tard)", vid)
        source.unlink(missing_ok=True)
    return True


def traiter_une(cx: psycopg.Connection, c: Config, r: redis.Redis | None = None) -> bool:
    """Traite une vidéo si une attend. Renvoie True si une vidéo a été prise."""
    tache = prendre(cx, prets_seulement=c.role == "traitement")
    if tache is None:
        return False
    vid, garder_son, tentative, masquer = tache
    if len(vid) != 36:
        raise ValueError("identifiant inattendu")
    if r is not None and (c.copies / vid / "demande.json").exists() and (c.copies / vid / "copie.enc").exists():
        journal.info("retouche de %s (tentative %d)", vid, tentative)
        traiter_retouche(cx, c, r, vid, garder_son, tentative)
        return True
    source = c.quarantaine / f"{vid}.video"
    dossier = c.floutees / vid
    journal.info("traitement de %s (tentative %d)", vid, tentative)

    def echec(raison: str) -> None:
        cx.execute("""UPDATE core.videos SET status = 'failed', failure_reason = %s, processing_progress = NULL
                       WHERE id = %s AND status = 'processing'""", (raison, vid))
        effacer(dossier)
        source.unlink(missing_ok=True)   # la copie de travail ne doit pas rester
        if r is not None:   # B15 : aucune clé ne reste après un échec
            r.delete(f"argos:cle-copie:{vid}", f"argos:cle-original:{vid}")

    if tentative > TENTATIVES_MAX:
        echec("processing_error")
        return True
    if not source.exists():
        try:
            if not recuperer(cx, c, r, vid, source):
                echec("unreadable")
                return True
        except (recuperation.Impossible, CleInvalide):
            journal.warning("vidéo %s : récupération par lien impossible", vid)
            echec("fetch_failed")
            return True
        except Exception:   # panne passagère : nouvel essai, le lien n'est jamais écrit au journal
            journal.warning("vidéo %s : récupération par lien interrompue (nouvel essai plus tard)", vid)
            cx.execute("UPDATE core.videos SET processing_started_at = now() - interval '2 hours' WHERE id = %s", (vid,))
            return True

    dernier = [0.0]

    def avancement(x: float) -> None:
        if x - dernier[0] >= 0.05 or x >= 1.0:   # pas plus d'une écriture tous les 5 %
            dernier[0] = x
            cx.execute("UPDATE core.videos SET processing_progress = %s WHERE id = %s", (int(x * 100), vid))

    try:
        resultat = traiter(source, dossier, garder_son, c.duree_max, avancement, masquer=masquer)
    except ffmpeg.FichierRefuse as e:
        journal.warning("vidéo %s refusée : %s", vid, e.raison)
        echec(e.raison)
        return True
    except Exception:
        journal.exception("échec du traitement de %s (nouvel essai plus tard)", vid)
        effacer(dossier)
        cx.execute("UPDATE core.videos SET processing_started_at = now() - interval '2 hours' WHERE id = %s", (vid,))
        return True

    # La copie chiffrée et les pistes sont prêtes AVANT que la source puisse vérifier.
    if r is not None:
        garder_copie(c, r, vid, source, resultat.pistes)
        r.delete(f"argos:cle-copie:{vid}")   # dans tous les cas, la clé est oubliée
    source.unlink(missing_ok=True)
    fini = cx.execute("""
        UPDATE core.videos SET status = 'awaiting_author', processing_progress = 100, blurred_sha256 = %s,
                               r2_blurred_key = %s, r2_preview_key = %s, duration_s = %s
         WHERE id = %s AND status = 'processing' RETURNING id""",
        (resultat.sha256, f"floutees/{vid}", f"floutees/{vid}/apercu.mp4", round(resultat.duree, 2), vid)).fetchone()
    if fini is None:
        # La vidéo a été retirée par sa source pendant le traitement : rien ne doit rester.
        effacer(dossier)
        effacer(c.copies / vid)
    elif resultat.signes is not None:
        try:
            if empreintes.enregistrer(cx, vid, resultat.signes, "blurred"):
                doublons.apres_enregistrement(cx, vid)
        except psycopg.Error:   # ne bloque pas la vidéo : le rattrapage s'en chargera
            journal.exception("empreintes de %s non enregistrées", vid)
    journal.info("vidéo %s traitée", vid)
    return True


SOURCE_REFLOUTAGE = "source-refloutage.mp4"   # version actuelle, déposée par l'API à côté de la vidéo


def traiter_refloutage(cx: psycopg.Connection, c: Config) -> bool:
    """Re-floutage demandé par l'administration (zones ajoutées). Renvoie True si une demande a été prise."""
    t = cx.execute("SELECT id::text, video_id::text, zones, keep_audio FROM core.take_reblur()").fetchone()
    if t is None:
        return False
    rid, vid, zones, garder_son = t
    if len(vid) != 36:
        raise ValueError("identifiant inattendu")
    dossier = c.floutees / vid
    source = dossier / SOURCE_REFLOUTAGE
    if not source.exists() and (dossier / "video.mp4").exists():   # développement : la version est restée en local
        shutil.copyfile(dossier / "video.mp4", source)
    if not source.exists():
        journal.warning("re-floutage de %s : version actuelle introuvable", vid)
        cx.execute("SELECT core.fail_reblur(%s)", (rid,))
        return True
    journal.info("re-floutage de %s", vid)
    try:
        dernier = [0.0]

        def avancement(x: float) -> None:
            if x - dernier[0] >= 0.05 or x >= 1.0:   # pas plus d'une écriture tous les 5 %
                dernier[0] = x
                cx.execute("SELECT core.reblur_progress(%s, %s)", (rid, int(x * 100)))

        resultat = refluter(source, dossier, bool(garder_son), c.duree_max, zones_demandees({"zones": zones}), avancement)
    except Exception:
        journal.exception("échec du re-floutage de %s (nouvel essai plus tard)", vid)
        return True
    source.unlink(missing_ok=True)
    if not cx.execute("SELECT core.finish_reblur(%s, %s)", (rid, resultat.sha256)).fetchone()[0]:
        # Retirée pendant le re-floutage (B7) : rien de ce qui vient d'être produit ne doit rester.
        effacer(dossier)
        journal.info("re-floutage de %s abandonné : vidéo retirée", vid)
        return True
    journal.info("vidéo %s re-floutée", vid)
    return True


def tourner(c: Config, pause: float = 5.0) -> None:
    from . import ancrage
    # Audit M19 : rien n'est décodé au-delà de la durée permise (+1 s), même si l'en-tête du fichier annonce moins.
    if isinstance(c.duree_max, int):
        ffmpeg.DUREE_DECODAGE_MAX = min(ffmpeg.DUREE_DECODAGE_MAX, c.duree_max + 1)
    r = redis_cles(c)
    cx: psycopg.Connection | None = None
    try:
        while True:
            # Base redémarrée (mise à jour, coupure) : on se reconnecte au lieu de s'arrêter. Une vidéo
            # réservée au moment de la coupure est reprise par le délai de 2 h de prendre().
            if cx is None or cx.closed:
                try:
                    cx = connexion(c)
                except psycopg.OperationalError as e:
                    journal.warning("base injoignable (%s), nouvel essai dans %s s", e, pause)
                    time.sleep(pause)
                    continue
            try:
                if c.role == "recuperation":
                    # Workers de récupération : seulement les liens (ni floutage, ni ancrage).
                    if not recuperer_une(cx, c, r):
                        time.sleep(pause)
                    continue
                try:
                    ancrage.tour(cx, c.ancrage, c.calendriers)   # une fois par jour ; preuves complétées toutes les heures
                except Exception:
                    journal.exception("échec de l'ancrage du journal (nouvel essai plus tard)")
                if not traiter_une(cx, c, r) and not traiter_refloutage(cx, c):
                    time.sleep(pause)
            except psycopg.OperationalError:
                if not cx.closed:
                    raise
                journal.warning("connexion à la base perdue, reconnexion")
                time.sleep(pause)
    finally:
        if cx is not None:
            cx.close()
