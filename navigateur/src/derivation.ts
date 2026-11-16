// Trois secrets dérivés de la phrase (HKDF-SHA256), indépendants les uns des autres :
//   - le jeton de suivi : le serveur n'en garde que le SHA-256 (empreinte) et le recalcule à chaque visite ;
//   - la clé de l'original (AES-256-GCM) : elle ne quitte jamais le navigateur ;
//   - la clé de copie : transmise au serveur à la fin de l'envoi et à chaque retouche, pour chiffrer puis
//     relire la copie de travail gardée 7 jours ; le serveur l'oublie aussitôt le traitement fini.
// Connaître l'un ne permet de retrouver ni les autres, ni la phrase.

import { cleEmpreinteOriginal } from './empreinte.ts';

const SEL = new TextEncoder().encode('argos/phrase/v1');

async function hkdf(entropie: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', entropie as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits', 'deriveKey']);
}

const b64u = (o: Uint8Array) => btoa(String.fromCharCode(...o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface Secrets {
  jetonSuivi: string;       // envoyé au serveur pour consulter le suivi (43 caractères base64url)
  empreinteSuivi: string;   // SHA-256 du jeton, en hexadécimal : seule chose que le serveur conserve
  cleOriginal: CryptoKey;   // AES-256-GCM, non exportable
  cleCopie: string;         // 32 octets en base64url (43 caractères), à transmettre au serveur
  cleEmpreinte: Uint8Array; // clé de l'empreinte clée de l'original (H10) : ne quitte jamais le navigateur
}

export async function deriverSecrets(entropie: Uint8Array): Promise<Secrets> {
  if (entropie.length !== 16) throw new Error('16 octets attendus');
  const base = await hkdf(entropie);
  const jeton = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SEL, info: new TextEncoder().encode('suivi') }, base, 256));
  const cleOriginal = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SEL, info: new TextEncoder().encode('original') }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  // Clé brute de l'original (la même que cleOriginalBrute) : seulement pour en tirer la clé d'empreinte.
  const brute = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SEL, info: new TextEncoder().encode('original') }, base, 256));
  const copie = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SEL, info: new TextEncoder().encode('copie') }, base, 256));
  const empreinte = new Uint8Array(await crypto.subtle.digest('SHA-256', jeton));
  const cleEmpreinte = cleEmpreinteOriginal(brute);
  brute.fill(0);   // la clé brute ne reste pas en mémoire
  return {
    jetonSuivi: b64u(jeton),
    empreinteSuivi: [...empreinte].map((o) => o.toString(16).padStart(2, '0')).join(''),
    cleOriginal,
    cleCopie: b64u(copie),
    cleEmpreinte,
  };
}

// Code unique pour plusieurs vidéos (9 novembre 2026) : chaque vidéo a son propre secret de 16 octets, tiré du code. La
// vidéo 0 utilise le code tel quel, ce qui laisse valables les codes déjà donnés. Connaître le secret d'une vidéo
// (celui qu'on transmet à un contact, par exemple) ne permet de retrouver ni le code, ni les autres vidéos.
export const VIDEOS_PAR_CODE = 50;

export async function entropieVideo(code: Uint8Array, n: number): Promise<Uint8Array> {
  if (code.length !== 16) throw new Error('16 octets attendus');
  if (!Number.isInteger(n) || n < 0 || n >= VIDEOS_PAR_CODE) throw new Error('numéro de vidéo invalide');
  if (n === 0) return code;
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SEL, info: new TextEncoder().encode(`video/${n}`) }, await hkdf(code), 128));
}

/** Les jetons de suivi de toutes les vidéos possibles d'un code, dans l'ordre. */
export async function jetonsDuCode(code: Uint8Array): Promise<string[]> {
  return Promise.all(Array.from({ length: VIDEOS_PAR_CODE }, async (_, n) => (await deriverSecrets(await entropieVideo(code, n))).jetonSuivi));
}

/** Retrouve le secret de la vidéo que `convient` reconnaît, parmi celles du code. */
export async function trouverEntropie(code: Uint8Array, convient: (e: Uint8Array) => Promise<boolean>): Promise<Uint8Array | null> {
  for (let n = 0; n < VIDEOS_PAR_CODE; n++) {
    const e = await entropieVideo(code, n);
    if (await convient(e)) return e;
  }
  return null;
}
