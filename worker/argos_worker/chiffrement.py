"""Chiffrement de la copie de travail gardée 7 jours, avec la « clé de copie » dérivée de la phrase de
la source (le serveur ne la détient que le temps d'un traitement).

Format : « ARGOS-C1 » (8) | préfixe de nonce (8) | morceaux de 4 Mio chiffrés en AES-256-GCM.
Nonce du morceau i : préfixe + i ; données associées : en-tête + i + « dernier ». Un morceau retiré,
ajouté, déplacé ou modifié fait échouer le déchiffrement.
"""
import hashlib
import hmac
import os
import struct
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIE = b"ARGOS-C1"
MORCEAU = 4 * 1024 * 1024
ETIQUETTE = 16


class CleInvalide(Exception):
    pass


def _cle(texte: str) -> bytes:
    import base64
    try:
        cle = base64.urlsafe_b64decode(texte + "=" * (-len(texte) % 4))
    except ValueError:
        raise CleInvalide("clé de copie illisible")
    if len(cle) != 32:
        raise CleInvalide("clé de copie de 32 octets attendue")
    return cle


def chiffrer_fichier(source: Path, sortie: Path, cle_b64: str) -> None:
    aes = AESGCM(_cle(cle_b64))
    prefixe = os.urandom(8)
    entete = MAGIE + prefixe
    taille = source.stat().st_size
    n = max(1, -(-taille // MORCEAU))
    tmp = sortie.with_suffix(".partiel")
    with open(source, "rb") as e, open(tmp, "wb") as s:
        os.chmod(tmp, 0o660)
        s.write(entete)
        for i in range(n):
            clair = e.read(MORCEAU)
            dernier = i == n - 1
            s.write(aes.encrypt(prefixe + struct.pack(">I", i), clair, entete + struct.pack(">I?", i, dernier)))
    tmp.replace(sortie)


def dechiffrer_fichier(source: Path, sortie: Path, cle_b64: str) -> None:
    aes = AESGCM(_cle(cle_b64))
    taille = source.stat().st_size
    with open(source, "rb") as e:
        entete = e.read(16)
        if len(entete) != 16 or entete[:8] != MAGIE:
            raise CleInvalide("ce n'est pas une copie chiffrée d'Argos")
        prefixe = entete[8:]
        n = max(1, -(-(taille - 16) // (MORCEAU + ETIQUETTE)))
        with open(sortie, "wb") as s:
            os.chmod(sortie, 0o660)
            for i in range(n):
                bloc = e.read(MORCEAU + ETIQUETTE)
                try:
                    s.write(aes.decrypt(prefixe + struct.pack(">I", i), bloc, entete + struct.pack(">I?", i, i == n - 1)))
                except Exception:
                    raise CleInvalide("copie modifiée ou mauvaise clé")


MAGIE_ORIGINAL = b"ARGOS-O1"


ETIQUETTE_EMPREINTE = b"argos/empreinte-original/v1"


def cle_empreinte(cle_brute: bytes) -> bytes:
    """Clé de l'empreinte clée de l'original (H10, même calcul que navigateur/src/empreinte.ts)."""
    if len(cle_brute) != 32:
        raise ValueError("clé de 32 octets attendue")
    return hmac.new(cle_brute, ETIQUETTE_EMPREINTE, hashlib.sha256).digest()


def chiffrer_original(source: Path, sortie: Path, cle_b64: str) -> tuple[bytes, bytes]:
    """Chiffre au format de l'original (ARGOS-O1, navigateur/src/chiffrement.ts). Remplacement atomique.
    Renvoie l'empreinte CLÉE du clair (H10 : jamais le SHA-256 simple du clair) et le SHA-256 du chiffré."""
    brute = _cle(cle_b64)
    aes = AESGCM(brute)
    entete = MAGIE_ORIGINAL + struct.pack(">I", MORCEAU) + os.urandom(8)
    prefixe = entete[12:]
    taille = source.stat().st_size
    n = max(1, -(-taille // MORCEAU))
    clair, chiffre = hmac.new(cle_empreinte(brute), digestmod=hashlib.sha256), hashlib.sha256(entete)
    tmp = sortie.with_name(sortie.name + ".partiel")
    with open(source, "rb") as e, open(tmp, "wb") as s:
        os.chmod(tmp, 0o660)
        s.write(entete)
        for i in range(n):
            bloc = e.read(MORCEAU)
            clair.update(bloc)
            sceau = aes.encrypt(prefixe + struct.pack(">I", i), bloc, entete + struct.pack(">I", i) + bytes([i == n - 1]))
            chiffre.update(sceau)
            s.write(sceau)
    tmp.replace(sortie)
    return clair.digest(), chiffre.digest()
