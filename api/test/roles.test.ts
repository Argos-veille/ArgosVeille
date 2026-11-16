// Les rôles de connexion de l'API n'ont que les droits de leur rôle applicatif.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { codeErreur, preparer, REFUSE } from './aide.ts';

const { bases, redis } = preparer();
after(async () => {
  await bases.fermer();
  redis.disconnect();
});

test("argos_api (le site) ne peut pas lire l'identité", async () => {
  assert.equal(await codeErreur(bases.app.query('SELECT * FROM identity.account_identities')), REFUSE);
  assert.equal(await codeErreur(bases.app.query('SELECT * FROM identity.legal_connection_logs')), REFUSE);
});

test('argos_api ne peut pas modifier le score ni devenir super-administrateur', async () => {
  assert.equal(await codeErreur(bases.app.query('UPDATE core.accounts SET score = 10')), REFUSE);
  assert.equal(await codeErreur(bases.app.query('UPDATE core.accounts SET is_superadmin = true')), REFUSE);
});

test('argos_api_identity ne voit que le schéma identity', async () => {
  assert.equal(await codeErreur(bases.identity.query('SELECT id FROM core.accounts')), REFUSE);
  assert.equal(await codeErreur(bases.identity.query('SELECT * FROM core.credentials')), REFUSE);
  // Journaux légaux : écriture seule, aucune relecture.
  assert.equal(await codeErreur(bases.identity.query('SELECT * FROM identity.legal_connection_logs')), REFUSE);
});

test("aucun rôle de l'API ne peut prendre un autre rôle ni en créer", async () => {
  // Chaque rôle de connexion ne peut endosser que son propre rôle parent (mêmes droits, rien de plus).
  const cas = [
    { pool: bases.app, parent: 'argos_app' },
    { pool: bases.identity, parent: 'argos_identity' },
  ];
  const tous = ['argos_owner', 'argos_admin', 'argos_scoring', 'argos_worker', 'argos_identity', 'argos_app'];
  for (const { pool, parent } of cas) {
    for (const r of tous.filter((r) => r !== parent)) {
      assert.equal(await codeErreur(pool.query(`SET ROLE ${r}`)), REFUSE, `${parent} -> ${r}`);
    }
    assert.equal(await codeErreur(pool.query('CREATE ROLE intrus')), REFUSE);
  }
});

test("les rôles de l'API ne sont ni superutilisateurs ni créateurs de rôles ou de bases", async () => {
  const { rows } = await bases.app.query(
    `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
       FROM pg_roles WHERE rolname IN ('argos_api', 'argos_api_identity') ORDER BY rolname`);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.deepEqual([r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls], [false, false, false, false], r.rolname);
  }
});
