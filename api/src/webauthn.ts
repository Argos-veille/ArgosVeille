// Clés de sécurité et passkeys (WebAuthn), comme second facteur. Vérifications déléguées à
// @simplewebauthn/server : défi, origine exacte du site (une clé ne répond pas à un faux site),
// identifiant du site, signature, compteur (une clé clonée fait reculer le compteur).
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Dependances } from './app.ts';
import { empreinte } from './crypto.ts';

const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card', 'cable']);

export interface CleEnregistree { id: string; credential_id: Buffer; public_key: Buffer; sign_count: string | number; transports: string[] | null }

export function site(deps: Dependances) {
  // Domaine des clés : celui du site public (argos-veille.fr) ; origine : celle de l'instance (le site, ou
  // admin.argos-veille.fr). Une clé enregistrée sur le site fonctionne donc aussi sur l'administration.
  const url = new URL(deps.reglages.urlPublique);
  return { origine: new URL(deps.reglages.origine ?? deps.reglages.urlPublique).origin, rpID: url.hostname };
}

export async function clesActives(deps: Dependances, compteId: string): Promise<CleEnregistree[]> {
  const r = await deps.bases.app.query<CleEnregistree>(
    `SELECT id, credential_id, public_key, sign_count, transports FROM core.mfa_factors
      WHERE account_id = $1 AND kind = 'webauthn' AND revoked_at IS NULL ORDER BY created_at`, [compteId]);
  return r.rows;
}

/** Options d'enregistrement d'une nouvelle clé (le défi est à garder côté serveur). */
export async function optionsEnregistrement(deps: Dependances, compteId: string, pseudo: string) {
  const { rpID } = site(deps);
  return generateRegistrationOptions({
    rpName: 'Argos Veille',
    rpID,
    userName: pseudo,
    // Identifiant opaque pour la clé : ni le pseudo, ni l'identifiant interne du compte.
    userID: new Uint8Array(empreinte(deps.cles, 'webauthn-utilisateur', compteId)),
    attestationType: 'none',   // le site ne demande ni la marque ni le modèle de la clé
    excludeCredentials: (await clesActives(deps, compteId)).map((c) => ({
      id: c.credential_id.toString('base64url'), ...(c.transports ? { transports: c.transports } : {}),
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
}

export async function verifierEnregistrement(deps: Dependances, reponse: RegistrationResponseJSON, defi: string) {
  const { origine, rpID } = site(deps);
  try {
    const v = await verifyRegistrationResponse({
      response: reponse, expectedChallenge: defi, expectedOrigin: origine, expectedRPID: rpID, requireUserVerification: false,
    });
    if (!v.verified) return null;
    const c = v.registrationInfo.credential;
    return {
      credentialId: Buffer.from(c.id, 'base64url'),
      clePublique: Buffer.from(c.publicKey),
      compteur: c.counter,
      transports: (c.transports ?? []).filter((t) => TRANSPORTS.has(t)),
    };
  } catch {
    return null;   // réponse mal formée, mauvais défi, mauvaise origine, signature invalide…
  }
}

/** Options pour prouver la possession d'une des clés du compte. */
export async function optionsPreuve(deps: Dependances, compteId: string) {
  const cles = await clesActives(deps, compteId);
  if (!cles.length) return null;
  return generateAuthenticationOptions({
    rpID: site(deps).rpID,
    userVerification: 'preferred',
    allowCredentials: cles.map((c) => ({
      id: c.credential_id.toString('base64url'), ...(c.transports ? { transports: c.transports } : {}),
    })),
  });
}

export type ResultatPreuve = { ok: true; methode: string; clonee?: undefined } | { ok: false; clonee?: boolean };

/**
 * Vérifie une réponse de clé pour ce compte et met à jour son compteur. Une clé dont le compteur
 * recule est probablement clonée : refus, et le signale à l'appelant (mail d'alerte).
 */
/** Clés acceptées pour l'administration (ARGOS_PASSKEYS_ADMIN : identifiants séparés par des virgules, lus à chaque
 *  vérification). Vide : toute clé du super-administrateur en développement seulement ; en production, aucune (M12). */
export function cleAdminAutorisee(id: string, env = process.env): boolean {
  const liste = (env['ARGOS_PASSKEYS_ADMIN'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (liste.length === 0) return env['NODE_ENV'] !== 'production';
  return liste.includes(id);
}

export async function verifierPreuve(deps: Dependances, compteId: string, reponse: AuthenticationResponseJSON,
                                     defi: string, o: { admin?: boolean } = {}): Promise<ResultatPreuve> {
  // Administration : seulement la ou les clés physiques déclarées sur le serveur, jamais une clé ajoutée au compte.
  if (o.admin && !cleAdminAutorisee(reponse.id)) return { ok: false };
  const cle = (await clesActives(deps, compteId)).find((c) => c.credential_id.toString('base64url') === reponse.id);
  if (!cle) return { ok: false };   // clé inconnue ou appartenant à un autre compte
  const { origine, rpID } = site(deps);
  try {
    const v = await verifyAuthenticationResponse({
      response: reponse, expectedChallenge: defi, expectedOrigin: origine, expectedRPID: rpID, requireUserVerification: false,
      credential: { id: reponse.id, publicKey: new Uint8Array(cle.public_key), counter: Number(cle.sign_count ?? 0) },
    });
    if (!v.verified) return { ok: false };
    await deps.bases.app.query('UPDATE core.mfa_factors SET sign_count = $2, last_used_at = now() WHERE id = $1',
                               [cle.id, v.authenticationInfo.newCounter]);
    return { ok: true, methode: cle.id };
  } catch (e) {
    return { ok: false, clonee: /counter/i.test(String((e as Error).message)) };
  }
}

/** Schéma JSON d'une réponse de clé (taille bornée ; le navigateur peut ajouter des champs). */
export const SCHEMA_REPONSE_CLE = {
  type: 'object', required: ['id', 'rawId', 'type', 'response'],
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,1400}$' },
    rawId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,1400}$' },
    type: { const: 'public-key' },
    response: { type: 'object', maxProperties: 12 },
    clientExtensionResults: { type: 'object', maxProperties: 12 },
    authenticatorAttachment: { type: 'string', maxLength: 30 },
  },
  maxProperties: 8,
} as const;
