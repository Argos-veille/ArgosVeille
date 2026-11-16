// Gestion de la double authentification par le relecteur connecté (étape 4e-1 : application TOTP).
//   GET  /2fa                  méthodes actives
//   POST /2fa/totp/debut       mot de passe → secret et lien otpauth:// (à afficher en QR code)
//   POST /2fa/totp/confirmer   premier code de l'application (+ nom facultatif) → méthode activée
//   POST /2fa/cle/debut        mot de passe → options d'enregistrement d'une clé de sécurité ou passkey
//   POST /2fa/cle/confirmer    réponse de la clé (+ nom facultatif) → clé enregistrée
//   POST /2fa/cle/defi         défi pour prouver la possession d'une clé (avant un retrait)
//   POST /2fa/retirer          méthode + mot de passe + code (TOTP, code de secours) ou clé → méthode retirée
//   POST /compte/fermer        mot de passe (+ code ou clé si une double authentification est active) → compte fermé,
//                              effacé dans 30 jours sauf reconnexion (0043)
import type { FastifyInstance } from 'fastify';
import type { Dependances } from './app.ts';
import { oublierConfiance } from './appareils.ts';
import { utiliserCode } from './codes.ts';
import { alerter, doubleAuthObligatoire, ecrire, facteursActifs, verifierMdpConnecte } from './compte.ts';
import { effacerCookie } from './sessions.ts';
import { codeArgos } from './schemas.ts';
import { chiffrerAvec, dechiffrerAvec } from './crypto.ts';
import { texte } from './schemas.ts';
import { deBase32, lienOtpauth, nouveauSecret, verifierTotp } from './totp.ts';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { optionsEnregistrement, optionsPreuve, SCHEMA_REPONSE_CLE, verifierEnregistrement, verifierPreuve } from './webauthn.ts';

const DUREE_ACTIVATION = 10 * 60;
const DUREE_DEFI = 5 * 60;
const cleActivation = (compteId: string) => `totp-activation:${compteId}`;
const cleDefiEnregistrement = (compteId: string) => `cle-activation:${compteId}`;
const cleDefiPreuve = (compteId: string) => `cle-preuve:${compteId}`;

/** Action grave (fermer son compte, retirer une vidéo depuis son compte) : mot de passe, plus le second
 *  facteur si une double authentification est active (code d'application, code de secours ou clé).
 *  Renvoie null si tout est bon, sinon le refus à renvoyer. */
export async function verifierIdentite(app: FastifyInstance, deps: Dependances, compteId: string,
                                       corps: { motDePasse: string; code?: string; cle?: AuthenticationResponseJSON })
  : Promise<{ statut: number; erreur: string } | null> {
  const v = await verifierMdpConnecte(deps, compteId, corps.motDePasse);
  if (v === 'bloque') return { statut: 429, erreur: 'trop_de_demandes' };
  if (v === 'faux') return { statut: 401, erreur: 'mot_de_passe_incorrect' };
  if (!(await facteursActifs(deps, compteId)).length) return null;
  if ((corps.code === undefined) === (corps.cle === undefined)) return { statut: 400, erreur: 'second_facteur_requis' };
  let ok: boolean;
  if (corps.cle) {
    const defi = await deps.redis.getdel(cleDefiPreuve(compteId));
    ok = defi !== null && (await verifierPreuve(deps, compteId, corps.cle, defi)).ok;
  } else {
    const code = corps.code!.trim();
    ok = /^\d{6}$/.test(code) ? (await app.verifierCodeTotp(compteId, code)) !== null : await utiliserCode(deps.bases, deps.cles, compteId, code);
  }
  return ok ? null : { statut: 401, erreur: 'code_invalide' };
}

export function enregistrerMfa(app: FastifyInstance, deps: Dependances): void {
  const { bases, redis, cles } = deps;
  const session = { preHandler: app.exigerSession };

  app.get('/2fa', session, async (req, reply) => {
    const r = await bases.app.query<{ id: string; kind: string; label: string | null; created_at: Date; last_used_at: Date | null }>(
      `SELECT id, kind, label, created_at, last_used_at FROM core.mfa_factors
        WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at`, [req.compte!.id]);
    return reply.send({
      methodes: r.rows.map((f) => ({
        id: f.id, type: f.kind, nom: f.label, ajouteeLe: f.created_at.toISOString(),
        derniereUtilisation: f.last_used_at?.toISOString() ?? null,
      })),
    });
  });

  app.post<{ Body: { motDePasse: string } }>('/2fa/totp/debut', {
    ...session,
    schema: { body: { type: 'object', additionalProperties: false, required: ['motDePasse'], properties: { motDePasse: texte(512) } } },
  }, async (req, reply) => {
    const compte = req.compte!;
    const v = await verifierMdpConnecte(deps, compte.id, req.body.motDePasse);
    if (v === 'bloque') return reply.code(429).send({ erreur: 'trop_de_demandes' });
    if (v === 'faux') return reply.code(401).send({ erreur: 'mot_de_passe_incorrect' });
    if ((await facteursActifs(deps, compte.id)).some((f) => f.kind === 'totp')) {
      return reply.code(409).send({ erreur: 'deja_active' });
    }
    const secret = nouveauSecret();
    // Le secret attend la confirmation dans Redis, chiffré, 10 minutes au plus.
    await redis.set(cleActivation(compte.id), chiffrerAvec(cles.mfa, secret).toString('base64'), 'EX', DUREE_ACTIVATION);
    return reply.send({ secret, lien: lienOtpauth(secret, compte.pseudo), expireDans: DUREE_ACTIVATION });
  });

  app.post<{ Body: { code: string; nom?: string } }>('/2fa/totp/confirmer', {
    ...session,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['code'],
        properties: { code: { type: 'string', pattern: '^[0-9]{6}$' }, nom: texte(40) },
      },
    },
  }, async (req, reply) => {
    const compte = req.compte!;
    const enAttente = await redis.get(cleActivation(compte.id));
    if (!enAttente) return reply.code(410).send({ erreur: 'activation_expiree' });
    const chiffre = Buffer.from(enAttente, 'base64');
    const p = verifierTotp(deBase32(dechiffrerAvec(cles.mfa, chiffre)), req.body.code);
    if (p === null) return reply.code(400).send({ erreur: 'code_invalide' });
    try {
      const r = await bases.app.query<{ id: string }>(
        `INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc, label, last_used_at)
         VALUES ($1, 'totp', $2, $3, now()) RETURNING id`,
        [compte.id, chiffre, req.body.nom?.trim() || null]);
      // Le code qui a servi à confirmer ne pourra pas servir une seconde fois à la connexion.
      await redis.set(`totp-utilise:${r.rows[0]!.id}:${p}`, '1', 'EX', 120);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ erreur: 'deja_active' });
      throw e;
    }
    await redis.del(cleActivation(compte.id));
    await oublierConfiance(deps, compte.id);   // méthodes changées : plus d'appareil de confiance
    await alerter(deps, req.log, compte.id, 'double authentification activée',
      'La double authentification par application a été activée sur votre compte.');
    return reply.code(201).send({ ok: true });
  });

  // --- Clés de sécurité et passkeys (4e-2) -------------------------------------------------

  app.post<{ Body: { motDePasse: string } }>('/2fa/cle/debut', {
    ...session,
    schema: { body: { type: 'object', additionalProperties: false, required: ['motDePasse'], properties: { motDePasse: texte(512) } } },
  }, async (req, reply) => {
    const compte = req.compte!;
    const v = await verifierMdpConnecte(deps, compte.id, req.body.motDePasse);
    if (v === 'bloque') return reply.code(429).send({ erreur: 'trop_de_demandes' });
    if (v === 'faux') return reply.code(401).send({ erreur: 'mot_de_passe_incorrect' });
    const options = await optionsEnregistrement(deps, compte.id, compte.pseudo);
    await redis.set(cleDefiEnregistrement(compte.id), options.challenge, 'EX', DUREE_DEFI);
    return reply.send({ options });
  });

  app.post<{ Body: { reponse: RegistrationResponseJSON; nom?: string } }>('/2fa/cle/confirmer', {
    ...session,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['reponse'],
        properties: { reponse: SCHEMA_REPONSE_CLE, nom: texte(40) },
      },
    },
  }, async (req, reply) => {
    const compte = req.compte!;
    // Le défi ne sert qu'une fois, que la réponse soit bonne ou non.
    const defi = await redis.getdel(cleDefiEnregistrement(compte.id));
    if (!defi) return reply.code(410).send({ erreur: 'activation_expiree' });
    const cle = await verifierEnregistrement(deps, req.body.reponse, defi);
    if (!cle) return reply.code(400).send({ erreur: 'cle_invalide' });
    try {
      await bases.app.query(
        `INSERT INTO core.mfa_factors (account_id, kind, credential_id, public_key, sign_count, transports, label, last_used_at)
         VALUES ($1, 'webauthn', $2, $3, $4, $5, $6, now())`,
        [compte.id, cle.credentialId, cle.clePublique, cle.compteur, cle.transports.length ? cle.transports : null,
         req.body.nom?.trim() || null]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return reply.code(409).send({ erreur: 'deja_enregistree' });
      throw e;
    }
    await oublierConfiance(deps, compte.id);   // méthodes changées : plus d'appareil de confiance
    await alerter(deps, req.log, compte.id, 'clé de sécurité enregistrée',
      'Une clé de sécurité (ou passkey) a été enregistrée sur votre compte.');
    return reply.code(201).send({ ok: true });
  });

  app.post('/2fa/cle/defi', session, async (req, reply) => {
    const options = await optionsPreuve(deps, req.compte!.id);
    if (!options) return reply.code(404).send({ erreur: 'aucune_cle' });
    await redis.set(cleDefiPreuve(req.compte!.id), options.challenge, 'EX', DUREE_DEFI);
    return reply.send({ options });
  });

  app.post<{ Body: { methode: string; motDePasse: string; code?: string; cle?: AuthenticationResponseJSON } }>('/2fa/retirer', {
    ...session,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['methode', 'motDePasse'],
        properties: { methode: { type: 'string', format: 'uuid' }, motDePasse: texte(512), code: texte(20), cle: SCHEMA_REPONSE_CLE },
      },
    },
  }, async (req, reply) => {
    if ((req.body.code === undefined) === (req.body.cle === undefined)) {
      return reply.code(400).send({ erreur: 'requete_invalide' });   // un code OU une clé, pas les deux
    }
    const compte = req.compte!;
    const v = await verifierMdpConnecte(deps, compte.id, req.body.motDePasse);
    if (v === 'bloque') return reply.code(429).send({ erreur: 'trop_de_demandes' });
    if (v === 'faux') return reply.code(401).send({ erreur: 'mot_de_passe_incorrect' });
    const facteurs = await facteursActifs(deps, compte.id);
    if (!facteurs.some((f) => f.id === req.body.methode)) return reply.code(404).send({ erreur: 'introuvable' });
    if (facteurs.length === 1 && (await doubleAuthObligatoire(deps, compte.id))) {
      return reply.code(409).send({ erreur: 'derniere_methode' });
    }

    // Le second facteur prouve que c'est bien le relecteur : code d'application, code de secours ou clé.
    let ok: boolean;
    if (req.body.cle) {
      const defi = await redis.getdel(cleDefiPreuve(compte.id));
      ok = defi !== null && (await verifierPreuve(deps, compte.id, req.body.cle, defi)).ok;
    } else {
      const code = req.body.code!.trim();
      ok = /^\d{6}$/.test(code)
        ? (await app.verifierCodeTotp(compte.id, code)) !== null
        : await utiliserCode(bases, cles, compte.id, code);
    }
    if (!ok) return reply.code(401).send({ erreur: 'code_invalide' });

    await bases.app.query('UPDATE core.mfa_factors SET revoked_at = now() WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL',
                          [req.body.methode, compte.id]);
    await oublierConfiance(deps, compte.id);   // méthodes changées : plus d'appareil de confiance
    await alerter(deps, req.log, compte.id, 'double authentification retirée',
      'Une méthode de double authentification a été retirée de votre compte.');
    return reply.send({ ok: true });
  });

  app.post<{ Body: { motDePasse: string; code?: string; cle?: AuthenticationResponseJSON } }>('/compte/fermer', {
    ...session,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['motDePasse'],
        properties: { motDePasse: texte(512), code: texte(20), cle: SCHEMA_REPONSE_CLE },
      },
    },
  }, async (req, reply) => {
    const compte = req.compte!;
    const refus = await verifierIdentite(app, deps, compte.id, req.body);
    if (refus) return reply.code(refus.statut).send({ erreur: refus.erreur });
    let effaceLe: Date;
    try {
      effaceLe = (await bases.app.query<{ le: Date }>('SELECT core.close_account($1) AS le', [compte.id])).rows[0]!.le;
    } catch (e) {
      const code = codeArgos(e);
      if (code === 'reserve_super_admin' || code === 'compte_inactif') return reply.code(409).send({ erreur: 'fermeture_impossible' });
      throw e;
    }
    // L'adresse mail reste jusqu'à l'effacement : le mail de confirmation part maintenant.
    const le = effaceLe.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
    try {
      await ecrire(deps, compte.id, 'fermeture de votre compte',
        `Votre compte Argos Veille est fermé. Il sera effacé définitivement le ${le}.\n\n`
        + `Vous avez changé d'avis ? Reconnectez-vous avant cette date : la fermeture sera annulée.\n\n`
        + `Si vous n'êtes pas à l'origine de cette fermeture, reconnectez-vous tout de suite, puis changez votre mot de passe.`);
    } catch (e) {
      req.log.error({ err: e }, 'échec du mail de fermeture de compte');
    }
    effacerCookie(reply);
    return reply.send({ ok: true, effaceLe: effaceLe.toISOString() });
  });
}
