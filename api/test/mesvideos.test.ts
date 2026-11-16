// Envoi avec son compte (étape 2) : rattachement, « Mes vidéos », suivi sans le code, retrait avec mot de
// passe, exclusion de ses propres vidéos, oubli du lien quand le compte est effacé.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { chiffrerOriginal, deriverSecrets, genererEntropie, lecteurOctets, type MorceauChiffre } from '../../navigateur/src/index.ts';
import { construireApp } from '../src/app.ts';
import { CONDITIONS_VERSION } from '../src/conditions.ts';
import { chiffrer, hacherMotDePasse } from '../src/crypto.ts';
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

const VIDEO = readFileSync(new URL('./fixtures/mini.mp4', import.meta.url));
const MDP = 'cheval correct pile agrafe';

async function compte(cles = dependances(socle).deps.cles): Promise<{ id: string; pseudo: string }> {
  const pseudo = `Source_${randomInt(10_000_000, 100_000_000)}`;
  const r = await bases.identity.query<{ id: string }>(
    'SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(MDP), randomBytes(32), randomBytes(32),
     chiffrer(cles, `${pseudo.toLowerCase()}@exemple.fr`),
     Array.from({ length: 10 }, () => randomBytes(32).toString('hex')), '192.0.2.1', null]);
  return { id: r.rows[0]!.id, pseudo };
}

function monter() {
  const { deps, stockage } = dependances(socle);
  const app = construireApp(deps);
  return { app, stockage };
}

async function connecter(app: ReturnType<typeof construireApp>, pseudo: string) {
  const r = await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: MDP } });
  const m = new RegExp(`^${COOKIE}=([A-Za-z0-9_-]{43});`).exec(String(r.headers['set-cookie']));
  assert.ok(m, 'connexion impossible');
  return { cookie: `${COOKIE}=${m[1]}` };
}

/** Envoi complet ; avecCompte + cookie pour un envoi rattaché au compte. */
async function envoyer(app: ReturnType<typeof construireApp>, headers: Record<string, string> = {}, avecCompte = true) {
  const s = await deriverSecrets(genererEntropie());
  const morceaux: MorceauChiffre[] = [];
  const { sha256 } = await chiffrerOriginal(lecteurOctets(VIDEO), s.cleOriginal, async (m) => { morceaux.push(m); }, s.cleEmpreinte);
  const o = await app.inject({ method: 'POST', url: '/envois', headers, payload: {
    turnstile: 'x', conditions: CONDITIONS_VERSION, avecCompte, empreinteSuivi: s.empreinteSuivi,
    tailleOriginal: morceaux[0]!.octets.length, tailleCopie: VIDEO.length, sha256Original: sha256, schemaEmpreinte: 1, metadonnees: 'absentes',
    contexte: { date: '2026-11-03T14:12:00Z', lieu: { lat: 48.8566, lon: 2.3522 }, precision: 'exact', forces: 'unknown',
                situation: 'other', categorie: 'abuse', sousCategorie: 'other_abuse', description: 'Description d’essai, assez longue pour être acceptée.', langue: 'fr' },
  } });
  if (o.statusCode !== 201) return { ouverture: o };
  const { envoi, pseudonyme } = o.json();
  const h = { 'content-type': 'application/octet-stream', 'argos-suivi': s.jetonSuivi };
  await app.inject({ method: 'PUT', url: `/envois/${envoi}/original/0`, payload: Buffer.from(morceaux[0]!.octets), headers: h });
  await app.inject({ method: 'PUT', url: `/envois/${envoi}/copie/0`, payload: VIDEO, headers: h });
  const f = await app.inject({ method: 'POST', url: `/envois/${envoi}/finaliser`, headers: { 'argos-suivi': s.jetonSuivi },
                               payload: { cleCopie: s.cleCopie } });
  assert.equal(f.statusCode, 200, f.body);
  return { ouverture: o, envoi: envoi as string, pseudonyme: pseudonyme as string, s };
}

test('limite : 20 par heure pour un compte de confiance avec son compte, 5 à la connexion en envoi anonyme', async () => {
  const { app } = monter();
  const c = await compte();
  const { cookie } = await connecter(app, c.pseudo);
  proprietaire(`UPDATE core.accounts SET certified = true WHERE id = '${c.id}'`);
  await redis.set(`limite:envoi:heure:compte:${c.id}`, '19', 'EX', 3600);
  assert.equal((await envoyer(app, { cookie })).ouverture.statusCode, 201);     // le 20e passe
  const refus = (await envoyer(app, { cookie })).ouverture;
  assert.equal(refus.statusCode, 429);
  assert.deepEqual([refus.json().erreur, refus.json().limite], ['limite_envois', 20]);
  for (let i = 0; i < 5; i++) assert.equal((await envoyer(app, { cookie }, false)).ouverture.statusCode, 201);
  assert.equal((await envoyer(app, { cookie }, false)).ouverture.json().limite, 5);
  await app.close();
});

test('envoi avec compte : il faut être connecté', async () => {
  const { app } = monter();
  const { ouverture } = await envoyer(app, {});
  assert.deepEqual([ouverture.statusCode, ouverture.json()], [401, { erreur: 'non_connecte' }]);
  await app.close();
});

test('envoi avec compte : listé dans « Mes vidéos », suivi sans le code, et seulement par ce compte', async () => {
  const { app } = monter();
  const a = await compte();
  const b = await compte();
  const ha = await connecter(app, a.pseudo);
  const hb = await connecter(app, b.pseudo);
  const e = await envoyer(app, ha);

  const liste = (await app.inject({ method: 'GET', url: '/compte/videos', headers: ha })).json().videos;
  assert.equal(liste.length, 1);
  assert.deepEqual([liste[0].video, liste[0].pseudonyme, liste[0].etat], [e.envoi, e.pseudonyme, 'floutage_en_cours']);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/compte/videos', headers: hb })).json().videos, []);

  const suivi = await app.inject({ method: 'POST', url: '/suivi', headers: ha, payload: { video: e.envoi } });
  assert.equal(suivi.statusCode, 200);
  assert.equal(suivi.json().pseudonyme, e.pseudonyme);
  // Un autre compte, ou sans session : rien.
  assert.equal((await app.inject({ method: 'POST', url: '/suivi', headers: hb, payload: { video: e.envoi } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/suivi', payload: { video: e.envoi } })).statusCode, 401);
  // Le code et la vidéo ensemble : refusé.
  assert.equal((await app.inject({ method: 'POST', url: '/suivi', headers: ha,
                                   payload: { video: e.envoi, jeton: e.s!.jetonSuivi } })).statusCode, 400);
  // Le code de 12 mots marche toujours.
  assert.equal((await app.inject({ method: 'POST', url: '/suivi', payload: { jeton: e.s!.jetonSuivi } })).json().pseudonyme, e.pseudonyme);

  // Journal légal : l'envoi est rattaché au compte.
  assert.equal(proprietaire(`SELECT count(*) FROM identity.legal_connection_logs WHERE account_id = '${a.id}' AND action = 'upload'`), '1');
  await app.close();
});

test('envoi anonyme connecté : rien n’est rattaché au compte', async () => {
  const { app } = monter();
  const a = await compte();
  const ha = await connecter(app, a.pseudo);
  const e = await envoyer(app, ha, false);
  assert.equal(e.ouverture.statusCode, 201);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/compte/videos', headers: ha })).json().videos, []);
  assert.equal(proprietaire(`SELECT count(*) FROM core.video_owners WHERE video_id = '${e.envoi}'`), '0');
  await app.close();
});

test('retouche du floutage depuis le compte : la clé de copie gardée par le site sert', async () => {
  const { app, stockage } = monter();
  const a = await compte();
  const ha = await connecter(app, a.pseudo);
  const e = await envoyer(app, ha);
  // Ce que le worker aurait produit (copie chiffrée + pistes), puis vidéo « à vérifier ».
  mkdirSync(stockage.chemin('copies', e.envoi!), { recursive: true });
  writeFileSync(stockage.fichierVideo('copies', e.envoi!, 'pistes.json'), JSON.stringify([{ id: 0, instants: [0], zones: [[0.1, 0.1, 0.1, 0.1]] }]));
  writeFileSync(stockage.fichierVideo('copies', e.envoi!, 'verif'), createHash('sha256').update(e.s!.cleCopie).digest('hex'));
  proprietaire(`UPDATE core.videos SET status = 'awaiting_author', processing_progress = 100 WHERE id = '${e.envoi}'`);

  const avecCle = await app.inject({ method: 'POST', url: '/suivi/retoucher', headers: ha,
    payload: { video: e.envoi, cleCopie: e.s!.cleCopie, retirees: [0], zones: [] } });
  assert.equal(avecCle.statusCode, 400);   // depuis un compte, la clé ne vient jamais du navigateur
  const r = await app.inject({ method: 'POST', url: '/suivi/retoucher', headers: ha, payload: { video: e.envoi, retirees: [0], zones: [] } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await redis.get(`cle-copie:${e.envoi}`), e.s!.cleCopie);
  await app.close();
});

test('retrait depuis le compte : mot de passe exigé', async () => {
  const { app } = monter();
  const a = await compte();
  const ha = await connecter(app, a.pseudo);
  const e = await envoyer(app, ha);
  const sans = await app.inject({ method: 'POST', url: '/suivi/retirer', headers: ha, payload: { video: e.envoi, confirmation: e.pseudonyme } });
  assert.equal(sans.statusCode, 400);
  const faux = await app.inject({ method: 'POST', url: '/suivi/retirer', headers: ha, payload: { video: e.envoi, motDePasse: 'pas le bon mot de passe' } });
  assert.deepEqual([faux.statusCode, faux.json()], [401, { erreur: 'mot_de_passe_incorrect' }]);
  const ok = await app.inject({ method: 'POST', url: '/suivi/retirer', headers: ha, payload: { video: e.envoi, motDePasse: MDP } });
  assert.deepEqual([ok.statusCode, ok.json().etat], [200, 'retiree']);
  // B2 (0104) : la vidéo retirée n'est plus liée au compte.
  assert.ok(!(await app.inject({ method: 'GET', url: '/compte/videos', headers: ha })).json().videos.some((v: { video: string }) => v.video === e.envoi));
  await app.close();
});

test('jamais convoqué pour sa propre vidéo ; « ne pas me convoquer » annule les convocations en attente', async () => {
  const { app } = monter();
  const a = await compte();
  const ha = await connecter(app, a.pseudo);
  const e = await envoyer(app, ha);
  proprietaire(`UPDATE core.videos SET status = 'in_review' WHERE id = '${e.envoi}'`);
  // Tous les autres comptes actifs sont écartés le temps du tirage : seul le propriétaire pourrait être tiré.
  const autres = proprietaire(`SELECT string_agg(id::text, ',') FROM core.accounts WHERE status = 'active' AND NOT review_opt_out AND id <> '${a.id}'`);
  proprietaire(`UPDATE core.accounts SET review_opt_out = true WHERE status = 'active' AND id <> '${a.id}' AND NOT review_opt_out`);
  try {
    proprietaire('SELECT core.draw_summons()');
    assert.equal(proprietaire(`SELECT count(*) FROM core.summons WHERE video_id = '${e.envoi}' AND account_id = '${a.id}'`), '0');
    assert.equal(proprietaire(`SELECT count(*) FROM core.jury_pool('${e.envoi}', (SELECT params FROM core.settings ORDER BY version DESC LIMIT 1)) WHERE account_id = '${a.id}'`), '0');
  } finally {
    if (autres) proprietaire(`UPDATE core.accounts SET review_opt_out = false WHERE id = ANY ('{${autres}}'::uuid[])`);
    proprietaire(`UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '${e.envoi}'`);
  }

  // Une convocation en attente sur une autre vidéo, puis « ne pas me convoquer ».
  const autre = await envoyer(app, {}, false);
  proprietaire(`INSERT INTO core.summons (video_id, account_id, round, expires_at) VALUES ('${autre.envoi}', '${a.id}', 'review', now() + interval '2 days')`);
  const moi = async () => (await app.inject({ method: 'GET', url: '/moi', headers: ha })).json();
  assert.equal((await moi()).convocations, true);
  const r = await app.inject({ method: 'POST', url: '/compte/relecture', headers: ha, payload: { convoquer: false } });
  assert.deepEqual(r.json(), { convoquer: false });
  assert.equal((await moi()).convocations, false);
  assert.equal(proprietaire(`SELECT string_agg(DISTINCT outcome, ',') FROM core.summons WHERE account_id = '${a.id}' AND outcome <> 'expired'`), 'cancelled');
  await app.inject({ method: 'POST', url: '/compte/relecture', headers: ha, payload: { convoquer: true } });
  assert.equal((await moi()).convocations, true);
  await app.close();
});

test('compte effacé définitivement : la vidéo redevient anonyme', async () => {
  const { app } = monter();
  const a = await compte();
  const ha = await connecter(app, a.pseudo);
  const e = await envoyer(app, ha);
  assert.equal(proprietaire(`SELECT count(*) FROM core.video_owners WHERE video_id = '${e.envoi}'`), '1');
  proprietaire(`UPDATE core.accounts SET status = 'closing', closing_at = now() - interval '31 days' WHERE id = '${a.id}'`);
  proprietaire('SELECT core.purge_closed_accounts()');
  assert.equal(proprietaire(`SELECT count(*) FROM core.video_owners WHERE video_id = '${e.envoi}'`), '0');
  assert.equal(proprietaire(`SELECT status FROM core.videos WHERE id = '${e.envoi}'`), 'processing');   // la vidéo, elle, reste
  await app.close();
});

test('mails d’avancement : floutage prêt toujours, le reste selon les préférences, rien sur la vidéo', async () => {
  const { prevenirSources } = await import('../src/mesvideos.ts');
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const facteur = deps.facteur as unknown as { mails: { adresse: string; sujet: string; texte: string }[] };
  const a = await compte(deps.cles);
  const ha = await connecter(app, a.pseudo);
  const e = await envoyer(app, ha);
  await prevenirSources(deps);   // vide la file des autres tests
  facteur.mails.length = 0;

  // Préférences : tout est actif par défaut ; on coupe « en relecture ».
  assert.deepEqual((await app.inject({ method: 'GET', url: '/compte/notifications', headers: ha })).json(),
                   { convocations: true, relecture: true, decision: true, motifLegal: true, messageVideo: true, reponseSource: true });
  const p = await app.inject({ method: 'POST', url: '/compte/notifications', headers: ha, payload: { relecture: false } });
  assert.equal(p.json().relecture, false);

  proprietaire(`UPDATE core.videos SET status = 'awaiting_author', processing_progress = 100 WHERE id = '${e.envoi}'`);
  proprietaire(`UPDATE core.videos SET status = 'in_review' WHERE id = '${e.envoi}'`);
  proprietaire(`UPDATE core.videos SET status = 'published', decided_at = now(), decided_by_stage = 'review' WHERE id = '${e.envoi}'`);
  assert.equal(await prevenirSources(deps), 2);   // prête + décision ; « en relecture » coupé
  assert.deepEqual(facteur.mails.map((m) => m.sujet),
                   ['Argos Veille : votre vidéo est prête à vérifier', 'Argos Veille : décision sur votre vidéo']);
  for (const m of facteur.mails) {
    assert.ok(!m.texte.includes(e.pseudonyme!), 'le nom de la vidéo ne doit pas être dans le mail');
    assert.match(m.texte, /\/compte\/videos/);
  }
  assert.equal(await prevenirSources(deps), 0);   // rien en double
  await app.close();
});
