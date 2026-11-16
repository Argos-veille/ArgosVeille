// Chiffrement de l'original par morceaux (AES-256-GCM), dans le navigateur de la source.
//
// Format du fichier chiffré :
//   en-tête (20 octets) : « ARGOS-O1 » (8) | taille des morceaux en clair (4, gros-boutiste) | préfixe de nonce (8, aléatoire)
//   puis chaque morceau : texte chiffré + étiquette d'authentification (16)
// Nonce du morceau i : préfixe (8) + i (4). Données associées : en-tête + i (4) + « dernier » (1).
// Chaque morceau est donc lié à sa place et au fichier : on ne peut ni en retirer, ni en ajouter,
// ni en échanger, ni couper la fin, sans que le déchiffrement échoue.
import { calculEmpreinte, verificationEmpreinte } from './empreinte.ts';
import type { Lecteur } from './lecteur.ts';

export const MAGIE = new TextEncoder().encode('ARGOS-O1');
export const TAILLE_ENTETE = 20;
export const TAILLE_MORCEAU = 4 * 1024 * 1024;   // 4 Mio en clair
export const TAILLE_MAX = 2 * 1024 ** 3;         // 2 Go
const ETIQUETTE = 16;

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function concat(...parties: Uint8Array[]): Uint8Array {
  const r = new Uint8Array(parties.reduce((t, p) => t + p.length, 0));
  let i = 0;
  for (const p of parties) { r.set(p, i); i += p.length; }
  return r;
}

const nonce = (prefixe: Uint8Array, i: number) => concat(prefixe, u32(i)) as Uint8Array<ArrayBuffer>;
const associees = (entete: Uint8Array, i: number, dernier: boolean) =>
  concat(entete, u32(i), new Uint8Array([dernier ? 1 : 0])) as Uint8Array<ArrayBuffer>;

export const nombreMorceaux = (tailleClair: number, tailleMorceau = TAILLE_MORCEAU) =>
  Math.max(1, Math.ceil(tailleClair / tailleMorceau));

/** Taille du fichier chiffré pour une taille en clair donnée (utile pour annoncer l'envoi). */
export const tailleChiffree = (tailleClair: number, tailleMorceau = TAILLE_MORCEAU) =>
  TAILLE_ENTETE + tailleClair + nombreMorceaux(tailleClair, tailleMorceau) * ETIQUETTE;

export interface MorceauChiffre { index: number; octets: Uint8Array; dernier: boolean }

/**
 * Chiffre la vidéo morceau par morceau. Chaque morceau chiffré est passé à `envoyer` (qui peut
 * l'envoyer au serveur) ; l'en-tête est collé devant le premier. Renvoie l'empreinte CLÉE de l'original (H10),
 * calculée au fil de l'eau avec `cleEmpreinte` (obligatoire : jamais de SHA-256 simple du clair).
 */
export async function chiffrerOriginal(source: Lecteur, cle: CryptoKey, envoyer: (m: MorceauChiffre) => Promise<void>,
                                       cleEmpreinte: Uint8Array, tailleMorceau = TAILLE_MORCEAU): Promise<{ sha256: string; taille: number }> {
  if (source.taille === 0) throw new Error('fichier vide');
  if (source.taille > TAILLE_MAX) throw new Error('fichier trop volumineux (2 Go au plus)');
  const prefixe = crypto.getRandomValues(new Uint8Array(8));
  const entete = concat(MAGIE, u32(tailleMorceau), prefixe);
  const n = nombreMorceaux(source.taille, tailleMorceau);
  const empreinte = calculEmpreinte(cleEmpreinte);
  for (let i = 0; i < n; i++) {
    const clair = await source.lire(i * tailleMorceau, (i + 1) * tailleMorceau);
    empreinte.update(clair);
    const dernier = i === n - 1;
    const chiffre = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce(prefixe, i), additionalData: associees(entete, i, dernier) }, cle,
      clair as Uint8Array<ArrayBuffer>));
    await envoyer({ index: i, dernier, octets: i === 0 ? concat(entete, chiffre) : chiffre });
  }
  return { sha256: empreinte.hex(), taille: source.taille };
}

/**
 * Déchiffre un original (pour la source, un avocat ou un tribunal qui a la phrase). Vérifie chaque
 * morceau ; échoue au moindre octet modifié, morceau manquant, ajouté ou déplacé. `correspond(attendue)` compare
 * à l'empreinte enregistrée (clée, ou SHA-256 simple pour une vidéo d'avant H10).
 */
export async function dechiffrerOriginal(chiffre: Lecteur, cle: CryptoKey, recevoir: (clair: Uint8Array) => Promise<void>,
                                         cleEmpreinte: Uint8Array): Promise<{ sha256: string; correspond: (attendue: string) => boolean }> {
  if (chiffre.taille < TAILLE_ENTETE + ETIQUETTE) throw new Error('fichier chiffré invalide');
  const entete = await chiffre.lire(0, TAILLE_ENTETE);
  if (!MAGIE.every((o, i) => entete[i] === o)) throw new Error("ce n'est pas un original chiffré d'Argos");
  const tailleMorceau = new DataView(entete.buffer, entete.byteOffset).getUint32(8);
  if (tailleMorceau < 1024 || tailleMorceau > 64 * 1024 * 1024) throw new Error('fichier chiffré invalide');
  const prefixe = entete.slice(12, 20);
  const pas = tailleMorceau + ETIQUETTE;
  const corps = chiffre.taille - TAILLE_ENTETE;
  const n = Math.ceil(corps / pas);
  const empreinte = verificationEmpreinte(cleEmpreinte);
  for (let i = 0; i < n; i++) {
    const debut = TAILLE_ENTETE + i * pas;
    const morceau = await chiffre.lire(debut, debut + pas);
    if (morceau.length <= ETIQUETTE) throw new Error('fichier chiffré tronqué ou modifié');
    let clair: Uint8Array;
    try {
      clair = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce(prefixe, i), additionalData: associees(entete, i, i === n - 1) }, cle,
        morceau as Uint8Array<ArrayBuffer>));
    } catch {
      throw new Error('fichier chiffré tronqué ou modifié, ou mauvaise phrase');
    }
    empreinte.update(clair);
    await recevoir(clair);
  }
  return { sha256: empreinte.empreinte(), correspond: empreinte.correspond };
}
