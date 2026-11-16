// Alerte par mail quand l'API enchaîne des erreurs.
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { alerterErreurs } from '../src/alertes.ts';
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

const erreurs = (n: number, depuis = '1 minute') => proprietaire(Array.from({ length: n }, () =>
  `INSERT INTO core.request_errors (request_id, created_at, method, route, status, error_name, message)
   VALUES ('${randomUUID()}', now() - interval '${depuis}', 'PUT', '/envois/:id/copie/:n', 500, 'Error', 'chemin secret');`).join('\n'));

test('alerte : à partir de 5 erreurs récentes, une par heure, sans le message d’erreur', async () => {
  const { deps, facteur } = dependances(socle);
  const pseudo = `Alerte_${randomInt(10_000_000, 100_000_000)}`;
  const r = await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse('cheval correct pile agrafe'), randomBytes(32), randomBytes(32), chiffrer(deps.cles, `${pseudo.toLowerCase()}@exemple.fr`),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null]);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${r.rows[0]!.id}';
                DELETE FROM core.request_errors`);

  erreurs(4);
  erreurs(10, '1 hour');   // trop anciennes
  assert.equal(await alerterErreurs(deps), false);
  erreurs(1);
  const avant = facteur.mails.length;
  assert.equal(await alerterErreurs(deps), true);
  const mail = facteur.mails.at(-1)!;
  assert.equal(facteur.mails.length, avant + 1);
  assert.match(JSON.stringify(mail), /5 erreurs/);
  assert.match(JSON.stringify(mail), /PUT \/envois\/:id\/copie\/:n/);
  assert.doesNotMatch(JSON.stringify(mail), /chemin secret/);
  assert.equal(await alerterErreurs(deps), false);   // une seule par heure
  assert.equal(facteur.mails.length, avant + 1);
});
