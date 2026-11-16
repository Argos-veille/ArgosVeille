// A7 : la clé d'administration épinglée dans le site est exactement celle qu'accepte le serveur en production.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const SERVICES = new URL('../../deploiement/serveur/05-services.sh', import.meta.url);

// Sauté dans la copie publique du code (sans deploiement/).
test('clé admin épinglée = ARGOS_CLES_ADMIN de la production', { skip: !existsSync(SERVICES) && 'deploiement/ absent' }, () => {
  const site = readFileSync(new URL('../src/lib/cles-admin.ts', import.meta.url), 'utf8');
  const serveur = readFileSync(SERVICES, 'utf8');
  const epinglees = [...site.matchAll(/^\s*'(B[A-Za-z0-9+/=]{87})',$/gm)].map((m) => m[1]).sort();
  const production = (/^ARGOS_CLES_ADMIN=(.+)$/m.exec(serveur)?.[1] ?? '').split(',').map((x) => x.trim()).sort();
  assert.ok(epinglees.length > 0);
  assert.deepEqual(epinglees, production);
});
