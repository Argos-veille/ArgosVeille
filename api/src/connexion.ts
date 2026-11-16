// Connexion des relecteurs, sessions et déconnexion.
//   POST /connexion             pseudo + mot de passe (+ Turnstile après 5 échecs sur ce compte)
//   POST /deconnexion           ferme la session en cours
//   POST /deconnexion/partout   ferme toutes les sessions du compte
//   GET  /compte/sessions       appareils connectés (description approximative, dates)
//   POST /compte/sessions/:id/fermer   fermer l'une d'elles (pas celle en cours : « Se déconnecter »)
//   GET  /moi                   le compte connecté
import { conversationsDesVideos, statutVerifie } from './messagerie.ts';
import { CONDITIONS_VERSION } from './conditions.ts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Dependances } from './app.ts';
import { appareilDeConfiance, CONFIANCE_JOURS, decrireAppareil, noterAppareil, oublierConfiance } from './appareils.ts';
import { codesRestants, utiliserCode } from './codes.ts';
import { alerter, doubleAuthObligatoire, facteursActifs } from './compte.ts';
import { dechiffrerAvec, empreinte, hacherMotDePasse, jeton as nouveauJeton, verifierMotDePasse } from './crypto.ts';
import { deBase32, verifierTotp } from './totp.ts';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { optionsPreuve, SCHEMA_REPONSE_CLE, verifierPreuve } from './webauthn.ts';
import { normaliserPseudo } from './normalisation.ts';
import { texte } from './schemas.ts';
import { compteActif, creerSession, effacerCookie, lireSession, poserCookie, type Compte, INACTIVITE_JOURS } from './sessions.ts';

const ECHECS_AVANT_TURNSTILE = 5;   // par compte, sur 15 minutes
const ECHECS_PAR_IP = 20;           // par heure
const DUREE_ATTENTE_2FA = 5 * 60;   // secondes pour donner le code de double authentification
const ESSAIS_2FA = 5;
// B3 : plafond dur par compte, quelle que soit l'attente ou l'adresse : au-delà, plus aucun essai pendant 24 h.
const ECHECS_2FA_PAR_JOUR = 20;
const cleEchecs2fa = (compteId: string) => `limite:2fa-echec:compte:${compteId}`;

interface Connexion { pseudo: string; motDePasse: string; nouveauSecret?: string; turnstile?: string }

declare module 'fastify' {
  interface FastifyRequest {
    compte: Compte | null;
  }
}

export function enregistrerConnexion(app: FastifyInstance, deps: Dependances): void {
  const { bases, redis, cles, turnstile } = deps;
  const hex = (domaine: string, valeur: string) => empreinte(cles, domaine, valeur).toString('hex');

  // Empreinte factice : un pseudo inconnu coûte le même calcul Argon2 qu'un vrai compte,
  // pour que le temps de réponse ne révèle pas si le pseudo existe.
  const factice = hacherMotDePasse('compte inexistant, empreinte factice');

  app.decorateRequest('compte', null);

  /** À placer en preHandler des routes réservées aux relecteurs connectés. */
  async function exigerSession(req: FastifyRequest, reply: FastifyReply) {
    req.compte = await lireSession(bases, req);
    if (!req.compte) {
      effacerCookie(reply);
      return reply.code(401).send({ erreur: 'non_connecte' });
    }
  }
  app.decorate('exigerSession', exigerSession);

  app.post<{ Body: Connexion }>('/connexion', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['pseudo', 'motDePasse'],
        properties: {
          pseudo: texte(60),
          motDePasse: texte(512),
          // Bascule (0101) : compte encore haché sur le mot de passe lui-même ; le navigateur renvoie alors le mot de
          // passe une dernière fois, avec le secret de connexion qui le remplace.
          nouveauSecret: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
          turnstile: texte(2048),
        },
      },
    },
  }, async (req, reply) => {
    const cleIp = `limite:connexion-echec:ip:${hex('ip', req.ip)}`;
    const cleCompte = `limite:connexion-echec:pseudo:${hex('pseudo', normaliserPseudo(req.body.pseudo).toLowerCase())}`;
    const [echecsIp, echecsCompte] = (await redis.mget(cleIp, cleCompte)).map((v) => Number(v ?? 0));
    if (echecsIp! >= ECHECS_PAR_IP) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    if (echecsCompte! >= ECHECS_AVANT_TURNSTILE
        && !(req.body.turnstile && (await turnstile.verifier(req.body.turnstile)))) {
      return reply.code(400).send({ erreur: 'turnstile_requis' });
    }

    const r = await bases.app.query<{ id: string; username: string; status: string; suspended_until: Date | null; password_hash: string;
                                      password_scheme: number }>(
      `SELECT a.id, a.username, a.status, a.suspended_until, c.password_hash, c.password_scheme
         FROM core.accounts a JOIN core.credentials c ON c.account_id = a.id
        WHERE lower(a.username) = lower($1)`, [normaliserPseudo(req.body.pseudo)]);
    const c = r.rows[0];
    const ok = await verifierMotDePasse(req.body.motDePasse, c?.password_hash ?? (await factice));
    // Compte d'avant le secret de connexion (0101) : le navigateur a envoyé le secret, que le serveur ne peut pas
    // vérifier ; il renverra le mot de passe une dernière fois. Compté comme un échec (audit du 15 novembre 2026, H6) :
    // sinon, essais illimités sur ces comptes. Une connexion normale ne passe ici qu'une fois.
    if (c && c.password_scheme === 0 && !ok && !req.body.nouveauSecret && c.status !== 'deleted') {
      await redis.multi()
        .incr(cleIp).expire(cleIp, 3600, 'NX')
        .incr(cleCompte).expire(cleCompte, 15 * 60, 'NX')
        .exec();
      return reply.code(409).send({ erreur: 'mot_de_passe_a_convertir' });
    }
    if (c && ok && c.password_scheme === 0 && req.body.nouveauSecret) {
      await bases.app.query('UPDATE core.credentials SET password_hash = $2, password_scheme = 1, updated_at = now() WHERE account_id = $1',
                            [c.id, await hacherMotDePasse(req.body.nouveauSecret)]);
    }

    if (!c || !ok || c.status === 'deleted') {
      await redis.multi()
        .incr(cleIp).expire(cleIp, 3600, 'NX')
        .incr(cleCompte).expire(cleCompte, 15 * 60, 'NX')
        .exec();
      return reply.code(401).send({ erreur: 'identifiants_incorrects' });
    }
    // Le statut n'est révélé qu'à qui a le bon mot de passe.
    if (c.status === 'banned') return reply.code(403).send({ erreur: 'compte_banni' });
    // Compte en cours de fermeture (30 jours) : se reconnecter l'annule (terminerConnexion).
    if (c.status !== 'closing' && !compteActif(c.status, c.suspended_until)) {
      return reply.code(403).send({ erreur: 'compte_suspendu', jusquau: c.suspended_until?.toISOString() });
    }

    // Second audit (15 novembre, N3) : le super-administrateur ne se connecte qu'à l'administration. Sur le site public, son
    // mot de passe (qui ouvre aussi la clé de messagerie de l'Administration) serait exposé à un site public compromis.
    if (deps.reglages.administration === false && (await estSuperAdmin(c.id))) {
      return reply.code(403).send({ erreur: 'super_admin_administration_seulement' });
    }

    // Double authentification : le mot de passe est bon, mais la session attend le second facteur.
    const facteurs = await facteursActifs(deps, c.id);
    // Appareil de confiance (« ne pas me redemander pendant 30 jours ») : jamais pour un compte à double authentification
    // obligatoire (super-administrateur, analyste, journaliste, avocat, association : audit du 15 novembre, A1).
    const obligatoire = facteurs.length > 0 && (await doubleAuthObligatoire(deps, c.id));
    const confiance = facteurs.length > 0 && !obligatoire && (await appareilDeConfiance(deps, req, c.id));
    if (facteurs.length && !confiance) {
      const attente = nouveauJeton();
      await redis.multi()
        .hset(cleAttente(attente), { compte: c.id, cleCompte, essais: '0' })
        .expire(cleAttente(attente), DUREE_ATTENTE_2FA)
        .exec();
      const methodes = [...new Set(facteurs.map((f) => f.kind)), 'code_secours'];
      return reply.send({ etape: 'double_authentification', methodes, attente, ...(obligatoire ? { confiancePossible: false } : {}) });
    }

    await redis.del(cleCompte);
    return terminerConnexion(req, reply, c.id, c.username);
  });

  const cleAttente = (attente: string) => `connexion-2fa:${hex('attente-2fa', attente)}`;

  const estSuperAdmin = async (compteId: string) =>
    !!(await bases.app.query('SELECT 1 FROM core.accounts WHERE id = $1 AND is_superadmin', [compteId])).rowCount;

  /** Ouvre la session : cookie, journal légal, appareil connu ou alerte. */
  async function terminerConnexion(req: FastifyRequest, reply: FastifyReply, compteId: string, pseudo: string, plus: object = {},
                                   faireConfiance = false) {
    if (deps.reglages.administration === false && (await estSuperAdmin(compteId))) {
      return reply.code(403).send({ erreur: 'super_admin_administration_seulement' });   // N3, quel que soit le chemin
    }
    // Reconnexion pendant le délai de grâce : la fermeture du compte est annulée.
    const rouvert = (await bases.app.query<{ ok: boolean }>('SELECT core.reopen_account($1) AS ok', [compteId])).rows[0]!.ok;
    if (rouvert) {
      await alerter(deps, req.log, compteId, 'fermeture annulée',
        'Vous vous êtes reconnecté : la fermeture de votre compte est annulée et votre compte reste actif.');
      plus = { ...plus, fermetureAnnulee: true };
    }
    const jeton = await creerSession(bases, compteId, decrireAppareil(req.headers['user-agent']));
    // Journal légal (décret 2021-1362), par le rôle d'identité qui l'écrit sans pouvoir le relire.
    await bases.identity.query(
      "SELECT identity.log_legal($1, 'login', $2, $3, NULL)",
      [compteId, req.ip, req.socket.remotePort ?? null]);
    poserCookie(reply, jeton);
    const appareil = await noterAppareil(deps, req, reply, req.log, compteId);
    if (faireConfiance && !(await doubleAuthObligatoire(deps, compteId))) {
      await bases.app.query(
        `UPDATE core.known_devices SET mfa_trusted_until = now() + make_interval(days => $3) WHERE account_id = $1 AND device_hash = $2`,
        [compteId, appareil, CONFIANCE_JOURS]);
      plus = { ...plus, appareilDeConfiance: true };
    }
    return reply.send({ pseudo, ...plus });
  }

  /**
   * Vérifie un code TOTP d'un compte, en refusant de rejouer un code déjà accepté pendant sa
   * période de validité. Renvoie l'identifiant de la méthode reconnue, ou null.
   */
  async function verifierCodeTotp(compteId: string, code: string): Promise<string | null> {
    for (const f of await facteursActifs(deps, compteId)) {
      if (f.kind !== 'totp' || !f.totp_secret_enc) continue;
      const p = verifierTotp(deBase32(dechiffrerAvec(cles.mfa, f.totp_secret_enc)), code);
      if (p === null) continue;
      if ((await redis.set(`totp-utilise:${f.id}:${p}`, '1', 'EX', 120, 'NX')) !== 'OK') return null;   // déjà utilisé
      await bases.app.query('UPDATE core.mfa_factors SET last_used_at = now() WHERE id = $1', [f.id]);
      return f.id;
    }
    return null;
  }
  app.decorate('verifierCodeTotp', verifierCodeTotp);

  const ATTENTE = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };

  // Défi pour se connecter avec une clé de sécurité ou une passkey (gardé dans l'attente, usage unique).
  app.post<{ Body: { attente: string } }>('/connexion/2fa/cle', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['attente'], properties: { attente: ATTENTE } } },
  }, async (req, reply) => {
    const cle = cleAttente(req.body.attente);
    const compteId = await redis.hget(cle, 'compte');
    if (!compteId) return reply.code(410).send({ erreur: 'attente_expiree' });
    const options = await optionsPreuve(deps, compteId);
    if (!options) return reply.code(404).send({ erreur: 'aucune_cle' });
    await redis.hset(cle, 'defi', options.challenge);
    return reply.send({ options });
  });

  app.post<{ Body: { attente: string; code?: string; cle?: AuthenticationResponseJSON; seSouvenir?: boolean } }>('/connexion/2fa', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['attente'],
        properties: { attente: ATTENTE, code: texte(20), cle: SCHEMA_REPONSE_CLE, seSouvenir: { type: 'boolean' } },
      },
    },
  }, async (req, reply) => {
    if ((req.body.code === undefined) === (req.body.cle === undefined)) {
      return reply.code(400).send({ erreur: 'requete_invalide' });   // un code OU une clé, pas les deux
    }
    const cle = cleAttente(req.body.attente);
    const a = await redis.hgetall(cle);
    if (!a['compte']) return reply.code(410).send({ erreur: 'attente_expiree' });
    const compteId = a['compte'];
    if (Number((await redis.get(cleEchecs2fa(compteId))) ?? 0) >= ECHECS_2FA_PAR_JOUR) {
      return reply.code(429).send({ erreur: 'trop_de_demandes' });
    }

    let ok = false;
    let parCodeSecours = false;
    if (req.body.cle) {
      // Clé de sécurité : le défi ne sert qu'une fois, réussite ou échec.
      await redis.hdel(cle, 'defi');
      if (a['defi']) {
        const r = await verifierPreuve(deps, compteId, req.body.cle, a['defi']);
        ok = r.ok;
        if (r.clonee) {
          await alerter(deps, req.log, compteId, 'vérification d’une clé de sécurité',
            'Une connexion à votre compte a été refusée : une clé de sécurité enregistrée sur votre compte a donné une '
            + 'réponse inattendue. Par précaution, retirez cette clé dans « Mon compte » et enregistrez-en une nouvelle.');
        }
      }
    } else {
      // Code à 6 chiffres : application d'authentification ; sinon : code de secours.
      const code = req.body.code!.trim();
      if (deps.reglages.deuxFacteursFactice && code === '000000') ok = true;   // développement seulement (config.ts)
      else if (/^\d{6}$/.test(code)) ok = (await verifierCodeTotp(compteId, code)) !== null;
      else ok = parCodeSecours = await utiliserCode(bases, cles, compteId, code);
    }
    if (!ok) {
      const essais = await redis.hincrby(cle, 'essais', 1);
      await redis.multi().incr(a['cleCompte']!).expire(a['cleCompte']!, 15 * 60, 'NX').exec();
      const [[, echecs]] = (await redis.multi().incr(cleEchecs2fa(compteId)).expire(cleEchecs2fa(compteId), 24 * 3600, 'NX').exec())! as [[null, number]];
      if (echecs === ECHECS_2FA_PAR_JOUR) {
        // Le mot de passe est connu de quelqu'un d'autre : la personne est prévenue (une seule fois par jour).
        await alerter(deps, req.log, compteId, 'tentatives de connexion bloquées',
          'Quelqu’un qui connaît votre mot de passe a échoué de nombreuses fois à la double authentification. Les essais '
            + 'sont bloqués pendant 24 heures. Changez votre mot de passe dans « Mon compte » dès que possible.');
      }
      if (essais >= ESSAIS_2FA) {
        await redis.del(cle);
        return reply.code(410).send({ erreur: 'trop_d_essais' });
      }
      return reply.code(401).send({ erreur: 'code_invalide', essaisRestants: ESSAIS_2FA - essais });
    }
    // Une seule session par attente, même si deux codes arrivent en même temps.
    if ((await redis.del(cle)) === 0) return reply.code(410).send({ erreur: 'attente_expiree' });

    // Le compte a pu être banni ou suspendu pendant ces quelques minutes.
    const r = await bases.app.query<{ username: string; status: string; suspended_until: Date | null }>(
      'SELECT username, status, suspended_until FROM core.accounts WHERE id = $1', [compteId]);
    const c = r.rows[0];
    if (!c || (c.status !== 'closing' && !compteActif(c.status, c.suspended_until))) return reply.code(403).send({ erreur: 'compte_inactif' });

    await redis.del(a['cleCompte']!);
    return terminerConnexion(req, reply, compteId, c.username,
      parCodeSecours ? { codeSecoursUtilise: true, codesSecoursRestants: await codesRestants(bases, compteId) } : {},
      req.body.seSouvenir === true);
  });

  app.post('/deconnexion', { preHandler: exigerSession }, async (req, reply) => {
    await bases.app.query('UPDATE core.sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
                          [req.compte!.sessionId]);
    effacerCookie(reply);
    return reply.send({ ok: true });
  });

  app.post('/deconnexion/partout', { preHandler: exigerSession }, async (req, reply) => {
    const r = await bases.app.query(
      'UPDATE core.sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL', [req.compte!.id]);
    await oublierConfiance(deps, req.compte!.id);
    effacerCookie(reply);
    return reply.send({ sessionsFermees: r.rowCount });
  });

  app.get('/compte/sessions', { preHandler: exigerSession }, async (req, reply) => {
    const r = await bases.app.query<{ id: string; device_label: string | null; created_at: Date; last_seen_at: Date }>(
      `SELECT id, device_label, created_at, last_seen_at FROM core.sessions
        WHERE account_id = $1 AND revoked_at IS NULL AND expires_at > now()
          AND last_seen_at > now() - make_interval(days => $2)
        ORDER BY last_seen_at DESC LIMIT 50`, [req.compte!.id, INACTIVITE_JOURS]);
    return reply.send({ sessions: r.rows.map((s) => ({
      id: s.id, appareil: s.device_label ?? 'Appareil inconnu', connecteLe: s.created_at.toISOString(),
      derniereActivite: s.last_seen_at.toISOString(), actuelle: s.id === req.compte!.sessionId,
    })) });
  });

  app.post<{ Params: { id: string } }>('/compte/sessions/:id/fermer', {
    preHandler: exigerSession,
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req, reply) => {
    if (req.params.id === req.compte!.sessionId) return reply.code(409).send({ erreur: 'session_en_cours' });
    const r = await bases.app.query('UPDATE core.sessions SET revoked_at = now() WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL',
                                    [req.params.id, req.compte!.id]);
    return r.rowCount ? reply.send({ ok: true }) : reply.code(404).send({ erreur: 'introuvable' });
  });

  app.get('/moi', { preHandler: exigerSession }, async (req, reply) => {
    const r = await bases.app.query<{ username: string; created_at: Date; is_superadmin: boolean; terms_version: string | null;
                                       review_opt_out: boolean; certified: boolean }>(
      'SELECT username, created_at, is_superadmin, terms_version, review_opt_out, certified FROM core.accounts WHERE id = $1', [req.compte!.id]);
    return reply.send({
      pseudo: r.rows[0]!.username,
      inscritLe: r.rows[0]!.created_at.toISOString(),
      codesSecoursRestants: await codesRestants(bases, req.compte!.id),
      doubleAuthentification: (await facteursActifs(deps, req.compte!.id)).map((f) => f.kind),
      analysteOsint: (await bases.app.query<{ ok: boolean }>('SELECT core.is_osint_analyst($1) AS ok', [req.compte!.id]))
        .rows[0]!.ok,
      ...(r.rows[0]!.is_superadmin ? { superAdmin: true } : {}),   // absent pour tous les autres comptes
      // Version des conditions à (re)accepter, si le compte n'a pas accepté celle en vigueur.
      convocations: !r.rows[0]!.review_opt_out,   // false = « ne pas me convoquer pour relire »
      // Compte certifié par un code de compte spécial, et sa catégorie (journaliste, avocat, association).
      ...(r.rows[0]!.certified ? { certification: (await bases.app.query<{ category: string }>(
        `SELECT category FROM core.verifications WHERE account_id = $1 AND revoked_at IS NULL AND expires_at > now()
            AND category <> 'osint_analyst' ORDER BY verified_at DESC LIMIT 1`, [req.compte!.id])).rows[0]?.category ?? 'trusted' } : {}),
      ...(r.rows[0]!.terms_version !== CONDITIONS_VERSION ? { conditionsAAccepter: CONDITIONS_VERSION } : {}),
      messagesNonLus: (await bases.app.query<{ n: number }>('SELECT core.my_unread_messages($1) AS n', [req.compte!.id])).rows[0]!.n,
      // Messages reçus au sujet des vidéos envoyées avec ce compte (non lus).
      messagesVideosNonLus: (await conversationsDesVideos(deps, req.compte!.session)).reduce((t, v) => t + v.nonLus, 0),
      // Messagerie avec les sources : comptes vérifiés (journaliste, avocat, association) et super-admin.
      ...(await (async () => {
        const statut = r.rows[0]!.is_superadmin ? 'admin' : await statutVerifie(deps, req.compte!.id);
        if (!statut) return {};
        const n = (await bases.app.query<{ n: number }>('SELECT core.my_unread_source_messages($1) AS n', [req.compte!.id])).rows[0]!.n;
        return { messagerieSources: { statut, nonLus: n } };
      })()),
    });
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    exigerSession: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    verifierCodeTotp: (compteId: string, code: string) => Promise<string | null>;
  }
}
