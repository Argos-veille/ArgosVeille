// Secret de connexion : stable, propre au pseudo (casse ignorée), différent du mot de passe et de la clé de messagerie.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secretDeConnexion } from '../src/connexion.ts';

test('secret de connexion : stable, lié au pseudo, jamais le mot de passe', async () => {
  const a = await secretDeConnexion('Marie_75', 'cheval correct pile agrafe');
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await secretDeConnexion(' marie_75 ', 'cheval correct pile agrafe'), a);   // casse et espaces ignorés
  assert.notEqual(await secretDeConnexion('Paul_13', 'cheval correct pile agrafe'), a);
  assert.notEqual(await secretDeConnexion('Marie_75', 'cheval correct pile agrafF'), a);
  assert.ok(!a.includes('cheval'));
});
