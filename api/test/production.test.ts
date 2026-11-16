// Réglages de production : adresse du visiteur derrière cloudflared, préfixe /api, origine de l'instance
// d'administration, appels internes du site sans limite, secrets lus dans des fichiers.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { construireApp, retirerPrefixe } from '../src/app.ts';
import { lireConfig } from '../src/config.ts';
import { dependances, preparer } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

test('préfixe /api retiré, et seulement lui', () => {
  assert.equal(retirerPrefixe('/api/public/videos', '/api'), '/public/videos');
  assert.equal(retirerPrefixe('/api', '/api'), '/');
  assert.equal(retirerPrefixe('/api?x=1', '/api'), '?x=1');
  assert.equal(retirerPrefixe('/apiculture', '/api'), '/apiculture');
  assert.equal(retirerPrefixe('/sante', ''), '/sante');
});

test('derrière cloudflared : adresse du visiteur, préfixe, origine admin', async () => {
  const { deps } = dependances(socle);
  const app = construireApp({ ...deps, reglages: { ...deps.reglages, proxyLocal: true, prefixeApi: '/api',
                                                   origine: 'https://admin.argos.test' } });
  app.get('/qui', async (req) => ({ ip: req.ip }));
  // Le visiteur (dernière adresse ajoutée par Cloudflare) ; une adresse glissée par le client avant est ignorée.
  const r = await app.inject({ method: 'GET', url: '/api/qui', headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' } });
  assert.deepEqual(r.json(), { ip: '203.0.113.7' });
  assert.equal((await app.inject({ method: 'GET', url: '/api/public/journal/verification' })).statusCode, 200);
  // Origine : celle de l'instance (admin), et plus celle du site public.
  const post = (origin: string) => app.inject({ method: 'POST', url: '/api/deconnexion', headers: { origin }, payload: {} });
  assert.equal((await post('https://argos.test')).statusCode, 403);
  assert.notEqual((await post('https://admin.argos.test')).statusCode, 403);
  await app.close();
});

test('administration sur socket Unix : adresse prise de Caddy (X-Forwarded-For), carte et journal sans erreur', async () => {
  const { deps } = dependances(socle);
  const app = construireApp({ ...deps, reglages: { ...deps.reglages, surSocket: true } });
  app.get('/qui', async (req) => ({ ip: req.ip ?? null }));
  const d = await mkdtemp(join(tmpdir(), 'argos-socket-'));
  const chemin = join(d, 'api.sock');
  await app.listen({ path: chemin });
  const appel = (url: string) => new Promise<{ code: number; corps: string }>((ok, ko) => {
    const r = request({ socketPath: chemin, path: url, headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.8', host: 'admin.argos.test' } }, (rep) => {
      let corps = ''; rep.on('data', (x) => { corps += x; }); rep.on('end', () => ok({ code: rep.statusCode ?? 0, corps }));
    });
    r.on('error', ko); r.end();
  });
  assert.deepEqual(JSON.parse((await appel('/qui')).corps), { ip: '203.0.113.8' });
  for (const url of ['/public/videos', '/public/journal', '/public/journal/verification']) {
    assert.equal((await appel(url)).code, 200, url);
  }
  await app.close();
});

test('secrets lus dans des fichiers (systemd-creds)', async () => {
  const d = await mkdtemp(join(tmpdir(), 'argos-creds-'));
  await writeFile(join(d, 'pg'), 'mot-de-passe-pg\n');
  await writeFile(join(d, 'ts'), 'secret-turnstile\n');
  await writeFile(join(d, 'admin'), 'mot-de-passe-admin\n');
  await writeFile(join(d, 'redis'), 'mot-de-passe-redis\n');
  const c = lireConfig({
    ARGOS_HOST: '127.0.0.1', ARGOS_PORT: '3000', ARGOS_PG_HOST: '127.0.0.1', ARGOS_PG_PORT: '5432', ARGOS_PG_DATABASE: 'argos',
    ARGOS_PG_APP_PASSWORD_FICHIER: join(d, 'pg'), ARGOS_PG_IDENTITY_PASSWORD_FICHIER: join(d, 'pg'),
    ARGOS_PG_ADMIN_PASSWORD_FICHIER: join(d, 'admin'), ARGOS_REDIS_PASSWORD_FICHIER: join(d, 'redis'),
    ARGOS_REDIS_URL: 'redis://127.0.0.1:6379/1', ARGOS_CLE_HMAC: 'a', ARGOS_CLE_MAIL: 'b', ARGOS_CLE_MFA: 'c',
    ARGOS_TURNSTILE_SECRET_FICHIER: join(d, 'ts'), ARGOS_URL_PUBLIQUE: 'https://argos.test', ARGOS_ORIGINE: 'https://admin.argos.test',
    ARGOS_MAIL: 'fichier', ARGOS_SMS: 'fichier', ARGOS_BOITE: '.b', ARGOS_SMS_PLAFOND_JOUR: '10', ARGOS_STOCKAGE: 'o',
    ARGOS_QUARANTAINE: 'q', ARGOS_FLOUTEES: 'f', ARGOS_COPIES: 'c', ARGOS_ENVOIS_PAR_HEURE: '10',
    ARGOS_PROXY_LOCAL: 'oui', ARGOS_PREFIXE_API: '/api', ARGOS_TACHES: 'non',
  });
  assert.equal(c.pg.adminPassword, 'mot-de-passe-admin');
  assert.equal(c.redisPassword, 'mot-de-passe-redis');   // A8 : Redis protégé par mot de passe en production
  assert.deepEqual([c.pg.appPassword, c.turnstileSecret, c.origine, c.proxyLocal, c.prefixeApi, c.taches],
                   ['mot-de-passe-pg', 'secret-turnstile', 'https://admin.argos.test', true, '/api', false]);
});
