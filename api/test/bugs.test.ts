// Rapports de bug (interface I-1) : thèmes, pages des sources, pseudo facultatif, limite, numéro de
// requête, journal des erreurs internes, boîte de développement.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { genererCodes } from '../src/codes.ts';
import { chiffrer, hacherMotDePasse } from '../src/crypto.ts';
import { codeErreur, dependances, preparer, proprietaire, REFUSE } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

const RAPPORT = {
  theme: 'relecture', sousTheme: 'vote_refuse', description: 'Le bouton Envoyer ne fait rien.\nAucun message.',
  page: '/relecture/[convocation]', pageSource: false, joindrePseudo: false,
  telemetrie: { version: 'abc123', navigateur: 'Firefox 144.0', appels: [{ route: 'POST /relecture/:id/vote', statut: 409 }] },
};
const envoyer = (app: ReturnType<typeof construireApp>, payload: object, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/bugs', payload, headers });

test('thèmes : grands thèmes et thèmes précis, « Autre » partout, urgence et pages des sources', async () => {
  const app = construireApp(dependances(socle).deps);
  const { themes } = (await app.inject({ method: 'GET', url: '/bugs/themes' })).json();
  assert.equal(themes.length, 9);
  assert.ok(themes.every((t: { precis: { cle: string }[] }) => t.precis.at(-1)!.cle === 'autre'));
  const securite = themes.find((t: { cle: string }) => t.cle === 'securite');
  assert.equal(securite.urgent, true);
  assert.equal(themes.find((t: { cle: string }) => t.cle === 'compte').pourLesSources, false);
  await app.close();
});

test('rapport : rangé avec sa télémétrie, numéro de requête renvoyé, illisible pour le site', async () => {
  const app = construireApp(dependances(socle).deps);
  const r = await envoyer(app, RAPPORT);
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().requete, r.headers['x-argos-requete']);
  assert.match(String(r.headers['x-argos-requete']), /^[0-9a-f-]{36}$/);
  assert.equal(proprietaire(`SELECT theme || ' ' || subtheme || ' ' || urgent || ' ' || (account_id IS NULL) || ' ' || (telemetry ->> 'version')
                             FROM core.bug_reports ORDER BY created_at DESC LIMIT 1`), 'relecture vote_refuse false true abc123');
  assert.equal(await codeErreur(bases.app.query('SELECT * FROM core.bug_reports')), REFUSE);
  assert.equal((await envoyer(app, { ...RAPPORT, theme: 'securite', sousTheme: 'faille' })).statusCode, 201);
  assert.equal(proprietaire('SELECT urgent FROM core.bug_reports ORDER BY created_at DESC LIMIT 1'), 't');
  for (const mauvais of [{ ...RAPPORT, theme: 'inconnu' }, { ...RAPPORT, sousTheme: 'carte' }, { ...RAPPORT, description: ' ' },
                         { ...RAPPORT, ip: '1.2.3.4' }, { ...RAPPORT, capture: 'data:text/html;base64,PHNjcmlwdD4=' }]) {
    assert.equal((await envoyer(app, mauvais)).statusCode, 400, JSON.stringify(mauvais).slice(0, 80));
  }
  await app.close();
});

test('pages des sources : ni pseudo, ni capture, ni thème réservé aux comptes', async () => {
  const app = construireApp(dependances(socle).deps);
  const source = { ...RAPPORT, theme: 'envoi', sousTheme: 'envoi_bloque', page: '/envoi', pageSource: true };
  assert.equal((await envoyer(app, source)).statusCode, 201);
  assert.equal((await envoyer(app, { ...source, joindrePseudo: true })).statusCode, 400);
  assert.equal((await envoyer(app, { ...source, capture: 'data:image/jpeg;base64,/9j/4AAQ' })).statusCode, 400);
  assert.equal((await envoyer(app, { ...source, theme: 'compte', sousTheme: 'connexion' })).statusCode, 400);
  await app.close();
});

test('pseudo joint seulement si demandé, capture rangée', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const pseudo = `Bug_${randomInt(10_000_000, 100_000_000)}`;
  const mdp = 'cheval correct pile agrafe';
  const c = await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(mdp), randomBytes(32), randomBytes(32), chiffrer(deps.cles, `${pseudo.toLowerCase()}@exemple.fr`),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null]);
  const cookie = String((await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: mdp } }))
    .headers['set-cookie']).split(';')[0]!;
  await envoyer(app, RAPPORT, { cookie });
  assert.equal(proprietaire('SELECT account_id IS NULL FROM core.bug_reports ORDER BY created_at DESC LIMIT 1'), 't');
  const image = `data:image/jpeg;base64,${randomBytes(2000).toString('base64')}`;
  await envoyer(app, { ...RAPPORT, joindrePseudo: true, capture: image }, { cookie });
  assert.equal(proprietaire('SELECT account_id || \' \' || length(screenshot) FROM core.bug_reports ORDER BY created_at DESC LIMIT 1'),
               `${c.rows[0]!.id} 2000`);
  await app.close();
});

test('5 rapports par heure au plus', async () => {
  const app = construireApp(dependances(socle).deps);
  for (let i = 0; i < 5; i++) assert.equal((await envoyer(app, RAPPORT)).statusCode, 201);
  assert.deepEqual((await envoyer(app, RAPPORT)).json(), { erreur: 'trop_de_demandes' });
  const cles = await redis.keys('*limite:bug:ip:*');
  assert.equal(cles.length, 1);
  assert.ok(!cles[0]!.includes('127.0.0.1'));             // empreinte, jamais l'adresse
  const ttl = await redis.ttl(cles[0]!.replace(/^argos:/, ''));   // keys() renvoie le préfixe, ttl() l'ajoute
  assert.ok(ttl > 0 && ttl <= 3600);
  await app.close();
});

test("erreur interne : réponse neutre, gardée avec son numéro de requête et sa trace", async () => {
  const app = construireApp(dependances(socle).deps);
  app.get('/__panne/:id', async () => { throw new Error('panne simulée'); });
  const r = await app.inject({ method: 'GET', url: '/__panne/secret-123' });
  assert.deepEqual([r.statusCode, r.json()], [500, { erreur: 'erreur_interne' }]);
  const id = String(r.headers['x-argos-requete']);
  await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(proprietaire(`SELECT route || ' ' || message || ' ' || (stack LIKE '%panne simulée%')
                             FROM core.request_errors WHERE request_id = '${id}'`), '/__panne/:id panne simulée true');
  assert.equal(proprietaire(`SELECT count(*) FROM core.request_errors WHERE route LIKE '%secret%'`), '0');
  await app.close();
});

test('boîte de développement : seulement si le faux facteur est configuré', async () => {
  const sans = construireApp(dependances(socle).deps);
  assert.equal((await sans.inject({ method: 'GET', url: '/dev/boite' })).statusCode, 404);
  await sans.close();
  const d = dependances(socle);
  const dossier = join(d.racine, 'boite');
  mkdirSync(dossier);
  appendFileSync(join(dossier, 'sms.log'), JSON.stringify({ date: 'x', numero: '+33600000000', texte: 'code 123456' }) + '\n');
  const avec = construireApp({ ...d.deps, reglages: { ...d.deps.reglages, boiteDev: dossier } });
  const b = (await avec.inject({ method: 'GET', url: '/dev/boite' })).json();
  assert.deepEqual([b.sms[0].texte, b.mails], ['code 123456', []]);
  await avec.close();
});
