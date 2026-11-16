// Accès à la bêta par code (validé le 7 novembre 2026). Actif seulement si ARGOS_BETA=oui, sur l'instance
// publique : toute requête doit alors porter le cookie d'un code valable, sauf la saisie du code
// elle-même et l'état du service. L'instance d'administration (WireGuard) n'est jamais concernée.
//   POST /beta/entrer  { code } → cookie posé sur cet appareil (réutilisable ailleurs avec le même code)
//   GET  /beta/etat    → { acces } (utilisé par le site pour choisir entre la page d'attente et le vrai site)
//   POST /beta/sortir  → cookie effacé
// Codes : 12 signes en trois groupes (ex. K7M2-P9XW-QR4T), alphabet sans 0/O/1/I/L ; la base ne garde
// que leur empreinte HMAC. Le cookie contient le code lui-même (il ne donne que l'accès au site en bêta,
// et se révoque côté administration). Il est lisible par le site (pas HttpOnly) : les appels ANONYMES
// (envoi sans compte, suivi par code) partent sans aucun cookie, pour ne jamais être liés à une session ;
// ils transmettent alors le code bêta seul, dans l'en-tête « argos-beta ».
import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Dependances } from './app.ts';
import { empreinte } from './crypto.ts';
import { consommer } from './limites.ts';
import { lireCookie, lireSession } from './sessions.ts';

export const COOKIE_BETA = '__Host-argos_beta';
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
// Ouvertes même sans code : saisie du code, état du service, et ce qu'il faut pour arriver depuis un lien reçu
// par mail (confirmation d'inscription, nouveau mot de passe) ou se connecter — un compte n'a pu être créé que
// pendant la bêta, avec un code. « /moi » répond « non connecté » sans session (sinon la page rechargerait en boucle).
const LIBRES = new Set(['/beta/entrer', '/beta/etat', '/beta/sortir', '/sante', '/acces-beta', '/moi',
  '/connexion', '/connexion/2fa', '/connexion/2fa/cle', '/inscription/mail',
  '/recuperation/demande', '/recuperation/code', '/recuperation/nouveau-mot-de-passe', '/recuperation/pseudo',
  '/etat/copie-externe']);   // signal du serveur de copie (B13), protégé par son propre secret
const CACHE_MS = 60_000;
const DUREE_MAX = 180 * 86400;   // le cookie est redemandé au plus tard tous les 6 mois

export function nouveauCodeBeta(): string {
  let c = '';
  for (let i = 0; i < 12; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

/** Forme saisie → forme canonique (12 signes), ou null. */
export function normaliserCodeBeta(saisie: string): string | null {
  const c = saisie.toUpperCase().replace(/[\s-]/g, '');
  return new RegExp(`^[${ALPHABET}]{12}$`).test(c) ? c : null;
}

export const empreinteBeta = (deps: Dependances, code: string) => empreinte(deps.cles, 'beta', code);

function poserCookie(reply: FastifyReply, code: string, secondes: number) {
  // SameSite=Lax (et non Strict) : un lien reçu par mail (confirmation d'inscription…) doit ouvrir le site.
  const cookie = `${COOKIE_BETA}=${code}; Path=/; Secure; SameSite=Lax; Max-Age=${secondes}`;
  const deja = reply.getHeader('set-cookie');
  const liste = deja === undefined ? [] : Array.isArray(deja) ? deja.map(String) : [String(deja)];
  reply.header('set-cookie', [...liste, cookie]);
}

export function enregistrerBeta(app: FastifyInstance, deps: Dependances): void {
  const { bases, redis } = deps;
  // Cache court : un code révoqué cesse de marcher en une minute au plus.
  const cache = new Map<string, { valable: boolean; jusqua: number }>();

  async function valable(req: FastifyRequest): Promise<boolean> {
    const entete = req.headers['argos-beta'];
    const code = normaliserCodeBeta(lireCookie(req, COOKIE_BETA) ?? (typeof entete === 'string' ? entete : ''));
    // Être connecté à son compte vaut accès : pas besoin du code sur chaque appareil.
    if (!code) return (await lireSession(bases, req)) !== null;
    const enCache = cache.get(code);
    if (enCache && enCache.jusqua > Date.now()) return enCache.valable;
    const r = await bases.app.query<{ fin: Date | number | null }>('SELECT core.beta_code_valid($1) AS fin', [empreinteBeta(deps, code)]);
    const ok = r.rows[0]!.fin !== null || (await lireSession(bases, req)) !== null;
    if (cache.size > 10_000) cache.clear();
    cache.set(code, { valable: ok, jusqua: Date.now() + CACHE_MS });
    return ok;
  }

  if (deps.reglages.beta && !deps.reglages.administration) {
    app.addHook('onRequest', async (req, reply) => {
      const chemin = req.url.split('?')[0]!;
      if (LIBRES.has(chemin)) return;
      if (!(await valable(req))) return reply.code(403).send({ erreur: 'acces_beta' });
    });
  } else if (!deps.reglages.beta) {
    // Site ouvert (audit du 15 novembre 2026, M13) : le code d'accès personnel d'un testeur ne doit plus partir avec ses
    // envois anonymes (Cloudflare le verrait à côté de l'envoi). Le cookie est effacé dès la première réponse.
    app.addHook('onRequest', async (req, reply) => {
      if (lireCookie(req, COOKIE_BETA) !== undefined) poserCookie(reply, '', 0);
    });
  }

  app.get('/beta/etat', async (req) => ({ acces: !deps.reglages.beta || (await valable(req)) }));

  app.post<{ Body: { code: string } }>('/beta/entrer', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['code'],
                      properties: { code: { type: 'string', maxLength: 40 } } } },
  }, async (req, reply) => {
    // 10 essais par heure et par adresse : deviner un code (59 bits) est hors de portée.
    if (!(await consommer(redis, `beta:ip:${empreinte(deps.cles, 'ip', req.ip).toString('hex')}`, 10, 3600))) {
      return reply.code(429).send({ erreur: 'trop_de_demandes' });
    }
    const code = normaliserCodeBeta(req.body.code);
    // Sans expiration, la base renvoie « infinity » (Infinity côté Node, et non une date).
    const fin = code ? (await bases.app.query<{ fin: Date | number | null }>('SELECT core.beta_code_enter($1) AS fin',
                                                                    [empreinteBeta(deps, code)])).rows[0]!.fin : null;
    if (!code || !fin) return reply.code(400).send({ erreur: 'code_beta_invalide' });
    const restant = fin instanceof Date && Number.isFinite(fin.getTime()) ? Math.floor((fin.getTime() - Date.now()) / 1000) : DUREE_MAX;
    poserCookie(reply, code, Math.max(60, Math.min(DUREE_MAX, restant)));
    cache.delete(code);
    return reply.send({ ok: true });
  });

  // Formulaire HTML de la page d'attente (sans script), envoyé par le tunnel directement ici (et non au site) :
  // la protection de SvelteKit refuse un formulaire dont l'en-tête Origin vaut « null », ce que fait un
  // navigateur réglé pour ne rien transmettre de la page d'origine (profil Firefox durci). Ici, la preuve
  // que l'envoi vient du site est Sec-Fetch-Site (posé par le navigateur, impossible à falsifier par une page),
  // ou, pour un ancien navigateur, un en-tête Origin égal à l'adresse du site.
  // Succès : retour à l'accueil, cookie posé. Échec : retour à la page d'attente avec le motif dans l'adresse.
  void app.register(async (sous) => {
    sous.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 },
      (_req, corps, fait) => fait(null, Object.fromEntries(new URLSearchParams(String(corps)))));
    sous.post<{ Body: { code?: string } }>('/acces-beta', async (req, reply) => {
      const site = req.headers['sec-fetch-site'];
      const origine = req.headers.origin;
      const duSite = site !== undefined ? site === 'same-origin' : origine === (deps.reglages.origine ?? deps.reglages.urlPublique);
      if (!duSite) return reply.code(403).type('text/plain; charset=utf-8').send('Formulaire refusé : il ne vient pas de ce site.');
      const retour = (motif: string) => reply.code(303).header('location', `/?beta=${motif}`).header('cache-control', 'no-store').send();
      if (!(await consommer(redis, `beta:ip:${empreinte(deps.cles, 'ip', req.ip).toString('hex')}`, 10, 3600))) return retour('trop');
      const code = normaliserCodeBeta(String(req.body?.code ?? '').slice(0, 40));
      const fin = code ? (await bases.app.query<{ fin: Date | number | null }>('SELECT core.beta_code_enter($1) AS fin',
                                                                             [empreinteBeta(deps, code)])).rows[0]!.fin : null;
      if (!code || !fin) return retour('invalide');
      const restant = fin instanceof Date && Number.isFinite(fin.getTime()) ? Math.floor((fin.getTime() - Date.now()) / 1000) : DUREE_MAX;
      poserCookie(reply, code, Math.max(60, Math.min(DUREE_MAX, restant)));
      cache.delete(code);
      return reply.code(303).header('location', '/').header('cache-control', 'no-store').send();
    });
  });

  app.post('/beta/sortir', async (_req, reply) => {
    poserCookie(reply, '', 0);
    return reply.send({ ok: true });
  });
}
