// Récupération du compte (mail, codes de secours), changement de mot de passe, régénération des codes.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { genererCodes } from '../src/codes.ts';
import { chiffrer, empreinte, hacherMotDePasse } from '../src/crypto.ts';
import { normaliserMail } from '../src/normalisation.ts';
import { COOKIE } from '../src/sessions.ts';
import { dependances, preparer, proprietaire } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

const MDP = 'cheval correct pile agrafe';
const NOUVEAU = 'girafe bleue sous la pluie';

function monter(journal?: { stream: NodeJS.WritableStream }) {
  const { deps, facteur, turnstile } = dependances(socle);
  const app = construireApp(deps, journal ? { journal } : {});
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload, headers });

  /** Un relecteur avec ses vrais codes de secours (créés avec les clés de cette application). */
  async function relecteur() {
    const n = randomInt(10_000_000, 100_000_000);
    const pseudo = `Recup_${n}`;
    const mail = `recup.${n}@proton.me`;
    const canon = normaliserMail(mail);
    assert.ok(canon.ok);
    const { codes, empreintes } = genererCodes(deps.cles);
    const r = await bases.identity.query<{ id: string }>(
      'SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
      [pseudo, await hacherMotDePasse(MDP), randomBytes(32), empreinte(deps.cles, 'mail', canon.canonique),
       chiffrer(deps.cles, mail), empreintes, '192.0.2.1', null]);
    return { id: r.rows[0]!.id, pseudo, mail, codes };
  }

  async function connecter(pseudo: string, mdp = MDP) {
    const rep = await post('/connexion', { pseudo, motDePasse: mdp });
    if (rep.statusCode !== 200) return undefined;
    return /=([A-Za-z0-9_-]{43});/.exec(String(rep.headers['set-cookie']))![1]!;
  }
  const avec = (jeton: string) => ({ cookie: `${COOKIE}=${jeton}` });
  const moi = (jeton: string) => app.inject({ method: 'GET', url: '/moi', headers: avec(jeton) });

  return { app, deps, facteur, turnstile, post, relecteur, connecter, avec, moi };
}

// --- Par mail ---------------------------------------------------------------------------------

/** Le mail de récupération part sans être attendu par la réponse (même temps de réponse qu'un compte existe ou non). */
async function mailArrive(facteur: { mails: unknown[] }, avant: number) {
  for (let i = 0; i < 100 && facteur.mails.length <= avant; i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.ok(facteur.mails.length > avant, 'mail de récupération attendu');
}

test('récupération par mail : lien, nouveau mot de passe, sessions fermées, alerte', async () => {
  const { app, facteur, post, relecteur, connecter, moi } = monter();
  const r = await relecteur();
  const ancienne = (await connecter(r.pseudo))!;

  const avant = facteur.mails.length;
  const d = await post('/recuperation/demande', { mail: r.mail.toUpperCase(), turnstile: 'x' });
  assert.equal(d.statusCode, 200);
  await mailArrive(facteur, avant);
  const envoi = facteur.mails.at(-1)!;
  assert.equal(envoi.adresse, r.mail);
  assert.ok(envoi.texte.includes(`Votre pseudo : ${r.pseudo}`));
  const lien = /\/recuperation#([A-Za-z0-9_-]{43})/.exec(envoi.texte)![1]!;

  const n = await post('/recuperation/nouveau-mot-de-passe', { jeton: lien, motDePasse: NOUVEAU });
  assert.deepEqual([n.statusCode, n.json()], [200, { ok: true }]);
  assert.equal((await moi(ancienne)).statusCode, 401);                 // sessions fermées
  assert.equal(await connecter(r.pseudo, MDP), undefined);            // ancien mot de passe refusé
  assert.ok(await connecter(r.pseudo, NOUVEAU));
  assert.ok(facteur.mails.some((m) => /mot de passe a été modifié/.test(m.sujet)));
  // Le lien ne sert qu'une fois.
  const encore = await post('/recuperation/nouveau-mot-de-passe', { jeton: lien, motDePasse: 'encore une autre phrase' });
  assert.deepEqual([encore.statusCode, encore.json()], [410, { erreur: 'lien_expire' }]);
  await app.close();
});

test('mail inconnu, invalide pour un compte banni : même réponse, aucun envoi', async () => {
  const { app, facteur, post, relecteur } = monter();
  const r = await relecteur();
  const avant = facteur.mails.length;
  const connu = await post('/recuperation/demande', { mail: r.mail, turnstile: 'x' });
  await mailArrive(facteur, avant);
  const nbApresConnu = facteur.mails.length;
  const inconnu = await post('/recuperation/demande', { mail: 'personne.inconnue@proton.me', turnstile: 'x' });
  assert.equal(inconnu.statusCode, connu.statusCode);
  assert.deepEqual(inconnu.json(), connu.json());
  assert.equal(facteur.mails.length, nbApresConnu);
  const banni = await relecteur();
  proprietaire(`UPDATE core.accounts SET status = 'banned' WHERE id = '${banni.id}'`);
  const b = await post('/recuperation/demande', { mail: banni.mail, turnstile: 'x' });
  assert.deepEqual(b.json(), connu.json());
  await new Promise((ok) => setTimeout(ok, 100));   // un envoi en retard aurait le temps d'arriver
  assert.equal(facteur.mails.length, nbApresConnu);
  await app.close();
});

test('mot de passe refusé par les règles : le lien reste utilisable', async () => {
  const { app, facteur, post, relecteur } = monter();
  const r = await relecteur();
  const avantDemande = facteur.mails.length;
  await post('/recuperation/demande', { mail: r.mail, turnstile: 'x' });
  await mailArrive(facteur, avantDemande);
  const lien = /#([A-Za-z0-9_-]{43})/.exec(facteur.mails.at(-1)!.texte)![1]!;
  const court = await post('/recuperation/nouveau-mot-de-passe', { jeton: lien, motDePasse: 'court' });
  assert.deepEqual([court.statusCode, court.json()], [400, { erreur: 'mdp_trop_court' }]);
  const ok = await post('/recuperation/nouveau-mot-de-passe', { jeton: lien, motDePasse: NOUVEAU });
  assert.equal(ok.statusCode, 200);
  await app.close();
});

test('récupération par mail : Turnstile exigé, limites par IP et par mail', async () => {
  const { app, facteur, turnstile, post, relecteur } = monter();
  const r = await relecteur();
  turnstile.accepte = false;
  assert.deepEqual((await post('/recuperation/demande', { mail: r.mail, turnstile: 'x' })).json(), { erreur: 'turnstile' });
  turnstile.accepte = true;
  for (let i = 0; i < 3; i++) await post('/recuperation/demande', { mail: r.mail, turnstile: 'x' });
  await new Promise((ok) => setTimeout(ok, 100));   // les 3 mails partent sans être attendus
  const avant = facteur.mails.length;
  await post('/recuperation/demande', { mail: r.mail, turnstile: 'x' });   // 4e demande : réponse normale, pas d'envoi
  await new Promise((ok) => setTimeout(ok, 100));
  assert.equal(facteur.mails.length, avant);
  // 5 demandes par heure et par IP (celle refusée par Turnstile compte aussi).
  const x = await post('/recuperation/demande', { mail: 'autre@proton.me', turnstile: 'x' });
  assert.deepEqual([x.statusCode, x.json()], [429, { erreur: 'trop_de_demandes' }]);
  await app.close();
});

// --- Par code de secours ----------------------------------------------------------------------

test('récupération par code de secours : une seule utilisation par code', async () => {
  const { app, facteur, post, relecteur, connecter, moi } = monter();
  const r = await relecteur();
  const ancienne = (await connecter(r.pseudo))!;
  const code = r.codes[3]!;
  // Saisie tolérante : minuscules, sans tiret.
  const ok = await post('/recuperation/code', { pseudo: r.pseudo, code: code.toLowerCase().replace('-', ''), motDePasse: NOUVEAU });
  assert.deepEqual([ok.statusCode, ok.json()], [200, { ok: true }]);
  assert.equal((await moi(ancienne)).statusCode, 401);
  assert.match(facteur.mails.at(-1)!.texte, /code de secours/);
  const nouvelle = (await connecter(r.pseudo, NOUVEAU))!;
  assert.equal((await moi(nouvelle)).json().codesSecoursRestants, 9);
  const encore = await post('/recuperation/code', { pseudo: r.pseudo, code, motDePasse: 'encore une autre phrase' });
  assert.deepEqual([encore.statusCode, encore.json()], [401, { erreur: 'code_invalide' }]);
  await app.close();
});

test("code faux, pseudo inconnu, code d'un autre compte : même refus", async () => {
  const { app, post, relecteur } = monter();
  const r = await relecteur();
  const autre = await relecteur();
  for (const [pseudo, code] of [[r.pseudo, 'ABCDE-FGHJK'], ['Inconnu_Total', r.codes[0]!], [r.pseudo, autre.codes[0]!], [r.pseudo, 'n importe quoi']]) {
    const x = await post('/recuperation/code', { pseudo, code, motDePasse: NOUVEAU });
    assert.deepEqual([x.statusCode, x.json()], [401, { erreur: 'code_invalide' }], `${pseudo} ${code}`);
  }
  await app.close();
});

test('mot de passe refusé par les règles : le code de secours n\'est pas gâché', async () => {
  const { app, post, relecteur } = monter();
  const r = await relecteur();
  const x = await post('/recuperation/code', { pseudo: r.pseudo, code: r.codes[0]!, motDePasse: 'ironmaiden123' });
  assert.deepEqual(x.json(), { erreur: 'mdp_courant' });
  // Même réponse pour un pseudo qui n'existe pas : elle ne révèle pas si un pseudo est pris.
  const inconnu = await post('/recuperation/code', { pseudo: 'Personne_Ici_42', code: r.codes[0]!, motDePasse: 'ironmaiden123' });
  assert.deepEqual([inconnu.statusCode, inconnu.json()], [x.statusCode, x.json()]);
  assert.equal((await post('/recuperation/code', { pseudo: r.pseudo, code: r.codes[0]!, motDePasse: NOUVEAU })).statusCode, 200);
  await app.close();
});

test('codes de secours : 10 essais par heure et par pseudo', async () => {
  const { app, post, relecteur } = monter();
  const r = await relecteur();
  for (let i = 0; i < 10; i++) await post('/recuperation/code', { pseudo: r.pseudo, code: 'ABCDE-FGHJK', motDePasse: NOUVEAU });
  const x = await post('/recuperation/code', { pseudo: r.pseudo, code: r.codes[0]!, motDePasse: NOUVEAU });
  assert.deepEqual([x.statusCode, x.json()], [429, { erreur: 'trop_de_demandes' }]);
  await app.close();
});

// --- Connecté ---------------------------------------------------------------------------------

test('changer son mot de passe : les autres sessions sont fermées, pas la sienne', async () => {
  const { app, facteur, post, relecteur, connecter, avec, moi } = monter();
  const r = await relecteur();
  const ici = (await connecter(r.pseudo))!;
  const ailleurs = (await connecter(r.pseudo))!;
  const faux = await post('/mot-de-passe', { ancien: 'pas le bon', nouveau: NOUVEAU }, avec(ici));
  assert.deepEqual([faux.statusCode, faux.json()], [401, { erreur: 'mot_de_passe_incorrect' }]);
  const regle = await post('/mot-de-passe', { ancien: MDP, nouveau: r.pseudo + '-2026-abc' }, avec(ici));
  assert.deepEqual(regle.json(), { erreur: 'mdp_contient_pseudo' });
  const ok = await post('/mot-de-passe', { ancien: MDP, nouveau: NOUVEAU }, avec(ici));
  assert.deepEqual([ok.statusCode, ok.json()], [200, { ok: true }]);
  assert.equal((await moi(ici)).statusCode, 200);
  assert.equal((await moi(ailleurs)).statusCode, 401);
  assert.ok(facteur.mails.some((m) => /mot de passe a été modifié/.test(m.sujet)));
  assert.ok(await connecter(r.pseudo, NOUVEAU));
  await app.close();
});

test("changer son mot de passe : connexion obligatoire, 5 erreurs de l'ancien au plus", async () => {
  const { app, post, relecteur, connecter, avec } = monter();
  assert.equal((await post('/mot-de-passe', { ancien: MDP, nouveau: NOUVEAU })).statusCode, 401);
  const r = await relecteur();
  const ici = (await connecter(r.pseudo))!;
  for (let i = 0; i < 5; i++) await post('/mot-de-passe', { ancien: 'faux', nouveau: NOUVEAU }, avec(ici));
  const x = await post('/mot-de-passe', { ancien: MDP, nouveau: NOUVEAU }, avec(ici));
  assert.deepEqual([x.statusCode, x.json()], [429, { erreur: 'trop_de_demandes' }]);
  await app.close();
});

test('régénérer les codes : mot de passe exigé, anciens codes annulés', async () => {
  const { app, facteur, post, relecteur, connecter, avec, moi } = monter();
  const r = await relecteur();
  const ici = (await connecter(r.pseudo))!;
  assert.equal((await post('/codes-secours', { motDePasse: 'faux' }, avec(ici))).statusCode, 401);
  const rep = await post('/codes-secours', { motDePasse: MDP }, avec(ici));
  assert.equal(rep.statusCode, 200);
  const nouveaux: string[] = rep.json().codesSecours;
  assert.equal(nouveaux.length, 10);
  assert.equal(nouveaux.filter((c) => r.codes.includes(c)).length, 0);
  assert.equal((await moi(ici)).json().codesSecoursRestants, 10);
  assert.match(facteur.mails.at(-1)!.sujet, /nouveaux codes de secours/);
  // Un ancien code ne marche plus, un nouveau oui.
  assert.equal((await post('/recuperation/code', { pseudo: r.pseudo, code: r.codes[0]!, motDePasse: NOUVEAU })).statusCode, 401);
  assert.equal((await post('/recuperation/code', { pseudo: r.pseudo, code: nouveaux[0]!, motDePasse: NOUVEAU })).statusCode, 200);
  await app.close();
});

// --- Rien en clair ----------------------------------------------------------------------------

test('aucun code, jeton ou mot de passe en clair dans la base, Redis ou le journal', async () => {
  const lignes: string[] = [];
  const { app, facteur, post, relecteur } = monter({ stream: new Writable({ write(c, _e, fin) { lignes.push(String(c)); fin(); } }) });
  const r = await relecteur();
  const avantDemande = facteur.mails.length;
  await post('/recuperation/demande', { mail: r.mail, turnstile: 'x' });
  await mailArrive(facteur, avantDemande);
  const lien = /#([A-Za-z0-9_-]{43})/.exec(facteur.mails.at(-1)!.texte)![1]!;
  const redisTout = JSON.stringify(await Promise.all((await redis.keys('*')).map(async (k) =>
    [k, await redis.type(k) === 'string' ? await redis.get(k.replace(/^argos:/, '')) : ''])));
  assert.ok(!redisTout.includes(lien), 'jeton de récupération en clair dans Redis');
  await post('/recuperation/nouveau-mot-de-passe', { jeton: lien, motDePasse: NOUVEAU });
  const base = proprietaire(`SELECT string_agg(code_hash, ',') FROM core.backup_codes WHERE account_id = '${r.id}'`);
  for (const c of r.codes) assert.ok(!base.includes(c) && !base.includes(c.replace('-', '')), 'code en clair dans la base');
  const journal = lignes.join('');
  for (const secret of [lien, NOUVEAU, r.mail, ...r.codes]) assert.ok(!journal.includes(secret), `journal : ${secret}`);
  await app.close();
});

test('statut annuel : rappel par mail au titulaire 30 jours avant l\'échéance, une seule fois', async () => {
  const { app, facteur, relecteur, deps } = monter();
  const r = await relecteur();
  proprietaire(`INSERT INTO core.verifications (account_id, category, expires_at) VALUES ('${r.id}', 'journalist', now() + interval '20 days')`);
  const { rappelerStatuts } = await import('../src/compte.ts');
  const avant = facteur.mails.length;
  assert.ok((await rappelerStatuts(deps)) >= 1);
  const mail = facteur.mails.slice(avant).find((m) => m.adresse === r.mail);
  assert.ok(mail && /statut de journaliste expire le/.test(mail.sujet));
  const encore = facteur.mails.length;
  await rappelerStatuts(deps);
  assert.ok(!facteur.mails.slice(encore).some((m) => m.adresse === r.mail));
  await app.close();
});
