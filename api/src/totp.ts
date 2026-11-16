// Codes à usage unique basés sur le temps (TOTP, RFC 6238 sur HOTP, RFC 4226).
// Réglages universels des applications d'authentification : SHA-1, 6 chiffres, 30 secondes.
import { createHmac, randomBytes } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const PERIODE = 30;

export function base32(octets: Buffer): string {
  let bits = 0, valeur = 0, sortie = '';
  for (const o of octets) {
    valeur = (valeur << 8) | o;
    bits += 8;
    while (bits >= 5) {
      sortie += BASE32[(valeur >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) sortie += BASE32[(valeur << (5 - bits)) & 31];
  return sortie;
}

export function deBase32(texte: string): Buffer {
  const propre = texte.toUpperCase().replace(/=+$/, '');
  let bits = 0, valeur = 0;
  const octets: number[] = [];
  for (const c of propre) {
    const i = BASE32.indexOf(c);
    if (i < 0) throw new Error('base32 invalide');
    valeur = (valeur << 5) | i;
    bits += 5;
    if (bits >= 8) {
      octets.push((valeur >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(octets);
}

/** HOTP (RFC 4226) : HMAC-SHA1 du compteur, troncature dynamique. */
export function hotp(secret: Buffer, compteur: number, chiffres = 6): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(compteur));
  const h = createHmac('sha1', secret).update(c).digest();
  const decalage = h[h.length - 1]! & 0x0f;
  const nombre = (h.readUInt32BE(decalage) & 0x7fffffff) % 10 ** chiffres;
  return String(nombre).padStart(chiffres, '0');
}

export const pas = (instantMs: number) => Math.floor(instantMs / 1000 / PERIODE);

export const totp = (secret: Buffer, instantMs: number, chiffres = 6) => hotp(secret, pas(instantMs), chiffres);

/**
 * Vérifie un code en tolérant un décalage d'horloge de ±1 période (±30 s).
 * Renvoie le pas de temps reconnu (pour empêcher de rejouer le même code), ou null.
 */
export function verifierTotp(secret: Buffer, code: string, instantMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const actuel = pas(instantMs);
  for (const p of [actuel, actuel - 1, actuel + 1]) {
    if (hotp(secret, p) === code) return p;
  }
  return null;
}

export const nouveauSecret = () => base32(randomBytes(20));   // 160 bits, recommandé par la RFC 4226

/** Lien à transformer en QR code pour l'application d'authentification. */
export function lienOtpauth(secret: string, pseudo: string): string {
  const etiquette = encodeURIComponent(`Argos Veille:${pseudo}`);
  return `otpauth://totp/${etiquette}?secret=${secret}&issuer=${encodeURIComponent('Argos Veille')}&algorithm=SHA1&digits=6&period=${PERIODE}`;
}
