// Primitives cryptographiques d'Argos Veille. Tout passe par le module crypto de Node (aucune dépendance).
import { argon2, createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export interface Cles {
  hmac: Buffer;  // 32 octets
  mail: Buffer;  // 32 octets, AES-256-GCM, chiffrement des mails
  mfa: Buffer;   // 32 octets, AES-256-GCM, chiffrement des secrets de double authentification
}

/** Lit une clé de 32 octets (64 caractères hexadécimaux) dans un fichier lisible par son seul propriétaire. */
export function lireCle(fichier: string): Buffer {
  // Fichier fourni par systemd (LoadCredential) : dossier en mémoire réservé au service, lisible par son seul
  // utilisateur et son groupe (droits 440 posés par systemd). Ailleurs : droits 600 exigés.
  const systemd = process.env['CREDENTIALS_DIRECTORY'];
  const fourniParSystemd = systemd !== undefined && fichier.startsWith(`${systemd}/`);
  const mode = statSync(fichier).mode & (fourniParSystemd ? 0o007 : 0o077);
  if (mode !== 0) throw new Error(`la clé ${fichier} est lisible par d'autres utilisateurs (chmod 600)`);
  const hex = readFileSync(fichier, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`la clé ${fichier} doit contenir 64 caractères hexadécimaux`);
  return Buffer.from(hex, 'hex');
}

/**
 * Empreinte HMAC-SHA256. Le domaine (« tel », « mail »…) sépare les usages : la même valeur
 * donne des empreintes différentes selon ce qu'elle représente.
 */
export function empreinte(cles: Cles, domaine: string, valeur: string): Buffer {
  return createHmac('sha256', cles.hmac).update(`argos:${domaine}:`).update(valeur).digest();
}

export function egal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Chiffrement (AES-256-GCM) : nonce (12) + texte chiffré + étiquette (16) ---

export function chiffrerAvec(cle: Buffer, texte: string): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cle, nonce);
  const corps = Buffer.concat([c.update(texte, 'utf8'), c.final()]);
  return Buffer.concat([nonce, corps, c.getAuthTag()]);
}

export function dechiffrerAvec(cle: Buffer, donnee: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', cle, donnee.subarray(0, 12));
  d.setAuthTag(donnee.subarray(donnee.length - 16));
  return Buffer.concat([d.update(donnee.subarray(12, donnee.length - 16)), d.final()]).toString('utf8');
}

/** Mails des relecteurs. */
export const chiffrer = (cles: Cles, texte: string) => chiffrerAvec(cles.mail, texte);
export const dechiffrer = (cles: Cles, donnee: Buffer) => dechiffrerAvec(cles.mail, donnee);

// --- Mots de passe : Argon2id, réglages minimaux recommandés par l'OWASP (19 Mio, 2 passes) ---

const ARGON = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 } as const;

function argon(message: string, nonce: Buffer, p: typeof ARGON): Promise<Buffer> {
  return new Promise((ok, ko) =>
    argon2('argon2id', { message, nonce, ...p }, (err, h) => (err ? ko(err) : ok(h))));
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

/** Empreinte au format PHC : $argon2id$v=19$m=…,t=…,p=…$sel$empreinte */
export async function hacherMotDePasse(mdp: string): Promise<string> {
  const sel = randomBytes(16);
  const h = await argon(mdp, sel, ARGON);
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${b64(sel)}$${b64(h)}`;
}

export async function verifierMotDePasse(mdp: string, phc: string): Promise<boolean> {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
  if (!m) return false;
  const attendu = Buffer.from(m[5]!, 'base64');
  const h = await argon(mdp, Buffer.from(m[4]!, 'base64'), {
    memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]), tagLength: attendu.length,
  } as typeof ARGON);
  return egal(h, attendu);
}

// --- Codes et jetons aléatoires ---

export const codeSms = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const jeton = (): string => randomBytes(32).toString('base64url');
