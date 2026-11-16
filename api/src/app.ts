// Construction de l'application Fastify, sans démarrer le serveur (les tests l'appellent directement).
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { enregistrerConnexion } from './connexion.ts';
import type { Cles } from './crypto.ts';
import type { Bases } from './db.ts';
import { enregistrerEnvois } from './envois.ts';
import type { Stockage } from './stockage.ts';
import { enregistrerSuivi } from './suivi.ts';
import { enregistrerMessagerie } from './messagerie.ts';
import { enregistrerRelecture } from './relecture.ts';
import { enregistrerAdmin } from './admin.ts';
import { enregistrerOsint } from './osint.ts';
import { enregistrerBugs } from './bugs.ts';
import { enregistrerPublic } from './public.ts';
import { enregistrerAdministration, enregistrerSignalements } from './administration.ts';
import { enregistrerMessages } from './messages.ts';
import { enregistrerV1 } from './v1.ts';
import { enregistrerConditions } from './conditions.ts';
import { enregistrerMesVideos } from './mesvideos.ts';
import { enregistrerTransmission } from './transmission.ts';
import { enregistrerBeta } from './beta.ts';
import { enregistrerCopieExterne } from './copie-externe.ts';
import type { Facteur } from './facteur.ts';
import { enregistrerInscription } from './inscription.ts';
import { enregistrerMfa } from './mfa.ts';
import { enregistrerAdresse } from './adresse.ts';
import { enregistrerContact } from './contact.ts';
import { enregistrerRecuperation } from './recuperation.ts';
import type { Listes } from './listes.ts';
import type { Turnstile } from './turnstile.ts';

export interface Dependances {
  bases: Bases;
  redis: Redis;
  cles: Cles;
  facteur: Facteur;
  turnstile: Turnstile;
  listes: Listes;
  stockage: Stockage;
  // boiteDev : dossier du faux facteur local, exposé par GET /dev/boite (développement seulement)
  reglages: { urlPublique: string; smsPlafondJour: number; envoisParHeure: number; envoisParIpHeure?: number; envoisCertifiesParHeure?: number; boiteDev?: string;
              // Faux sur l'instance publique en production : les routes /admin/* n'y existent pas (404) ;
              // elles ne sont servies que par l'instance d'administration, joignable seulement par WireGuard.
              administration?: boolean;
              deuxFacteursFactice?: boolean;   // développement seulement : « 000000 » accepté (config.ts le refuse en production)
              origine?: string;      // origine acceptée des requêtes (défaut : urlPublique)
              proxyLocal?: boolean;  // derrière cloudflared : adresse du visiteur dans X-Forwarded-For, boucle locale seulement
              surSocket?: boolean;   // API d'administration sur un socket Unix (seul Caddy peut s'y connecter)
              prefixeApi?: string;   // « /api » en production
              // Clés publiques d'administration (points P-256 non compressés, base64) : la source peut autoriser
              // la transmission de l'original (enveloppe). Vide : l'option n'est pas proposée.
              clesAdmin?: string[];
              beta?: boolean;
              copieExterne?: string };   // secret du signal de la copie tirée par le serveur de copie (B13), instance publique       // accès réservé aux codes bêta (instance publique, avant l'ouverture)
}

/** Retire le préfixe « /api » d'une adresse (production). */
export function retirerPrefixe(url: string, prefixe: string): string {
  if (!prefixe) return url;
  if (url === prefixe) return '/';
  return url.startsWith(`${prefixe}/`) || url.startsWith(`${prefixe}?`) ? url.slice(prefixe.length) : url;
}

/** Appel interne du serveur du site (aperçus de partage) : boucle locale, sans passer par le tunnel. */
export function appelInterne(deps: Dependances, req: FastifyRequest): boolean {
  if (!deps.reglages.proxyLocal) return false;
  const a = req.socket.remoteAddress ?? '';
  return (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1')
    && req.headers['x-forwarded-for'] === undefined && req.headers['cf-connecting-ip'] === undefined;
}

export interface Options {
  journal?: boolean | { stream: NodeJS.WritableStream };  // journal des requêtes (désactivé dans les tests)
}

export function construireApp(deps: Dependances, options: Options = {}): FastifyInstance {
  const app = Fastify({
    // Numéro de requête aléatoire, renvoyé dans l'en-tête x-argos-requete : un rapport de bug le
    // joint, et le journal des erreurs le garde (14 jours). Jamais repris d'un en-tête du client.
    genReqId: () => randomUUID(),
    // Derrière le tunnel Cloudflare, toutes les connexions viennent de cloudflared (boucle locale) : l'adresse
    // du visiteur est alors la dernière de X-Forwarded-For. Un en-tête venu d'ailleurs n'est jamais cru.
    // Sur un socket Unix (administration, 15 novembre) : pas d'adresse de connexion ; le seul client possible est Caddy
    // (droits du dossier du socket), dont X-Forwarded-For donne l'adresse WireGuard. Sans cela, req.ip était vide et
    // les limites par adresse plantaient (carte et journal en erreur 500 dans l'administration).
    // Seule l'entrée posée par Caddy (rang 0, la plus proche) est crue, jamais une adresse glissée par le client avant.
    trustProxy: deps.reglages.surSocket ? (_adresse: string, rang: number) => rang === 0
      : deps.reglages.proxyLocal ? ['127.0.0.1', '::1'] : false,
    // Production : le tunnel envoie /api/… à l'API, qui retire le préfixe (comme le serveur de dev).
    rewriteUrl: (r: IncomingMessage) => retirerPrefixe(r.url ?? '/', deps.reglages.prefixeApi ?? ''),
    requestIdHeader: false,
    bodyLimit: 64 * 1024,  // l'API ne reçoit que du JSON ; les vidéos passeront par un autre chemin
    // Un champ inconnu est refusé (400), pas retiré en silence ; aucune conversion de type implicite.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    // Erreurs du routeur (adresse mal encodée, paramètre trop long) : par défaut, Fastify recopie
    // l'adresse dans la réponse. Réponse neutre à la place, comme pour toutes les autres erreurs.
    frameworkErrors: (err, _req, rep) => {
      const reply = rep as unknown as FastifyReply;
      if (err.code === 'FST_ERR_MAX_PARAM_LENGTH') return reply.code(414).send({ erreur: 'adresse_trop_longue' });
      return reply.code(400).send({ erreur: 'requete_invalide' });
    },
    // Le journal ne garde ni l'adresse IP, ni l'URL complète (un lien de vérification contient un jeton),
    // ni les en-têtes (cookies de session), ni le corps des requêtes. Les seules données de connexion
    // conservées sont celles imposées par la loi, dans identity.legal_connection_logs.
    logger: options.journal
      ? {
          ...(typeof options.journal === 'object' ? { stream: options.journal.stream } : {}),
          serializers: {
            req: (req) => ({ method: req.method, route: req.routeOptions?.url ?? 'inconnue' }),
            res: (res) => ({ statusCode: res.statusCode }),
          },
        }
      : false,
  });

  app.decorate('deps', deps);

  // Seul le JSON est accepté. Fastify lit aussi le texte brut par défaut : c'est le format qu'un
  // formulaire d'un autre site peut envoyer sans vérification préalable du navigateur, on le retire.
  app.removeContentTypeParser('text/plain');

  // En-têtes de sécurité sur toutes les réponses. L'API ne sert que du JSON : aucun contenu actif,
  // aucun affichage dans un cadre, aucune mise en cache, aucune adresse transmise aux autres sites.
  app.addHook('onSend', async (_req, reply) => {
    reply.headers({
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
      'cache-control': 'no-store',
      'x-argos-requete': String(_req.id),
    });
  });

  // Erreurs : jamais de détail technique dans la réponse (message PostgreSQL, pile d'appels…).
  // Une requête mal formée reçoit « requete_invalide », une panne « erreur_interne » (détail au journal).
  app.setErrorHandler((err: { statusCode?: number; code?: string }, req, reply) => {
    const code = err.statusCode ?? 500;
    if (code >= 500) {
      req.log.error({ err }, 'erreur interne');
      // Gardée 14 jours avec son numéro de requête, sans IP ni contenu : un rapport de bug y renvoie.
      const e = err as Error;
      deps.bases.app.query(
        `INSERT INTO core.request_errors (request_id, method, route, status, error_name, message, stack)
         VALUES ($1, $2, $3, 500, $4, $5, $6)`,
        [req.id, req.method.slice(0, 10), (req.routeOptions?.url ?? 'inconnue').slice(0, 200),
         String(e.name ?? '').slice(0, 200), String(e.message ?? '').slice(0, 2000), String(e.stack ?? '').slice(0, 20000)])
        .catch((x: unknown) => req.log.error({ err: x }, "échec de l'enregistrement de l'erreur"));
      return reply.code(500).send({ erreur: 'erreur_interne' });
    }
    if (code === 413) return reply.code(413).send({ erreur: 'trop_volumineux' });
    if (code === 415) return reply.code(415).send({ erreur: 'format_non_accepte' });
    return reply.code(code >= 400 && code < 500 ? code : 400).send({ erreur: 'requete_invalide' });
  });

  // Contre les requêtes forgées depuis un autre site (en plus du cookie SameSite=Strict et du JSON
  // obligatoire) : une requête qui modifie quelque chose et annonce une autre origine est refusée.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (req.url === '/acces-beta') return;   // formulaire de la page d'attente : vérification propre (beta.ts)
    const origine = req.headers.origin;
    if (origine !== undefined && origine !== (deps.reglages.origine ?? deps.reglages.urlPublique)) {
      return reply.code(403).send({ erreur: 'origine_refusee' });
    }
  });

  // Adresse inconnue : réponse neutre, sans recopier l'URL (ni dans la réponse, ni dans le journal).
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ erreur: 'introuvable' }));

  // État du service : vérifie l'accès à la base (avec chaque rôle) et à Redis.
  // Ne renvoie aucun détail technique en cas d'erreur.
  app.get('/sante', async (_req, reply) => {
    const verifs = await Promise.allSettled([
      deps.bases.app.query('SELECT 1'),
      deps.bases.identity.query('SELECT 1'),
      deps.redis.ping(),
    ]);
    const ok = verifs.every((v) => v.status === 'fulfilled');
    for (const v of verifs) {
      if (v.status === 'rejected') app.log.error({ err: v.reason }, 'vérification de santé en échec');
    }
    return reply.code(ok ? 200 : 503).send({ ok });
  });

  enregistrerBeta(app, deps);   // en premier : son contrôle d'accès s'applique à toutes les routes
  enregistrerInscription(app, deps);
  enregistrerConnexion(app, deps);
  enregistrerRecuperation(app, deps);
  enregistrerContact(app, deps);
  enregistrerAdresse(app, deps);
  enregistrerMfa(app, deps);
  enregistrerEnvois(app, deps);
  enregistrerSuivi(app, deps);
  enregistrerRelecture(app, deps);
  const administration = deps.reglages.administration !== false;
  if (administration) enregistrerAdmin(app, deps);
  enregistrerOsint(app, deps);
  enregistrerBugs(app, deps);
  enregistrerPublic(app, deps);
  if (administration) enregistrerAdministration(app, deps);
  enregistrerSignalements(app, deps);
  if (!administration) enregistrerCopieExterne(app, deps);
  enregistrerMessages(app, deps);
  enregistrerV1(app, deps);
  enregistrerConditions(app, deps);
  enregistrerMesVideos(app, deps);
  enregistrerTransmission(app, deps);
  enregistrerMessagerie(app, deps);

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Dependances;
  }
}
