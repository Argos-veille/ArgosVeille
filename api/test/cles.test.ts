// Clés de sécurité et passkeys (WebAuthn), avec une clé logicielle qui signe comme une vraie.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { genererCodes } from '../src/codes.ts';
import { chiffrer, hacherMotDePasse } from '../src/crypto.ts';
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

const MDP = 'cheval correct pile agrafe';
const ORIGINE = 'https://argos.test';
const FAUX_SITE = 'https://argos-veille.example';
const nouvelleCle = () => new CleLogicielle(ORIGINE, 'argos.test');

function monter() {
  const { deps, facteur } = dependances(socle);
  const app = construireApp(deps);
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload, headers });

  async function relecteur() {
    const pseudo = `Cle_${randomInt(10_000_000, 100_000_000)}`;
    const { codes, empreintes } = genererCodes(deps.cles);
    const r = await bases.identity.query<{ id: string }>(
      'SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
      [pseudo, await hacherMotDePasse(MDP), randomBytes(32), randomBytes(32),
       chiffrer(deps.cles, `${pseudo.toLowerCase()}@proton.me`), empreintes, '192.0.2.1', null]);
    const rep = await post('/connexion', { pseudo, motDePasse: MDP });
    const cookie = String((rep.headers['set-cookie'] as string[])[0]).split(';')[0]!;
    return { id: r.rows[0]!.id, pseudo, codes, session: { cookie } };
  }

  async function enregistrer(r: { session: Record<string, string> }, cle: CleLogicielle, nom = 'YubiKey bleue') {
    const debut = await post('/2fa/cle/debut', { motDePasse: MDP }, r.session);
    assert.equal(debut.statusCode, 200, debut.body);
    return post('/2fa/cle/confirmer', { reponse: cle.enregistrer(debut.json().options), nom }, r.session);
  }

  /** Mot de passe, puis défi de clé : renvoie le jeton d'attente et les options. */
  async function attenteCle(pseudo: string) {
    const attente = (await post('/connexion', { pseudo, motDePasse: MDP })).json().attente as string;
    const opt = await post('/connexion/2fa/cle', { attente });
    return { attente, options: opt.json().options, statut: opt.statusCode };
  }

  return { app, deps, facteur, post, relecteur, enregistrer, attenteCle };
}

test('enregistrement : options sans donnée inutile, clé ajoutée, alerte', async () => {
  const { app, facteur, post, relecteur } = monter();
  const r = await relecteur();
  const debut = await post('/2fa/cle/debut', { motDePasse: MDP }, r.session);
  const o = debut.json().options;
  assert.deepEqual(o.rp, { name: 'Argos Veille', id: 'argos.test' });
  assert.equal(o.attestation, 'none');                       // ni marque ni modèle demandés
  assert.equal(o.user.name, r.pseudo);
  const userId = Buffer.from(o.user.id, 'base64url').toString('hex');
  assert.ok(!userId.includes(r.id.replace(/-/g, '')), "l'identifiant interne ne doit pas sortir");
  const cle = nouvelleCle();
  const conf = await post('/2fa/cle/confirmer', { reponse: cle.enregistrer(o), nom: 'YubiKey bleue' }, r.session);
  assert.deepEqual([conf.statusCode, conf.json()], [201, { ok: true }]);
  const liste = (await app.inject({ method: 'GET', url: '/2fa', headers: r.session })).json().methodes;
  assert.deepEqual(liste.map((m: { type: string; nom: string }) => [m.type, m.nom]), [['webauthn', 'YubiKey bleue']]);
  assert.equal(proprietaire(`SELECT array_to_string(transports, ',') FROM core.mfa_factors WHERE account_id = '${r.id}'`), 'usb,nfc');
  assert.ok(facteur.mails.some((m) => /clé de sécurité enregistrée/.test(m.sujet)));
  await app.close();
});

test('enregistrement : mot de passe exigé, faux site refusé, défi à usage unique', async () => {
  const { app, post, relecteur } = monter();
  const r = await relecteur();
  assert.equal((await post('/2fa/cle/debut', { motDePasse: 'faux' }, r.session)).statusCode, 401);
  const o = (await post('/2fa/cle/debut', { motDePasse: MDP }, r.session)).json().options;
  const cle = nouvelleCle();
  const hameconnage = await post('/2fa/cle/confirmer', { reponse: cle.enregistrer(o, FAUX_SITE) }, r.session);
  assert.deepEqual([hameconnage.statusCode, hameconnage.json()], [400, { erreur: 'cle_invalide' }]);
  const rejeu = await post('/2fa/cle/confirmer', { reponse: cle.enregistrer(o) }, r.session);
  assert.deepEqual([rejeu.statusCode, rejeu.json()], [410, { erreur: 'activation_expiree' }]);
  await app.close();
});

test('une même clé ne s\'enregistre pas deux fois', async () => {
  const { app, post, relecteur, enregistrer } = monter();
  const r = await relecteur();
  const cle = nouvelleCle();
  assert.equal((await enregistrer(r, cle)).statusCode, 201);
  const o = (await post('/2fa/cle/debut', { motDePasse: MDP }, r.session)).json().options;
  assert.deepEqual(o.excludeCredentials.map((c: { id: string }) => c.id), [cle.id.toString('base64url')]);
  const encore = await post('/2fa/cle/confirmer', { reponse: cle.enregistrer(o) }, r.session);
  assert.deepEqual([encore.statusCode, encore.json()], [409, { erreur: 'deja_enregistree' }]);
  await app.close();
});

test('connexion avec une clé : mot de passe, défi, signature, session', async () => {
  const { app, post, relecteur, enregistrer, attenteCle } = monter();
  const r = await relecteur();
  const cle = nouvelleCle();
  await enregistrer(r, cle);
  const premiere = await post('/connexion', { pseudo: r.pseudo, motDePasse: MDP });
  assert.deepEqual(premiere.json().methodes, ['webauthn', 'code_secours']);
  const { attente, options } = await attenteCle(r.pseudo);
  assert.equal(options.rpId, 'argos.test');
  assert.deepEqual(options.allowCredentials.map((c: { id: string }) => c.id), [cle.id.toString('base64url')]);
  const fin = await post('/connexion/2fa', { attente, cle: cle.prouver(options) });
  assert.deepEqual([fin.statusCode, fin.json()], [200, { pseudo: r.pseudo }]);
  assert.match(String(fin.headers['set-cookie']), /__Host-argos_session=/);
  assert.equal(proprietaire(`SELECT sign_count FROM core.mfa_factors WHERE account_id = '${r.id}'`), '1');
  await app.close();
});

test("connexion : réponse d'un faux site refusée (hameçonnage), défi à usage unique", async () => {
  const { app, post, relecteur, enregistrer, attenteCle } = monter();
  const r = await relecteur();
  const cle = nouvelleCle();
  await enregistrer(r, cle);
  const { attente, options } = await attenteCle(r.pseudo);
  const faux = await post('/connexion/2fa', { attente, cle: cle.prouver(options, FAUX_SITE) });
  assert.deepEqual([faux.statusCode, faux.json()], [401, { erreur: 'code_invalide', essaisRestants: 4 }]);
  // Le défi a été consommé : même une réponse correcte ne passe plus sans nouveau défi.
  const sansDefi = await post('/connexion/2fa', { attente, cle: cle.prouver(options) });
  assert.equal(sansDefi.statusCode, 401);
  await app.close();
});

test('clé clonée (compteur qui recule) : refus et mail d\'alerte', async () => {
  const { app, facteur, post, relecteur, enregistrer, attenteCle } = monter();
  const r = await relecteur();
  const cle = nouvelleCle();
  await enregistrer(r, cle);
  let a = await attenteCle(r.pseudo);
  for (let i = 0; i < 4; i++) cle.compteur += 1;   // la vraie clé a servi plusieurs fois
  assert.equal((await post('/connexion/2fa', { attente: a.attente, cle: cle.prouver(a.options) })).statusCode, 200);
  cle.compteur = 1;                                  // la copie a un compteur en retard
  a = await attenteCle(r.pseudo);
  const copie = await post('/connexion/2fa', { attente: a.attente, cle: cle.prouver(a.options) });
  assert.equal(copie.statusCode, 401);
  assert.ok(facteur.mails.some((m) => /vérification d’une clé de sécurité/.test(m.sujet)));
  await app.close();
});

test("la clé d'un autre compte ne sert pas", async () => {
  const { app, post, relecteur, enregistrer, attenteCle } = monter();
  const r = await relecteur();
  const autre = await relecteur();
  await enregistrer(r, nouvelleCle());
  const cleAutre = nouvelleCle();
  await enregistrer(autre, cleAutre);
  const { attente, options } = await attenteCle(r.pseudo);
  const x = await post('/connexion/2fa', { attente, cle: cleAutre.prouver(options) });
  assert.equal(x.statusCode, 401);
  await app.close();
});

test('un code OU une clé, jamais les deux ni aucun', async () => {
  const { app, post, relecteur, enregistrer, attenteCle } = monter();
  const r = await relecteur();
  const cle = nouvelleCle();
  await enregistrer(r, cle);
  const { attente, options } = await attenteCle(r.pseudo);
  assert.equal((await post('/connexion/2fa', { attente })).statusCode, 400);
  assert.equal((await post('/connexion/2fa', { attente, code: r.codes[0]!, cle: cle.prouver(options) })).statusCode, 400);
  await app.close();
});

test('double authentification : plafond dur de 20 échecs par jour et par compte (B3)', async () => {
  const { app, post, relecteur, enregistrer, attenteCle } = monter();
  const r = await relecteur();
  const cle = nouvelleCle();
  await enregistrer(r, cle);
  await redis.set(`limite:2fa-echec:compte:${r.id}`, '20');
  const { attente, options } = await attenteCle(r.pseudo);
  const bloque = await post('/connexion/2fa', { attente, cle: cle.prouver(options) });   // même la bonne clé
  assert.deepEqual([bloque.statusCode, bloque.json().erreur], [429, 'trop_de_demandes']);
  await app.close();
});

test('compte sans clé : pas de défi de clé', async () => {
  const { app, relecteur, attenteCle } = monter();
  const r = await relecteur();
  // Sans aucune méthode, /connexion ouvre directement la session : pas d'attente du tout.
  const { statut } = await attenteCle(r.pseudo);
  assert.equal(statut, 400);
  await app.close();
});

test('retirer une clé en prouvant la possession d\'une autre clé', async () => {
  const { app, facteur, post, relecteur, enregistrer } = monter();
  const r = await relecteur();
  const a = nouvelleCle();
  const b = nouvelleCle();
  await enregistrer(r, a, 'Clé A');
  await enregistrer(r, b, 'Clé B');
  const methodes = (await app.inject({ method: 'GET', url: '/2fa', headers: r.session })).json().methodes;
  const idA = methodes.find((m: { nom: string }) => m.nom === 'Clé A').id;
  const defi = (await post('/2fa/cle/defi', {}, r.session)).json().options;
  const ok = await post('/2fa/retirer', { methode: idA, motDePasse: MDP, cle: b.prouver(defi) }, r.session);
  assert.deepEqual([ok.statusCode, ok.json()], [200, { ok: true }]);
  const restantes = (await app.inject({ method: 'GET', url: '/2fa', headers: r.session })).json().methodes;
  assert.deepEqual(restantes.map((m: { nom: string }) => m.nom), ['Clé B']);
  assert.ok(facteur.mails.some((m) => /double authentification retirée/.test(m.sujet)));
  // Sans nouveau défi, une seconde preuve ne passe pas.
  const encore = await post('/2fa/retirer', { methode: restantes[0].id, motDePasse: MDP, cle: b.prouver(defi) }, r.session);
  assert.equal(encore.statusCode, 401);
  await app.close();
});

test('compte vérifié : double authentification obligatoire, dernière méthode impossible à retirer', async () => {
  const { app, post, relecteur, enregistrer } = monter();
  const r = await relecteur();
  const a = nouvelleCle();
  await enregistrer(r, a, 'Clé A');
  const id = r.id;
  proprietaire(`INSERT INTO core.verifications (account_id, category, expires_at) VALUES ('${id}', 'journalist', now() + interval '1 year')`);
  const methode = (await app.inject({ method: 'GET', url: '/2fa', headers: r.session })).json().methodes[0].id;
  const defi = (await post('/2fa/cle/defi', {}, r.session)).json().options;
  const refus = await post('/2fa/retirer', { methode, motDePasse: MDP, cle: a.prouver(defi) }, r.session);
  assert.deepEqual([refus.statusCode, refus.json().erreur], [409, 'derniere_methode']);
  // Sans aucune méthode (retirée à la main), la messagerie des comptes vérifiés est fermée.
  proprietaire(`UPDATE core.mfa_factors SET revoked_at = now() WHERE account_id = '${id}'`);
  const m = await app.inject({ method: 'GET', url: '/messagerie', headers: r.session });
  assert.deepEqual([m.statusCode, m.json().erreur], [403, 'double_auth_requise']);
  await app.close();
});

test('réponses de clé mal formées : refusées proprement', async () => {
  const { app, post, relecteur } = monter();
  const r = await relecteur();
  const o = (await post('/2fa/cle/debut', { motDePasse: MDP }, r.session)).json().options;
  const cas: unknown[] = [
    {}, { id: 'x', rawId: 'x', type: 'autre', response: {} },
    { id: 'x', rawId: 'x', type: 'public-key', response: { clientDataJSON: 'pas du base64 !', attestationObject: '' } },
    { id: 'x'.repeat(2000), rawId: 'x', type: 'public-key', response: {} },
  ];
  for (const reponse of cas) {
    await redis.set(`cle-activation:${r.id}`, o.challenge, 'EX', 60);
    const x = await post('/2fa/cle/confirmer', { reponse }, r.session);
    assert.ok([400].includes(x.statusCode), `${JSON.stringify(reponse).slice(0, 60)} : ${x.statusCode} ${x.body}`);
  }
  await app.close();
});
