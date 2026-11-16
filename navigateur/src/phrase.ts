// Phrase secrète de la source : 12 mots français, selon l'algorithme BIP39
// (128 bits de hasard + 4 bits de contrôle, soit 12 × 11 bits). Le contrôle détecte presque toutes
// les fautes de saisie. Tout le reste (code de suivi, clé de l'original) en est dérivé.
import { MOTS } from './mots-fr.ts';

export const NOMBRE_MOTS = 12;

/** Minuscules, sans accents : « Académie » → « academie ». */
export const sansAccents = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const INDEX_COMPLET = new Map(MOTS.map((m, i) => [sansAccents(m), i]));
const INDEX_PREFIXE = new Map(MOTS.map((m, i) => [sansAccents(m).slice(0, 4), i]));

async function sha256(octets: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', octets as Uint8Array<ArrayBuffer>));
}

/** 16 octets de hasard → 12 mots (ou les 16 octets fournis, pour les tests). */
export async function phraseDepuisEntropie(entropie: Uint8Array): Promise<string[]> {
  if (entropie.length !== 16) throw new Error('16 octets attendus');
  const controle = (await sha256(entropie))[0]! >> 4;   // 4 bits
  let bits = 0n;
  for (const o of entropie) bits = (bits << 8n) | BigInt(o);
  bits = (bits << 4n) | BigInt(controle);               // 132 bits
  const mots: string[] = [];
  for (let i = NOMBRE_MOTS - 1; i >= 0; i--) mots[i] = MOTS[Number((bits >> BigInt(11 * (NOMBRE_MOTS - 1 - i))) & 2047n)]!;
  return mots;
}

export function genererEntropie(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

export type LecturePhrase =
  | { ok: true; entropie: Uint8Array; mots: string[] }
  | { ok: false; erreur: 'nombre_de_mots'; nombre: number }
  | { ok: false; erreur: 'mot_inconnu'; position: number }
  | { ok: false; erreur: 'controle' };

/**
 * Relit une phrase saisie : accents, majuscules et séparateurs indifférents, et chaque mot peut
 * être abrégé à ses 4 premières lettres. Vérifie les 4 bits de contrôle.
 */
export async function lirePhrase(saisie: string): Promise<LecturePhrase> {
  const brut = sansAccents(saisie).split(/[^a-z]+/).filter(Boolean);
  if (brut.length !== NOMBRE_MOTS) return { ok: false, erreur: 'nombre_de_mots', nombre: brut.length };
  const index: number[] = [];
  for (const [i, m] of brut.entries()) {
    const n = INDEX_COMPLET.get(m) ?? (m.length === 4 ? INDEX_PREFIXE.get(m) : undefined);
    if (n === undefined) return { ok: false, erreur: 'mot_inconnu', position: i + 1 };
    index.push(n);
  }
  let bits = 0n;
  for (const n of index) bits = (bits << 11n) | BigInt(n);
  const controle = Number(bits & 15n);
  bits >>= 4n;
  const entropie = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) { entropie[i] = Number(bits & 255n); bits >>= 8n; }
  if ((await sha256(entropie))[0]! >> 4 !== controle) return { ok: false, erreur: 'controle' };
  return { ok: true, entropie, mots: index.map((n) => MOTS[n]!) };
}
