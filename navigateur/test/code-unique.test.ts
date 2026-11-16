// Code unique pour plusieurs vidéos : secrets séparés, anciens codes inchangés.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriverSecrets, entropieVideo, genererEntropie, jetonsDuCode, trouverEntropie, VIDEOS_PAR_CODE } from '../src/index.ts';

test('la vidéo 0 garde le code tel quel : les codes déjà donnés restent valables', async () => {
  const code = genererEntropie();
  assert.deepEqual(await entropieVideo(code, 0), code);
  assert.equal((await jetonsDuCode(code))[0], (await deriverSecrets(code)).jetonSuivi);
});

test('chaque vidéo a son propre secret, stable', async () => {
  const code = genererEntropie();
  const a = await entropieVideo(code, 1);
  assert.equal(a.length, 16);
  assert.notDeepEqual(a, await entropieVideo(code, 2));
  assert.notDeepEqual(a, code);
  assert.deepEqual(a, await entropieVideo(code, 1));
  const jetons = await jetonsDuCode(code);
  assert.equal(jetons.length, VIDEOS_PAR_CODE);
  assert.equal(new Set(jetons).size, VIDEOS_PAR_CODE);
});

test('le secret d’une vidéo ne donne pas celui d’une autre', async () => {
  const code = genererEntropie();
  const video1 = await entropieVideo(code, 1);
  assert.notDeepEqual(await entropieVideo(video1, 1), await entropieVideo(code, 2));
  assert.notDeepEqual(await entropieVideo(video1, 2), await entropieVideo(code, 2));
});

test('numéro de vidéo hors limites refusé ; retrouver le secret d’une vidéo', async () => {
  const code = genererEntropie();
  await assert.rejects(entropieVideo(code, VIDEOS_PAR_CODE));
  await assert.rejects(entropieVideo(code, -1));
  const cherche = await entropieVideo(code, 7);
  const trouve = await trouverEntropie(code, async (e) => e.every((o, i) => o === cherche[i]));
  assert.deepEqual(trouve, cherche);
  assert.equal(await trouverEntropie(code, async () => false), null);
});
