// Recherche d'adresse : passe par le serveur, résultats simplifiés, panne du service gérée, limite par adresse IP.
import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { dependances, preparer } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  mock.restoreAll();
  await bases.fermer();
  await redis.quit();
});

function monter() {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  return (q: unknown) => app.inject({ method: 'POST', url: '/adresse', payload: { q }, remoteAddress: '198.51.100.91' });
}

test('adresse : un libellé renvoyé deux fois par le service n’apparaît qu’une fois', async () => {
  const lieu = (label: string, lon: number) => ({ properties: { label }, geometry: { coordinates: [lon, 43.4] } });
  const faux = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    features: [lieu('Lyon', 4.8), lieu('Lyons 31560 Saint-Léon', 1.5381), lieu('Lyons 31560 Saint-Léon', 1.5384)] }), { status: 200 }));
  const noms = (await monter()('lyon')).json().resultats.map((r: { label: string }) => r.label);
  assert.deepEqual(noms, ['Lyon', 'Lyons 31560 Saint-Léon']);
  faux.mock.restore();
});

test('adresse : résultats du service, sans rien d’autre', async () => {
  const faux = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    features: [{ properties: { label: '10 Rue de Rivoli 75004 Paris', score: 0.9 }, geometry: { coordinates: [2.36, 48.85] } }] }), { status: 200 }));
  const r = await monter()('10 rue de rivoli');
  assert.deepEqual(r.json(), { resultats: [{ label: '10 Rue de Rivoli 75004 Paris', lon: 2.36, lat: 48.85 }] });
  assert.match(String(faux.mock.calls[0]!.arguments[0]), /^https:\/\/data\.geopf\.fr\/geocodage\/search\?q=10%20rue%20de%20rivoli&limit=5$/);
  faux.mock.restore();
});

test('adresse : texte trop court refusé, panne du service signalée, limite par adresse', async () => {
  const appel = monter();
  assert.equal((await appel('ab')).statusCode, 400);
  const panne = mock.method(globalThis, 'fetch', async () => { throw new Error('coupure'); });
  assert.deepEqual((await appel('10 rue de rivoli')).json(), { erreur: 'adresse_indisponible' });
  panne.mock.restore();
  const vide = mock.method(globalThis, 'fetch', async () => new Response('{"features":[]}', { status: 200 }));
  for (let i = 0; i < 59; i++) assert.equal((await appel('10 rue de rivoli')).statusCode, 200, `essai ${i}`);
  assert.equal((await appel('10 rue de rivoli')).statusCode, 429);
  vide.mock.restore();
});

function monterInverse() {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  return (corps: Record<string, unknown>) => app.inject({ method: 'POST', url: '/adresse/inverse', payload: corps, remoteAddress: '198.51.100.92' });
}

test('adresse inverse : adresse la plus proche, simplifiée, puis gardée en mémoire', async () => {
  const faux = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ features: [{ properties: {
    label: '18bis Rue de la République 69002 Lyon', city: 'Lyon', postcode: '69002', distance: 2.4, score: 0.99, id: 'x' } }] }), { status: 200 }));
  const demander = monterInverse();
  const r = await demander({ lat: 45.76398, lon: 4.83571 });
  assert.deepEqual(r.json(), { adresse: { label: '18bis Rue de la République 69002 Lyon', commune: 'Lyon', codePostal: '69002', distance: 2 } });
  assert.match(String(faux.mock.calls[0]!.arguments[0]), /^https:\/\/data\.geopf\.fr\/geocodage\/reverse\?lat=45\.76398&lon=4\.83571&limit=1$/);
  assert.equal((await demander({ lat: 45.76398, lon: 4.83571 })).statusCode, 200);
  assert.equal(faux.mock.callCount(), 1);
  // Un autre visiteur ne profite pas de la mémoire du premier : rien ne révèle que ce point a déjà été cherché.
  const { deps } = dependances(socle);
  const autre = construireApp(deps);
  await autre.inject({ method: 'POST', url: '/adresse/inverse', payload: { lat: 45.76398, lon: 4.83571 }, remoteAddress: '198.51.100.93' });
  assert.equal(faux.mock.callCount(), 2);
  faux.mock.restore();
});

test('adresse inverse : aucun résultat (en mer) → null ; panne → 503 ; coordonnées invalides → 400', async () => {
  const demander = monterInverse();
  let faux = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ features: [] }), { status: 200 }));
  assert.deepEqual((await demander({ lat: 43.1, lon: 5.1 })).json(), { adresse: null });
  faux.mock.restore();
  faux = mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
  assert.equal((await demander({ lat: 43.2, lon: 5.2 })).statusCode, 503);
  faux.mock.restore();
  assert.equal((await demander({ lat: 91, lon: 5 })).statusCode, 400);
  assert.equal((await demander({ lat: '43', lon: 5, autre: 1 })).statusCode, 400);
});
