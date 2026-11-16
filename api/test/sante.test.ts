import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Redis } from 'ioredis';
import { construireApp } from '../src/app.ts';
import { dependances, preparer } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
const { deps } = dependances(socle);
before(() => redis.connect());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

test('/sante répond 200 quand base et Redis sont joignables', async () => {
  const app = construireApp(deps);
  const r = await app.inject({ method: 'GET', url: '/sante' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true });
  await app.close();
});

test('/sante répond 503 sans aucun détail quand Redis est injoignable', async () => {
  // Port 1 : rien n'y écoute.
  const mort = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0,
                                                  enableOfflineQueue: false, retryStrategy: () => null });
  const app = construireApp({ ...deps, redis: mort });
  const r = await app.inject({ method: 'GET', url: '/sante' });
  assert.equal(r.statusCode, 503);
  assert.deepEqual(r.json(), { ok: false });
  await app.close();
  mort.disconnect();
});

test("une route inconnue répond 404 sans recopier l'adresse demandée", async () => {
  const app = construireApp(deps);
  const r = await app.inject({ method: 'GET', url: '/admin?jeton=SECRET123' });
  assert.equal(r.statusCode, 404);
  assert.deepEqual(r.json(), { erreur: 'introuvable' });
  await app.close();
});

test('un corps de requête trop gros est refusé (413)', async () => {
  const app = construireApp(deps);
  app.post('/echo', async () => ({}));
  const r = await app.inject({ method: 'POST', url: '/echo', payload: { x: 'a'.repeat(70 * 1024) } });
  assert.equal(r.statusCode, 413);
  await app.close();
});
