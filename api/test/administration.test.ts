// Administration A1 : session d'administration ouverte par la clé physique, tableau de bord, rapports de bug.
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
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

type App = ReturnType<typeof construireApp>;

async function compte(app: App, deps: ReturnType<typeof dependances>['deps']) {
  const pseudo = `Admin_${randomInt(10_000_000, 100_000_000)}`;
  const mdp = 'cheval correct pile agrafe';
  const r = await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(mdp), randomBytes(32), randomBytes(32), chiffrer(deps.cles, `${pseudo.toLowerCase()}@exemple.fr`),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null]);
  const rep = await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: mdp } });
  return { id: r.rows[0]!.id, mdp, headers: { cookie: String(rep.headers['set-cookie']).split(';')[0]! } };
}

test("session d'administration : clé physique exigée, puis tableau de bord et rapports de bug", async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  const autre = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (methode: 'GET' | 'POST', url: string, qui = admin, payload?: object) =>
    app.inject({ method: methode, url, headers: qui.headers, ...(payload ? { payload } : {}) });
  const debut = await req('POST', '/2fa/cle/debut', admin, { motDePasse: admin.mdp });
  await req('POST', '/2fa/cle/confirmer', admin, { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });

  assert.deepEqual((await req('GET', '/admin/tableau-de-bord')).json(), { erreur: 'session_admin_requise' });
  assert.deepEqual((await req('GET', '/admin/session')).json(), { superAdmin: true, ouverte: false, expireDans: 0 });
  assert.equal((await req('GET', '/admin/tableau-de-bord', autre)).statusCode, 403);
  assert.deepEqual((await req('GET', '/admin/session', autre)).json(), { superAdmin: false, ouverte: false, expireDans: 0 });

  const o = (await req('POST', '/admin/decision/defi', admin, {})).json().options;
  const ouverture = await req('POST', '/admin/session', admin, { cle: cle.prouver(o) });
  assert.deepEqual(ouverture.json(), { ok: true, expireDans: 600 });
  assert.equal((await req('GET', '/admin/session')).json().ouverte, true);

  const t = (await req('GET', '/admin/tableau-de-bord')).json();
  assert.ok(['aTraiter', 'videos', 'communaute', 'sante'].every((k) => k in t));
  assert.equal(typeof t.relecture.disponibles, 'number');
  assert.ok(['votees', 'passees', 'expirees', 'enAttente'].every((k) => typeof t.relecture.convocations30j[k] === 'number'));
  assert.ok(['recues24h', 'recues7j', 'avecCompte7j', 'echecs7j', 'doublons7j'].every((k) => typeof t.envois[k] === 'number'));
  assert.equal(typeof t.sante.journalIntact, 'boolean');
  assert.ok(Array.isArray((await req('GET', '/admin/alertes')).json().juresManquants));

  // Un rapport de bug avec une capture et un numéro de requête dont le serveur a gardé l'erreur.
  const requete = '11111111-2222-4333-8444-555555555555';
  proprietaire(`INSERT INTO core.request_errors (request_id, method, route, status, error_name, message, stack)
                VALUES ('${requete}', 'POST', '/relecture/:convocation/vote', 500, 'Error', 'panne simulée', 'pile')`);
  const image = `data:image/jpeg;base64,${randomBytes(500).toString('base64')}`;
  await app.inject({ method: 'POST', url: '/bugs', payload: {
    theme: 'securite', sousTheme: 'faille', description: 'Essai de rapport.', page: '/relecture/[convocation]', pageSource: false,
    joindrePseudo: true, capture: image, telemetrie: { version: 'x', appels: [{ route: 'POST /relecture/:id/vote', statut: 500, requete }] },
  }, headers: autre.headers });
  const liste = (await req('GET', '/admin/bugs')).json().rapports;
  const b = liste.find((x: { extrait: string }) => x.extrait === 'Essai de rapport.');
  assert.deepEqual([b.urgent, b.capture, b.theme], [true, true, 'securite']);
  assert.equal(liste[0].urgent, true);   // les urgents d'abord
  const detail = (await req('GET', `/admin/bugs/${b.id}`)).json();
  assert.equal(detail.capture, image);
  assert.equal(detail.erreursServeur[0].message, 'panne simulée');
  assert.equal((await req('POST', `/admin/bugs/${b.id}/statut`, admin, { statut: 'handled' })).statusCode, 200);
  assert.ok(!(await req('GET', '/admin/bugs')).json().rapports.some((x: { id: string }) => x.id === b.id));
  assert.ok((await req('GET', '/admin/bugs?statut=handled')).json().rapports.some((x: { id: string }) => x.id === b.id));

  // Le site seul ne lit toujours pas les rapports ; la session d'administration se ferme.
  await assert.rejects(bases.app.query('SELECT * FROM core.bug_reports'), /permission|droit/);
  await req('POST', '/admin/session/fin', admin, {});
  assert.equal((await req('GET', '/admin/tableau-de-bord')).statusCode, 401);
  await app.close();
});

test("session d'administration : fermée après 10 minutes sans activité", async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const session = proprietaire(`SELECT id FROM core.sessions WHERE account_id = '${admin.id}' ORDER BY created_at DESC LIMIT 1`);
  proprietaire(`INSERT INTO core.admin_sessions (session_id, started_at, last_at) VALUES ('${session}', now() - interval '11 minutes', now() - interval '11 minutes')`);
  assert.equal((await app.inject({ method: 'GET', url: '/admin/tableau-de-bord', headers: admin.headers })).statusCode, 401);
  await app.close();
});

test("fiche d'administration d'une vidéo : contexte, totaux des votes, signalements, journal", async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const session = proprietaire(`SELECT id FROM core.sessions WHERE account_id = '${admin.id}' ORDER BY created_at DESC LIMIT 1`);
  proprietaire(`INSERT INTO core.admin_sessions (session_id) VALUES ('${session}') ON CONFLICT (session_id) DO UPDATE SET started_at = now(), last_at = now()`);
  const vid = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status, review_started_at, category, description)
                VALUES ('${vid}', 'in_review', now(), 'violence', 'Vidéo pour la fiche admin');
                INSERT INTO core.reports (video_id, severity, reason_code, details)
                VALUES ('${vid}', 'serious', 'visible_identity', 'Visage d''un passant visible à 0:03.')`);
  const req = (methode: 'GET' | 'POST', url: string) => app.inject({ method: methode, url, headers: admin.headers, ...(methode === 'POST' ? { payload: {} } : {}) });

  const liste = (await req('GET', '/admin/videos?statut=in_review')).json().videos;
  const v = liste.find((x: { id: string }) => x.id === vid);
  assert.deepEqual([v.statut, v.signalements, v.gelLegal], ['in_review', 1, false]);
  assert.equal((await req('GET', '/admin/videos?statut=nimporte')).statusCode, 400);
  assert.ok((await req('GET', '/admin/videos?signalees=true&categorie=violence&texte=fiche%20admin')).json().videos.some((x: { id: string }) => x.id === vid));
  assert.ok(!(await req('GET', '/admin/videos?gel=true&texte=fiche%20admin')).json().videos.some((x: { id: string }) => x.id === vid));
  assert.ok(!(await req('GET', '/admin/videos?du=2099-01-01')).json().videos.some((x: { id: string }) => x.id === vid));

  const f = (await req('GET', `/admin/videos/${vid}`)).json();
  assert.equal(f.description, 'Vidéo pour la fiche admin');
  assert.deepEqual(f.votes, {});
  assert.equal(f.signalements[0].motif, 'visible_identity');
  assert.ok(Array.isArray(f.journal) && Array.isArray(f.notes));
  assert.ok(!JSON.stringify(f).includes('account'));   // aucun lien vote-compte
  assert.match((await req('POST', `/admin/videos/${vid}/video`)).json().lien, /^\/apercu\//);
  assert.equal((await req('GET', `/admin/videos/${randomUUID()}`)).statusCode, 404);
  await app.close();
});

test("signalements depuis un compte, classement avec mail à la personne, masquage et retrait légal", async () => {
  const { deps, facteur } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  const membre = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (methode: 'GET' | 'POST', url: string, qui = admin, payload?: object) =>
    app.inject({ method: methode, url, headers: qui.headers, ...(payload ? { payload } : {}) });
  const debut = await req('POST', '/2fa/cle/debut', admin, { motDePasse: admin.mdp });
  await req('POST', '/2fa/cle/confirmer', admin, { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });
  const o = (await req('POST', '/admin/decision/defi', admin, {})).json().options;
  await req('POST', '/admin/session', admin, { cle: cle.prouver(o) });
  const avecCle = async (url: string, corps: object) =>
    req('POST', url, admin, { ...corps, cle: cle.prouver((await req('POST', '/admin/decision/defi', admin, {})).json().options) });

  const vid = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status, decided_at, category, description)
                VALUES ('${vid}', 'published', now(), 'violence', 'Vidéo publique à signaler')`);

  // Signaler : un compte connecté, une fois par vidéo tant que c'est ouvert.
  assert.equal((await app.inject({ method: 'POST', url: `/videos/${vid}/signaler`, payload: { motif: 'defamation' } })).statusCode, 401);
  assert.equal((await req('POST', `/videos/${vid}/signaler`, membre, { motif: 'other' })).json().erreur, 'details');
  assert.equal((await req('POST', `/videos/${vid}/signaler`, membre, { motif: 'visible_identity', details: 'Visage à 0:03.\nÀ droite de l’image.' })).statusCode, 200);
  assert.equal((await req('POST', `/videos/${vid}/signaler`, membre, { motif: 'defamation' })).json().erreur, 'deja_signale');

  const liste = (await req('GET', '/admin/signalements')).json().signalements;
  const s = liste.find((x: { video: string }) => x.video === vid);
  assert.deepEqual([s.gravite, s.motif, s.origine], ['serious', 'visible_identity', 'compte']);
  assert.ok(!('auteur' in s) && !JSON.stringify(s).includes(membre.id));   // jamais qui a signalé

  // Masquer : la fiche publique répond « masquée », sans rien montrer ; rétablir la remet.
  assert.equal((await avecCle(`/admin/videos/${vid}/moderation`, { action: 'masquer', motif: 'court' })).json().erreur, 'motif');
  assert.equal((await avecCle(`/admin/videos/${vid}/moderation`, { action: 'masquer', motif: 'Examen du visage signalé.' })).statusCode, 200);
  assert.deepEqual([(await app.inject({ method: 'GET', url: `/public/videos/${vid}` })).statusCode,
                    (await app.inject({ method: 'GET', url: `/public/videos/${vid}` })).json()], [410, { erreur: 'video_masquee' }]);
  assert.equal((await req('POST', `/admin/videos/${vid}/moderation`, admin, { action: 'retablir', motif: 'Floutage vérifié.', cle: cle.prouver(o) })).json().erreur, 'cle_invalide');
  assert.equal((await avecCle(`/admin/videos/${vid}/moderation`, { action: 'retablir', motif: 'Floutage vérifié, visage invisible.' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/public/videos/${vid}` })).statusCode, 200);

  // Classer le signalement : la personne reçoit la réponse par mail.
  const avant = facteur.mails.length;
  const c = await req('POST', `/admin/signalements/${s.id}`, admin, { statut: 'handled', note: 'Floutage vérifié image par image.' });
  assert.deepEqual(c.json(), { ok: true, prevenu: true });
  assert.match(facteur.mails.slice(avant).map((m) => m.texte).join(), /Floutage vérifié image par image/);
  assert.equal((await req('POST', `/admin/signalements/${s.id}`, admin, { statut: 'handled', note: 'Encore une fois.' })).statusCode, 404);

  // Gel légal puis retrait légal : fiche « retirée », journal avec le motif.
  assert.equal((await avecCle(`/admin/videos/${vid}/moderation`, { action: 'geler', motif: 'Réquisition judiciaire reçue.' })).statusCode, 200);
  assert.equal((await avecCle(`/admin/videos/${vid}/moderation`, { action: 'geler', motif: 'Réquisition judiciaire reçue.' })).json().erreur, 'deja_ainsi');
  assert.equal((await avecCle(`/admin/videos/${vid}/moderation`, { action: 'retirer', motif: 'Décision de justice du 5 novembre.' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/public/videos/${vid}` })).json().erreur, 'video_retiree');
  assert.equal(proprietaire(`SELECT status || '|' || legal_hold || '|' || decided_by_stage FROM core.videos WHERE id = '${vid}'`), 'removed|true|legal');
  assert.equal(proprietaire(`SELECT count(*) FROM ledger.entries WHERE kind = 'admin_action' AND payload ->> 'video' = '${vid}'`), '4');
  assert.equal((await avecCle(`/admin/videos/${vid}/moderation`, { action: 'masquer', motif: 'Examen du visage signalé.' })).json().erreur, 'action_impossible');
  await app.close();
});

test("re-floutage : administration seulement, clé et motif, vidéo après vérification, une demande à la fois, journal", async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (methode: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method: methode, url, headers: admin.headers, ...(payload ? { payload } : {}) });
  const debut = await req('POST', '/2fa/cle/debut', { motDePasse: admin.mdp });
  await req('POST', '/2fa/cle/confirmer', { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });
  await req('POST', '/admin/session', { cle: cle.prouver((await req('POST', '/admin/decision/defi', {})).json().options) });
  const avecCle = async (url: string, corps: object) =>
    req('POST', url, { ...corps, cle: cle.prouver((await req('POST', '/admin/decision/defi', {})).json().options) });
  const zones = [{ debut: 1, fin: 3, de: [0.1, 0.1, 0.2, 0.2], a: [0.2, 0.1, 0.2, 0.2] }];
  const vid = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status, decided_at, category) VALUES ('${vid}', 'published', now(), 'violence')`);
  const avant = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status) VALUES ('${avant}', 'awaiting_author')`);

  assert.equal((await avecCle(`/admin/videos/${vid}/refloutage`, { zones, motif: 'court' })).json().erreur, 'motif');
  assert.equal((await avecCle(`/admin/videos/${avant}/refloutage`, { zones, motif: 'Visage oublié signalé.' })).json().erreur, 'action_impossible');
  assert.equal((await avecCle(`/admin/videos/${vid}/refloutage`, { zones: [{ ...zones[0], fin: 0.5 }], motif: 'Visage oublié signalé.' })).statusCode, 400);
  assert.equal((await avecCle(`/admin/videos/${vid}/refloutage`, { zones, motif: 'Visage oublié signalé.' })).statusCode, 200);
  assert.equal((await avecCle(`/admin/videos/${vid}/refloutage`, { zones, motif: 'Visage oublié signalé.' })).json().erreur, 'deja_en_cours');
  await new Promise((ok) => setTimeout(ok, 200));   // préparation (locale : immédiate)
  assert.equal(proprietaire(`SELECT source_ready_at IS NOT NULL FROM core.reblur_requests WHERE video_id = '${vid}'`), 't');
  assert.equal((await req('GET', `/admin/videos/${vid}`)).json().refloutage.enCours, true);
  const etat = (await req('GET', `/admin/videos/${vid}/refloutage`)).json();
  assert.equal(etat.etape, 'attente');
  assert.equal(etat.avancement, null);
  assert.equal(proprietaire(`SELECT count(*) FROM ledger.entries WHERE payload->>'action' = 'reblur' AND payload->>'video' = '${vid}'`), '1');
  await app.close();
});

test("comptes : fiche, sanctions (mail motivé, journal sans pseudo), conversation avec réponse", async () => {
  const { deps, facteur } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  const membre = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (methode: 'GET' | 'POST', url: string, qui = admin, payload?: object) =>
    app.inject({ method: methode, url, headers: qui.headers, ...(payload ? { payload } : {}) });
  const debut = await req('POST', '/2fa/cle/debut', admin, { motDePasse: admin.mdp });
  await req('POST', '/2fa/cle/confirmer', admin, { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });
  await req('POST', '/admin/session', admin, { cle: cle.prouver((await req('POST', '/admin/decision/defi', admin, {})).json().options) });
  const avecCle = async (url: string, corps: object) =>
    req('POST', url, admin, { ...corps, cle: cle.prouver((await req('POST', '/admin/decision/defi', admin, {})).json().options) });
  const pseudo = proprietaire(`SELECT username FROM core.accounts WHERE id = '${membre.id}'`);

  const liste = (await req('GET', `/admin/comptes?texte=${pseudo}`)).json().comptes;
  assert.deepEqual([liste.length, liste[0].pseudo, liste[0].statut], [1, pseudo, 'active']);
  assert.ok(!JSON.stringify(liste).includes('@'));   // jamais l'adresse mail

  // Conversation : le compte ne peut pas écrire le premier ; l'administration écrit, il est prévenu, il répond.
  assert.equal((await req('POST', '/compte/messages', membre, { texte: 'Bonjour ?' })).json().erreur, 'aucune_conversation');
  const avant = facteur.mails.length;
  assert.deepEqual((await req('POST', `/admin/comptes/${membre.id}/messages`, admin, { texte: 'Pouvez-vous préciser votre signalement ?' })).json(),
                   { ok: true, prevenu: true });
  assert.match(facteur.mails[avant]!.texte, /\/compte\/messages/);
  assert.ok(!facteur.mails[avant]!.texte.includes('préciser'));   // le message lui-même n'est pas dans le mail
  assert.equal((await req('GET', '/moi', membre)).json().messagesNonLus, 1);
  assert.equal((await req('GET', '/compte/messages', membre)).json().messages[0].texte, 'Pouvez-vous préciser votre signalement ?');
  assert.equal((await req('GET', '/moi', membre)).json().messagesNonLus, 0);
  assert.equal((await req('POST', '/compte/messages', membre, { texte: 'Le visage est à 0:03.' })).statusCode, 200);
  assert.equal((await req('GET', '/admin/tableau-de-bord')).json().aTraiter.messages >= 1, true);
  assert.equal((await req('GET', `/admin/comptes?nonLus=true&texte=${pseudo}`)).json().comptes.length, 1);
  const fiche = (await req('GET', `/admin/comptes/${membre.id}`)).json();
  assert.deepEqual(fiche.messages.map((m: { deLAdmin: boolean }) => m.deLAdmin), [true, false]);
  assert.equal((await req('GET', `/admin/comptes?nonLus=true&texte=${pseudo}`)).json().comptes.length, 0);   // lue à l'ouverture

  // Suspendre : sessions fermées, mail avec le motif, journal sans pseudo ; lever ; bannir.
  assert.equal((await avecCle(`/admin/comptes/${membre.id}/sanction`, { action: 'suspendre', jours: 7, motif: 'court' })).json().erreur, 'motif');
  const m2 = facteur.mails.length;
  assert.deepEqual((await avecCle(`/admin/comptes/${membre.id}/sanction`, { action: 'suspendre', jours: 7, motif: 'Votes en série sans regarder les vidéos.' })).json(),
                   { ok: true, prevenu: true });
  assert.match(facteur.mails[m2]!.texte, /7 jours[\s\S]*Votes en série/);
  assert.equal((await req('GET', '/moi', membre)).statusCode, 401);
  const entree = JSON.parse(proprietaire(`SELECT payload::text FROM ledger.entries WHERE kind = 'admin_action' AND payload ->> 'action' = 'suspend_account' ORDER BY seq DESC LIMIT 1`));
  assert.deepEqual([entree.action, entree.days], ['suspend_account', 7]);
  assert.ok(!JSON.stringify(entree).includes(pseudo) && !JSON.stringify(entree).includes(membre.id));
  assert.equal((await avecCle(`/admin/comptes/${membre.id}/sanction`, { action: 'lever', motif: 'Explications reçues, erreur de bonne foi.' })).statusCode, 200);
  assert.equal((await avecCle(`/admin/comptes/${membre.id}/sanction`, { action: 'bannir', motif: 'Comptes multiples pour peser sur les votes.' })).statusCode, 200);
  assert.equal(proprietaire(`SELECT a.status || '|' || i.banned FROM core.accounts a JOIN identity.account_identities i ON i.account_id = a.id
                             WHERE a.id = '${membre.id}'`), 'banned|true');
  assert.deepEqual((await req('GET', `/admin/comptes/${membre.id}`)).json().sanctions.map((x: { type: string }) => x.type), ['ban', 'suspend']);
  assert.equal((await avecCle(`/admin/comptes/${admin.id}/sanction`, { action: 'deconnecter', motif: 'Essai sur soi-même.' })).json().erreur, 'action_impossible');
  await app.close();
});

test("instance publique (administration désactivée) : aucune route /admin, signaler reste possible", async () => {
  const { deps } = dependances(socle);
  const app = construireApp({ ...deps, reglages: { ...deps.reglages, administration: false } });
  for (const [methode, url] of [['GET', '/admin/session'], ['POST', '/admin/session'], ['POST', '/admin/decision/defi'],
                                 ['GET', '/admin/tableau-de-bord'], ['GET', '/admin/comptes'],
                                 ['POST', `/admin/videos/${randomUUID()}/decision`]] as const) {
    assert.equal((await app.inject({ method: methode, url, ...(methode === 'POST' ? { payload: {} } : {}) })).statusCode, 404, `${methode} ${url}`);
  }
  assert.equal((await app.inject({ method: 'POST', url: `/videos/${randomUUID()}/signaler`, payload: { motif: 'defamation' } })).statusCode, 401);
  await app.close();
});

test('doublons : liste réservée à la session admin, écarter puis rétablir, compté au tableau de bord', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  const autre = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}';
                DELETE FROM core.video_matches`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (methode: 'GET' | 'POST', url: string, qui = admin, payload?: object) =>
    app.inject({ method: methode, url, headers: qui.headers, ...(payload ? { payload } : {}) });
  const debut = await req('POST', '/2fa/cle/debut', admin, { motDePasse: admin.mdp });
  await req('POST', '/2fa/cle/confirmer', admin, { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });
  const o = (await req('POST', '/admin/decision/defi', admin, {})).json().options;
  await req('POST', '/admin/session', admin, { cle: cle.prouver(o) });

  const a = randomUUID();
  const b = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status) VALUES ('${a}', 'in_review'), ('${b}', 'published');
                INSERT INTO core.video_matches (video_id, other_video_id, level, visual_score, audio_score)
                VALUES ('${a}', '${b}', 'strong', 0.9, 0.97)`);

  assert.equal((await req('GET', '/admin/doublons', autre)).statusCode, 403);
  const [d] = (await req('GET', '/admin/doublons')).json().doublons;
  assert.equal(d.niveau, 'strong');
  assert.equal(d.video.statut, 'in_review');
  assert.equal(d.autre.id, b);
  assert.ok(Math.abs(d.scores.visuel - 0.9) < 0.001);
  assert.equal((await req('GET', '/admin/tableau-de-bord')).json().aTraiter.doublons, 1);

  assert.equal((await req('POST', `/admin/doublons/${d.id}`, admin, { ecarter: true })).statusCode, 200);
  assert.equal((await req('GET', '/admin/doublons')).json().doublons.length, 0);
  assert.equal((await req('GET', '/admin/doublons?ecartes=oui')).json().doublons.length, 1);
  assert.equal((await req('GET', '/admin/tableau-de-bord')).json().aTraiter.doublons, 0);
  assert.equal((await req('POST', `/admin/doublons/${randomUUID()}`, admin, { ecarter: true })).statusCode, 404);

  // Annuler un rattachement : clé physique et motif, inscrit au journal.
  proprietaire(`UPDATE core.videos SET status = 'published', duplicate_of = '${b}' WHERE id = '${a}'`);
  assert.equal((await req('GET', `/admin/videos/${a}`)).json().versionDe.id, b);
  const avecCle = async (corps: object) =>
    req('POST', `/admin/videos/${a}/version/annuler`, admin, { ...corps, cle: cle.prouver((await req('POST', '/admin/decision/defi', admin, {})).json().options) });
  assert.equal((await req('POST', `/admin/videos/${a}/version/annuler`, autre, { motif: 'Motif assez long.', cle: {} })).statusCode, 400);
  assert.equal((await avecCle({ motif: 'court' })).statusCode, 400);
  assert.equal((await avecCle({ motif: 'Vidéos différentes après vérification.' })).statusCode, 200);
  assert.equal(proprietaire(`SELECT coalesce(duplicate_of::text, 'aucun') FROM core.videos WHERE id = '${a}'`).trim(), 'aucun');
  assert.match(proprietaire(`SELECT payload ->> 'action' FROM ledger.entries WHERE kind = 'admin_action' AND payload ->> 'video' = '${a}'`), /detach_version/);
  assert.equal((await avecCle({ motif: 'Vidéos différentes après vérification.' })).statusCode, 404);

  // Rattacher depuis la ressemblance : clé et motif, journal, la ligne quitte « À voir ».
  const rattacher = async (m: string, video: string, motif = 'Même vidéo, recadrée.') =>
    req('POST', `/admin/doublons/${m}/rattacher`, admin, { video, motif, cle: cle.prouver((await req('POST', '/admin/decision/defi', admin, {})).json().options) });
  const c = randomUUID();
  const d2 = randomUUID();
  proprietaire(`UPDATE core.videos SET status = 'in_review' WHERE id = '${a}';
                INSERT INTO core.videos (id, status) VALUES ('${c}', 'in_review'), ('${d2}', 'rejected');
                UPDATE core.video_matches SET dismissed_at = NULL WHERE video_id = '${a}';
                INSERT INTO core.video_matches (video_id, other_video_id, level) VALUES ('${c}', '${a}', 'possible'), ('${d2}', '${b}', 'strong')`);
  const liste = (await req('GET', '/admin/doublons')).json().doublons as { id: string; video: { id: string } }[];
  const id = (v: string) => liste.find((x) => x.video.id === v)!.id;
  assert.equal((await rattacher(id(c), c)).statusCode, 409);                 // l'autre n'est pas publiée
  assert.equal((await rattacher(id(d2), d2)).statusCode, 409);               // vidéo rejetée
  assert.equal((await rattacher(id(a), randomUUID())).statusCode, 404);      // pas dans cette ressemblance
  assert.equal((await rattacher(id(a), a, 'court')).statusCode, 400);
  const ok = await rattacher(id(a), a);
  assert.deepEqual(ok.json(), { ok: true, fiche: b });
  assert.equal(proprietaire(`SELECT duplicate_of FROM core.videos WHERE id = '${a}'`).trim(), b);
  assert.equal(proprietaire(`SELECT dismissed_at IS NOT NULL FROM core.video_matches WHERE video_id = '${a}'`).trim(), 't');
  assert.match(proprietaire(`SELECT payload ->> 'action' FROM ledger.entries WHERE kind = 'admin_action' AND payload ->> 'video' = '${a}' ORDER BY seq DESC LIMIT 1`), /attach_version/);
  assert.equal((await req('GET', `/admin/videos/${a}`)).json().versionDe.id, b);
});

test('contact : envoi chiffré, mail requis selon le motif, lecture réservée à l’administration', async () => {
  const { deps, facteur } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  const autre = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}';
                DELETE FROM core.contact_messages`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (methode: 'GET' | 'POST', url: string, qui = admin, payload?: object) =>
    app.inject({ method: methode, url, headers: qui.headers, ...(payload ? { payload } : {}) });
  const debut = await req('POST', '/2fa/cle/debut', admin, { motDePasse: admin.mdp });
  await req('POST', '/2fa/cle/confirmer', admin, { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });
  await req('POST', '/admin/session', admin, { cle: cle.prouver((await req('POST', '/admin/decision/defi', admin, {})).json().options) });

  const envoyer = (corps: object) => app.inject({ method: 'POST', url: '/contact', payload: { turnstile: 'x', ...corps } });
  const texte = 'Un message assez long pour passer.';
  assert.equal((await envoyer({ motif: 'autre', message: 'court' })).json().erreur, 'message_trop_court');
  assert.equal((await envoyer({ motif: 'droit_de_reponse', message: texte })).json().erreur, 'mail_requis');
  assert.equal((await envoyer({ motif: 'autre', message: texte, mail: 'pas-un-mail' })).json().erreur, 'mail_invalide');
  assert.equal((await envoyer({ motif: 'inconnu', message: texte })).statusCode, 400);
  assert.equal((await envoyer({ motif: 'certification', message: texte })).json().erreur, 'mail_requis');
  const avant = facteur.mails.length;
  assert.equal((await envoyer({ motif: 'autre', message: texte })).statusCode, 200);
  assert.equal((await envoyer({ motif: 'droit_de_reponse', message: texte, mail: 'personne@exemple.fr' })).statusCode, 200);

  // Une seule alerte, sans le contenu ; rien en clair dans la base.
  const alertes = facteur.mails.slice(avant);
  assert.equal(alertes.length, 1);
  assert.ok(!JSON.stringify(alertes[0]).includes('assez long'));
  assert.equal(proprietaire(`SELECT count(*) FROM core.contact_messages WHERE position(convert_to('assez long', 'UTF8') IN body_enc) > 0`).trim(), '0');

  assert.equal((await req('GET', '/admin/contact', autre)).statusCode, 403);
  const liste = (await req('GET', '/admin/contact')).json().messages;
  assert.equal(liste.length, 2);
  const m = liste.find((x: { motif: string }) => x.motif === 'right_of_reply');
  assert.deepEqual([m.mail, m.message], ['personne@exemple.fr', texte]);
  assert.equal((await req('GET', '/admin/tableau-de-bord')).json().aTraiter.contacts, 2);
  assert.equal((await req('POST', `/admin/contact/${m.id}`, admin, { traite: true })).statusCode, 200);
  assert.equal((await req('GET', '/admin/contact')).json().messages.length, 1);
  assert.equal((await req('GET', '/admin/contact?traites=oui')).json().messages.length, 1);

  // Effacé au bout d'un an.
  proprietaire(`UPDATE core.contact_messages SET created_at = now() - interval '13 months' WHERE id = '${m.id}'`);
  assert.equal(proprietaire('SELECT core.purge_contact_messages()').trim(), '1');

  // Demande de certification, message sur plusieurs lignes (texte collé).
  assert.equal((await envoyer({ motif: 'certification', message: 'Journaliste.\nRédaction à vérifier.', mail: 'presse@exemple.fr' })).statusCode, 200);
  assert.ok((await req('GET', '/admin/contact')).json().messages.some((x: { motif: string }) => x.motif === 'certification'));
});

test('erreurs du serveur : détail réservé à la session admin, filtré par durée', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  const autre = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}';
                DELETE FROM core.request_errors;
                INSERT INTO core.request_errors (request_id, created_at, method, route, status, error_name, message, stack) VALUES
                  ('${randomUUID()}', now() - interval '1 hour', 'PUT', '/envois/:id/copie/:n', 500, 'Error', 'EACCES', 'trace'),
                  ('${randomUUID()}', now() - interval '3 days', 'GET', '/carte', 500, 'Error', 'ancienne', NULL)`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (methode: 'GET' | 'POST', url: string, qui = admin, payload?: object) =>
    app.inject({ method: methode, url, headers: qui.headers, ...(payload ? { payload } : {}) });
  const debut = await req('POST', '/2fa/cle/debut', admin, { motDePasse: admin.mdp });
  await req('POST', '/2fa/cle/confirmer', admin, { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });
  await req('POST', '/admin/session', admin, { cle: cle.prouver((await req('POST', '/admin/decision/defi', admin, {})).json().options) });

  assert.equal((await req('GET', '/admin/erreurs', autre)).statusCode, 403);
  const e = (await req('GET', '/admin/erreurs')).json().erreurs;
  assert.deepEqual(e.map((x: { route: string; message: string }) => [x.route, x.message]), [['PUT /envois/:id/copie/:n', 'EACCES']]);
  assert.equal((await req('GET', '/admin/erreurs?heures=168')).json().erreurs.length, 2);
  assert.equal((await req('GET', '/admin/erreurs?heures=9999')).statusCode, 400);
});

test('suppression d’une vidéo en échec : clé et motif, réservée à cet état, inscrite au journal', async () => {
  const { deps, stockage } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (url: string, payload?: object) => app.inject({ method: payload ? 'POST' : 'GET', url, headers: admin.headers, ...(payload ? { payload } : {}) });
  const debut = await req('/2fa/cle/debut', { motDePasse: admin.mdp });
  await req('/2fa/cle/confirmer', { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });
  await req('/admin/session', { cle: cle.prouver((await req('/admin/decision/defi', {})).json().options) });
  const signer = async (id: string, motif: string) =>
    req(`/admin/videos/${id}/supprimer-echec`, { motif, cle: cle.prouver((await req('/admin/decision/defi', {})).json().options) });

  const echec = randomUUID();
  const publiee = randomUUID();
  const gelee = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status, failure_reason) VALUES ('${echec}', 'failed', 'processing_error'), ('${gelee}', 'failed', 'processing_error');
                UPDATE core.videos SET legal_hold = true WHERE id = '${gelee}';
                INSERT INTO core.videos (id, status) VALUES ('${publiee}', 'published')`);
  await stockage.ecrireMorceau('originaux', echec, 0, new Uint8Array([1, 2, 3]));

  assert.equal((await signer(echec, 'court')).statusCode, 400);
  assert.equal((await signer(publiee, 'Motif assez long pour passer.')).json().erreur, 'action_impossible');
  assert.equal((await signer(gelee, 'Motif assez long pour passer.')).json().erreur, 'action_impossible');
  assert.equal((await signer(randomUUID(), 'Motif assez long pour passer.')).statusCode, 404);
  assert.equal((await signer(echec, 'Essai raté, vidéo inutilisable.')).statusCode, 200);
  assert.equal(proprietaire(`SELECT count(*) FROM core.videos WHERE id = '${echec}'`).trim(), '0');
  assert.match(proprietaire(`SELECT payload ->> 'action' FROM ledger.entries WHERE kind = 'admin_action' AND payload ->> 'video' = '${echec}'`), /delete_failed/);
  assert.equal(proprietaire(`SELECT status FROM core.videos WHERE id = '${publiee}'`).trim(), 'published');
});

test('origine modifiable par l’administration : clé et motif, nom requis pour citer, tout vider supprime', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (url: string, payload?: object) => app.inject({ method: payload ? 'POST' : 'GET', url, headers: admin.headers, ...(payload ? { payload } : {}) });
  const debut = await req('/2fa/cle/debut', { motDePasse: admin.mdp });
  await req('/2fa/cle/confirmer', { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });
  await req('/admin/session', { cle: cle.prouver((await req('/admin/decision/defi', {})).json().options) });
  const v = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status) VALUES ('${v}', 'in_review')`);
  const modifier = async (corps: object) =>
    req(`/admin/videos/${v}/origine`, { motif: 'Correction du nom de la journaliste.', ...corps, cle: cle.prouver((await req('/admin/decision/defi', {})).json().options) });

  assert.equal((await modifier({ lien: 'https://x.fr/1', publique: true })).json().erreur, 'origine_invalide');
  assert.equal((await modifier({ publiePar: 'Nom', lien: 'javascript:x', publique: false })).statusCode, 400);
  assert.equal((await modifier({ publiePar: 'Une journaliste', lien: 'https://x.fr/1', publique: true })).statusCode, 200);
  assert.deepEqual((await req(`/admin/videos/${v}`)).json().origine, { publiePar: 'Une journaliste', lien: 'https://x.fr/1', precisions: null, publique: true });
  assert.equal((await modifier({ publiePar: 'Autre nom', publique: false })).statusCode, 200);
  assert.equal((await req(`/admin/videos/${v}`)).json().origine.publique, false);
  assert.match(proprietaire(`SELECT payload::text FROM ledger.entries WHERE kind = 'admin_action' AND payload ->> 'video' = '${v}' ORDER BY seq DESC LIMIT 1`), /origin_edited/);
  assert.doesNotMatch(proprietaire(`SELECT payload::text FROM ledger.entries WHERE kind = 'admin_action' AND payload ->> 'video' = '${v}' ORDER BY seq DESC LIMIT 1`), /Autre nom/);
  assert.equal((await modifier({ publique: false })).statusCode, 200);
  assert.equal((await req(`/admin/videos/${v}`)).json().origine, null);
});

test('demandes des autorités : registre réservé à la session admin, jamais au journal, comptées au rapport', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  const autre = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (methode: 'GET' | 'POST', url: string, qui = admin, payload?: object) =>
    app.inject({ method: methode, url, headers: qui.headers, ...(payload ? { payload } : {}) });
  const debut = await req('POST', '/2fa/cle/debut', admin, { motDePasse: admin.mdp });
  await req('POST', '/2fa/cle/confirmer', admin, { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });
  await req('POST', '/admin/session', admin, { cle: cle.prouver((await req('POST', '/admin/decision/defi', admin, {})).json().options) });

  const vid = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status, description) VALUES ('${vid}', 'published', 'x')`);
  const journalAvant = proprietaire('SELECT count(*) FROM ledger.entries');
  const demande = { recueLe: '2026-11-10', auteur: 'judicial', objet: 'identification', video: vid, suite: 'pending', notes: 'Réquisition n° 42.' };
  assert.equal((await req('POST', '/admin/autorites', autre, demande)).statusCode, 403);
  assert.equal((await req('POST', '/admin/autorites', admin, { ...demande, auteur: 'voisin' })).statusCode, 400);
  assert.equal((await req('POST', '/admin/autorites', admin, { ...demande, recueLe: '2999-01-01' })).json().erreur, 'date_invalide');
  const id = (await req('POST', '/admin/autorites', admin, demande)).json().id;
  assert.equal((await req('POST', '/admin/autorites', admin, { ...demande, id, suite: 'refused' })).statusCode, 200);
  const liste = (await req('GET', '/admin/autorites')).json().demandes;
  const d = liste.find((x: { id: string }) => x.id === id);
  assert.deepEqual([d.auteur, d.objet, d.suite, d.video.id, d.notes], ['judicial', 'identification', 'refused', vid, 'Réquisition n° 42.']);
  assert.equal(proprietaire('SELECT count(*) FROM ledger.entries'), journalAvant);   // rien au journal public
  assert.match(proprietaire(`SELECT core.transparency_authority_raw('2026-10-01', '2027-01-01')::text`), /"judicial": [1-9]/);
  // Supprimer exige la clé physique (audit M11).
  assert.equal((await req('POST', `/admin/autorites/${id}/supprimer`, admin, {})).statusCode, 400);
  const supprimer = async () => req('POST', `/admin/autorites/${id}/supprimer`, admin,
    { cle: cle.prouver((await req('POST', '/admin/decision/defi', admin, {})).json().options) });
  assert.equal((await supprimer()).statusCode, 200);
  assert.equal((await supprimer()).statusCode, 404);
});

test('serveur : disques, sauvegardes (fichiers d’état), réservé à la session admin', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  const autre = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (url: string, qui = admin) => app.inject({ method: 'GET', url, headers: qui.headers });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: admin.headers, payload });
  const debut = await post('/2fa/cle/debut', { motDePasse: admin.mdp });
  await post('/2fa/cle/confirmer', { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });
  await post('/admin/session', { cle: cle.prouver((await post('/admin/decision/defi', {})).json().options) });

  assert.equal((await req('/admin/serveur', autre)).statusCode, 403);
  const e = (await req('/admin/serveur')).json();
  assert.ok(e.disques.some((d: { nom: string; total: number }) => d.nom === 'Système' && d.total > 0));
  assert.deepEqual(e.sauvegardes.map((s: { nom: string }) => s.nom), ['Base et réglages', 'Vidéos', 'Copie externe']);
  assert.equal(e.r2, null);   // stockage local en test

  // B13 : signal du serveur de copie, sur l'instance publique, avec son secret seulement.
  const publique = construireApp({ ...deps, reglages: { ...deps.reglages, administration: false, copieExterne: 'secret-de-copie' } });
  const signal = (auth: string | undefined, payload: object) => publique.inject({ method: 'POST', url: '/etat/copie-externe',
    headers: auth ? { authorization: auth } : {}, payload });
  assert.equal((await signal(undefined, { ok: true })).statusCode, 401);
  assert.equal((await signal('Bearer mauvais', { ok: true })).statusCode, 401);
  assert.equal((await signal('Bearer secret-de-copie', { ok: false, detail: 'conteneur introuvable' })).statusCode, 204);
  let copie = (await req('/admin/serveur')).json().sauvegardes[2];
  assert.equal(copie.ok, false);
  assert.equal(copie.detail, 'conteneur introuvable');
  assert.equal((await signal('Bearer secret-de-copie', { ok: true, detail: '2 conteneurs, 312 Mo' })).statusCode, 204);
  copie = (await req('/admin/serveur')).json().sauvegardes[2];
  assert.equal(copie.ok, true);
  assert.ok(Date.now() - new Date(copie.le).getTime() < 60_000);
  // Sans secret configuré, l'adresse n'existe pas ; jamais sur l'instance d'administration.
  const sansSecret = construireApp({ ...deps, reglages: { ...deps.reglages, administration: false } });
  assert.equal((await sansSecret.inject({ method: 'POST', url: '/etat/copie-externe', payload: { ok: true } })).statusCode, 404);
  const adm = construireApp({ ...deps, reglages: { ...deps.reglages, copieExterne: 'secret-de-copie' } });
  assert.equal((await adm.inject({ method: 'POST', url: '/etat/copie-externe', headers: { authorization: 'Bearer secret-de-copie' },
    payload: { ok: true } })).statusCode, 404);
});

test('administration : seulement les clés physiques déclarées sur le serveur (ARGOS_PASSKEYS_ADMIN)', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: admin.headers, payload });
  const enregistrer = async (cle: CleLogicielle, nom: string) => {
    const debut = await post('/2fa/cle/debut', { motDePasse: admin.mdp });
    await post('/2fa/cle/confirmer', { reponse: cle.enregistrer(debut.json().options), nom });
  };
  const ouvrir = async (cle: CleLogicielle) => {
    const preuve = cle.prouver((await post('/admin/decision/defi', {})).json().options);
    return { id: preuve.id as string, statut: (await post('/admin/session', { cle: preuve })).statusCode };
  };
  const yubikey = new CleLogicielle('https://argos.test', 'argos.test');
  const ajoutee = new CleLogicielle('https://argos.test', 'argos.test');   // par exemple, ajoutée par quelqu'un qui a pris le compte
  await enregistrer(yubikey, 'YubiKey');
  await enregistrer(ajoutee, 'Autre');
  const avant = process.env['ARGOS_PASSKEYS_ADMIN'];
  try {
    const { id } = await ouvrir(yubikey);
    process.env['ARGOS_PASSKEYS_ADMIN'] = ` ${id} , autre-identifiant`;
    assert.equal((await ouvrir(ajoutee)).statut, 401);
    assert.equal((await ouvrir(yubikey)).statut, 200);
  } finally {
    if (avant === undefined) delete process.env['ARGOS_PASSKEYS_ADMIN']; else process.env['ARGOS_PASSKEYS_ADMIN'] = avant;
  }
});
