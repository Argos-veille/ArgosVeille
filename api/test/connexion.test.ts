// Connexion, sessions et déconnexion, sur la vraie base argos_test et le vrai Redis (base 15).
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { hacherMotDePasse } from '../src/crypto.ts';
import { COOKIE } from '../src/sessions.ts';
import { dependances, preparer, proprietaire } from './aide.ts';
import { CONDITIONS_VERSION } from '../src/conditions.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

const MDP = 'cheval correct pile agrafe';

/** Crée directement un relecteur (l'inscription est testée à part). */
async function relecteur(): Promise<{ id: string; pseudo: string }> {
  const pseudo = `Connexion_${randomInt(10_000_000, 100_000_000)}`;
  const r = await bases.identity.query<{ id: string }>(
    'SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(MDP), randomBytes(32), randomBytes(32), randomBytes(40),
     Array.from({ length: 10 }, () => randomBytes(32).toString('hex')), '192.0.2.1', null]);
  return { id: r.rows[0]!.id, pseudo };
}

function monter(journal?: { stream: NodeJS.WritableStream }) {
  const { deps, turnstile } = dependances(socle);
  const app = construireApp(deps, journal ? { journal } : {});
  return { app, turnstile };
}

const connexion = (app: ReturnType<typeof construireApp>, pseudo: string, motDePasse: string, plus: object = {}) =>
  app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse, ...plus } });

function jetonDe(rep: { headers: Record<string, unknown> }): string {
  const c = String(rep.headers['set-cookie']);
  const m = new RegExp(`^${COOKIE}=([A-Za-z0-9_-]{43});`).exec(c);
  assert.ok(m, `cookie de session absent : ${c}`);
  return m[1]!;
}
const avec = (jeton: string) => ({ cookie: `${COOKIE}=${jeton}` });

test('connexion réussie : cookie protégé, session valide', async () => {
  const { app } = monter();
  const r = await relecteur();
  const rep = await connexion(app, r.pseudo.toUpperCase(), MDP);   // pseudo insensible à la casse
  assert.deepEqual([rep.statusCode, rep.json()], [200, { pseudo: r.pseudo }]);
  const cookie = String(rep.headers['set-cookie']);
  for (const attribut of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) {
    assert.ok(cookie.includes(attribut), attribut);
  }
  assert.ok(!/Domain=/i.test(cookie));
  const moi = await app.inject({ method: 'GET', url: '/moi', headers: avec(jetonDe(rep)) });
  assert.equal(moi.statusCode, 200);
  assert.equal(moi.json().pseudo, r.pseudo);
  await app.close();
});

test('la base ne garde que l\'empreinte du jeton', async () => {
  const { app } = monter();
  const r = await relecteur();
  const jeton = jetonDe(await connexion(app, r.pseudo, MDP));
  const brut = Buffer.from(jeton, 'base64url');
  // Lu par le propriétaire de la base : le site, lui, ne peut pas lire les empreintes de session (0115).
  const [id, empreinte] = proprietaire(`SELECT id::text || '|' || encode(token_hash, 'hex') FROM core.sessions WHERE account_id = '${r.id}'`).split('|');
  assert.ok(id && empreinte);
  assert.notEqual(empreinte, brut.toString('hex'));
  assert.ok(!id.includes(jeton));
  await bases.app.query('SELECT token_hash FROM core.sessions LIMIT 1').then(() => assert.fail('empreintes lisibles par le site'), (x: { code?: string }) => assert.equal(x.code, '42501'));
  await app.close();
});

test('mauvais mot de passe et pseudo inconnu : même réponse', async () => {
  const { app } = monter();
  const r = await relecteur();
  const a = await connexion(app, r.pseudo, 'mauvais mot de passe');
  const b = await connexion(app, 'Pseudo_Qui_N_Existe_Pas', MDP);
  assert.deepEqual([a.statusCode, a.json()], [401, { erreur: 'identifiants_incorrects' }]);
  assert.deepEqual([b.statusCode, b.json()], [401, { erreur: 'identifiants_incorrects' }]);
  assert.equal(a.headers['set-cookie'], undefined);
  await app.close();
});

test('pseudo inconnu : le calcul Argon2 a bien lieu (pas de réponse instantanée)', async () => {
  const { app } = monter();
  const r = await relecteur();
  await connexion(app, 'Echauffement_1', MDP);   // l'empreinte factice est calculée au premier appel
  const mesurer = async (pseudo: string) => {
    const t = performance.now();
    await connexion(app, pseudo, 'mauvais mot de passe');
    return performance.now() - t;
  };
  const inconnu = Math.min(await mesurer('Inconnu_A'), await mesurer('Inconnu_B'), await mesurer('Inconnu_C'));
  const connu = Math.min(await mesurer(r.pseudo), await mesurer(r.pseudo), await mesurer(r.pseudo));
  assert.ok(inconnu > connu / 3, `inconnu ${inconnu.toFixed(1)} ms, connu ${connu.toFixed(1)} ms`);
  await app.close();
});

test('5 échecs sur un compte : Turnstile exigé, puis connexion possible avec', async () => {
  const { app, turnstile } = monter();
  const r = await relecteur();
  for (let i = 0; i < 5; i++) assert.equal((await connexion(app, r.pseudo, 'faux')).statusCode, 401);
  const sans = await connexion(app, r.pseudo, MDP);
  assert.deepEqual([sans.statusCode, sans.json()], [400, { erreur: 'turnstile_requis' }]);
  turnstile.accepte = false;
  assert.equal((await connexion(app, r.pseudo, MDP, { turnstile: 'x' })).statusCode, 400);
  turnstile.accepte = true;
  const avecT = await connexion(app, r.pseudo, MDP, { turnstile: 'x' });
  assert.equal(avecT.statusCode, 200);
  // Le compteur repart à zéro après une connexion réussie.
  assert.equal((await connexion(app, r.pseudo, MDP)).statusCode, 200);
  await app.close();
});

test('20 échecs par heure depuis une IP : refus temporaire', async () => {
  const { app } = monter();
  for (let i = 0; i < 20; i++) await connexion(app, `Inconnu_${i}`, 'faux');
  const r = await relecteur();
  const x = await connexion(app, r.pseudo, MDP);
  assert.deepEqual([x.statusCode, x.json()], [429, { erreur: 'trop_de_demandes' }]);
  await app.close();
});

test('compte suspendu : connexion refusée avec la date de fin ; suspension terminée : acceptée', async () => {
  const { app } = monter();
  const r = await relecteur();
  proprietaire(`UPDATE core.accounts SET status = 'suspended', suspended_until = '2099-01-01T00:00:00Z' WHERE id = '${r.id}'`);
  const x = await connexion(app, r.pseudo, MDP);
  assert.deepEqual([x.statusCode, x.json()], [403, { erreur: 'compte_suspendu', jusquau: '2099-01-01T00:00:00.000Z' }]);
  // Le statut n'est pas révélé sans le bon mot de passe.
  assert.equal((await connexion(app, r.pseudo, 'faux')).json().erreur, 'identifiants_incorrects');
  proprietaire(`UPDATE core.accounts SET suspended_until = now() - interval '1 minute' WHERE id = '${r.id}'`);
  assert.equal((await connexion(app, r.pseudo, MDP)).statusCode, 200);
  await app.close();
});

test('compte banni : connexion refusée, et la session déjà ouverte est coupée', async () => {
  const { app } = monter();
  const r = await relecteur();
  const jeton = jetonDe(await connexion(app, r.pseudo, MDP));
  proprietaire(`UPDATE core.accounts SET status = 'banned' WHERE id = '${r.id}'`);
  const moi = await app.inject({ method: 'GET', url: '/moi', headers: avec(jeton) });
  assert.deepEqual([moi.statusCode, moi.json()], [401, { erreur: 'non_connecte' }]);
  const n = await bases.app.query('SELECT count(*)::int AS n FROM core.sessions WHERE account_id = $1 AND revoked_at IS NULL', [r.id]);
  assert.equal(n.rows[0].n, 0);
  assert.deepEqual((await connexion(app, r.pseudo, MDP)).json(), { erreur: 'compte_banni' });
  await app.close();
});

test('déconnexion : la session ne sert plus', async () => {
  const { app } = monter();
  const r = await relecteur();
  const jeton = jetonDe(await connexion(app, r.pseudo, MDP));
  const d = await app.inject({ method: 'POST', url: '/deconnexion', headers: avec(jeton) });
  assert.equal(d.statusCode, 200);
  assert.match(String(d.headers['set-cookie']), /Max-Age=0/);
  assert.equal((await app.inject({ method: 'GET', url: '/moi', headers: avec(jeton) })).statusCode, 401);
  await app.close();
});

test('déconnexion partout : toutes les sessions du compte, et seulement elles', async () => {
  const { app } = monter();
  const r = await relecteur();
  const autre = await relecteur();
  const j1 = jetonDe(await connexion(app, r.pseudo, MDP));
  const j2 = jetonDe(await connexion(app, r.pseudo, MDP));
  const jAutre = jetonDe(await connexion(app, autre.pseudo, MDP));
  const d = await app.inject({ method: 'POST', url: '/deconnexion/partout', headers: avec(j1) });
  assert.deepEqual(d.json(), { sessionsFermees: 2 });
  assert.equal((await app.inject({ method: 'GET', url: '/moi', headers: avec(j2) })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/moi', headers: avec(jAutre) })).statusCode, 200);
  await app.close();
});

test('session expirée ou inactive depuis 7 jours : refusée', async () => {
  const { app } = monter();
  const r = await relecteur();
  const j1 = jetonDe(await connexion(app, r.pseudo, MDP));
  proprietaire(`UPDATE core.sessions SET last_seen_at = now() - interval '8 days' WHERE account_id = '${r.id}'`);
  assert.equal((await app.inject({ method: 'GET', url: '/moi', headers: avec(j1) })).statusCode, 401);
  const j2 = jetonDe(await connexion(app, r.pseudo, MDP));
  proprietaire(`UPDATE core.sessions SET created_at = now() - interval '31 days', expires_at = now() - interval '1 day'
                WHERE account_id = '${r.id}' AND revoked_at IS NULL AND last_seen_at > now() - interval '1 day'`);
  assert.equal((await app.inject({ method: 'GET', url: '/moi', headers: avec(j2) })).statusCode, 401);
  await app.close();
});

test('cookie absent, inventé ou modifié : refusé', async () => {
  const { app } = monter();
  const r = await relecteur();
  const jeton = jetonDe(await connexion(app, r.pseudo, MDP));
  const modifie = (jeton[0] === 'A' ? 'B' : 'A') + jeton.slice(1);
  for (const headers of [{}, avec('x'.repeat(43)), avec(modifie), avec(`${jeton}'; DROP TABLE x;--`), { cookie: 'autre=1' }]) {
    const x = await app.inject({ method: 'GET', url: '/moi', headers });
    assert.equal(x.statusCode, 401, JSON.stringify(headers));
  }
  await app.close();
});

test("requête venant d'un autre site refusée", async () => {
  const { app } = monter();
  const r = await relecteur();
  const jeton = jetonDe(await connexion(app, r.pseudo, MDP));
  const x = await app.inject({ method: 'POST', url: '/deconnexion/partout',
                               headers: { ...avec(jeton), origin: 'https://site-malveillant.example' } });
  assert.deepEqual([x.statusCode, x.json()], [403, { erreur: 'origine_refusee' }]);
  assert.equal((await app.inject({ method: 'GET', url: '/moi', headers: avec(jeton) })).statusCode, 200);
  const ok = await app.inject({ method: 'POST', url: '/deconnexion', headers: { ...avec(jeton), origin: 'https://argos.test' } });
  assert.equal(ok.statusCode, 200);
  // Un formulaire HTML classique (pas du JSON) est refusé.
  const form = await app.inject({ method: 'POST', url: '/connexion', headers: { 'content-type': 'application/x-www-form-urlencoded' },
                                  payload: `pseudo=${r.pseudo}&motDePasse=${MDP}` });
  assert.equal(form.statusCode, 415);
  await app.close();
});

test('journal légal : chaque connexion est enregistrée', async () => {
  const { app } = monter();
  const r = await relecteur();
  await connexion(app, r.pseudo, MDP);
  await connexion(app, r.pseudo, 'faux');   // un échec n'est pas une connexion
  assert.equal(proprietaire(`SELECT string_agg(action || ' ' || host(ip), ',' ORDER BY id) FROM identity.legal_connection_logs
                             WHERE account_id = '${r.id}'`), 'signup 192.0.2.1,login 127.0.0.1');
  await app.close();
});

test('rien en clair dans le journal du serveur', async () => {
  const lignes: string[] = [];
  const { app } = monter({ stream: new Writable({ write(c, _e, fin) { lignes.push(String(c)); fin(); } }) });
  const r = await relecteur();
  const jeton = jetonDe(await connexion(app, r.pseudo, MDP));
  await connexion(app, r.pseudo, 'mauvais mot de passe secret');
  await app.inject({ method: 'GET', url: '/moi', headers: avec(jeton) });
  const journal = lignes.join('');
  for (const secret of [MDP, 'mauvais mot de passe secret', jeton, '127.0.0.1"']) {
    assert.ok(!journal.includes(secret), `trouvé dans le journal : ${secret}`);
  }
  await app.close();
});

test("conditions d'utilisation : un compte qui ne les a pas acceptées doit le faire, version en vigueur seulement", async () => {
  const { app } = monter();
  const r = await relecteur();   // créé directement en base : aucune version acceptée
  const jeton = jetonDe(await connexion(app, r.pseudo, MDP));
  const moi = async () => (await app.inject({ method: 'GET', url: '/moi', headers: avec(jeton) })).json();
  assert.equal((await moi()).conditionsAAccepter, CONDITIONS_VERSION);

  const perimee = await app.inject({ method: 'POST', url: '/compte/conditions', headers: avec(jeton), payload: { version: '2000-01-01' } });
  assert.deepEqual([perimee.statusCode, perimee.json()], [409, { erreur: 'conditions_perimees', version: CONDITIONS_VERSION }]);
  assert.equal((await moi()).conditionsAAccepter, CONDITIONS_VERSION);

  const ok = await app.inject({ method: 'POST', url: '/compte/conditions', headers: avec(jeton), payload: { version: CONDITIONS_VERSION } });
  assert.equal(ok.statusCode, 200);
  assert.equal((await moi()).conditionsAAccepter, undefined);
  assert.equal(proprietaire(`SELECT terms_version || (terms_accepted_at IS NOT NULL) FROM core.accounts WHERE id = '${r.id}'`),
               `${CONDITIONS_VERSION}true`);

  // Sans session : refusé.
  assert.equal((await app.inject({ method: 'POST', url: '/compte/conditions', payload: { version: CONDITIONS_VERSION } })).statusCode, 401);
  await app.close();
});

test('secret de connexion (0101) : un compte d’avant bascule à sa première connexion, puis seul le secret marche', async () => {
  const { app } = monter();
  const r = await relecteur();
  proprietaire(`UPDATE core.credentials SET password_scheme = 0 WHERE account_id = '${r.id}'`);   // compte d'avant
  const secret = 'S'.repeat(43);   // ce que le navigateur tire du mot de passe
  // Le navigateur envoie d'abord le secret : le serveur ne peut pas le vérifier et demande la bascule.
  assert.deepEqual([(await connexion(app, r.pseudo, secret)).statusCode, (await connexion(app, r.pseudo, secret)).json().erreur],
                   [409, 'mot_de_passe_a_convertir']);
  // Mauvais mot de passe pendant la bascule : refusé, rien ne change.
  assert.equal((await connexion(app, r.pseudo, 'mauvais mot de passe', { nouveauSecret: secret })).statusCode, 401);
  assert.equal(proprietaire(`SELECT password_scheme FROM core.credentials WHERE account_id = '${r.id}'`), '0');
  // Le mot de passe une dernière fois, avec le secret qui le remplace.
  assert.equal((await connexion(app, r.pseudo, MDP, { nouveauSecret: secret })).statusCode, 200);
  assert.equal(proprietaire(`SELECT password_scheme FROM core.credentials WHERE account_id = '${r.id}'`), '1');
  assert.equal((await connexion(app, r.pseudo, secret)).statusCode, 200);
  assert.equal((await connexion(app, r.pseudo, MDP)).statusCode, 401);   // le mot de passe lui-même ne sert plus
  // Compte inconnu : réponse ordinaire, pas de demande de bascule.
  assert.equal((await connexion(app, `Inconnu_${randomInt(1e6, 1e7)}`, secret)).json().erreur, 'identifiants_incorrects');
  await app.close();
});

test('compte d’avant le secret (H6) : les demandes de bascule comptent comme des échecs, pas d’essais illimités', async () => {
  const { app } = monter();
  const r = await relecteur();
  proprietaire(`UPDATE core.credentials SET password_scheme = 0 WHERE account_id = '${r.id}'`);
  const codes = new Set<number>();
  for (let i = 0; i < 12; i++) codes.add((await connexion(app, r.pseudo, `essai ${i}`)).statusCode);
  // Au bout de quelques essais, la vérification anti-robot (400) ou la limite par adresse (429) s'impose.
  assert.ok(codes.has(400) || codes.has(429), [...codes].join(','));
  await app.close();
});
