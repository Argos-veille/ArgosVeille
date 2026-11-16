// Inscription des relecteurs, de bout en bout, sur la vraie base argos_test et le vrai Redis (base 15).
import { CONDITIONS_VERSION } from '../src/conditions.ts';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { dechiffrer, empreinte } from '../src/crypto.ts';
import { dependances, preparer, proprietaire } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());   // base Redis 15 réservée aux tests
after(async () => {
  await bases.fermer();
  await redis.quit();
});

const MDP = 'cheval correct pile agrafe';

/** Un relecteur neuf, sans collision avec les tests précédents (la base argos_test est conservée). */
function nouveau() {
  const n = randomInt(10_000_000, 100_000_000);
  return {
    pseudo: `Relecteur_${n}`,
    motDePasse: MDP,
    // 061x xx xx xx : toujours un mobile de métropole valide (06 9x est réservé à l'outre-mer).
    telephone: `061${String(n).slice(1, 8)}`,
    numero: `+3361${String(n).slice(1, 8)}`,
    mail: `Relecteur.${n}+argos@gmail.com`,
    turnstile: 'jeton-turnstile', conditions: CONDITIONS_VERSION,
  };
}
type Relecteur = ReturnType<typeof nouveau>;
const corps = (r: Relecteur) => ({ pseudo: r.pseudo, motDePasse: r.motDePasse, telephone: r.telephone, mail: r.mail, turnstile: r.turnstile,
                                conditions: r.conditions });

function monter(plafondSms = 1000, journal?: { stream: NodeJS.WritableStream }) {
  const { deps, facteur, turnstile } = dependances(socle, plafondSms);
  const app = construireApp(deps, journal ? { journal } : {});
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  return { app, deps, facteur, turnstile, post };
}

async function compte(pseudo: string) {
  const r = await bases.app.query('SELECT id FROM core.accounts WHERE username = $1', [pseudo]);
  return r.rows[0]?.id as string | undefined;
}

test('parcours complet : SMS puis mail, le compte est créé', async () => {
  const { app, deps, facteur, post } = monter();
  const r = nouveau();
  const d = await post('/inscription/debut', corps(r));
  assert.equal(d.statusCode, 201, d.body);
  const { inscription } = d.json();
  assert.equal(facteur.sms_[0]!.numero, r.numero);
  assert.equal(facteur.mails[0]!.adresse, r.mail);
  assert.match(facteur.mails[0]!.texte, /^https:\/\/argos\.test\/inscription\/mail#/m);

  const s = await post('/inscription/sms', { inscription, code: facteur.dernierCode() });
  assert.deepEqual([s.statusCode, s.json()], [200, { etape: 'attente_mail' }]);
  assert.equal(await compte(r.pseudo), undefined);   // pas de compte tant que le mail n'est pas confirmé

  const m = await post('/inscription/mail', { jeton: facteur.dernierJeton() });
  assert.equal(m.statusCode, 201);
  assert.equal(m.json().compte, 'cree');
  // Les 10 codes de secours sont montrés une seule fois, ici.
  const codes: string[] = m.json().codesSecours;
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);

  const id = await compte(r.pseudo);
  assert.ok(id);
  // Conditions acceptées au début de l'inscription : version enregistrée sur le compte.
  assert.equal((await bases.app.query('SELECT terms_version FROM core.accounts WHERE id = $1', [id])).rows[0].terms_version,
               CONDITIONS_VERSION);
  const cred = await bases.app.query('SELECT password_hash FROM core.credentials WHERE account_id = $1', [id]);
  assert.match(cred.rows[0].password_hash, /^\$argon2id\$/);
  const ident = await bases.identity.query(
    'SELECT phone_hmac, email_hmac, email_enc FROM identity.account_identities WHERE account_id = $1', [id]);
  const ligne = ident.rows[0];
  assert.deepEqual(ligne.phone_hmac, empreinte(deps.cles, 'tel', r.numero));
  assert.equal(dechiffrer(deps.cles, ligne.email_enc), r.mail);   // le mail exact, pour lui écrire
  // L'inscription en cours a disparu de Redis.
  assert.deepEqual(await redis.keys('argos:inscription*'), []);
  await app.close();
});

test('ordre inverse : mail puis SMS', async () => {
  const { app, facteur, post } = monter();
  const r = nouveau();
  const { inscription } = (await post('/inscription/debut', corps(r))).json();
  const m = await post('/inscription/mail', { jeton: facteur.dernierJeton() });
  assert.deepEqual(m.json(), { etape: 'attente_sms' });
  const s = await post('/inscription/sms', { inscription, code: facteur.dernierCode() });
  assert.equal(s.statusCode, 201);
  assert.ok(await compte(r.pseudo));
  await app.close();
});

test('confirmations simultanées : un seul compte', async () => {
  const { app, facteur, post } = monter();
  const r = nouveau();
  const { inscription } = (await post('/inscription/debut', corps(r))).json();
  const [a, b] = await Promise.all([
    post('/inscription/sms', { inscription, code: facteur.dernierCode() }),
    post('/inscription/mail', { jeton: facteur.dernierJeton() }),
  ]);
  assert.equal([a, b].filter((x) => x.statusCode === 201).length, 1, `${a.body} / ${b.body}`);
  const n = await bases.app.query('SELECT count(*)::int AS n FROM core.accounts WHERE username = $1', [r.pseudo]);
  assert.equal(n.rows[0].n, 1);
  await app.close();
});

test("aucune donnée personnelle en clair dans Redis pendant l'inscription", async () => {
  const { app, facteur, post } = monter();
  const r = nouveau();
  await post('/inscription/debut', corps(r));
  const tout: string[] = [];
  for (const k of await redis.keys('*')) {
    tout.push(k);
    const type = await redis.type(k);
    if (type === 'hash') tout.push(...Object.entries(await redis.hgetall(k.replace(/^argos:/, ''))).flat());
    else if (type === 'string') tout.push((await redis.get(k.replace(/^argos:/, ''))) ?? '');
  }
  const texte = tout.join('\n');
  for (const secret of [r.numero, r.telephone, r.numero.slice(3), r.mail, r.mail.toLowerCase(), MDP,
                        facteur.dernierCode(), facteur.dernierJeton()]) {
    assert.ok(!texte.includes(secret), `trouvé en clair dans Redis : ${secret}`);
  }
  await app.close();
});

test('rien en clair dans le journal du serveur', async () => {
  const lignes: string[] = [];
  const stream = new Writable({ write(c, _e, fin) { lignes.push(String(c)); fin(); } });
  const { app, facteur, post } = monter(1000, { stream });
  const r = nouveau();
  const { inscription } = (await post('/inscription/debut', corps(r))).json();
  await post('/inscription/sms', { inscription, code: '000000' === facteur.dernierCode() ? '111111' : '000000' });
  await post('/inscription/sms', { inscription, code: facteur.dernierCode() });
  await post('/inscription/mail', { jeton: facteur.dernierJeton() });
  const journal = lignes.join('');
  assert.ok(journal.length > 0);
  for (const secret of [r.numero, r.telephone, r.mail, MDP, facteur.dernierCode(), facteur.dernierJeton(), '127.0.0.1']) {
    assert.ok(!journal.includes(secret), `trouvé dans le journal : ${secret}`);
  }
  await app.close();
});

test("journal légal : l'inscription est enregistrée avec l'IP", async () => {
  const { app, facteur, post } = monter();
  const r = nouveau();
  const { inscription } = (await post('/inscription/debut', corps(r))).json();
  await post('/inscription/sms', { inscription, code: facteur.dernierCode() });
  await post('/inscription/mail', { jeton: facteur.dernierJeton() });
  const id = await compte(r.pseudo);
  // argos_identity écrit le journal mais ne peut pas le relire : vérification avec le rôle propriétaire.
  const { execFileSync } = await import('node:child_process');
  const sortie = execFileSync('python3', ['-c',
    `import sys; sys.path.insert(0, '../db'); import migrate; ` +
    `print(migrate.psql('argos_test', "SELECT action || ' ' || host(ip) FROM identity.legal_connection_logs ` +
    `WHERE account_id = '${id}'").stdout.strip())`], { encoding: 'utf8' });
  assert.equal(sortie.trim(), 'signup 127.0.0.1');
  await app.close();
});

test('code SMS faux : 5 essais puis inscription annulée', async () => {
  const { app, facteur, post } = monter();
  const r = nouveau();
  const { inscription } = (await post('/inscription/debut', corps(r))).json();
  const bon = facteur.dernierCode();
  const faux = bon === '000000' ? '111111' : '000000';
  for (let restants = 4; restants >= 1; restants--) {
    const x = await post('/inscription/sms', { inscription, code: faux });
    assert.deepEqual([x.statusCode, x.json()], [400, { erreur: 'code_faux', essaisRestants: restants }]);
  }
  const dernier = await post('/inscription/sms', { inscription, code: faux });
  assert.deepEqual([dernier.statusCode, dernier.json()], [410, { erreur: 'trop_d_essais' }]);
  const apres = await post('/inscription/sms', { inscription, code: bon });
  assert.equal(apres.statusCode, 410);   // même le bon code ne sert plus
  // Le pseudo est libéré.
  assert.equal((await post('/inscription/debut', corps({ ...nouveau(), pseudo: r.pseudo }))).statusCode, 201);
  await app.close();
});

test('pseudo déjà pris, sans tenir compte des majuscules, y compris par une inscription en cours', async () => {
  const { app, facteur, post } = monter();
  const r = nouveau();
  const { inscription } = (await post('/inscription/debut', corps(r))).json();
  const enCours = await post('/inscription/debut', corps({ ...nouveau(), pseudo: r.pseudo.toUpperCase() }));
  assert.deepEqual([enCours.statusCode, enCours.json()], [409, { erreur: 'pseudo_pris' }]);
  await post('/inscription/sms', { inscription, code: facteur.dernierCode() });
  await post('/inscription/mail', { jeton: facteur.dernierJeton() });
  const existant = await post('/inscription/debut', corps({ ...nouveau(), pseudo: r.pseudo.toLowerCase() }));
  assert.deepEqual([existant.statusCode, existant.json()], [409, { erreur: 'pseudo_pris' }]);
  await app.close();
});

// B4 : le début de l'inscription ne dit jamais si un numéro ou un mail est déjà inscrit ; la réponse ne vient qu'à la
// fin, une fois le téléphone et le mail confirmés par leurs codes (la personne prouve qu'ils sont à elle).
async function jusquAuBout(post: (u: string, b: object) => Promise<{ statusCode: number; json: () => any }>,
                           facteur: { dernierCode: () => string; dernierJeton: () => string }, c: object) {
  const d = await post('/inscription/debut', c);
  assert.equal(d.statusCode, 201);   // rien n'est dit ici
  await post('/inscription/sms', { inscription: d.json().inscription, code: facteur.dernierCode() });
  return post('/inscription/mail', { jeton: facteur.dernierJeton() });
}

test('numéro ou mail déjà inscrit : dit seulement après confirmation, avec la récupération', async () => {
  const { app, facteur, post } = monter();
  const r = nouveau();
  const { inscription } = (await post('/inscription/debut', corps(r))).json();
  await post('/inscription/sms', { inscription, code: facteur.dernierCode() });
  await post('/inscription/mail', { jeton: facteur.dernierJeton() });

  const memeTel = await jusquAuBout(post, facteur, corps({ ...nouveau(), telephone: `+33 ${r.telephone.slice(1)}` }));
  assert.deepEqual([memeTel.statusCode, memeTel.json()], [409, { erreur: 'deja_inscrit', recuperation: true }]);
  // Variante Gmail de la même boîte : points déplacés, autre étiquette, majuscules.
  const variante = r.mail.replace('Relecteur.', 'r.e.l.e.c.t.e.u.r').replace('+argos', '+autre').toUpperCase();
  const memeMail = await jusquAuBout(post, facteur, corps({ ...nouveau(), mail: variante }));
  assert.deepEqual([memeMail.statusCode, memeMail.json()], [409, { erreur: 'deja_inscrit', recuperation: true }]);
  await app.close();
});

test('numéro ou mail banni : refus neutre, seulement après confirmation', async () => {
  const { app, facteur, post } = monter();
  const r = nouveau();
  const { inscription } = (await post('/inscription/debut', corps(r))).json();
  await post('/inscription/sms', { inscription, code: facteur.dernierCode() });
  await post('/inscription/mail', { jeton: facteur.dernierJeton() });
  await bases.identity.query('UPDATE identity.account_identities SET banned = true WHERE account_id = $1',
                             [await compte(r.pseudo)]);
  const x = await jusquAuBout(post, facteur, corps({ ...nouveau(), telephone: r.telephone }));
  assert.equal(x.statusCode >= 400, true);
  assert.ok(['refuse', 'deja_inscrit'].includes(x.json().erreur), JSON.stringify(x.json()));
  await app.close();
});

test('test anti-robot refusé : aucun SMS envoyé', async () => {
  const { app, facteur, turnstile, post } = monter();
  turnstile.accepte = false;
  const x = await post('/inscription/debut', corps(nouveau()));
  assert.deepEqual([x.statusCode, x.json()], [400, { erreur: 'turnstile' }]);
  assert.equal(facteur.sms_.length, 0);
  await app.close();
});

test('saisies refusées avant tout envoi', async () => {
  const { app, facteur, post } = monter();
  const cas: [object, string][] = [
    [{ motDePasse: 'ironmaiden123' }, 'mdp_courant'],
    [{ motDePasse: 'court' }, 'mdp_trop_court'],
    [{ telephone: '+32 470 12 34 56' }, 'telephone_pays'],
    [{ telephone: '01 23 45 67 89' }, 'telephone_non_mobile'],
    [{ mail: 'pas-un-mail' }, 'mail_invalide'],
    [{ pseudo: 'Admin_Argos' }, 'pseudo_interdit'],
    [{ pseudo: 'a b' }, 'pseudo_invalide'],
  ];
  for (const [modif, erreur] of cas) {
    const x = await post('/inscription/debut', { ...corps(nouveau()), ...modif });
    assert.deepEqual([x.statusCode, x.json()], [400, { erreur }], erreur);
  }
  const champEnTrop = await post('/inscription/debut', { ...corps(nouveau()), isSuperadmin: true });
  assert.equal(champEnTrop.statusCode, 400);
  assert.equal(facteur.sms_.length, 0);
  await app.close();
});

test('limites : 3 SMS par numéro et par jour', async () => {
  const { app, post } = monter();
  const r = nouveau();
  for (let i = 0; i < 3; i++) {
    // Nouveau pseudo et nouveau mail à chaque fois, même numéro.
    const x = await post('/inscription/debut', corps({ ...nouveau(), telephone: r.telephone }));
    assert.equal(x.statusCode, 201, x.body);
  }
  const x = await post('/inscription/debut', corps({ ...nouveau(), telephone: r.telephone }));
  assert.deepEqual([x.statusCode, x.json()], [429, { erreur: 'trop_de_demandes' }]);
  await app.close();
});

test('limites : 10 demandes par heure et par adresse IP', async () => {
  const { app, post } = monter();
  for (let i = 0; i < 10; i++) assert.equal((await post('/inscription/debut', corps(nouveau()))).statusCode, 201);
  const x = await post('/inscription/debut', corps(nouveau()));
  assert.equal(x.statusCode, 429);
  await app.close();
});

test('plafond quotidien de SMS pour tout le site', async () => {
  const { app, post } = monter(2);
  assert.equal((await post('/inscription/debut', corps(nouveau()))).statusCode, 201);
  assert.equal((await post('/inscription/debut', corps(nouveau()))).statusCode, 201);
  const x = await post('/inscription/debut', corps(nouveau()));
  assert.deepEqual([x.statusCode, x.json()], [503, { erreur: 'sms_indisponible' }]);
  await app.close();
});

test("échec d'envoi : rien ne reste, le pseudo est libéré", async () => {
  const { app, facteur, post } = monter();
  const r = nouveau();
  facteur.enPanne = true;
  const x = await post('/inscription/debut', corps(r));
  assert.deepEqual([x.statusCode, x.json()], [503, { erreur: 'envoi_impossible' }]);
  assert.deepEqual(await redis.keys('argos:inscription*'), []);
  facteur.enPanne = false;
  assert.equal((await post('/inscription/debut', corps({ ...nouveau(), pseudo: r.pseudo }))).statusCode, 201);
  await app.close();
});

test('lien mail inconnu ou inscription inconnue : expiré', async () => {
  const { app, post } = monter();
  const x = await post('/inscription/mail', { jeton: 'A'.repeat(43) });
  assert.deepEqual([x.statusCode, x.json()], [410, { erreur: 'lien_expire' }]);
  const y = await post('/inscription/sms', { inscription: '00000000-0000-4000-8000-000000000000', code: '123456' });
  assert.deepEqual([y.statusCode, y.json()], [410, { erreur: 'inscription_expiree' }]);
  const z = await post('/inscription/sms', { inscription: 'pas-un-uuid', code: '123456' });
  assert.equal(z.statusCode, 400);
  await app.close();
});

test("conditions d'utilisation périmées : refus avant tout SMS", async () => {
  const { app, facteur, post } = monter();
  const x = await post('/inscription/debut', { ...corps(nouveau()), conditions: '2000-01-01' });
  assert.deepEqual([x.statusCode, x.json()], [409, { erreur: 'conditions_perimees', version: CONDITIONS_VERSION }]);
  assert.equal(facteur.sms_.length, 0);
  await app.close();
});

test('code de compte spécial à l’inscription : code faux refusé ; statut vérifié mis en attente de la double authentification', async () => {
  const { app, deps, facteur, post } = monter();
  const { nouveauCodeBeta, normaliserCodeBeta } = await import('../src/beta.ts');
  const code = nouveauCodeBeta();
  proprietaire(`INSERT INTO core.account_codes (code_hmac, label, category)
                VALUES ('\\x${empreinte(deps.cles, 'code-compte', normaliserCodeBeta(code)!).toString('hex')}', 'Maître X', 'lawyer')`);

  assert.deepEqual((await post('/inscription/debut', { ...corps(nouveau()), codeInvitation: 'AAAA-BBBB-CCCC' })).json(),
                   { erreur: 'code_invitation_invalide' });
  const r = nouveau();
  const d = await post('/inscription/debut', { ...corps(r), codeInvitation: code.toLowerCase() });
  assert.equal(d.statusCode, 201, d.body);
  await post('/inscription/sms', { inscription: d.json().inscription, code: facteur.dernierCode() });
  const m = await post('/inscription/mail', { jeton: facteur.dernierJeton() });
  // Statut vérifié : double authentification obligatoire (0102), que le compte n'a pas encore. Le compte est créé,
  // le code n'est pas consommé : il sera saisi dans « Mon compte » une fois la double authentification activée.
  assert.deepEqual([m.statusCode, m.json().certification, m.json().certificationEnAttente], [201, undefined, true]);
  const id = await compte(r.pseudo);
  assert.equal(proprietaire(`SELECT count(*) FROM core.verifications WHERE account_id = '${id}'`), '0');
  assert.equal(proprietaire(`SELECT used_by IS NULL FROM core.account_codes WHERE label = 'Maître X' ORDER BY created_at DESC LIMIT 1`), 't');
  await app.close();
});
