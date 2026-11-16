// Relecture (7a, 7b, 7c) : tirage des convocations par le moteur (rôle à part), ce que voit le relecteur,
// passer son tour, lien vers la version floutée, mail de convocation.
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { parseEnv } from 'node:util';
import { construireApp } from '../src/app.ts';
import { genererCodes } from '../src/codes.ts';
import { chiffrer, hacherMotDePasse } from '../src/crypto.ts';
import { ouvrirMoteur, tour } from '../src/moteur.ts';
import { prevenirConvocations } from '../src/relecture.ts';
import { dependances, preparer, proprietaire } from './aide.ts';
import { CleLogicielle } from './cle-logicielle.ts';

const socle = preparer();
const { bases, redis } = socle;
const envMoteur = parseEnv(readFileSync(new URL('../.env.moteur', import.meta.url), 'utf8'));
const moteur = ouvrirMoteur({ ...envMoteur, ARGOS_PG_DATABASE: 'argos_test' });
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  await Promise.all([bases.fermer(), moteur.end()]);
  await redis.quit();
});

function monter() {
  const { deps, facteur, stockage } = dependances(socle);
  return { app: construireApp(deps), deps, facteur, stockage };
}

/** Un relecteur inscrit et connecté ; renvoie son id, son cookie et son mail. */
async function relecteur(app: ReturnType<typeof construireApp>, deps: ReturnType<typeof monter>['deps']) {
  const pseudo = `Relecteur_${randomInt(10_000_000, 100_000_000)}`;
  const mail = `${pseudo.toLowerCase()}@exemple.fr`;
  const mdp = 'cheval correct pile agrafe';
  const r = await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(mdp), randomBytes(32), randomBytes(32), chiffrer(deps.cles, mail),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null]);
  const rep = await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: mdp } });
  return { id: r.rows[0]!.id, mail, mdp, headers: { cookie: String(rep.headers['set-cookie']).split(';')[0]! } };
}

/** Une vidéo en relecture, avec son contexte et son pseudonyme. */
function video(statut = 'in_review') {
  const id = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status, category, subcategory, forces, situation, occurred_at, location,
                  location_precision, description, language, metadata_check)
                VALUES ('${id}', '${statut}', 'violence', 'weapons', 'national_police', 'demonstration', '2026-11-01T15:00:00Z',
                  ST_GeogFromText('POINT(2.352 48.857)'), 'approx_100m', 'Tir de LBD', 'fr', 'coherent');
                INSERT INTO core.pseudonyms (video_id, pseudonym, tracking_code_hash)
                VALUES ('${id}', 'Heron-${id.slice(0, 13)}', '\\x${randomBytes(32).toString('hex')}')`);
  return id;
}

function convoquer(videoId: string, compteId: string, expire = "now() + interval '2 days'") {
  const id = randomUUID();
  // Vidéo déjà ouverte : le vote attend le premier visionnage (testé à part).
  proprietaire(`INSERT INTO core.summons (id, video_id, account_id, round, sent_at, expires_at, video_opened_at)
                VALUES ('${id}', '${videoId}', '${compteId}', 'review', least(now(), ${expire} - interval '1 hour'), ${expire},
                        least(now(), ${expire} - interval '1 hour'))`);
  return id;
}

test('moteur : 3 convocations par place, seulement pour les vidéos en relecture, avec son propre rôle', async () => {
  const relue = video();
  const brouillon = video('awaiting_author');
  const r = await tour(moteur);
  assert.ok(r.convocations > 0);
  const n = Number(proprietaire(`SELECT count(*) FROM core.summons WHERE video_id = '${relue}'`));
  const actifs = Number(proprietaire(`SELECT count(*) FROM core.accounts WHERE status = 'active'`));
  assert.equal(n, Math.min(45, actifs));
  assert.equal(proprietaire(`SELECT count(*) FROM core.summons WHERE video_id = '${brouillon}'`), '0');
  assert.equal(proprietaire(`SELECT count(*) FROM core.summons s JOIN core.accounts a ON a.id = s.account_id
                             WHERE s.video_id = '${relue}' AND a.status <> 'active'`), '0');
  // Le site, lui, ne peut pas tirer.
  await assert.rejects(bases.app.query('SELECT core.draw_summons()'), /permission|droit/);
  proprietaire(`UPDATE core.videos SET status = 'published', decided_at = now(), decided_by_stage = 'review' WHERE id = '${relue}'`);
});

test('le relecteur voit ses convocations valables, le contexte, et rien de la source', async () => {
  const { app, deps } = monter();
  assert.equal((await app.inject({ method: 'GET', url: '/relecture' })).statusCode, 401);
  const moi = await relecteur(app, deps);
  const autre = await relecteur(app, deps);
  const v = video();
  const c = convoquer(v, moi.id);
  convoquer(video(), moi.id, "now() - interval '1 minute'");   // expirée
  convoquer(video('awaiting_author'), moi.id);                   // vidéo pas en relecture
  convoquer(v, autre.id);                                        // convocation d'un autre
  const r = await app.inject({ method: 'GET', url: '/relecture', headers: moi.headers });
  assert.equal(r.statusCode, 200);
  const corps = r.json();
  assert.deepEqual([corps.relecturesAujourdhui, corps.plafondParJour, corps.mailConvocations], [0, 5, true]);
  assert.equal(corps.convocations.length, 1);
  const x = corps.convocations[0];
  assert.deepEqual(Object.keys(x).sort(), ['aEtablir', 'categorie', 'convocation', 'correction', 'date', 'description', 'evenements', 'expireLe', 'forces', 'heureConnue', 'langue', 'lieu', 'metadonnees', 'notesAnalystes', 'origine', 'pseudonyme', 'raisonsObligatoires', 'ressemblance', 'secondExamen', 'situation', 'situations', 'sousCategorie', 'sousCategories', 'verdicts']);
  assert.deepEqual([x.secondExamen, x.verdicts, x.raisonsObligatoires], [false, ['oui', 'en_partie', 'non'], true]);
  assert.equal(x.convocation, c);
  assert.deepEqual(x.lieu, { lat: 48.857, lon: 2.352, precision: 'approx_100m' });
  assert.deepEqual([x.categorie, x.sousCategorie, x.metadonnees, x.description], ['violence', 'weapons', 'coherent', 'Tir de LBD']);
  await app.close();
});

test('lien vers la version floutée : seulement pour sa propre convocation valable', async () => {
  const { app, deps, stockage } = monter();
  const moi = await relecteur(app, deps);
  const autre = await relecteur(app, deps);
  const v = video();
  const c = convoquer(v, moi.id);
  const sienne = convoquer(v, autre.id);
  mkdirSync(stockage.chemin('floutees', v), { recursive: true });
  writeFileSync(stockage.fichierVideo('floutees', v, 'video.mp4'), 'version floutée');
  const r = await app.inject({ method: 'POST', url: `/relecture/${c}/video`, headers: moi.headers, payload: {} });
  assert.equal(r.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: r.json().lien })).body, 'version floutée');
  for (const id of [sienne, randomUUID(), 'pas-un-uuid']) {
    const x = await app.inject({ method: 'POST', url: `/relecture/${id}/video`, headers: moi.headers, payload: {} });
    assert.ok([400, 404].includes(x.statusCode), id);
  }
  assert.equal((await app.inject({ method: 'POST', url: `/relecture/${c}/video`, payload: {} })).statusCode, 401);
  await app.close();
});

test('passer son tour : une fois, sans pénalité, et la convocation disparaît', async () => {
  const { app, deps } = monter();
  const moi = await relecteur(app, deps);
  const autre = await relecteur(app, deps);
  const c = convoquer(video(), moi.id);
  const sienne = convoquer(video(), autre.id);
  const passer = (id: string) => app.inject({ method: 'POST', url: `/relecture/${id}/passer`, headers: moi.headers });
  assert.equal((await passer(sienne)).statusCode, 404);
  assert.deepEqual((await passer(c)).json(), { ok: true });
  assert.equal((await passer(c)).statusCode, 404);
  assert.equal(proprietaire(`SELECT outcome FROM core.summons WHERE id = '${c}'`), 'passed');
  assert.equal(proprietaire(`SELECT outcome FROM core.summons WHERE id = '${sienne}'`), 'pending');
  assert.equal((await app.inject({ method: 'GET', url: '/relecture', headers: moi.headers })).json().convocations.length, 0);
  assert.equal(proprietaire(`SELECT score FROM core.accounts WHERE id = '${moi.id}'`), '1.000');
  await app.close();
});

test('mail de convocation : sobre, au plus un par jour, désactivable', async () => {
  const { app, deps, facteur } = monter();
  const moi = await relecteur(app, deps);
  const tranquille = await relecteur(app, deps);
  const v = video();
  convoquer(v, moi.id);
  convoquer(v, tranquille.id);
  const coupe = await app.inject({ method: 'POST', url: '/compte/notifications', headers: tranquille.headers,
                                   payload: { convocations: false } });
  assert.deepEqual([coupe.json().mailConvocations, coupe.json().convocations], [false, false]);
  // Seulement nos deux comptes : les convocations laissées par d'autres tests n'interfèrent pas.
  const prevenir = () => prevenirConvocations(deps, [moi.id, tranquille.id]);
  await prevenir();
  const pourMoi = () => facteur.mails.filter((m) => m.adresse === moi.mail);
  assert.equal(pourMoi().length, 1);
  assert.equal(facteur.mails.filter((m) => m.adresse === tranquille.mail).length, 0);
  assert.match(pourMoi()[0]!.texte, /\/relecture/);
  assert.ok(!pourMoi()[0]!.texte.includes('LBD') && !pourMoi()[0]!.texte.includes('Heron'));   // rien sur la vidéo
  convoquer(video(), moi.id);
  await prevenir();
  assert.equal(pourMoi().length, 1);   // déjà prévenu aujourd'hui
  proprietaire(`UPDATE core.accounts SET summons_notified_at = now() - interval '25 hours' WHERE id = '${moi.id}'`);
  await prevenir();
  assert.equal(pourMoi().length, 2);
  proprietaire(`UPDATE core.accounts SET summons_notified_at = now() - interval '25 hours' WHERE id = '${moi.id}'`);
  proprietaire(`UPDATE core.summons SET outcome = 'cancelled' WHERE account_id = '${moi.id}'`);
  await prevenir();
  assert.equal(pourMoi().length, 2);   // plus rien en attente : pas de mail
  await app.close();
});

// --- Vote et décision (7b) -------------------------------------------------------------------

const vote = (app: ReturnType<typeof construireApp>, headers: Record<string, string>, convocation: string, corps: object) =>
  app.inject({ method: 'POST', url: `/relecture/${convocation}/vote`, headers, payload: corps });
const OUI = { verdict: 'oui', raisons: ['intervention_visible', 'authentique'], visageIdentifiable: false };

test('vote : raisons propres au verdict, une seule fois, visage signalé', async () => {
  const { app, deps } = monter();
  const moi = await relecteur(app, deps);
  const liste = (await app.inject({ method: 'GET', url: '/relecture', headers: moi.headers })).json();
  assert.deepEqual(liste.raisons.oui.map((r: { cle: string }) => r.cle),
                   ['intervention_visible', 'contexte_coherent', 'authentique', 'categorie_correcte']);
  assert.equal(liste.raisons.non.length, 5);
  const v = video();
  const c = convoquer(v, moi.id);
  for (const mauvais of [{ ...OUI, raisons: ['rien_de_visible'] }, { ...OUI, verdict: 'non' }, { ...OUI, raisons: [] },
                         { ...OUI, raisons: ['inventee'] }, { ...OUI, verdict: 'peut-etre' }]) {
    assert.equal((await vote(app, moi.headers, c, mauvais)).statusCode, 400, JSON.stringify(mauvais));
  }
  const contradiction = await vote(app, moi.headers, c, { verdict: 'en_partie', raisons: ['contexte_coherent', 'ancienne_ou_reutilisee'],
                                                          visageIdentifiable: false });
  assert.deepEqual([contradiction.statusCode, contradiction.json()], [400, { erreur: 'raisons_contradictoires' }]);
  assert.deepEqual(liste.raisons.oui.find((x: { cle: string }) => x.cle === 'contexte_coherent').contraires,
                   ['contexte_incoherent', 'ancienne_ou_reutilisee']);
  const r = await vote(app, moi.headers, c, { verdict: 'en_partie', raisons: ['intervention_visible', 'ancienne_ou_reutilisee'],
                                              visageIdentifiable: true });
  assert.deepEqual([r.statusCode, r.json()], [200, { ok: true }]);
  assert.equal((await vote(app, moi.headers, c, OUI)).statusCode, 404);   // déjà voté
  assert.equal(proprietaire(`SELECT verdict || ' ' || array_to_string(reasons, ',') || ' ' || weight FROM core.votes
                             WHERE summons_id = '${c}'`), 'partly intervention_visible,old_or_reused 0.500');   // novice : moitié
  assert.equal(proprietaire(`SELECT count(*) FROM core.reports WHERE video_id = '${v}' AND reason_code = 'visible_identity'`), '1');
  const liste2 = (await app.inject({ method: 'GET', url: '/relecture', headers: moi.headers })).json();
  assert.deepEqual([liste2.relecturesAujourdhui, liste2.convocations.length], [1, 0]);
  // La convocation d'un autre : rien.
  const autre = await relecteur(app, deps);
  assert.equal((await vote(app, moi.headers, convoquer(v, autre.id), OUI)).statusCode, 404);
  await app.close();
});

test('premier visionnage : vote et notes attendent la vidéo ouverte et la moitié de sa durée', async () => {
  const { app, deps } = monter();
  const moi = await relecteur(app, deps);
  const v = video();
  proprietaire(`UPDATE core.videos SET duration_s = 60 WHERE id = '${v}'`);
  const c = randomUUID();
  proprietaire(`INSERT INTO core.summons (id, video_id, account_id, round, expires_at)
                VALUES ('${c}', '${v}', '${moi.id}', 'review', now() + interval '2 days')`);
  assert.deepEqual((await vote(app, moi.headers, c, OUI)).json(), { erreur: 'video_pas_encore_vue' });
  await app.inject({ method: 'POST', url: `/relecture/${c}/video`, headers: moi.headers, payload: {} });
  const tot = await vote(app, moi.headers, c, OUI);
  assert.equal(tot.json().erreur, 'video_pas_encore_vue');
  assert.ok(tot.json().disponibleDans > 25 && tot.json().disponibleDans <= 30);   // la moitié de 60 s
  proprietaire(`UPDATE core.summons SET video_opened_at = now() - interval '31 seconds' WHERE id = '${c}'`);
  assert.equal((await vote(app, moi.headers, c, OUI)).statusCode, 200);
  await app.close();
});

test('vote : 5 par 24 h au plus', async () => {
  const { app, deps } = monter();
  const moi = await relecteur(app, deps);
  for (let i = 0; i < 5; i++) assert.equal((await vote(app, moi.headers, convoquer(video(), moi.id), OUI)).statusCode, 200);
  const r = await vote(app, moi.headers, convoquer(video(), moi.id), OUI);
  assert.deepEqual([r.statusCode, r.json()], [429, { erreur: 'plafond_journalier' }]);
  await app.close();
});

test('de bout en bout : 15 votes « oui », le moteur publie et le journal public le note', async () => {
  const { app, deps } = monter();
  const v = video();
  for (let i = 0; i < 15; i++) {
    const r = await relecteur(app, deps);
    proprietaire(`UPDATE core.accounts SET created_at = now() - interval '60 days' WHERE id = '${r.id}'`);   // poids plein
    assert.equal((await vote(app, r.headers, convoquer(v, r.id), OUI)).statusCode, 200);
  }
  const t = await tour(moteur);
  assert.ok(t.decisions >= 1);
  assert.equal(proprietaire(`SELECT status || ' ' || decided_by_stage || ' ' || first_round_ratio FROM core.videos WHERE id = '${v}'`),
               'published review 1.0000');
  assert.equal(proprietaire(`SELECT count(*) FROM ledger.entries WHERE kind = 'decision' AND payload ->> 'video' = '${v}'`), '1');
  await app.close();
});

test('jury : second examen sans chiffre, oui ou non, raisons facultatives, double authentification exigée', async () => {
  const { app, deps } = monter();
  const moi = await relecteur(app, deps);
  const v = video('jury');
  proprietaire(`UPDATE core.videos SET jury_started_at = now(), first_round_ratio = 0.55 WHERE id = '${v}'`);
  const c = randomUUID();
  proprietaire(`INSERT INTO core.summons (id, video_id, account_id, round, expires_at, video_opened_at)
                VALUES ('${c}', '${v}', '${moi.id}', 'jury', now() + interval '2 days', now())`);
  const liste = (await app.inject({ method: 'GET', url: '/relecture', headers: moi.headers })).json();
  const conv = liste.convocations.find((x: { convocation: string }) => x.convocation === c);
  assert.deepEqual([conv.secondExamen, conv.verdicts, conv.raisonsObligatoires], [true, ['oui', 'non'], false]);
  assert.ok(!JSON.stringify(liste).includes('0.55'));   // rien du premier tour
  const NON = { verdict: 'non', raisons: [], visageIdentifiable: false };
  assert.deepEqual((await vote(app, moi.headers, c, { ...NON, verdict: 'en_partie' })).json(), { erreur: 'verdict_invalide' });
  const sans2fa = await vote(app, moi.headers, c, NON);
  assert.deepEqual([sans2fa.statusCode, sans2fa.json()], [403, { erreur: 'double_auth_requise' }]);
  proprietaire(`INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('${moi.id}', 'totp', '\\x00')`);
  assert.equal((await vote(app, moi.headers, c, NON)).statusCode, 200);
  assert.equal(proprietaire(`SELECT round || ' ' || verdict || ' ' || weight FROM core.votes WHERE summons_id = '${c}'`),
               'jury invalid 1.000');   // un juré, une voix
  proprietaire(`UPDATE core.videos SET status = 'under_debate', decided_at = now(), decided_by_stage = 'jury' WHERE id = '${v}'`);
  await app.close();
});

test('décision du super-administrateur : clé physique et motif exigés, inscrite au journal', async () => {
  const { app, deps } = monter();
  const admin = await relecteur(app, deps);
  const autre = await relecteur(app, deps);
  const post = (url: string, payload: object, headers: Record<string, string>) => app.inject({ method: 'POST', url, payload, headers });
  const v = video();
  assert.deepEqual((await post('/admin/decision/defi', {}, autre.headers)).json(), { erreur: 'reserve_super_admin' });
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  assert.deepEqual((await post('/admin/decision/defi', {}, admin.headers)).json(), { erreur: 'cle_requise' });
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const debut = await post('/2fa/cle/debut', { motDePasse: admin.mdp }, admin.headers);
  assert.equal((await post('/2fa/cle/confirmer', { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' }, admin.headers)).statusCode, 201);

  const decider = async (corps: object, prouver = true) => {
    const o = (await post('/admin/decision/defi', {}, admin.headers)).json().options;
    return post(`/admin/videos/${v}/decision`, { ...corps, ...(prouver ? { cle: cle.prouver(o) } : {}) }, admin.headers);
  };
  const autreCle = new CleLogicielle('https://argos.test', 'argos.test');
  const o = (await post('/admin/decision/defi', {}, admin.headers)).json().options;
  const sansLaBonneCle = await post(`/admin/videos/${v}/decision`,
    { decision: 'publier', motif: 'Vidéo vérifiée par mes soins.', cle: autreCle.prouver(o) }, admin.headers);
  assert.deepEqual([sansLaBonneCle.statusCode, sansLaBonneCle.json()], [401, { erreur: 'cle_invalide' }]);
  assert.equal((await decider({ decision: 'publier', motif: 'court' })).json().erreur, 'motif');
  assert.equal((await decider({ decision: 'publier', motif: 'Vidéo vérifiée par mes soins.' }, false)).statusCode, 400);
  const ok = await decider({ decision: 'publier', motif: 'Vidéo vérifiée par mes soins.' });
  assert.deepEqual([ok.statusCode, ok.json()], [200, { ok: true, statut: 'publiee' }]);
  assert.equal(proprietaire(`SELECT status || ' ' || decided_by_stage FROM core.videos WHERE id = '${v}'`), 'published admin');
  assert.equal(proprietaire(`SELECT payload ->> 'reason' FROM ledger.entries WHERE kind = 'admin_action' AND payload ->> 'video' = '${v}'`),
               'Vidéo vérifiée par mes soins.');
  assert.equal((await decider({ decision: 'publier', motif: 'Vidéo vérifiée par mes soins.' })).json().erreur, 'deja_ainsi');
  // Un défi ne sert qu'une fois.
  const o2 = (await post('/admin/decision/defi', {}, admin.headers)).json().options;
  const preuve = cle.prouver(o2);
  assert.equal((await post(`/admin/videos/${v}/decision`, { decision: 'rejeter', motif: 'Erreur constatée après coup.', cle: preuve }, admin.headers)).statusCode, 200);
  assert.equal((await post(`/admin/videos/${v}/decision`, { decision: 'publier', motif: 'Erreur constatée après coup.', cle: preuve }, admin.headers)).statusCode, 401);
  // Mettre en débat, puis relancer la relecture (0097).
  assert.deepEqual((await decider({ decision: 'debat', motif: 'Doute sérieux sur le contexte.' })).json(), { ok: true, statut: 'en_debat' });
  assert.deepEqual((await decider({ decision: 'relecture', motif: 'Élément nouveau : nouvelle relecture.' })).json(),
                   { ok: true, statut: 'en_relecture' });
  assert.equal((await decider({ decision: 'relecture', motif: 'Élément nouveau : nouvelle relecture.' })).json().erreur, 'video_hors_decision');
  await app.close();
});

test('purges planifiées : lien vote ↔ compte coupé après 6 mois (moteur), journaux de connexion effacés après 1 an (API)', async () => {
  const { tour } = await import('../src/moteur.ts');
  {
    const v = proprietaire(`SELECT id FROM core.votes WHERE account_id IS NOT NULL LIMIT 1`);
    if (v) {
      proprietaire(`UPDATE core.votes SET cast_at = now() - interval '7 months' WHERE id = '${v}'`);
      await tour(moteur);
      assert.equal(proprietaire(`SELECT account_id IS NULL FROM core.votes WHERE id = '${v}'`), 't');
    }
  }
  proprietaire(`INSERT INTO identity.legal_connection_logs (account_id, action, ip, occurred_at) VALUES (NULL, 'login', '192.0.2.9', now() - interval '13 months')`);
  const n = (await bases.identity.query<{ n: number }>('SELECT identity.purge_legal_logs() AS n')).rows[0]!.n;
  assert.ok(n >= 1);
  assert.equal(proprietaire(`SELECT count(*) FROM identity.legal_connection_logs WHERE occurred_at < now() - interval '1 year'`), '0');
});

test('« déjà présente » : indépendant du verdict, ressemblance montrée seulement si publiée, confirmée à 65 % du poids', async () => {
  const { app, deps } = monter();
  const moi = await relecteur(app, deps);
  const fiche = video('published');
  const brouillon = video('in_review');
  const v = video();
  const c = convoquer(v, moi.id);
  const liste = async () => (await app.inject({ method: 'GET', url: '/relecture', headers: moi.headers })).json()
    .convocations.find((x: { convocation: string }) => x.convocation === c);

  proprietaire(`INSERT INTO core.video_matches (video_id, other_video_id, level) VALUES ('${v}', '${brouillon}', 'exact')`);
  assert.equal((await liste()).ressemblance, null);   // jamais une vidéo non publiée
  proprietaire(`INSERT INTO core.video_matches (video_id, other_video_id, level) VALUES ('${v}', '${fiche}', 'possible')`);
  assert.equal((await liste()).ressemblance.video, fiche);

  for (const mauvais of ['inconnue', brouillon]) {
    assert.deepEqual((await vote(app, moi.headers, c, { ...OUI, dejaPresente: mauvais })).json(), { erreur: 'fiche_introuvable' });
  }
  assert.equal((await vote(app, moi.headers, c, { ...OUI, dejaPresente: `https://argos-veille.fr/videos/${fiche}` })).statusCode, 200);
  assert.equal(proprietaire(`SELECT verdict || '|' || duplicate_of FROM core.votes WHERE summons_id = '${c}'`).trim(), `valid|${fiche}`);

  // Fin du premier tour : poids des votes désignant la fiche / poids total.
  const second = await relecteur(app, deps);
  const fin = (x: string, poidsFiche: number, poidsAutres: number) => {
    const s1 = randomUUID(); const s2 = randomUUID();
    proprietaire(`BEGIN; ALTER TABLE core.votes DISABLE TRIGGER USER;
      INSERT INTO core.summons (id, video_id, account_id, round, expires_at) VALUES ('${s1}', '${x}', '${moi.id}', 'review', now() + interval '1 day');
      INSERT INTO core.votes (summons_id, video_id, round, verdict, reasons, is_valid, answers, weight, duplicate_of)
        VALUES ('${s1}', '${x}', 'review', 'valid', '{intervention_visible}', true, '{}', ${poidsFiche}, '${fiche}');
      INSERT INTO core.summons (id, video_id, account_id, round, expires_at) VALUES ('${s2}', '${x}', '${second.id}', 'review', now() + interval '1 day');
      INSERT INTO core.votes (summons_id, video_id, round, verdict, reasons, is_valid, answers, weight)
        VALUES ('${s2}', '${x}', 'review', 'valid', '{intervention_visible}', true, '{}', ${poidsAutres});
      ALTER TABLE core.votes ENABLE TRIGGER USER; COMMIT;
      UPDATE core.videos SET status = 'rejected', decided_at = now() WHERE id = '${x}'`);
    return proprietaire(`SELECT coalesce(duplicate_of::text, 'aucun') FROM core.videos WHERE id = '${x}'`).trim();
  };
  assert.equal(fin(video(), 7, 3), fiche);
  assert.equal(fin(video(), 6, 4), 'aucun');
  await app.close();
});

test('vidéo de contrôle : même forme qu’une vraie convocation, nom inventé, réponses annexes ignorées, sans effet sur la vidéo', async () => {
  const { app, deps } = monter();
  const moi = await relecteur(app, deps);
  const v = video('published');
  const vraie = convoquer(video(), moi.id);
  const c = randomUUID();
  proprietaire(`UPDATE core.videos SET r2_blurred_key = 'floutees/${v}', decided_at = now() WHERE id = '${v}';
                INSERT INTO core.control_videos (video_id, truth, display_pseudonym) VALUES ('${v}', true, 'Loup-Ambre-${v.slice(0, 8)}');
                INSERT INTO core.osint_notes (video_id, author_id, finding, explanation, links)
                  SELECT '${v}', '${moi.id}', 'Constat', 'Explication', ARRAY['https://exemple.fr'] WHERE false;
                INSERT INTO core.summons (id, video_id, account_id, round, expires_at, video_opened_at)
                VALUES ('${c}', '${v}', '${moi.id}', 'control', now() + interval '2 days', now() - interval '1 hour')`);
  const liste = (await app.inject({ method: 'GET', url: '/relecture', headers: moi.headers })).json().convocations;
  const trouver = (id: string) => liste.find((x: { convocation: string }) => x.convocation === id);
  const controle = trouver(c);
  assert.deepEqual(Object.keys(controle).sort(), Object.keys(trouver(vraie)).sort());
  assert.equal(controle.pseudonyme, `Loup-Ambre-${v.slice(0, 8)}`);
  assert.equal(controle.secondExamen, false);
  assert.equal(controle.raisonsObligatoires, true);
  assert.equal(controle.notesAnalystes, 0);
  assert.equal(controle.correction, null);

  const notes = await app.inject({ method: 'GET', url: `/relecture/${c}/notes`, headers: moi.headers });
  assert.deepEqual(notes.json().notes, []);
  // Désigner sa propre fiche ne doit rien révéler : pas d'erreur, et rien d'enregistré.
  const r = await vote(app, moi.headers, c, { ...OUI, dejaPresente: v, memeEvenement: v });
  assert.deepEqual([r.statusCode, r.json()], [200, { ok: true }]);
  assert.equal(proprietaire(`SELECT coalesce(duplicate_of::text, 'aucun') || '|' || round FROM core.votes WHERE summons_id = '${c}'`).trim(), 'aucun|control');
  assert.equal(proprietaire(`SELECT status FROM core.videos WHERE id = '${v}'`).trim(), 'published');
  await app.close();
});
