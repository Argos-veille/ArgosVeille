// Code gardé avec le compte : lisible seulement avec la clé du compte.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { creerCleCompte, genererEntropie, ouvrirCode, scellerCode } from '../src/index.ts';

test('le code scellé pour un compte se rouvre avec sa clé, et pas avec une autre', async () => {
  const moi = await creerCleCompte('mot de passe assez long', 1000);
  const autre = await creerCleCompte('un autre mot de passe', 1000);
  const code = genererEntropie();
  const scelle = await scellerCode(code, moi.ouverte.publique);
  assert.deepEqual(new Uint8Array(await ouvrirCode(scelle, moi.ouverte)), code);
  await assert.rejects(ouvrirCode(scelle, autre.ouverte));
  await assert.rejects(scellerCode(new Uint8Array(8), moi.ouverte.publique));
});
