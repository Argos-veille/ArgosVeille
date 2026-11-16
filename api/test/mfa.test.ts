// Double authentification par application (TOTP), connexion en deux temps et appareils connus.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { decrireAppareil } from '../src/appareils.ts';
import { genererCodes } from '../src/codes.ts';
import { chiffrer, hacherMotDePasse } from '../src/crypto.ts';
import { deBase32, totp } from '../src/totp.ts';
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
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

function monter() {
  const { deps, facteur } = dependances(socle);
  const app = construireApp(deps);
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload, headers });

  async function relecteur() {
    const pseudo = `Mfa_${randomInt(10_000_000, 100_000_000)}`;
    const { codes, empreintes } = genererCodes(deps.cles);
    const r = await bases.identity.query<{ id: string }>(
      'SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
      [pseudo, await hacherMotDePasse(MDP), randomBytes(32), randomBytes(32),
       chiffrer(deps.cles, `${pseudo.toLowerCase()}@proton.me`), empreintes, '192.0.2.1', null]);
    return { id: r.rows[0]!.id, pseudo, codes };
  }

  /** Cookies renvoyés par une réponse, sous forme d'en-tête « cookie » réutilisable. */
  function cookies(rep: { headers: Record<string, unknown> }, garder: Record<string, string> = {}) {
    const brut = rep.headers['set-cookie'];
    const liste = Array.isArray(brut) ? brut : brut ? [String(brut)] : [];
    const jar = { ...garder };
    for (const c of liste) {
      const [nv] = String(c).split(';');
      const i = nv!.indexOf('=');
      jar[nv!.slice(0, i)] = nv!.slice(i + 1);
    }
    return jar;
  }
  const entete = (jar: Record<string, string>) => ({ cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') });

  async function connecter(pseudo: string, jar: Record<string, string> = {}, ua = FIREFOX_LINUX) {
    const rep = await post('/connexion', { pseudo, motDePasse: MDP }, { ...entete(jar), 'user-agent': ua });
    return { rep, jar: cookies(rep, jar) };
  }

  /** Active le TOTP et renvoie le secret, avec une session ouverte. */
  async function activerTotp(r: { pseudo: string }) {
    const { jar } = await connecter(r.pseudo);
    const debut = await post('/2fa/totp/debut', { motDePasse: MDP }, entete(jar));
    assert.equal(debut.statusCode, 200, debut.body);
    const secret = deBase32(debut.json().secret);
    const conf = await post('/2fa/totp/confirmer', { code: totp(secret, Date.now()), nom: 'Téléphone' }, entete(jar));
    assert.equal(conf.statusCode, 201, conf.body);
    return { secret, jar, lien: debut.json().lien as string };
  }

  return { app, deps, facteur, post, relecteur, connecter, activerTotp, entete, cookies };
}

/** Un code TOTP valable mais différent du précédent (période suivante, tolérée à ±30 s). */
const codeSuivant = (secret: Buffer) => totp(secret, Date.now() + 30_000);

test('activation du TOTP : secret, lien, premier code, alerte', async () => {
  const { app, facteur, relecteur, activerTotp, post, entete } = monter();
  const r = await relecteur();
  const { lien, jar } = await activerTotp(r);
  assert.match(lien, new RegExp(`^otpauth://totp/Argos%20Veille%3A${r.pseudo}\\?secret=[A-Z2-7]{32}&issuer=Argos%20Veille`));
  assert.ok(facteur.mails.some((m) => /double authentification activée/.test(m.sujet)));
  const liste = await app.inject({ method: 'GET', url: '/2fa', headers: entete(jar) });
  assert.deepEqual(liste.json().methodes.map((m: { type: string; nom: string }) => [m.type, m.nom]), [['totp', 'Téléphone']]);
  const moi = await app.inject({ method: 'GET', url: '/moi', headers: entete(jar) });
  assert.deepEqual(moi.json().doubleAuthentification, ['totp']);
  // Une seule application à la fois.
  const encore = await post('/2fa/totp/debut', { motDePasse: MDP }, entete(jar));
  assert.deepEqual([encore.statusCode, encore.json()], [409, { erreur: 'deja_active' }]);
  await app.close();
});

test('activation : mot de passe exigé, mauvais code refusé, secret jamais en clair', async () => {
  const { app, relecteur, connecter, post, entete } = monter();
  const r = await relecteur();
  const { jar } = await connecter(r.pseudo);
  assert.equal((await post('/2fa/totp/debut', { motDePasse: 'faux' }, entete(jar))).statusCode, 401);
  const debut = await post('/2fa/totp/debut', { motDePasse: MDP }, entete(jar));
  const secret: string = debut.json().secret;
  const faux = await post('/2fa/totp/confirmer', { code: '000000' === totp(deBase32(secret), Date.now()) ? '111111' : '000000' }, entete(jar));
  assert.deepEqual([faux.statusCode, faux.json()], [400, { erreur: 'code_invalide' }]);
  // Ni Redis ni la base ne contiennent le secret en clair.
  for (const k of await redis.keys('*')) {
    if ((await redis.type(k)) === 'string') assert.ok(!String(await redis.get(k.replace(/^argos:/, ''))).includes(secret));
  }
  await post('/2fa/totp/confirmer', { code: totp(deBase32(secret), Date.now()) }, entete(jar));
  const base = proprietaire(`SELECT encode(totp_secret_enc, 'escape') FROM core.mfa_factors WHERE account_id = '${r.id}'`);
  assert.ok(base.length > 0 && !base.includes(secret));
  await app.close();
});

test('connexion en deux temps : mot de passe puis code, pas de session avant', async () => {
  const { app, relecteur, activerTotp, post, connecter, cookies, entete } = monter();
  const r = await relecteur();
  const { secret } = await activerTotp(r);
  const { rep } = await connecter(r.pseudo);
  assert.equal(rep.statusCode, 200);
  assert.deepEqual(rep.json().methodes, ['totp', 'code_secours']);
  assert.equal(rep.json().etape, 'double_authentification');
  assert.equal(rep.headers['set-cookie'], undefined);   // aucune session tant que le code manque
  const fin = await post('/connexion/2fa', { attente: rep.json().attente, code: codeSuivant(secret) });
  assert.deepEqual([fin.statusCode, fin.json()], [200, { pseudo: r.pseudo }]);
  const moi = await app.inject({ method: 'GET', url: '/moi', headers: entete(cookies(fin)) });
  assert.equal(moi.statusCode, 200);
  assert.equal(proprietaire(`SELECT count(*) FROM identity.legal_connection_logs WHERE account_id = '${r.id}' AND action = 'login'`), '2');
  await app.close();
});

test('un code TOTP déjà utilisé ne peut pas être rejoué', async () => {
  const { app, relecteur, activerTotp, post, connecter } = monter();
  const r = await relecteur();
  const { secret } = await activerTotp(r);
  const code = codeSuivant(secret);
  const a = (await connecter(r.pseudo)).rep.json().attente;
  assert.equal((await post('/connexion/2fa', { attente: a, code })).statusCode, 200);
  const b = (await connecter(r.pseudo)).rep.json().attente;
  const rejeu = await post('/connexion/2fa', { attente: b, code });
  assert.deepEqual([rejeu.statusCode, rejeu.json()], [401, { erreur: 'code_invalide', essaisRestants: 4 }]);
  await app.close();
});

test('code de secours à la place du TOTP : accepté une fois, codes restants indiqués', async () => {
  const { app, relecteur, activerTotp, post, connecter } = monter();
  const r = await relecteur();
  await activerTotp(r);
  const a = (await connecter(r.pseudo)).rep.json().attente;
  const ok = await post('/connexion/2fa', { attente: a, code: r.codes[0]! });
  assert.deepEqual([ok.statusCode, ok.json()], [200, { pseudo: r.pseudo, codeSecoursUtilise: true, codesSecoursRestants: 9 }]);
  const b = (await connecter(r.pseudo)).rep.json().attente;
  assert.equal((await post('/connexion/2fa', { attente: b, code: r.codes[0]! })).statusCode, 401);
  await app.close();
});

test('5 codes faux : attente annulée ; jeton inconnu ou expiré refusé', async () => {
  const { app, relecteur, activerTotp, post, connecter } = monter();
  const r = await relecteur();
  const { secret } = await activerTotp(r);
  const a = (await connecter(r.pseudo)).rep.json().attente;
  for (let i = 4; i >= 1; i--) {
    assert.deepEqual((await post('/connexion/2fa', { attente: a, code: 'ABCDE-FGHJK' })).json(), { erreur: 'code_invalide', essaisRestants: i });
  }
  assert.deepEqual((await post('/connexion/2fa', { attente: a, code: 'ABCDE-FGHJK' })).json(), { erreur: 'trop_d_essais' });
  assert.equal((await post('/connexion/2fa', { attente: a, code: codeSuivant(secret) })).statusCode, 410);
  assert.deepEqual((await post('/connexion/2fa', { attente: 'A'.repeat(43), code: '123456' })).json(), { erreur: 'attente_expiree' });
  await app.close();
});

test('les échecs du second facteur comptent pour exiger Turnstile', async () => {
  const { app, relecteur, activerTotp, post, connecter } = monter();
  const r = await relecteur();
  await activerTotp(r);
  await redis.flushdb();
  for (let i = 0; i < 5; i++) {
    const a = (await connecter(r.pseudo)).rep.json().attente;
    await post('/connexion/2fa', { attente: a, code: 'ABCDE-FGHJK' });
  }
  assert.deepEqual((await connecter(r.pseudo)).rep.json(), { erreur: 'turnstile_requis' });
  await app.close();
});

test('compte banni pendant la saisie du code : pas de session', async () => {
  const { app, relecteur, activerTotp, post, connecter } = monter();
  const r = await relecteur();
  const { secret } = await activerTotp(r);
  const a = (await connecter(r.pseudo)).rep.json().attente;
  proprietaire(`UPDATE core.accounts SET status = 'banned' WHERE id = '${r.id}'`);
  const x = await post('/connexion/2fa', { attente: a, code: codeSuivant(secret) });
  assert.deepEqual([x.statusCode, x.json()], [403, { erreur: 'compte_inactif' }]);
  assert.equal(x.headers['set-cookie'], undefined);
  await app.close();
});

test('retirer le TOTP : mot de passe et code exigés, puis connexion sans second facteur', async () => {
  const { app, facteur, relecteur, activerTotp, post, connecter, entete } = monter();
  const r = await relecteur();
  const { secret, jar } = await activerTotp(r);
  const id = (await app.inject({ method: 'GET', url: '/2fa', headers: entete(jar) })).json().methodes[0].id;
  assert.equal((await post('/2fa/retirer', { methode: id, motDePasse: 'faux', code: codeSuivant(secret) }, entete(jar))).statusCode, 401);
  assert.deepEqual((await post('/2fa/retirer', { methode: id, motDePasse: MDP, code: 'ABCDE-FGHJK' }, entete(jar))).json(),
                   { erreur: 'code_invalide' });
  assert.equal((await post('/2fa/retirer', { methode: '00000000-0000-4000-8000-000000000000', motDePasse: MDP, code: codeSuivant(secret) },
                           entete(jar))).statusCode, 404);
  const ok = await post('/2fa/retirer', { methode: id, motDePasse: MDP, code: r.codes[5]! }, entete(jar));   // code de secours
  assert.deepEqual([ok.statusCode, ok.json()], [200, { ok: true }]);
  assert.ok(facteur.mails.some((m) => /double authentification retirée/.test(m.sujet)));
  const apres = (await connecter(r.pseudo)).rep;
  assert.deepEqual(apres.json(), { pseudo: r.pseudo });
  await app.close();
});

test('nouvel appareil : alerte par mail, mais pas à la première connexion ni sur un appareil connu', async () => {
  const { app, facteur, relecteur, connecter } = monter();
  const r = await relecteur();
  const alertes = () => facteur.mails.filter((m) => /nouvel appareil/.test(m.sujet));
  const premier = await connecter(r.pseudo);                 // toute première connexion : pas d'alerte
  assert.equal(alertes().length, 0);
  assert.ok(premier.jar['__Host-argos_appareil']);
  await connecter(r.pseudo, { '__Host-argos_appareil': premier.jar['__Host-argos_appareil']! });   // même appareil
  assert.equal(alertes().length, 0);
  await connecter(r.pseudo, {}, 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36');
  assert.equal(alertes().length, 1);
  const texte = alertes()[0]!.texte;
  assert.match(texte, /depuis Chrome sous Android/);
  assert.ok(!texte.includes('127.0.0.1'));                   // ni IP ni lieu dans le mail
  // La base ne garde que des empreintes d'appareils, rien sur le navigateur.
  const colonnes = proprietaire(`SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns
                                 WHERE table_schema = 'core' AND table_name = 'known_devices'`);
  assert.equal(colonnes, 'account_id,device_hash,first_seen_at,id,last_seen_at,mfa_trusted_until');
  await app.close();
});

test("description de l'appareil", () => {
  assert.equal(decrireAppareil(FIREFOX_LINUX), 'Firefox sous Linux');
  assert.equal(decrireAppareil('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0'), 'Edge sous Windows');
  assert.equal(decrireAppareil('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari sous iOS');
  assert.equal(decrireAppareil(undefined), 'un navigateur inconnu sous un système inconnu');
});

test('fermer son compte : mot de passe + second facteur, mail, reconnexion qui annule, effacement à 30 jours', async () => {
  const { app, facteur, post, relecteur, connecter, activerTotp, entete } = monter();
  const r = await relecteur();
  const { secret, jar } = await activerTotp(r);
  assert.equal((await post('/compte/fermer', { motDePasse: 'mauvais mot de passe' }, entete(jar))).statusCode, 401);
  assert.equal((await post('/compte/fermer', { motDePasse: MDP }, entete(jar))).json().erreur, 'second_facteur_requis');
  assert.equal((await post('/compte/fermer', { motDePasse: MDP, code: '000000' }, entete(jar))).json().erreur, 'code_invalide');
  const avant = facteur.mails.length;
  const ferme = await post('/compte/fermer', { motDePasse: MDP, code: codeSuivant(secret) }, entete(jar));
  assert.equal(ferme.statusCode, 200, ferme.body);
  assert.ok(Date.parse(ferme.json().effaceLe) > Date.now() + 29 * 86_400_000);
  assert.match(facteur.mails.slice(avant).map((m) => m.texte).join(), /effacé définitivement[\s\S]*Reconnectez-vous/);
  assert.equal((await app.inject({ method: 'GET', url: '/moi', headers: entete(jar) })).statusCode, 401);   // session fermée
  assert.equal(proprietaire(`SELECT status FROM core.accounts WHERE id = '${r.id}'`), 'closing');

  // Se reconnecter (mot de passe puis code) annule la fermeture.
  const etape = await connecter(r.pseudo);
  assert.equal(etape.rep.json().etape, 'double_authentification');
  const fin = await post('/connexion/2fa', { attente: etape.rep.json().attente, code: r.codes[0]! });
  assert.equal(fin.json().fermetureAnnulee, true, fin.body);
  assert.equal(proprietaire(`SELECT status FROM core.accounts WHERE id = '${r.id}'`), 'active');

  // Refermé, puis 31 jours plus tard : effacé (pseudo libéré, identité effacée, votes détachés).
  const { jar: jar2 } = await (async () => {
    const e = await connecter(r.pseudo);
    const f = await post('/connexion/2fa', { attente: e.rep.json().attente, code: r.codes[2]! });
    return { jar: Object.fromEntries([String(f.headers['set-cookie']).split(';')[0]!.split('=')]) as Record<string, string> };
  })();
  assert.equal((await post('/compte/fermer', { motDePasse: MDP, code: r.codes[1]! }, entete(jar2))).statusCode, 200);
  proprietaire(`UPDATE core.accounts SET closing_at = now() - interval '31 days' WHERE id = '${r.id}'`);
  assert.equal(proprietaire('SELECT core.purge_closed_accounts() > 0'), 't');
  assert.equal(proprietaire(`SELECT status || '|' || (username IS NULL) FROM core.accounts WHERE id = '${r.id}'`), 'deleted|true');
  assert.equal(proprietaire(`SELECT count(*) FROM identity.account_identities WHERE account_id = '${r.id}'`), '0');
  assert.equal(proprietaire(`SELECT count(*) FROM core.credentials WHERE account_id = '${r.id}'`), '0');
  assert.equal((await connecter(r.pseudo)).rep.statusCode, 401);
  await app.close();
});

test('« ne pas me redemander pendant 30 jours » : cet appareil seulement, effacé par « se déconnecter partout », jamais pour le super-admin ni la 2FA obligatoire', async () => {
  const { relecteur, activerTotp, connecter, post, entete, cookies, app } = monter();
  const r = await relecteur();
  const { secret, jar } = await activerTotp(r);
  const premiere = await connecter(r.pseudo, jar);
  assert.equal(premiere.rep.json().etape, 'double_authentification');
  const fin = await post('/connexion/2fa', { attente: premiere.rep.json().attente, code: codeSuivant(secret), seSouvenir: true }, entete(premiere.jar));
  assert.equal(fin.statusCode, 200, fin.body);
  assert.equal(fin.json().appareilDeConfiance, true);
  const appareil = cookies(fin, premiere.jar);

  // Même appareil : le mot de passe suffit.
  const ensuite = await connecter(r.pseudo, appareil);
  assert.equal(ensuite.rep.statusCode, 200, ensuite.rep.body);
  assert.notEqual(ensuite.rep.json().etape, 'double_authentification');
  // Autre appareil (sans son témoin) : double authentification demandée.
  assert.equal((await connecter(r.pseudo, {})).rep.json().etape, 'double_authentification');
  // Le super-administrateur n'en profite jamais.
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${r.id}'`);
  assert.equal((await connecter(r.pseudo, appareil)).rep.json().etape, 'double_authentification');
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE id = '${r.id}'`);
  assert.notEqual((await connecter(r.pseudo, appareil)).rep.json().etape, 'double_authentification');
  // Ni un compte à double authentification obligatoire (journaliste…, audit A1) : case masquée, confiance ignorée.
  proprietaire(`INSERT INTO core.verifications (account_id, category, expires_at) VALUES ('${r.id}', 'journalist', now() + interval '1 year')`);
  const verifie = (await connecter(r.pseudo, appareil)).rep.json();
  assert.equal(verifie.etape, 'double_authentification');
  assert.equal(verifie.confiancePossible, false);
  const fin2 = await post('/connexion/2fa', { attente: verifie.attente, code: r.codes[0]!, seSouvenir: true }, entete(appareil));
  assert.equal(fin2.statusCode, 200, fin2.body);
  assert.equal(fin2.json().appareilDeConfiance, undefined);
  proprietaire(`DELETE FROM core.verifications WHERE account_id = '${r.id}'`);
  assert.notEqual((await connecter(r.pseudo, appareil)).rep.json().etape, 'double_authentification');
  // « Se déconnecter partout » : la confiance est effacée.
  const session = cookies(ensuite.rep, appareil);
  assert.equal((await post('/deconnexion/partout', {}, entete(session))).statusCode, 200);
  assert.equal((await connecter(r.pseudo, appareil)).rep.json().etape, 'double_authentification');
  await app.close();
});

test('N3 : le super-administrateur ne se connecte pas au site public (seulement à l\'administration)', async () => {
  const { relecteur, connecter, post, deps, app } = monter();
  const r = await relecteur();
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${r.id}'`);
  try {
    deps.reglages.administration = false;   // instance publique
    const pub = (await connecter(r.pseudo, {})).rep;
    assert.deepEqual([pub.statusCode, pub.json()], [403, { erreur: 'super_admin_administration_seulement' }]);
    // Récupération par code de secours : refusée comme un code faux, sans consommer le code.
    const recup = () => post('/recuperation/code', { pseudo: r.pseudo, code: r.codes[5]!, motDePasse: 'nouveau mot de passe très long 2026' });
    assert.deepEqual((await recup()).json(), { erreur: 'code_invalide' });
    deps.reglages.administration = true;    // instance d'administration
    assert.equal((await connecter(r.pseudo, {})).rep.statusCode, 200);
    assert.equal((await recup()).statusCode, 200);   // le même code marche depuis l'administration
  } finally {
    proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE id = '${r.id}'`);
  }
  await app.close();
});

test('fausse double authentification (développement) : « 000000 » seulement si le réglage est actif', async () => {
  const { relecteur, activerTotp, connecter, post, deps, app } = monter();
  const r = await relecteur();
  await activerTotp(r);
  const essai = async () => {
    const { rep } = await connecter(r.pseudo, {});
    return post('/connexion/2fa', { attente: rep.json().attente, code: '000000' });
  };
  assert.equal((await essai()).statusCode, 401);
  deps.reglages.deuxFacteursFactice = true;
  assert.equal((await essai()).statusCode, 200);
  await app.close();
});
