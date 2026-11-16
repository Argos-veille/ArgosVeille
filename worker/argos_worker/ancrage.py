"""Ancrage quotidien du journal public dans Bitcoin via OpenTimestamps.

Une fois par jour (heure de Paris), l'empreinte de la dernière entrée du journal — la « tête de chaîne »,
qui engage toutes les entrées précédentes — est envoyée à plusieurs serveurs publics OpenTimestamps
(« calendriers »). La preuve reçue est gardée dans ledger.anchors ; elle est « en attente » jusqu'à ce
qu'un calendrier l'ait inscrite dans une transaction Bitcoin, quelques heures plus tard. Le worker
redemande alors la preuve complète (toutes les heures au plus), qui désigne le bloc Bitcoin.

Seule l'empreinte (32 octets) quitte le serveur. En développement (ARGOS_ANCRAGE=simule, par défaut),
rien n'est envoyé : l'ancre est marquée « simulée ».
"""
import io
import logging
import time
from urllib.parse import urlsplit
from datetime import datetime
from zoneinfo import ZoneInfo

import psycopg

journal = logging.getLogger("argos.ancrage")
PARIS = ZoneInfo("Europe/Paris")
SIMULATION = b"ARGOS-SIMULATION-OTS"
_dernier_essai = [0.0]


def _bibliotheque_ots():
    """Imports de la bibliothèque OpenTimestamps (seulement en mode réel)."""
    from opentimestamps.calendar import RemoteCalendar
    from opentimestamps.core.notary import BitcoinBlockHeaderAttestation, PendingAttestation
    from opentimestamps.core.op import OpSHA256
    from opentimestamps.core.serialize import BytesDeserializationContext, StreamSerializationContext
    from opentimestamps.core.timestamp import DetachedTimestampFile, Timestamp
    return (RemoteCalendar, BitcoinBlockHeaderAttestation, PendingAttestation, OpSHA256,
            BytesDeserializationContext, StreamSerializationContext, DetachedTimestampFile, Timestamp)


def horodater(empreinte: bytes, calendriers: tuple[str, ...]) -> bytes:
    """Preuve OpenTimestamps (fichier .ots) d'une empreinte SHA-256, auprès de plusieurs calendriers."""
    (RemoteCalendar, _, _, OpSHA256, _, StreamSerializationContext, DetachedTimestampFile, Timestamp) = _bibliotheque_ots()
    racine = Timestamp(empreinte)
    acceptes = 0
    for url in calendriers:
        try:
            racine.merge(RemoteCalendar(url).submit(empreinte, timeout=15))
            acceptes += 1
        except Exception as e:   # un calendrier indisponible n'empêche pas les autres
            journal.warning("calendrier %s indisponible : %s", url, e)
    if not acceptes:
        raise RuntimeError("aucun calendrier OpenTimestamps n'a répondu")
    sortie = io.BytesIO()
    DetachedTimestampFile(OpSHA256(), racine).serialize(StreamSerializationContext(sortie))
    return sortie.getvalue()


def domaines_permis(calendriers: tuple[str, ...]) -> set[str]:
    """Domaines des calendriers configurés (deux derniers niveaux : opentimestamps.org, eternitywall.com…)."""
    return {".".join((urlsplit(u).hostname or "").split(".")[-2:]) for u in calendriers} - {""}


def adresse_permise(uri: str, domaines: set[str]) -> bool:
    """Vrai pour une adresse https d'un des domaines des calendriers configurés (ou d'un de leurs sous-domaines)."""
    try:
        u = urlsplit(uri)
    except ValueError:
        return False
    hote = (u.hostname or "").lower()
    return u.scheme == "https" and u.port in (None, 443) and any(hote == d or hote.endswith("." + d) for d in domaines)


def completer(preuve: bytes, calendriers: tuple[str, ...]) -> tuple[bytes, int | None]:
    """Redemande aux calendriers les parties en attente ; renvoie (preuve, bloc Bitcoin ou None).
    L'adresse à recontacter est écrite dans la preuve, donc par le calendrier : seules celles des domaines des
    calendriers configurés sont suivies (point bas de la revue, 15 novembre 2026). Un calendrier ne peut ainsi pas
    faire appeler au serveur une autre adresse (réseau interne, autre site)."""
    (RemoteCalendar, BitcoinAtt, PendingAttestation, _, BytesDeserializationContext, StreamSerializationContext,
     DetachedTimestampFile, _) = _bibliotheque_ots()
    fichier = DetachedTimestampFile.deserialize(BytesDeserializationContext(preuve))
    domaines = domaines_permis(calendriers)

    def parcourir(t):   # chaque morceau de preuve avec ses attestations (all_attestations ne donne que l'empreinte)
        for att in list(t.attestations):
            yield t, att
        for sous in list(t.ops.values()):
            yield from parcourir(sous)

    for sous, att in list(parcourir(fichier.timestamp)):
        if isinstance(att, PendingAttestation):
            if not adresse_permise(att.uri, domaines):
                journal.warning("adresse de calendrier ignorée (hors des calendriers configurés)")
                continue
            try:
                sous.merge(RemoteCalendar(att.uri).get_timestamp(sous.msg, timeout=15))
            except Exception:   # pas encore confirmé, ou calendrier injoignable : on réessaiera
                pass
    blocs = [att.height for _, att in fichier.timestamp.all_attestations() if isinstance(att, BitcoinAtt)]
    sortie = io.BytesIO()
    fichier.serialize(StreamSerializationContext(sortie))
    return sortie.getvalue(), (min(blocs) if blocs else None)


def tour(cx: psycopg.Connection, mode: str, calendriers: tuple[str, ...], maintenant: float | None = None) -> None:
    """À appeler régulièrement : ancre une fois par jour, complète les preuves en attente (toutes les heures)."""
    maintenant = time.time() if maintenant is None else maintenant
    jour = datetime.fromtimestamp(maintenant, PARIS).date()
    tete = cx.execute("SELECT seq, hash FROM ledger.entries ORDER BY seq DESC LIMIT 1").fetchone()
    deja = cx.execute("SELECT 1 FROM ledger.anchors WHERE day = %s", (jour,)).fetchone()
    derniere = cx.execute("SELECT max(last_seq) FROM ledger.anchors").fetchone()   # entrée la plus récente déjà ancrée
    if tete and not deja and (derniere[0] is None or derniere[0] < tete[0]):
        seq, empreinte = tete[0], bytes(tete[1])
        if mode == "reel":
            try:
                preuve, simulee = horodater(empreinte, calendriers), False
            except Exception as e:
                journal.warning("ancrage du %s reporté : %s", jour, e)
                return
        else:
            preuve, simulee = SIMULATION, True
        cx.execute("""INSERT INTO ledger.anchors (day, last_seq, root_hash, ots_proof, simulated)
                      VALUES (%s, %s, %s, %s, %s) ON CONFLICT (day) DO NOTHING""",
                   (jour, seq, empreinte, preuve, simulee))
        journal.info("journal ancré pour le %s (entrée %s%s)", jour, seq, ", simulé" if simulee else "")

    if mode != "reel" or maintenant - _dernier_essai[0] < 3600:
        return
    _dernier_essai[0] = maintenant
    for day, preuve in cx.execute("""SELECT day, ots_proof FROM ledger.anchors
                                      WHERE NOT simulated AND bitcoin_block IS NULL AND ots_proof IS NOT NULL
                                        AND published_at > now() - interval '14 days'""").fetchall():
        try:
            neuve, bloc = completer(bytes(preuve), calendriers)
        except Exception as e:
            journal.warning("preuve du %s non complétée : %s", day, e)
            continue
        if bloc:
            cx.execute("UPDATE ledger.anchors SET ots_proof = %s, bitcoin_block = %s, upgraded_at = now() WHERE day = %s",
                       (neuve, bloc, day))
            journal.info("ancrage du %s confirmé dans le bloc Bitcoin %s", day, bloc)
