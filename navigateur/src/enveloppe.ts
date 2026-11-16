// Autorisation de transmettre l'original (étape 3, 7 novembre 2026) : si la source l'accepte, son
// navigateur chiffre aussi la clé de l'original pour la clé d'administration (ECDH P-256). La partie
// secrète de cette clé est dans la YubiKey de l'administrateur (PIV, emplacement 9d), avec une copie de
// secours hors ligne : le serveur ne garde que l'enveloppe, qu'il ne peut pas ouvrir.
//
// Format (ARGOS-E1), un destinataire par clé d'administration :
//   - paire éphémère ECDH P-256 ; secret = abscisse du point partagé (32 octets, comme PIV « calculate secret »)
//   - clé d'enveloppe = HKDF-SHA256(secret, sel = point éphémère (65) | point admin (65), info = « argos/enveloppe/v1 »)
//   - enveloppe = AES-256-GCM(clé d'enveloppe, nonce aléatoire 12, clé de l'original (32),
//                             données associées = « argos/enveloppe/v1 » | SHA-256 de l'original en clair (32))
// L'enveloppe est donc liée à cette vidéo : elle ne peut pas être recollée sur une autre.

const INFO = new TextEncoder().encode('argos/enveloppe/v1');
const SEL_PHRASE = new TextEncoder().encode('argos/phrase/v1');

const b64 = (o: Uint8Array) => btoa(String.fromCharCode(...o));
const deB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (o: Uint8Array) => [...o].map((x) => x.toString(16).padStart(2, '0')).join('');
const concat = (...p: Uint8Array[]) => {
  const r = new Uint8Array(p.reduce((t, x) => t + x.length, 0));
  let i = 0;
  for (const x of p) { r.set(x, i); i += x.length; }
  return r;
};

export interface Destinataire { cle: string; epk: string; nonce: string; enveloppe: string }
export interface Enveloppe { v: 1; destinataires: Destinataire[] }

/** Empreinte courte d'une clé publique d'administration (point non compressé, 65 octets, en base64). */
export async function empreinteCle(publique: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', deB64(publique) as Uint8Array<ArrayBuffer>))).slice(0, 16);
}

/** Les 32 octets de la clé de l'original, dérivés de la phrase (les mêmes que la clé AES utilisée pour chiffrer). */
export async function cleOriginalBrute(entropie: Uint8Array): Promise<Uint8Array> {
  if (entropie.length !== 16) throw new Error('16 octets attendus');
  const base = await crypto.subtle.importKey('raw', entropie as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: SEL_PHRASE, info: new TextEncoder().encode('original') }, base, 256));
}

/**
 * Enveloppe la clé de l'original pour chaque clé d'administration (points P-256 non compressés, base64).
 * `sha256Original` : empreinte de l'original en clair, en hexadécimal (64 caractères).
 */
export async function envelopper(cleOriginal: Uint8Array, clesAdmin: string[], sha256Original: string): Promise<Enveloppe> {
  if (cleOriginal.length !== 32) throw new Error('clé de 32 octets attendue');
  if (!/^[0-9a-f]{64}$/.test(sha256Original)) throw new Error('empreinte invalide');
  if (!clesAdmin.length) throw new Error('aucune clé d’administration');
  const empreinte = Uint8Array.from(sha256Original.match(/../g)!, (h) => parseInt(h, 16));
  const destinataires: Destinataire[] = [];
  for (const publique of clesAdmin) {
    const pointAdmin = deB64(publique);
    if (pointAdmin.length !== 65 || pointAdmin[0] !== 4) throw new Error('clé d’administration invalide');
    const admin = await crypto.subtle.importKey('raw', pointAdmin as Uint8Array<ArrayBuffer>, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const ephemere = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pointEph = new Uint8Array(await crypto.subtle.exportKey('raw', ephemere.publicKey));
    const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: admin }, ephemere.privateKey, 256);
    const hk = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const cleEnveloppe = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: concat(pointEph, pointAdmin) as Uint8Array<ArrayBuffer>, info: INFO },
      hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const chiffre = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: concat(INFO, empreinte) as Uint8Array<ArrayBuffer> },
      cleEnveloppe, cleOriginal as Uint8Array<ArrayBuffer>));
    destinataires.push({ cle: await empreinteCle(publique), epk: b64(pointEph), nonce: b64(nonce), enveloppe: b64(chiffre) });
  }
  return { v: 1, destinataires };
}

/**
 * Ouvre une enveloppe avec la clé privée d'administration (pour les tests, et pour l'outil de secours
 * qui utilise la copie hors ligne). En production, c'est la YubiKey qui calcule le secret.
 */
export async function ouvrirEnveloppe(e: Enveloppe, privee: CryptoKey, publique: string, sha256Original: string): Promise<Uint8Array> {
  const moi = await empreinteCle(publique);
  const d = e.destinataires.find((x) => x.cle === moi);
  if (!d) throw new Error('aucune enveloppe pour cette clé');
  const eph = await crypto.subtle.importKey('raw', deB64(d.epk) as Uint8Array<ArrayBuffer>, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: eph }, privee, 256);
  const hk = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const cleEnveloppe = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: concat(deB64(d.epk), deB64(publique)) as Uint8Array<ArrayBuffer>, info: INFO },
    hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const empreinte = Uint8Array.from(sha256Original.match(/../g)!, (h) => parseInt(h, 16));
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: deB64(d.nonce) as Uint8Array<ArrayBuffer>, additionalData: concat(INFO, empreinte) as Uint8Array<ArrayBuffer> },
    cleEnveloppe, deB64(d.enveloppe) as Uint8Array<ArrayBuffer>));
}
