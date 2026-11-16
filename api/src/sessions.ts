// Sessions des relecteurs. Le cookie contient un jeton aléatoire de 32 octets ; la base n'en garde
// que le SHA-256. Une session se ferme après 7 jours sans activité, et au plus tard après 30 jours.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Bases } from './db.ts';

export const COOKIE = '__Host-argos_session';   // __Host- : Secure, Path=/, sans Domain (aucun sous-domaine ne peut l'écraser)
export const DUREE_MAX_JOURS = 30;
export const INACTIVITE_JOURS = 7;
const RAFRAICHIR_MS = 5 * 60 * 1000;            // dernière activité mise à jour au plus toutes les 5 minutes

export interface Compte {
  id: string;
  pseudo: string;
  sessionId: string;
  /** Empreinte du jeton de session : la base retrouve elle-même le compte pour le lien compte ↔ vidéo (0115). */
  session: Buffer;
}

const empreinteJeton = (jeton: string) => createHash('sha256').update(jeton).digest();

/** Lit un cookie dans l'en-tête, sans dépendance. */
export function lireCookie(req: FastifyRequest, nom: string): string | undefined {
  const entete = req.headers.cookie;
  if (!entete) return undefined;
  for (const morceau of entete.split(';')) {
    const i = morceau.indexOf('=');
    if (i > 0 && morceau.slice(0, i).trim() === nom) return morceau.slice(i + 1).trim();
  }
  return undefined;
}

/** Ajoute un cookie protégé à la réponse (sans écraser les autres cookies de la même réponse). */
export function ajouterCookie(reply: FastifyReply, nom: string, valeur: string, maxAgeSecondes: number) {
  const cookie = `${nom}=${valeur}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSecondes}`;
  const deja = reply.getHeader('set-cookie');
  const liste = deja === undefined ? [] : Array.isArray(deja) ? deja.map(String) : [String(deja)];
  reply.header('set-cookie', [...liste, cookie]);
}

export const poserCookie = (reply: FastifyReply, jeton: string) =>
  ajouterCookie(reply, COOKIE, jeton, DUREE_MAX_JOURS * 86400);

export const effacerCookie = (reply: FastifyReply) => ajouterCookie(reply, COOKIE, '', 0);

/** `appareil` : description approximative (« Firefox sous Linux »), montrée dans « Mon compte ». */
export async function creerSession(bases: Bases, compteId: string, appareil?: string): Promise<string> {
  const jeton = randomBytes(32).toString('base64url');
  await bases.app.query(
    `INSERT INTO core.sessions (account_id, expires_at, token_hash, device_label)
     VALUES ($1, now() + make_interval(days => $2), $3, $4)`,
    [compteId, DUREE_MAX_JOURS, empreinteJeton(jeton), appareil?.slice(0, 60) || null]);
  return jeton;
}

/**
 * Retrouve le compte de la session. Renvoie null si le jeton est absent, inconnu, révoqué, expiré,
 * inactif depuis 7 jours, ou si le compte n'est plus actif (banni, supprimé, suspendu) : dans ce
 * dernier cas la session est aussi révoquée, pour qu'un bannissement coupe l'accès immédiatement.
 */
export async function lireSession(bases: Bases, req: FastifyRequest): Promise<Compte | null> {
  const jeton = lireCookie(req, COOKIE);
  if (!jeton || !/^[A-Za-z0-9_-]{43}$/.test(jeton)) return null;
  const empreinte = empreinteJeton(jeton);
  // Lue par une fonction de la base : le site ne peut pas lire les empreintes de session (0115).
  const r = await bases.app.query<{
    id: string; account_id: string; last_seen_at: Date; username: string; status: string; suspended_until: Date | null;
  }>('SELECT * FROM core.read_session($1, $2)', [empreinte, INACTIVITE_JOURS]);
  const s = r.rows[0];
  if (!s) return null;
  if (!compteActif(s.status, s.suspended_until)) {
    await bases.app.query('UPDATE core.sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [s.id]);
    return null;
  }
  if (Date.now() - s.last_seen_at.getTime() > RAFRAICHIR_MS) {
    await bases.app.query('UPDATE core.sessions SET last_seen_at = now() WHERE id = $1', [s.id]);
  }
  return { id: s.account_id, pseudo: s.username, sessionId: s.id, session: empreinte };
}

/** Actif, ou suspendu dont la suspension est terminée. */
export function compteActif(statut: string, suspenduJusqua: Date | null): boolean {
  if (statut === 'active') return true;
  return statut === 'suspended' && suspenduJusqua !== null && suspenduJusqua.getTime() <= Date.now();
}
