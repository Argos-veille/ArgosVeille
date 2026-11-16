// Accès à la bêta par code : tout est fermé sans code valable ; un code par personne, réutilisable,
// expirable, révocable depuis l'administration.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { COOKIE_BETA, normaliserCodeBeta, nouveauCodeBeta } from '../src/beta.ts';
import { genererCodes } from '../src/codes.ts';
import { chiffrer, hacherMotDePasse } from '../src/crypto.ts';
import { dependances, preparer, proprietaire } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

test('format des codes : 12 signes sans caractères ambigus, saisie tolérante', () => {
  const c = nouveauCodeBeta();
  assert.match(c, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(normaliserCodeBeta(` ${c.toLowerCase().replace(/-/g, ' ')} `), c.replace(/-/g, ''));
  assert.equal(normaliserCodeBeta('O0I1-LLLL-AAAA'), null);
});

test('bêta : sans code tout est fermé ; un code créé par l’administration ouvre le site, sur plusieurs appareils ; révoqué, il ne marche plus', async () => {
  const { deps } = dependances(socle);
  deps.reglages.beta = true;
  const app = construireApp(deps);
  // Administrateur (session admin ouverte directement dans Redis, comme dans les autres tests).
  const pseudo = `Beta_${randomInt(10_000_000, 100_000_000)}`;
  const id = (await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse('cheval correct pile agrafe'), randomBytes(32), randomBytes(32), chiffrer(deps.cles, 'b@exemple.fr'),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null])).rows[0]!.id;
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin; UPDATE core.accounts SET is_superadmin = true WHERE id = '${id}'`);

  // Sans code : même la connexion est refusée ; l'état et la saisie du code restent ouverts.
  assert.deepEqual((await app.inject({ method: 'POST', url: '/inscription/debut', payload: {} })).json(), { erreur: 'acces_beta' });
  // Ouvert sans code : la connexion (un compte n'a pu être créé qu'avec un code) et « qui suis-je ».
  assert.notDeepEqual((await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: 'x' } })).json(), { erreur: 'acces_beta' });
  assert.equal((await app.inject({ method: 'GET', url: '/moi' })).statusCode, 401);
  // Connecté à son compte, sans code sur cet appareil : accès.
  const rep = await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: 'cheval correct pile agrafe' } });
  const session = { cookie: String(rep.headers['set-cookie']).split(';')[0]! };
  assert.equal((await app.inject({ method: 'GET', url: '/public/videos', headers: session })).statusCode, 200);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/beta/etat', headers: session })).json(), { acces: true });
  assert.deepEqual((await app.inject({ method: 'GET', url: '/beta/etat' })).json(), { acces: false });
  assert.equal((await app.inject({ method: 'GET', url: '/public/videos' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/sante' })).statusCode, 200);

  // Code créé en base comme le ferait l'administration (la route admin est testée à part).
  const code = nouveauCodeBeta();
  const { empreinteBeta } = await import('../src/beta.ts');
  await bases.app.query('SELECT core.admin_create_beta_code($1, $2, $3, NULL, NULL)', [id, empreinteBeta(deps, normaliserCodeBeta(code)!), 'Testeur']);

  assert.deepEqual((await app.inject({ method: 'POST', url: '/beta/entrer', payload: { code: 'AAAA-BBBB-CCCC' } })).json(), { erreur: 'code_beta_invalide' });
  const entree = await app.inject({ method: 'POST', url: '/beta/entrer', payload: { code: code.toLowerCase() } });
  assert.equal(entree.statusCode, 200);
  const cookie = String(entree.headers['set-cookie']);
  assert.match(cookie, new RegExp(`^${COOKIE_BETA}=[0-9A-Z]{12}; Path=/; Secure; SameSite=Lax; Max-Age=15552000$`));
  // Appel anonyme (sans cookie) : le code passe dans l'en-tête argos-beta.
  assert.equal((await app.inject({ method: 'GET', url: '/public/videos', headers: { 'argos-beta': code } })).statusCode, 200);
  const avec = { cookie: cookie.split(';')[0]! };
  assert.deepEqual((await app.inject({ method: 'GET', url: '/beta/etat', headers: avec })).json(), { acces: true });
  assert.equal((await app.inject({ method: 'GET', url: '/public/videos', headers: avec })).statusCode, 200);
  // Deuxième appareil, même code : accepté aussi, et compté.
  assert.equal((await app.inject({ method: 'POST', url: '/beta/entrer', payload: { code } })).statusCode, 200);
  assert.equal(proprietaire(`SELECT entries FROM core.beta_codes WHERE label = 'Testeur' AND created_by = '${id}'`), '2');

  // Révocation : refusé (nouvelle instance = sans le cache d'une minute).
  proprietaire(`UPDATE core.beta_codes SET revoked_at = now() WHERE created_by = '${id}'`);
  const app2 = construireApp(deps);
  assert.equal((await app2.inject({ method: 'GET', url: '/public/videos', headers: avec })).statusCode, 403);
  assert.deepEqual((await app2.inject({ method: 'POST', url: '/beta/entrer', payload: { code } })).json(), { erreur: 'code_beta_invalide' });
  await app.close(); await app2.close();
});

test('bêta : code expiré refusé ; cookie limité à la date d’expiration ; 10 essais par heure', async () => {
  const { deps } = dependances(socle);
  deps.reglages.beta = true;
  const app = construireApp(deps);
  const { empreinteBeta } = await import('../src/beta.ts');
  const code = nouveauCodeBeta();
  const h = empreinteBeta(deps, normaliserCodeBeta(code)!).toString('hex');
  proprietaire(`INSERT INTO core.beta_codes (code_hmac, label, expires_at) VALUES ('\\x${h}', 'Deux jours', now() + interval '2 days')`);
  const r = await app.inject({ method: 'POST', url: '/beta/entrer', payload: { code } });
  const age = Number(/Max-Age=(\d+)/.exec(String(r.headers['set-cookie']))![1]);
  assert.ok(age > 2 * 86400 - 120 && age <= 2 * 86400, `Max-Age ${age}`);
  proprietaire(`UPDATE core.beta_codes SET expires_at = now() - interval '1 minute' WHERE code_hmac = '\\x${h}'`);
  assert.equal((await app.inject({ method: 'POST', url: '/beta/entrer', payload: { code } })).statusCode, 400);
  for (let i = 0; i < 8; i++) await app.inject({ method: 'POST', url: '/beta/entrer', payload: { code: 'AAAA-BBBB-CCCC' } });
  assert.equal((await app.inject({ method: 'POST', url: '/beta/entrer', payload: { code } })).statusCode, 429);
  await app.close();
});

test('sans ARGOS_BETA : rien n’est fermé', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/beta/etat' })).json(), { acces: true });
  assert.equal((await app.inject({ method: 'GET', url: '/public/videos' })).statusCode, 200);
  await app.close();
});

test('administration : créer (code montré une fois), lister, révoquer', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const pseudo = `BetaAdm_${randomInt(10_000_000, 100_000_000)}`;
  const mdp = 'cheval correct pile agrafe';
  const id = (await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(mdp), randomBytes(32), randomBytes(32), chiffrer(deps.cles, 'c@exemple.fr'),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null])).rows[0]!.id;
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin; UPDATE core.accounts SET is_superadmin = true WHERE id = '${id}'`);
  const rep = await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: mdp } });
  const headers = { cookie: String(rep.headers['set-cookie']).split(';')[0]! };
  const session = proprietaire(`SELECT id FROM core.sessions WHERE account_id = '${id}' ORDER BY created_at DESC LIMIT 1`);
  proprietaire(`INSERT INTO core.admin_sessions (session_id) VALUES ('${session}') ON CONFLICT (session_id) DO UPDATE SET started_at = now(), last_at = now()`);

  assert.equal((await app.inject({ method: 'POST', url: '/admin/beta', headers, payload: { nom: 'Hier', expireLe: '2020-01-01T00:00:00Z' } })).json().erreur,
               'expiration_passee');
  const cree = await app.inject({ method: 'POST', url: '/admin/beta', headers, payload: { nom: 'Marie (asso X)' } });
  assert.equal(cree.statusCode, 201);
  assert.match(cree.json().code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  const liste = (await app.inject({ method: 'GET', url: '/admin/beta', headers })).json().codes;
  const c = liste.find((x: { nom: string }) => x.nom === 'Marie (asso X)');
  assert.equal(c.code, cree.json().code);   // réaffichable, pour le renvoyer
  assert.equal(proprietaire(`SELECT code_enc IS NOT NULL AND position(convert_to('${cree.json().code}', 'UTF8') in code_enc) = 0 FROM core.beta_codes WHERE id = '${c.id}'`), 't');   // chiffré en base
  assert.equal((await app.inject({ method: 'POST', url: `/admin/beta/${c.id}/revoquer`, headers })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/admin/beta/${c.id}/revoquer`, headers })).statusCode, 404);
  // Suppression : seulement révoqué ou expiré ; un code actif est refusé.
  const actif = (await app.inject({ method: 'POST', url: '/admin/beta', headers, payload: { nom: 'Encore actif' } })).json();
  const idActif = (await app.inject({ method: 'GET', url: '/admin/beta', headers })).json().codes.find((x: { nom: string }) => x.nom === 'Encore actif').id;
  assert.ok(actif.code);
  assert.equal((await app.inject({ method: 'POST', url: `/admin/beta/${idActif}/supprimer`, headers })).json().erreur, 'code_encore_actif');
  assert.equal((await app.inject({ method: 'POST', url: `/admin/beta/${c.id}/supprimer`, headers })).statusCode, 200);
  const reste = (await app.inject({ method: 'GET', url: '/admin/beta', headers })).json().codes;
  assert.ok(!reste.some((x: { id: string }) => x.id === c.id) && reste.some((x: { id: string }) => x.id === idActif));
  assert.equal(typeof (await app.inject({ method: 'POST', url: '/admin/beta/nettoyer', headers })).json().supprimes, 'number');
  await app.close();
});

test('formulaire de la page d’attente (/acces-beta) : accepté depuis le site, même avec Origin « null » ; refusé depuis un autre site', async () => {
  const { deps } = dependances(socle);
  deps.reglages.beta = true;
  deps.reglages.administration = false;
  const app = construireApp(deps);
  const { empreinteBeta } = await import('../src/beta.ts');
  const code = nouveauCodeBeta();
  proprietaire(`INSERT INTO core.beta_codes (code_hmac, label) VALUES ('\\x${empreinteBeta(deps, normaliserCodeBeta(code)!).toString('hex')}', 'Formulaire')`);
  const envoyer = (entetes: Record<string, string>, c = code) => app.inject({ method: 'POST', url: '/acces-beta',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...entetes }, payload: `code=${encodeURIComponent(c)}` });

  const ok = await envoyer({ 'sec-fetch-site': 'same-origin', origin: 'null' });   // profil Firefox durci
  assert.deepEqual([ok.statusCode, ok.headers.location], [303, '/']);
  assert.match(String(ok.headers['set-cookie']), new RegExp(`^${COOKIE_BETA}=`));
  const ancien = await envoyer({ origin: 'https://argos.test' });                   // sans Sec-Fetch-Site
  assert.equal(ancien.statusCode, 303);
  assert.equal((await envoyer({ 'sec-fetch-site': 'cross-site', origin: 'https://argos.test' })).statusCode, 403);
  assert.equal((await envoyer({ origin: 'https://site-malveillant.example' })).statusCode, 403);
  assert.equal((await envoyer({})).statusCode, 403);
  const faux = await envoyer({ 'sec-fetch-site': 'same-origin' }, 'AAAA-BBBB-CCCC');
  assert.deepEqual([faux.statusCode, faux.headers.location], [303, '/?beta=invalide']);
  await app.close();
});

test('site ouvert (M13) : le cookie du code d’accès est effacé, il ne part plus avec les envois anonymes', async () => {
  const { deps } = dependances(socle);
  deps.reglages.beta = false;
  const app = construireApp(deps);
  const r = await app.inject({ method: 'GET', url: '/conditions', headers: { cookie: `${COOKIE_BETA}=ABCDEFGHJKMN` } });
  assert.match(String(r.headers['set-cookie']), new RegExp(`^${COOKIE_BETA}=; Path=/; Secure; SameSite=Lax; Max-Age=0$`));
  assert.equal((await app.inject({ method: 'GET', url: '/conditions' })).headers['set-cookie'], undefined);   // sans cookie : rien
  await app.close();
});
