// Messagerie avec les sources (M1, 8 novembre 2026) : chiffrement de bout en bout, dans le navigateur.
//
// Chaque partie a une paire ECDH P-256 :
//   - la source, une par vidéo (créée à l'envoi) : sa partie privée (PKCS#8) est chiffrée avec une clé tirée des
//     12 mots (HKDF, info « messagerie ») et, pour un envoi avec compte, aussi pour la clé du compte (ARGOS-K1) ;
//   - un compte (vérifié, administration, ou source qui envoie avec son compte) : partie privée chiffrée avec une
//     clé tirée du mot de passe (PBKDF2-SHA256, sel aléatoire).
// Un message (ARGOS-M1) : texte chiffré une fois (AES-256-GCM, clé aléatoire), puis cette clé chiffrée pour
// chacune des deux parties (ECDH éphémère + HKDF), pour que l'expéditeur puisse relire ce qu'il a écrit.
// Données associées : la conversation et l'expéditeur, pour qu'un message ne puisse pas être déplacé.

import { cleEmpreinteOriginal } from './empreinte.ts';

const SEL_PHRASE = new TextEncoder().encode('argos/phrase/v1');
const INFO_PHRASE = new TextEncoder().encode('messagerie');
const INFO_CLE_VIDEO = new TextEncoder().encode('argos/messagerie/cle-video/v1');
const INFO_MESSAGE = new TextEncoder().encode('argos/message/v1');
const INFO_PARTAGE = new TextEncoder().encode('argos/original-partage/v1');
const INFO_CODE = new TextEncoder().encode('argos/code-du-compte/v1');
export const ITERATIONS_MDP = 600_000;
export const TEXTE_MAX = 4000;

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const b64 = (o: Uint8Array) => btoa(String.fromCharCode(...o));
const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const octets = (o: Uint8Array) => o as Uint8Array<ArrayBuffer>;
const concat = (...p: Uint8Array[]) => {
  const r = new Uint8Array(p.reduce((t, x) => t + x.length, 0));
  let i = 0;
  for (const x of p) { r.set(x, i); i += x.length; }
  return r;
};

/** Une paire de messagerie ouverte : la partie privée n'est jamais exportable une fois ouverte. */
export interface CleOuverte { publique: string; privee: CryptoKey }

/** Partie privée chiffrée : nonce (12) | AES-GCM(PKCS#8), en base64. */
export type PriveeChiffree = string;
/** Clé de compte telle que gardée par le serveur. */
export interface CleCompte { publique: string; privee: PriveeChiffree; sel: string; iterations: number }
/** Partie privée d'une clé de vidéo chiffrée pour la clé d'un compte (ARGOS-K1). */
export interface PourCompte { v: 1; epk: string; nonce: string; chiffre: string }
/** Clé de vidéo telle que gardée par le serveur. */
export interface CleVideo { publique: string; parPhrase: PriveeChiffree; pourCompte?: PourCompte }
/** Message chiffré (ARGOS-M1). */
export interface MessageChiffre {
  v: 1 | 2; nonce: string; texte: string; destinataires: { cle: string; epk: string; nonce: string; enveloppe: string }[];
  auth?: string;   // v2 : preuve de l'expéditeur (HMAC à clé ECDH statique entre les deux parties)
}

async function nouvellePaire(): Promise<{ publique: Uint8Array; pkcs8: Uint8Array }> {
  const p = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  return {
    publique: new Uint8Array(await crypto.subtle.exportKey('raw', p.publicKey)),
    pkcs8: new Uint8Array(await crypto.subtle.exportKey('pkcs8', p.privateKey)),
  };
}
const importerPrivee = (pkcs8: Uint8Array) => crypto.subtle.importKey('pkcs8', octets(pkcs8), ECDH, false, ['deriveBits']);
const importerPublique = (point: Uint8Array) => crypto.subtle.importKey('raw', octets(point), ECDH, false, []);

async function chiffrerAes(cle: CryptoKey, clair: Uint8Array, ad: Uint8Array): Promise<PriveeChiffree> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: octets(ad) }, cle, octets(clair)));
  return b64(concat(nonce, c));
}
async function dechiffrerAes(cle: CryptoKey, chiffre: PriveeChiffree, ad: Uint8Array): Promise<Uint8Array> {
  const o = deB64(chiffre);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: octets(o.subarray(0, 12)), additionalData: octets(ad) }, cle, octets(o.subarray(12))));
}

/** Clé AES dérivée d'un secret ECDH : HKDF(secret, sel = point éphémère | point destinataire, info). */
async function cleEcdh(secret: ArrayBuffer, epk: Uint8Array, destinataire: Uint8Array, info: Uint8Array, usage: KeyUsage) {
  const hk = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: octets(concat(epk, destinataire)), info: octets(info) },
    hk, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** Chiffre `clair` pour la clé publique `point` (ECDH éphémère). */
async function sceller(clair: Uint8Array, point: Uint8Array, info: Uint8Array, ad: Uint8Array) {
  const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importerPublique(point) }, eph.privateKey, 256);
  const cle = await cleEcdh(secret, epk, point, info, 'encrypt');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const c = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: octets(ad) }, cle, octets(clair)));
  return { epk: b64(epk), nonce: b64(nonce), chiffre: b64(c) };
}
async function desceller(s: { epk: string; nonce: string; chiffre: string }, moi: CleOuverte, info: Uint8Array, ad: Uint8Array) {
  const epk = deB64(s.epk);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importerPublique(epk) }, moi.privee, 256);
  const cle = await cleEcdh(secret, epk, deB64(moi.publique), info, 'decrypt');
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: octets(deB64(s.nonce)), additionalData: octets(ad) }, cle, octets(deB64(s.chiffre))));
}

/** Vérifie qu'une clé publique est un point P-256 non compressé valable (65 octets). */
export async function clePubliqueValable(publique: string): Promise<boolean> {
  try {
    const o = deB64(publique);
    if (o.length !== 65 || o[0] !== 4) return false;
    await importerPublique(o);
    return true;
  } catch { return false; }
}

/** Empreinte courte d'une clé publique (16 caractères hexadécimaux). */
export async function empreinteMessagerie(publique: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', octets(deB64(publique))));
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// --- Clé de compte (mot de passe) ----------------------------------------------------------------

async function cleMotDePasse(motDePasse: string, sel: Uint8Array, iterations: number, usage: KeyUsage) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(motDePasse.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: octets(sel), iterations },
    base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
const adCompte = (publique: Uint8Array) => concat(new TextEncoder().encode('argos/messagerie/compte/v1'), publique);

/** Crée la clé de messagerie d'un compte, protégée par son mot de passe. */
export async function creerCleCompte(motDePasse: string, iterations = ITERATIONS_MDP): Promise<{ stockee: CleCompte; ouverte: CleOuverte }> {
  const { publique, pkcs8 } = await nouvellePaire();
  const stockee = await protegerCleCompte(pkcs8, publique, motDePasse, iterations);
  return { stockee, ouverte: { publique: b64(publique), privee: await importerPrivee(pkcs8) } };
}

async function protegerCleCompte(pkcs8: Uint8Array, publique: Uint8Array, motDePasse: string, iterations: number): Promise<CleCompte> {
  const sel = crypto.getRandomValues(new Uint8Array(16));
  const cle = await cleMotDePasse(motDePasse, sel, iterations, 'encrypt');
  return { publique: b64(publique), privee: await chiffrerAes(cle, pkcs8, adCompte(publique)), sel: b64(sel), iterations };
}

async function pkcs8Compte(stockee: CleCompte, motDePasse: string): Promise<Uint8Array> {
  const cle = await cleMotDePasse(motDePasse, deB64(stockee.sel), stockee.iterations, 'decrypt');
  try { return await dechiffrerAes(cle, stockee.privee, adCompte(deB64(stockee.publique))); }
  catch { throw new Error('mot_de_passe_incorrect'); }
}

/**
 * Ouvre la clé d'un compte avec son mot de passe (erreur « mot_de_passe_incorrect » sinon, pour TOUT échec).
 * La clé publique est recalculée depuis la privée et doit être celle stockée : la liaison ne repose pas sur la seule
 * étiquette AES-GCM (qui n'engage pas la clé ; relecture de N1, 15 novembre).
 */
export async function ouvrirCleCompte(stockee: CleCompte, motDePasse: string): Promise<CleOuverte> {
  const pkcs8 = await pkcs8Verifie(stockee, motDePasse);
  return { publique: stockee.publique, privee: await importerPrivee(pkcs8) };
}

/** Partie privée déchiffrée ET cohérente avec la publique stockée ; sinon « mot_de_passe_incorrect » (tout échec). */
async function pkcs8Verifie(stockee: CleCompte, motDePasse: string): Promise<Uint8Array> {
  try {
    const pkcs8 = await pkcs8Compte(stockee, motDePasse);
    const jwk = await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('pkcs8', octets(pkcs8), ECDH, true, ['deriveBits']));
    const point = concat(new Uint8Array([4]), deB64Url(jwk.x!), deB64Url(jwk.y!));
    if (b64(point) !== stockee.publique) throw new Error('paire');
    return pkcs8;
  } catch {
    throw new Error('mot_de_passe_incorrect');
  }
}
const deB64Url = (s: string) => deB64(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));

/** Changement de mot de passe : même paire, protégée par le nouveau mot de passe. */
export async function rechiffrerCleCompte(stockee: CleCompte, ancien: string, nouveau: string, iterations = ITERATIONS_MDP): Promise<CleCompte> {
  return protegerCleCompte(await pkcs8Verifie(stockee, ancien), deB64(stockee.publique), nouveau, iterations);
}

// --- Clé de vidéo (12 mots, et compte) -----------------------------------------------------------

async function clePhrase(entropie: Uint8Array, usage: KeyUsage) {
  if (entropie.length !== 16) throw new Error('16 octets attendus');
  const base = await crypto.subtle.importKey('raw', octets(entropie), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: octets(SEL_PHRASE), info: octets(INFO_PHRASE) },
    base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
const adVideo = (publique: Uint8Array) => concat(INFO_CLE_VIDEO, publique);

/** À l'envoi : la clé de messagerie de la vidéo, ouvrable avec les 12 mots et, si donnée, avec la clé du compte. */
export async function creerCleVideo(entropie: Uint8Array, publiqueCompte?: string): Promise<CleVideo> {
  const { publique, pkcs8 } = await nouvellePaire();
  const parPhrase = await chiffrerAes(await clePhrase(entropie, 'encrypt'), pkcs8, adVideo(publique));
  if (!publiqueCompte) return { publique: b64(publique), parPhrase };
  const s = await sceller(pkcs8, deB64(publiqueCompte), INFO_CLE_VIDEO, adVideo(publique));
  return { publique: b64(publique), parPhrase, pourCompte: { v: 1, ...s } };
}

export async function ouvrirCleVideoParPhrase(cle: CleVideo, entropie: Uint8Array): Promise<CleOuverte> {
  let pkcs8: Uint8Array;
  try { pkcs8 = await dechiffrerAes(await clePhrase(entropie, 'decrypt'), cle.parPhrase, adVideo(deB64(cle.publique))); }
  catch { throw new Error('code_incorrect'); }
  return { publique: cle.publique, privee: await importerPrivee(pkcs8) };
}

/** Rattachement après coup : avec les 12 mots, la partie privée de la clé de la vidéo est chiffrée pour la clé du
 *  compte (même format qu'à un envoi avec compte). */
export async function cleVideoPourCompte(cle: CleVideo, entropie: Uint8Array, publiqueCompte: string): Promise<PourCompte> {
  let pkcs8: Uint8Array;
  try { pkcs8 = await dechiffrerAes(await clePhrase(entropie, 'decrypt'), cle.parPhrase, adVideo(deB64(cle.publique))); }
  catch { throw new Error('code_incorrect'); }
  return { v: 1, ...(await sceller(pkcs8, deB64(publiqueCompte), INFO_CLE_VIDEO, adVideo(deB64(cle.publique)))) };
}

export async function ouvrirCleVideoParCompte(cle: CleVideo, compte: CleOuverte): Promise<CleOuverte> {
  if (!cle.pourCompte) throw new Error('pas_de_cle_pour_le_compte');
  const pkcs8 = await desceller(cle.pourCompte, compte, INFO_CLE_VIDEO, adVideo(deB64(cle.publique)));
  return { publique: cle.publique, privee: await importerPrivee(pkcs8) };
}

// --- Messages ------------------------------------------------------------------------------------

export type Expediteur = 'witness' | 'verified';
const adMessage = (conversation: string, expediteur: Expediteur) =>
  concat(INFO_MESSAGE, new TextEncoder().encode(`|${conversation}|${expediteur}`));

/**
 * Preuve de l'expéditeur (second audit, N2) : HMAC-SHA256 du message chiffré, avec une clé tirée du secret ECDH STATIQUE
 * entre la clé de l'expéditeur et celle du destinataire. Seules ces deux clés peuvent la calculer : le serveur ne peut ni
 * fabriquer un message « de » l'autre partie, ni en modifier un. (Pas une signature publique : un tiers ne peut pas la
 * vérifier, ce qui est voulu, chacun peut nier devant un tiers.)
 */
async function preuve(m: { nonce: string; texte: string }, ad: Uint8Array, moi: CleOuverte, autre: string): Promise<Uint8Array> {
  const a = deB64(moi.publique), b = deB64(autre);
  const [x, y] = b64(a) < b64(b) ? [a, b] : [b, a];
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importerPublique(b) }, moi.privee, 256);
  const hk = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const k = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: octets(concat(x, y)), info: octets(INFO_AUTH) },
    hk, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, octets(concat(ad, deB64(m.nonce), deB64(m.texte)))));
}
const INFO_AUTH = new TextEncoder().encode('argos/messagerie/auth/v1');

/**
 * Vérifie que le message vient bien de la conversation entre `moi` et `autre` (vrai : écrit par l'une des deux clés).
 * Faux pour un message d'avant la preuve (v1) ou dont la preuve est fausse.
 */
export async function expediteurVerifie(m: MessageChiffre, conversation: string, expediteur: Expediteur, moi: CleOuverte, autre: string): Promise<boolean> {
  if (m.v !== 2 || !m.auth) return false;
  try {
    const attendue = await preuve(m, adMessage(conversation, expediteur), moi, autre);
    const recue = deB64(m.auth);
    if (recue.length !== attendue.length) return false;
    let d = 0;
    for (let i = 0; i < recue.length; i++) d |= recue[i]! ^ attendue[i]!;
    return d === 0;
  } catch { return false; }
}

/** Chiffre un message pour les deux parties (l'expéditeur et le destinataire), avec la preuve de l'expéditeur. */
export async function chiffrerMessage(texte: string, conversation: string, expediteur: Expediteur, publiques: string[],
                                      signataire?: { moi: CleOuverte; autre: string }): Promise<MessageChiffre> {
  const t = texte.trim();
  if (!t) throw new Error('message_vide');
  if (t.length > TEXTE_MAX) throw new Error('message_trop_long');
  const ad = adMessage(conversation, expediteur);
  const cleMessage = crypto.getRandomValues(new Uint8Array(32));
  const aes = await crypto.subtle.importKey('raw', octets(cleMessage), 'AES-GCM', false, ['encrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: octets(ad) }, aes,
                                                             new TextEncoder().encode(t)));
  const destinataires = [];
  for (const p of new Set(publiques)) {
    const s = await sceller(cleMessage, deB64(p), INFO_MESSAGE, ad);
    destinataires.push({ cle: await empreinteMessagerie(p), epk: s.epk, nonce: s.nonce, enveloppe: s.chiffre });
  }
  const m: MessageChiffre = { v: 1, nonce: b64(nonce), texte: b64(chiffre), destinataires };
  if (!signataire) return m;
  return { ...m, v: 2, auth: b64(await preuve(m, ad, signataire.moi, signataire.autre)) };
}

/** Empreinte LONGUE d'une clé publique (32 caractères hexadécimaux, 128 bits) : celle à comparer à la main. */
export async function empreinteLongue(publique: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', octets(deB64(publique))));
  return [...h].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** La clé (32 octets) d'un message reçu, en base64 : la révéler à l'administration lui permet de lire CE message
 *  seulement, et de vérifier qu'il n'a pas été inventé (signalement). */
export async function cleDuMessage(m: MessageChiffre, conversation: string, expediteur: Expediteur, moi: CleOuverte): Promise<string> {
  return b64(await cleMessageDe(m, conversation, expediteur, moi));
}

async function cleMessageDe(m: MessageChiffre, conversation: string, expediteur: Expediteur, moi: CleOuverte): Promise<Uint8Array> {
  const e = await empreinteMessagerie(moi.publique);
  const d = m.destinataires.find((x) => x.cle === e);
  if (!d) throw new Error('message_pas_pour_moi');
  return desceller({ epk: d.epk, nonce: d.nonce, chiffre: d.enveloppe }, moi, INFO_MESSAGE, adMessage(conversation, expediteur));
}

/** Déchiffre un message avec sa propre clé (erreur si le message n'est pas pour elle ou a été modifié). */
export async function dechiffrerMessage(m: MessageChiffre, conversation: string, expediteur: Expediteur, moi: CleOuverte): Promise<string> {
  const ad = adMessage(conversation, expediteur);
  const cleMessage = await cleMessageDe(m, conversation, expediteur, moi);
  const aes = await crypto.subtle.importKey('raw', octets(cleMessage), 'AES-GCM', false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: octets(deB64(m.nonce)), additionalData: octets(ad) }, aes, octets(deB64(m.texte))));
}

// --- Partage de l'original par la source -----------------------------------------------------------

const hexOctets = (h: string) => {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('empreinte invalide');
  return Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
};
const adPartage = (sha256Original: string) => concat(INFO_PARTAGE, hexOctets(sha256Original));

/** La source : la clé de l'original (32 octets), chiffrée pour la clé de messagerie d'un compte vérifié, liée à
 *  l'empreinte de CET original (elle ne peut pas servir pour un autre fichier). */
export async function partagerOriginal(cleOriginal: Uint8Array, publiqueCompte: string, sha256Original: string): Promise<PourCompte> {
  if (cleOriginal.length !== 32) throw new Error('clé de 32 octets attendue');
  return { v: 1, ...(await sceller(cleOriginal, deB64(publiqueCompte), INFO_PARTAGE, adPartage(sha256Original))) };
}

/** Le compte vérifié : retrouve la clé de l'original (AES-256-GCM, pour dechiffrerOriginal). */
export async function ouvrirPartageOriginal(e: PourCompte, moi: CleOuverte, sha256Original: string): Promise<CryptoKey> {
  const brute = await desceller(e, moi, INFO_PARTAGE, adPartage(sha256Original));
  return crypto.subtle.importKey('raw', octets(brute), 'AES-GCM', false, ['decrypt']);
}

/** Comme ouvrirPartageOriginal, avec aussi la clé d'empreinte (H10) pour vérifier le fichier déchiffré. */
export async function ouvrirPartageOriginalAvecEmpreinte(e: PourCompte, moi: CleOuverte, sha256Original: string):
    Promise<{ cle: CryptoKey; cleEmpreinte: Uint8Array }> {
  const brute = await desceller(e, moi, INFO_PARTAGE, adPartage(sha256Original));
  const cle = await crypto.subtle.importKey('raw', octets(brute), 'AES-GCM', false, ['decrypt']);
  const cleEmpreinte = cleEmpreinteOriginal(brute);
  brute.fill(0);
  return { cle, cleEmpreinte };
}

/** Envoi avec un compte : le code de la vidéo, chiffré pour la clé du compte. Le serveur le garde sans pouvoir le lire. */
export async function scellerCode(entropie: Uint8Array, publiqueCompte: string): Promise<PourCompte> {
  if (entropie.length !== 16) throw new Error('16 octets attendus');
  return { v: 1, ...(await sceller(entropie, deB64(publiqueCompte), INFO_CODE, INFO_CODE)) };
}

export async function ouvrirCode(e: PourCompte, moi: CleOuverte): Promise<Uint8Array> {
  return desceller(e, moi, INFO_CODE, INFO_CODE);
}
