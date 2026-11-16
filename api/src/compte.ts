// Opérations communes sur un compte : changement de mot de passe et mails d'alerte.
import { type CleCompte, majCleCompte } from './messagerie.ts';
import type { FastifyBaseLogger } from 'fastify';
import type { Dependances } from './app.ts';
import { dechiffrer, hacherMotDePasse, verifierMotDePasse } from './crypto.ts';

/**
 * Change le mot de passe et ferme les sessions du compte (toutes, sauf `garder` : la session
 * de celui qui change lui-même son mot de passe). Une seule transaction.
 */
/** `cle` : clé de messagerie rechiffrée par le navigateur (changement), ou « effacer » (réinitialisation : le
 *  navigateur ne connaît pas l'ancien mot de passe, la clé est perdue). */
export async function changerMotDePasse(deps: Dependances, compteId: string, nouveau: string, garder?: string,
                                        cle?: CleCompte | 'effacer') {
  const empreinte = await hacherMotDePasse(nouveau);
  const client = await deps.bases.app.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE core.credentials SET password_hash = $2, password_scheme = 1, updated_at = now() WHERE account_id = $1',
                       [compteId, empreinte]);
    await client.query(
      `UPDATE core.sessions SET revoked_at = now()
        WHERE account_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2`, [compteId, garder ?? null]);
    if (cle) await majCleCompte(client, compteId, cle);
    // Plus aucun appareil de confiance : la double authentification sera redemandée partout.
    await client.query('UPDATE core.known_devices SET mfa_trusted_until = NULL WHERE account_id = $1', [compteId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Mail d'alerte de sécurité au relecteur. Le mail est lu (chiffré) par le rôle d'identité.
 * Un échec d'envoi est journalisé mais ne bloque pas l'opération déjà faite.
 */
export async function alerter(deps: Dependances, log: FastifyBaseLogger, compteId: string, sujet: string, texte: string) {
  try {
    // Ton factuel, sans lien ni formule d'urgence : les filtres anti-spam traitent ces mails comme de l'hameçonnage.
    await ecrire(deps, compteId, sujet,
      `Bonjour,\n\n${texte}\n\nSi vous n'êtes pas à l'origine de cette action, connectez-vous à votre compte sur le site et `
      + `changez votre mot de passe dans « Mon compte », où vous pouvez aussi fermer toutes vos sessions.`);
  } catch (e) {
    log.error({ err: e }, "échec de l'envoi d'un mail d'alerte");
  }
}

/** Mail à un relecteur (adresse lue chiffrée par le rôle d'identité). Faux si le compte n'a pas de mail. */
export async function ecrire(deps: Dependances, compteId: string, sujet: string, texte: string): Promise<boolean> {
  const r = await deps.bases.identity.query<{ email_enc: Buffer }>(
    'SELECT email_enc FROM identity.account_identities WHERE account_id = $1', [compteId]);
  if (!r.rows[0]) return false;
  await deps.facteur.mail(dechiffrer(deps.cles, r.rows[0].email_enc), `Argos Veille : ${sujet}`, texte + signature(deps));
  return true;
}

/** Signature commune des mails : qui écrit, et pourquoi on reçoit ce message (aide à passer les filtres). */
export function signature(deps: Dependances, raison = 'Vous recevez ce message parce que vous avez un compte sur Argos Veille.') {
  return `\n\n--\nArgos Veille · ${deps.reglages.urlPublique.replace(/^https?:\/\//, '')}\n${raison}\n`
    + `Message automatique : pour nous écrire, utilisez la page Contact du site.`;
}

/** Vérifie le mot de passe d'un relecteur connecté, avec une limite de 5 échecs par 15 minutes. */
export async function verifierMdpConnecte(deps: Dependances, compteId: string, mdp: string): Promise<'ok' | 'faux' | 'bloque'> {
  const cle = `limite:mdp-connecte:${compteId}`;
  if (Number((await deps.redis.get(cle)) ?? 0) >= 5) return 'bloque';
  const r = await deps.bases.app.query<{ password_hash: string }>(
    'SELECT password_hash FROM core.credentials WHERE account_id = $1', [compteId]);
  if (r.rows[0] && (await verifierMotDePasse(mdp, r.rows[0].password_hash))) return 'ok';
  await deps.redis.multi().incr(cle).expire(cle, 15 * 60, 'NX').exec();
  return 'faux';
}

export interface Facteur { id: string; kind: 'totp' | 'webauthn'; label: string | null; totp_secret_enc: Buffer | null }

/** Méthodes de double authentification actives d'un compte. */
/** Le compte a-t-il au moins une méthode de double authentification active ? */
export async function aDoubleAuth(deps: Dependances, compteId: string): Promise<boolean> {
  const r = await deps.bases.app.query<{ ok: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM core.mfa_factors WHERE account_id = $1 AND revoked_at IS NULL) AS ok', [compteId]);
  return r.rows[0]!.ok;
}

/** Double authentification obligatoire (revue de sécurité, A3) : super-administrateur, analyste OSINT, compte vérifié
 *  (journaliste, avocat, association) : ils accèdent aux messages des sources, aux originaux ou à la file d'analyse. */
export async function doubleAuthObligatoire(deps: Dependances, compteId: string): Promise<boolean> {
  const r = await deps.bases.app.query<{ ok: boolean }>(
    `SELECT (SELECT is_superadmin FROM core.accounts WHERE id = $1) OR coalesce(core.is_osint_analyst($1), false)
            OR EXISTS (SELECT 1 FROM core.verifications WHERE account_id = $1 AND revoked_at IS NULL AND expires_at > now()) AS ok`,
    [compteId]);
  return r.rows[0]?.ok === true;
}

export async function facteursActifs(deps: Dependances, compteId: string): Promise<Facteur[]> {
  const r = await deps.bases.app.query<Facteur>(
    `SELECT id, kind, label, totp_secret_enc FROM core.mfa_factors
      WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at`, [compteId]);
  return r.rows;
}

const NOMS_STATUTS: Record<string, string> = { journalist: 'journaliste', lawyer: 'avocat', association: 'association', osint_analyst: 'analyste' };

/** Rappels d'échéance des statuts annuels (0118) : 30 jours puis 7 jours avant. Renvoie le nombre de mails envoyés. */
export async function rappelerStatuts(deps: Dependances): Promise<number> {
  const r = await deps.bases.app.query<{ account_id: string; category: string; expires_at: Date; palier: number }>(
    'SELECT * FROM core.take_status_reminders()');
  let n = 0;
  for (const s of r.rows) {
    const nom = NOMS_STATUTS[s.category] ?? s.category;
    const le = s.expires_at.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' });
    // Ton factuel, sans lien (voir alerter) ; le renouvellement passe par l'administration.
    if (await ecrire(deps, s.account_id, `Argos Veille : votre statut de ${nom} expire le ${le}`,
      `Bonjour,\n\nVotre statut de ${nom} sur Argos Veille expire le ${le}${s.palier === 7 ? ', dans une semaine' : ''}.\n\n`
      + `Pour le renouveler, écrivez à l'administration depuis la page Contact du site. Sans renouvellement, les droits liés `
      + `à ce statut s'arrêtent à cette date ; votre compte reste ouvert.`)) n++;
  }
  return n;
}
