// Empreinte de l'original (audit du 15 novembre 2026, H10). Avant : SHA-256 du fichier en clair, gardé en base ; une
// base saisie et un téléphone saisi suffisaient à prouver que CE fichier avait été envoyé. Désormais l'empreinte est
// CLÉE : HMAC-SHA256(clé d'empreinte, fichier en clair), avec
//   clé d'empreinte = HMAC-SHA256(clé brute de l'original, « argos/empreinte-original/v1 »).
// Seuls ceux qui ont la clé de l'original (la source, par son code ; les destinataires d'une enveloppe) peuvent la
// recalculer. La valeur garde 32 octets : elle lie toujours enveloppes et partages à CE fichier.
//
// Séparation des usages : la clé brute de 32 octets sert de clé AES-GCM à l'original et, ici seulement, de clé HMAC
// sur une étiquette fixe (fonction pseudo-aléatoire). Aucune attaque connue de ce double usage ; c'est le seul choix
// possible, les destinataires d'une enveloppe n'ayant que la clé brute.
//
// Le SHA-256 simple (schéma 0) ne sert plus qu'à VÉRIFIER une vidéo d'avant H10 : jamais à écrire une empreinte.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

const ETIQUETTE = new TextEncoder().encode('argos/empreinte-original/v1');
const hex = (o: Uint8Array) => [...o].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Schémas : 0 = SHA-256 du fichier (vidéos d'avant), 1 = empreinte clée. */
export const SCHEMA_EMPREINTE = 1;

export function cleEmpreinteOriginal(cleBrute: Uint8Array): Uint8Array {
  if (cleBrute.length !== 32) throw new Error('clé de 32 octets attendue');
  return hmac(sha256, cleBrute, ETIQUETTE);
}

/** Empreinte clée, calculée au fil de l'eau. La clé d'empreinte est obligatoire. */
export function calculEmpreinte(cleEmpreinte: Uint8Array) {
  if (!(cleEmpreinte instanceof Uint8Array) || cleEmpreinte.length !== 32) throw new Error('clé d’empreinte de 32 octets attendue');
  const h = hmac.create(sha256, cleEmpreinte);
  return { update: (o: Uint8Array) => { h.update(o); }, hex: () => hex(h.digest()) };
}

/**
 * Vérification d'un original déchiffré : l'empreinte clée et, pour les vidéos d'avant H10 seulement, le SHA-256 simple.
 * `correspond(attendue)` : vrai si l'une des deux est la valeur attendue (une empreinte clée ne peut pas tomber par
 * hasard sur un SHA-256 simple). Le SHA-256 simple n'est jamais renvoyé ni envoyé.
 */
export function verificationEmpreinte(cleEmpreinte: Uint8Array) {
  const cle = calculEmpreinte(cleEmpreinte);
  const simple = sha256.create();
  let fin: { cle: string; simple: string } | null = null;
  const finir = () => (fin ??= { cle: cle.hex(), simple: hex(simple.digest()) });
  return {
    update: (o: Uint8Array) => { cle.update(o); simple.update(o); },
    empreinte: () => finir().cle,
    correspond: (attendue: string) => { const f = finir(); return attendue === f.cle || attendue === f.simple; },
  };
}
