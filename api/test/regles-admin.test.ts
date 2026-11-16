// Règles de relecture depuis l'administration : clé physique, bornes, cohérence, journal public avec motif.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { genererCodes } from '../src/codes.ts';
import { chiffrer, hacherMotDePasse } from '../src/crypto.ts';
import { verifier } from '../src/regles.ts';
import { dependances, preparer, proprietaire } from './aide.ts';
import { CleLogicielle } from './cle-logicielle.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

test('bornes et cohérence des règles', () => {
  const n = { publish_threshold: 0.65, reject_threshold: 0.35, jury_size: 11, jury_majority: 8, jury_min_votes: 8 };
  assert.equal(verifier(n, { max_review_days: 30 }), null);
  assert.match(verifier(n, { inconnu: 1 })!, /inconnu/);
  assert.match(verifier(n, { sample_size: 7.5 })!, /entier/);
  assert.match(verifier(n, { max_review_days: 0 })!, /entre/);
  assert.match(verifier(n, { jury_majority: 12 })!, /jury/);
  assert.match(verifier(n, { reject_threshold: 0.5, publish_threshold: 0.5 }) ?? 'ok', /ok/);
});

test("règles : lecture, nouvelle version avec clé et motif, journal public", async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const pseudo = `Admin_${randomInt(10_000_000, 100_000_000)}`;
  const mdp = 'cheval correct pile agrafe';
  const id = (await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(mdp), randomBytes(32), randomBytes(32), chiffrer(deps.cles, `${pseudo.toLowerCase()}@exemple.fr`),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null])).rows[0]!.id;
  const headers = { cookie: String((await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: mdp } })).headers['set-cookie']).split(';')[0]! };
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${id}'`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (methode: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method: methode, url, headers, ...(payload ? { payload } : {}) });
  const debut = await req('POST', '/2fa/cle/debut', { motDePasse: mdp });
  await req('POST', '/2fa/cle/confirmer', { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });
  const preuve = async () => cle.prouver((await req('POST', '/admin/decision/defi', {})).json().options);
  await req('POST', '/admin/session', { cle: await preuve() });

  const avant = (await req('GET', '/admin/regles')).json();
  assert.equal(typeof avant.valeurs.max_review_days, 'number');
  assert.equal(avant.valeurs.control_min_pool, 30);   // absent des règles : valeur par défaut
  assert.ok(avant.bornes.sample_size.entier);
  const ancien = avant.valeurs.collusion_threshold as number;

  // Hors bornes : refusé avant même la clé.
  const hors = await req('POST', '/admin/regles', { changements: { sample_size: 1 }, motif: 'essai hors bornes', cle: await preuve() });
  assert.equal(hors.statusCode, 400);
  assert.equal(hors.json().erreur, 'regles_invalides');
  // Motif trop court.
  assert.equal((await req('POST', '/admin/regles', { changements: { collusion_threshold: ancien + 1 }, motif: 'court', cle: await preuve() })).statusCode, 400);

  const ok = await req('POST', '/admin/regles', { changements: { collusion_threshold: ancien + 1 }, motif: 'Essai de changement de règle', cle: await preuve() });
  assert.equal(ok.statusCode, 200);
  const apres = (await req('GET', '/admin/regles')).json();
  assert.equal(apres.version, ok.json().version);
  assert.equal(apres.valeurs.collusion_threshold, ancien + 1);
  assert.deepEqual(apres.historique[0].changements, [{ cle: 'collusion_threshold', avant: ancien, apres: ancien + 1 }]);
  assert.equal(apres.historique[0].motif, 'Essai de changement de règle');
  const j = await bases.app.query<{ payload: { reason: string; params: { collusion_threshold: number } } }>(
    "SELECT payload FROM ledger.entries WHERE kind = 'rule_change' ORDER BY seq DESC LIMIT 1");
  assert.equal(j.rows[0]!.payload.reason, 'Essai de changement de règle');
  assert.equal(j.rows[0]!.payload.params.collusion_threshold, ancien + 1);

  // Même valeur : rien à changer. Puis retour à la valeur d'avant (les autres tests partagent la base).
  assert.equal((await req('POST', '/admin/regles', { changements: { collusion_threshold: ancien + 1 }, motif: 'Essai sans changement', cle: await preuve() })).statusCode, 409);
  assert.equal((await req('POST', '/admin/regles', { changements: { collusion_threshold: ancien }, motif: 'Retour à la valeur initiale', cle: await preuve() })).statusCode, 200);
});

test('règles en vigueur lisibles par tous (page « Comment ça marche »)', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const r = (await app.inject({ method: 'GET', url: '/public/regles' })).json().regles;
  assert.equal(typeof r.publish_threshold, 'number');
  assert.equal(typeof r.max_review_days, 'number');
});
