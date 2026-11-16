// Notes d'analyse OSINT (7d-1) : statut accordé avec la clé physique, notes de l'analyste,
// première impression du relecteur, analyste retiré, masquage.
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
type Deps = ReturnType<typeof dependances>['deps'];

async function compte(app: App, deps: Deps) {
  const pseudo = `Analyste_${randomInt(10_000_000, 100_000_000)}`;
  const mdp = 'cheval correct pile agrafe';
  const r = await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(mdp), randomBytes(32), randomBytes(32), chiffrer(deps.cles, `${pseudo.toLowerCase()}@exemple.fr`),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null]);
  const rep = await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: mdp } });
  return { id: r.rows[0]!.id, pseudo, mdp, headers: { cookie: String(rep.headers['set-cookie']).split(';')[0]! } };
}

function video(statut = 'in_review') {
  const id = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status, review_started_at, category, description)
                VALUES ('${id}', '${statut}', now(), 'violence', 'Tir de LBD')`);
  return id;
}

const NOTE = {
  constat: 'Lieu confirmé : place de la République',
  explication: 'Façade et mobilier urbain identiques sur Mapillary.\nOmbres cohérentes avec 15 h.',
  liens: ['https://www.mapillary.com/app/?pKey=123', 'https://exemple.fr/article'],
};

/** Un super-administrateur avec sa clé physique, et de quoi signer une action. */
async function superAdmin(app: App, deps: Deps) {
  const admin = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const debut = await app.inject({ method: 'POST', url: '/2fa/cle/debut', payload: { motDePasse: admin.mdp }, headers: admin.headers });
  await app.inject({ method: 'POST', url: '/2fa/cle/confirmer', headers: admin.headers,
                     payload: { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' } });
  const signer = async (url: string, corps: object) => {
    const o = (await app.inject({ method: 'POST', url: '/admin/decision/defi', payload: {}, headers: admin.headers })).json().options;
    return app.inject({ method: 'POST', url, payload: { ...corps, cle: cle.prouver(o) }, headers: admin.headers });
  };
  return { admin, signer };
}

test("statut d'analyste : accordé par le super-administrateur avec sa clé, double authentification exigée", async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const { signer } = await superAdmin(app, deps);
  const a = await compte(app, deps);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/osint/videos', headers: a.headers })).json(), { erreur: 'reserve_analyste' });
  assert.deepEqual((await signer(`/admin/comptes/${a.pseudo}/osint`, { accorder: true })).json(), { erreur: 'double_auth_requise' });
  proprietaire(`INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('${a.id}', 'totp', '\\x00')`);
  const ok = await signer(`/admin/comptes/${a.pseudo.toLowerCase()}/osint`, { accorder: true });
  assert.deepEqual([ok.statusCode, ok.json()], [200, { ok: true, analysteOsint: true }]);
  assert.equal((await app.inject({ method: 'GET', url: '/moi', headers: a.headers })).json().analysteOsint, true);
  assert.equal((await signer('/admin/comptes/Personne_123/osint', { accorder: true })).statusCode, 404);
  // Un analyste n'est pas super-administrateur : pas de défi pour la clé, donc aucune action possible.
  assert.deepEqual((await app.inject({ method: 'POST', url: '/admin/decision/defi', payload: {}, headers: a.headers })).json(),
                   { erreur: 'reserve_super_admin' });
  await app.close();
});

test('super-administrateur : mêmes droits que les analystes, affiché « Administration » (jamais son pseudo)', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const { admin } = await superAdmin(app, deps);
  const v = video();
  assert.equal((await app.inject({ method: 'GET', url: '/osint/videos', headers: admin.headers })).statusCode, 200);
  const cree = await app.inject({ method: 'POST', url: `/osint/videos/${v}/notes`, payload: NOTE, headers: admin.headers });
  assert.equal(cree.statusCode, 201, cree.body);
  const notes = (await app.inject({ method: 'GET', url: `/osint/videos/${v}/notes`, headers: admin.headers })).json().notes;
  assert.ok(notes.length >= 1 && notes.every((n: { auteur: string }) => n.auteur !== admin.pseudo));
  assert.ok(notes.some((n: { auteur: string }) => n.auteur === 'Administration'));
  assert.equal(proprietaire(`SELECT core.public_author('${admin.id}')`), 'Administration');
  // Contenu de l'éditeur, pas d'un utilisateur : rien au journal légal (Q50).
  assert.equal(proprietaire(`SELECT count(*) FROM identity.legal_connection_logs WHERE content_id = '${cree.json().note}'`), '0');
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE id = '${admin.id}'`);
  await app.close();
});

test('analyste : voir les vidéos, écrire, corriger, retirer ; relecteur : notes après la vidéo seulement', async () => {
  const d = dependances(socle);
  const app = construireApp(d.deps);
  const { signer } = await superAdmin(app, d.deps);
  const a = await compte(app, d.deps);
  proprietaire(`INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('${a.id}', 'totp', '\\x00')`);
  assert.equal((await signer(`/admin/comptes/${a.pseudo}/osint`, { accorder: true })).statusCode, 200);
  const v = video();
  const get = (url: string, qui = a) => app.inject({ method: 'GET', url, headers: qui.headers });
  const post = (url: string, payload: object, qui = a) => app.inject({ method: 'POST', url, payload, headers: qui.headers });

  const liste = (await get('/osint/videos')).json();
  const x = liste.videos.find((y: { video: string }) => y.video === v);
  assert.deepEqual([x.etape, x.description, x.notes, x.mesNotes], ['relecture', 'Tir de LBD', 0, 0]);
  assert.ok(!liste.videos.some((y: { video: string }) => y.video === video('published')));
  assert.ok((await post(`/osint/videos/${v}/video`, {})).json().lien.startsWith('/apercu/'));

  for (const mauvais of [{ ...NOTE, liens: ['http://exemple.fr'] }, { ...NOTE, liens: [] }, { ...NOTE, constat: 'x'.repeat(201) },
                         { ...NOTE, liens: ['https://localhost/'] }, { ...NOTE, constat: 'a\u0000b' }]) {
    assert.equal((await post(`/osint/videos/${v}/notes`, mauvais)).statusCode, 400, JSON.stringify(mauvais));
  }
  const cree = await post(`/osint/videos/${v}/notes`, NOTE);
  assert.equal(cree.statusCode, 201);
  const n = cree.json().note;
  // Journal légal : la note est un contenu mis en ligne (décret 2021-1362).
  assert.equal(proprietaire(`SELECT count(*) FROM identity.legal_connection_logs WHERE content_id = '${n}' AND action = 'upload'`), '1');
  await post(`/osint/videos/${v}/notes`, NOTE);
  await post(`/osint/videos/${v}/notes`, NOTE);
  assert.deepEqual((await post(`/osint/videos/${v}/notes`, NOTE)).json(), { erreur: 'plafond_notes' });
  const corr = await app.inject({ method: 'PUT', url: `/osint/notes/${n}`, headers: a.headers,
                                  payload: { ...NOTE, constat: 'Lieu confirmé : place de la République, côté est', publier: true } });
  assert.deepEqual(corr.json(), { ok: true, version: 2 });
  const notes = (await get(`/osint/videos/${v}/notes`)).json().notes;
  const la = notes.find((y: { note: string }) => y.note === n);
  assert.deepEqual([la.version, la.historique.length, la.mienne, la.publier, la.statutAuteur], [2, 2, true, true, 'analyste_osint_verifie']);

  // Relecteur : le nombre de notes tout de suite, leur contenu une fois la vidéo ouverte.
  const r = await compte(app, d.deps);
  const c = randomUUID();
  proprietaire(`INSERT INTO core.summons (id, video_id, account_id, round, expires_at)
                VALUES ('${c}', '${v}', '${r.id}', 'review', now() + interval '2 days')`);
  const conv = (await get('/relecture', r)).json().convocations.find((y: { convocation: string }) => y.convocation === c);
  assert.equal(conv.notesAnalystes, 3);
  assert.deepEqual((await get(`/relecture/${c}/notes`, r)).json(), { erreur: 'video_pas_encore_vue' });
  await post(`/relecture/${c}/video`, {}, r);
  const vues = (await get(`/relecture/${c}/notes`, r)).json();
  assert.match(vues.rappel, /éclairent, elles ne décident pas/);
  assert.equal(vues.notes.length, 3);
  assert.equal(vues.notes[0].auteur, a.pseudo);
  assert.equal('mienne' in vues.notes[0], false);
  assert.equal((await get(`/osint/videos/${v}/notes`, r)).statusCode, 403);   // un relecteur n'est pas analyste

  // Retrait par l'auteur, analyste retiré, masquage par le super-administrateur.
  assert.equal((await post(`/osint/notes/${n}/retrait`, {})).statusCode, 200);
  assert.equal((await post(`/osint/notes/${n}/retrait`, {})).statusCode, 404);
  assert.equal((await get(`/relecture/${c}/notes`, r)).json().notes.length, 2);
  assert.equal((await signer(`/admin/comptes/${a.pseudo}/osint`, { accorder: false })).statusCode, 200);
  const apres = (await get(`/relecture/${c}/notes`, r)).json().notes;
  assert.ok(apres.every((y: { statutAuteur: string }) => y.statutAuteur === 'analyste_retire'));
  assert.equal((await signer(`/admin/notes/${apres[0].note}/masquer`, { motif: 'Lien vers un site malveillant.' })).statusCode, 200);
  assert.equal((await get(`/relecture/${c}/notes`, r)).json().notes.length, 1);
  // Démasquage : motif exigé, puis la note revient pour les relecteurs ; deux fois : refusé.
  assert.equal((await signer(`/admin/notes/${apres[0].note}/demasquer`, { motif: 'court' })).json().erreur, 'motif');
  assert.equal((await signer(`/admin/notes/${apres[0].note}/demasquer`, { motif: 'Le lien a été vérifié, il est sûr.' })).statusCode, 200);
  assert.equal((await get(`/relecture/${c}/notes`, r)).json().notes.length, 2);
  assert.equal((await signer(`/admin/notes/${apres[0].note}/demasquer`, { motif: 'Le lien a été vérifié, il est sûr.' })).statusCode, 404);
  assert.equal(proprietaire(`SELECT count(*) FROM ledger.entries WHERE kind = 'admin_action' AND payload->>'action' = 'unmask_note'
                              AND payload->>'note' = '${apres[0].note}'`), '1');
  assert.equal((await get('/osint/videos')).statusCode, 403);                 // plus analyste
  await app.close();
});

test('jugement des notes : après son vote seulement, mise en avant par les deux camps', async () => {
  const d = dependances(socle);
  const app = construireApp(d.deps);
  const { signer } = await superAdmin(app, d.deps);
  const a = await compte(app, d.deps);
  proprietaire(`INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('${a.id}', 'totp', '\\x00')`);
  await signer(`/admin/comptes/${a.pseudo}/osint`, { accorder: true });
  const v = video();
  const n = (await app.inject({ method: 'POST', url: `/osint/videos/${v}/notes`, payload: NOTE, headers: a.headers })).json().note;

  const relecteurs: (Awaited<ReturnType<typeof compte>> & { c: string; verdict: string })[] = [];
  for (const verdict of ['oui', 'oui', 'oui', 'non', 'non', 'non']) {
    const r = await compte(app, d.deps);
    const c = randomUUID();
    proprietaire(`INSERT INTO core.summons (id, video_id, account_id, round, expires_at, video_opened_at)
                  VALUES ('${c}', '${v}', '${r.id}', 'review', now() + interval '2 days', now())`);
    relecteurs.push({ ...r, c, verdict });
  }
  const juger = (r: typeof relecteurs[number], payload: object) =>
    app.inject({ method: 'POST', url: `/relecture/${r.c}/notes/${n}/jugement`, payload, headers: r.headers });
  const OUI = { avis: 'oui', raisons: ['sources_fiables', 'verifiable'] };

  const premier = relecteurs[0]!;
  assert.equal((await juger(premier, OUI)).statusCode, 404);                 // pas encore voté
  for (const r of relecteurs) {
    const raisons = r.verdict === 'oui' ? ['intervention_visible'] : ['rien_de_visible'];
    const vote = await app.inject({ method: 'POST', url: `/relecture/${r.c}/vote`, headers: r.headers,
                                    payload: { verdict: r.verdict, raisons, visageIdentifiable: false } });
    assert.equal(vote.statusCode, 200);
  }
  const accueil = (await app.inject({ method: 'GET', url: '/relecture', headers: premier.headers })).json();
  assert.deepEqual(accueil.notesAJuger, [{ convocation: premier.c, notes: 1, dejaJugees: 0 }]);
  const avant = (await app.inject({ method: 'GET', url: `/relecture/${premier.c}/notes`, headers: premier.headers })).json();
  assert.deepEqual([avant.notes[0].etat, avant.notes[0].monJugement, avant.raisons.non.length], ['a_evaluer', null, 5]);

  assert.equal((await juger(premier, { avis: 'oui', raisons: ['opinion'] })).statusCode, 400);   // raison du « non »
  assert.equal((await juger(premier, { avis: 'peut-etre', raisons: ['claire'] })).statusCode, 400);
  assert.deepEqual((await juger(premier, { avis: 'en_partie', raisons: ['sources_fiables', 'sources_douteuses'] })).json(),
                   { erreur: 'raisons_contradictoires' });
  for (const r of relecteurs.slice(0, 5)) assert.deepEqual((await juger(r, OUI)).json(), { ok: true, etat: 'a_evaluer' });
  assert.deepEqual((await juger(relecteurs[5]!, { avis: 'en_partie', raisons: ['claire', 'liens_morts'] })).json(),
                   { ok: true, etat: 'mise_en_avant' });                     // non : 2,5 / 3 ≥ 2/3
  const apres = (await app.inject({ method: 'GET', url: `/relecture/${relecteurs[5]!.c}/notes`, headers: relecteurs[5]!.headers })).json();
  assert.deepEqual(apres.notes[0].monJugement, { avis: 'en_partie', raisons: ['claire', 'liens_morts'] });
  assert.equal(apres.notes[0].auteurNotesMisesEnAvant, 1);
  const vueAnalyste = (await app.inject({ method: 'GET', url: `/osint/videos/${v}/notes`, headers: a.headers })).json();
  assert.equal(vueAnalyste.notes[0].etat, 'mise_en_avant');
  // Le jugement d'un autre n'est jamais visible.
  const autre = (await app.inject({ method: 'GET', url: `/relecture/${premier.c}/notes`, headers: relecteurs[1]!.headers }));
  assert.equal(autre.statusCode, 404);
  await app.close();
});

test("correction de la date, de l'heure et du lieu : appliquée, déclaration de la source montrée, annulable", async () => {
  const d = dependances(socle);
  const app = construireApp(d.deps);
  const { signer } = await superAdmin(app, d.deps);
  const a = await compte(app, d.deps);
  proprietaire(`INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('${a.id}', 'totp', '\\x00')`);
  await signer(`/admin/comptes/${a.pseudo}/osint`, { accorder: true });
  const v = video();
  proprietaire(`UPDATE core.videos SET occurred_at = '2026-10-29 10:00+00', location = ST_GeogFromText('POINT(2.35 48.85)'),
                location_precision = 'municipality' WHERE id = '${v}'`);
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload, headers: a.headers });
  const CORR = { date: '2026-10-28T14:40:00Z', heureConnue: false, lieu: { lat: 48.86734, lon: 2.36312 }, precision: 'approx_100m',
                 justification: 'Bouche de métro et kiosque identiques sur Mapillary.', liens: ['https://www.mapillary.com/app/?pKey=42'] };
  assert.deepEqual((await post(`/osint/videos/${v}/correction`, { ...CORR, lieu: { lat: 40.4, lon: -3.7 } })).json(), { erreur: 'lieu_hors_de_france' });
  assert.equal((await post(`/osint/videos/${v}/correction`, { ...CORR, justification: 'court' })).json().erreur, 'justification');
  const c = await post(`/osint/videos/${v}/correction`, CORR);
  assert.equal(c.statusCode, 201);
  assert.equal(proprietaire(`SELECT round(ST_Y(location::geometry)::numeric, 5) || ' ' || occurred_time_known || ' ' || location_precision
                              FROM core.videos WHERE id = '${v}'`),
               '48.87000 false municipality');   // jamais plus précis que la source (« commune ») : précision ramenée, arrondi (0092)
  const liste = (await app.inject({ method: 'GET', url: '/osint/videos', headers: a.headers })).json();
  const x = liste.videos.find((y: { video: string }) => y.video === v);
  assert.equal(x.correction.par, a.pseudo);
  assert.equal(x.correction.declare.lieu.precision, 'municipality');
  assert.equal(x.correction.declare.date, '2026-10-29T10:00:00.000Z');
  const hist = (await app.inject({ method: 'GET', url: `/osint/videos/${v}/corrections`, headers: a.headers })).json().corrections;
  assert.equal(hist.length, 1);
  const annul = await signer(`/admin/corrections/${hist[0].correction}/annuler`, { motif: 'Sources insuffisantes pour ce lieu.' });
  assert.deepEqual(annul.json(), { ok: true });
  assert.equal(proprietaire(`SELECT location_precision FROM core.videos WHERE id = '${v}'`), 'municipality');   // retour à la source
  await app.close();
});

test("description : corrigée ou masquée par l'administration seule, avec sa clé, sans aucune copie de l'ancien texte", async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const { admin, signer } = await superAdmin(app, deps);
  const vid = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status, decided_at, category, description)
                VALUES ('${vid}', 'published', now(), 'violence', 'Contrôle rue Victor Hugo, Jean Dupont filme depuis son balcon.')`);
  const corriger = (description: string, justification = 'Nom d’un témoin retiré.') =>
    signer(`/admin/videos/${vid}/description`, { description, justification });
  assert.equal((await corriger('x', 'court')).json().erreur, 'justification');
  const r = await corriger('Contrôle rue Victor Hugo, [retiré] filme depuis son balcon.');
  assert.equal(r.statusCode, 200, r.body);
  // La fiche publique montre la version corrigée ; l'ancien texte ne reste nulle part.
  assert.equal((await app.inject({ method: 'GET', url: `/public/videos/${vid}` })).json().description,
               'Contrôle rue Victor Hugo, [retiré] filme depuis son balcon.');
  const h = (await app.inject({ method: 'GET', url: `/admin/videos/${vid}/description`, headers: admin.headers }));
  assert.equal(h.json().corrections.length, 1);
  assert.ok(!h.body.includes('Dupont'));
  assert.equal(proprietaire(`SELECT count(*) FROM core.description_corrections c WHERE c::text LIKE '%Dupont%'`), '0');
  // Sans clé physique : refusé.
  const sansCle = await app.inject({ method: 'POST', url: `/admin/videos/${vid}/description`, headers: admin.headers,
                                     payload: { description: 'Autre.', justification: 'Encore une correction.', cle: { id: 'x' } } });
  assert.notEqual(sansCle.statusCode, 200);
  await app.close();
});
