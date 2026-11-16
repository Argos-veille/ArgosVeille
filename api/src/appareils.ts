// Appareils connus : prévenir le relecteur d'une connexion depuis un nouvel appareil.
// Un cookie protégé (un an) contient un jeton aléatoire ; la base n'en garde que le SHA-256.
// Le navigateur et le système sont déduits à la volée pour le mail, jamais enregistrés.
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type { Dependances } from './app.ts';
import { alerter } from './compte.ts';
import { ajouterCookie, lireCookie } from './sessions.ts';

export const COOKIE_APPAREIL = '__Host-argos_appareil';
const UN_AN = 365 * 86400;

/** « Firefox sous Linux » : approximatif, à partir de l'en-tête User-Agent. */
export function decrireAppareil(ua: string | undefined): string {
  const u = ua ?? '';
  const navigateur = /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox'
    : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'un navigateur inconnu';
  const systeme = /Android/.test(u) ? 'Android' : /iPhone|iPad/.test(u) ? 'iOS' : /Windows/.test(u) ? 'Windows'
    : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : 'un système inconnu';
  return `${navigateur} sous ${systeme}`;
}

/**
 * À chaque connexion réussie : reconnaît l'appareil ou l'enregistre. Si le compte avait déjà au
 * moins un appareil connu et que celui-ci est nouveau, un mail d'alerte part. (Pas d'alerte pour la
 * toute première connexion du compte.) Oublie les appareils inactifs depuis plus d'un an.
 */
export async function noterAppareil(deps: Dependances, req: FastifyRequest, reply: FastifyReply,
                                    log: FastifyBaseLogger, compteId: string): Promise<Buffer> {
  const { bases } = deps;
  let jeton = lireCookie(req, COOKIE_APPAREIL);
  if (!jeton || !/^[A-Za-z0-9_-]{43}$/.test(jeton)) jeton = randomBytes(32).toString('base64url');
  const empreinte = createHash('sha256').update(jeton).digest();

  await bases.app.query(
    `DELETE FROM core.known_devices WHERE account_id = $1 AND last_seen_at < now() - interval '1 year'`, [compteId]);
  const connu = await bases.app.query(
    'UPDATE core.known_devices SET last_seen_at = now() WHERE account_id = $1 AND device_hash = $2', [compteId, empreinte]);
  if (!connu.rowCount) {
    const autres = await bases.app.query('SELECT 1 FROM core.known_devices WHERE account_id = $1 LIMIT 1', [compteId]);
    await bases.app.query(
      `INSERT INTO core.known_devices (account_id, device_hash) VALUES ($1, $2)
       ON CONFLICT (account_id, device_hash) DO NOTHING`, [compteId, empreinte]);
    if (autres.rowCount) {
      const quand = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' })
        .format(new Date());
      await alerter(deps, log, compteId, 'connexion depuis un nouvel appareil',
        `Votre compte a été utilisé le ${quand} depuis ${decrireAppareil(req.headers['user-agent'])}, un appareil que le site `
        + `ne connaissait pas encore. Si c'était vous, aucune action n'est nécessaire.`);
    }
  }
  ajouterCookie(reply, COOKIE_APPAREIL, jeton, UN_AN);
  return empreinte;
}

export const CONFIANCE_JOURS = 30;

/** Cet appareil est-il de confiance pour ce compte (double authentification non redemandée) ? */
export async function appareilDeConfiance(deps: Dependances, req: FastifyRequest, compteId: string): Promise<boolean> {
  const jeton = lireCookie(req, COOKIE_APPAREIL);
  if (!jeton || !/^[A-Za-z0-9_-]{43}$/.test(jeton)) return false;
  const r = await deps.bases.app.query(
    'SELECT 1 FROM core.known_devices WHERE account_id = $1 AND device_hash = $2 AND mfa_trusted_until > now()',
    [compteId, createHash('sha256').update(jeton).digest()]);
  return !!r.rowCount;
}

/** Plus aucun appareil de confiance (mot de passe, méthodes de double authentification, déconnexion partout). */
export async function oublierConfiance(deps: Dependances, compteId: string): Promise<void> {
  await deps.bases.app.query('UPDATE core.known_devices SET mfa_trusted_until = NULL WHERE account_id = $1 AND mfa_trusted_until IS NOT NULL', [compteId]);
}
