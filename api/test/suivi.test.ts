// Suivi et retrait par la source, à partir de la phrase de 12 mots qu'elle retape.
import { CONDITIONS_VERSION } from '../src/conditions.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import {
  chiffrerOriginal, deriverSecrets, genererEntropie, lecteurOctets, lirePhrase, phraseDepuisEntropie, sansAccents,
  type MorceauChiffre,
} from '../../navigateur/src/index.ts';
import { construireApp } from '../src/app.ts';
import { plage, purgerNonPubliees, reprendreSuppressions, validerSansReponse } from '../src/suivi.ts';
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

function monter() {
  const { deps, stockage } = dependances(socle);
  const app = construireApp(deps);
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  return { app, deps, stockage, post };
}

/** Ce que le worker aurait produit : versions floutées, et copie chiffrée + pistes si la clé était là. */
function traitee(stockage: ReturnType<typeof monter>['stockage'], id: string, copie = true, cle?: string) {
  mkdirSync(stockage.chemin('floutees', id), { recursive: true });
  writeFileSync(stockage.fichierVideo('floutees', id, 'apercu.mp4'), APERCU);
  writeFileSync(stockage.fichierVideo('floutees', id, 'video.mp4'), COMPLETE);
  if (copie) {
    mkdirSync(stockage.chemin('copies', id), { recursive: true });
    writeFileSync(`${stockage.chemin('copies', id)}/copie.enc`, 'chiffrée');
    writeFileSync(stockage.fichierVideo('copies', id, 'pistes.json'), JSON.stringify(PISTES));
    if (cle) writeFileSync(stockage.fichierVideo('copies', id, 'verif'), createHash('sha256').update(cle).digest('hex'));
  }
  proprietaire(`UPDATE core.videos SET status = 'awaiting_author', processing_progress = 100 WHERE id = '${id}'`);
}
const APERCU = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
const COMPLETE = Buffer.from('version complète');
const PISTES = [{ id: 0, instants: [0, 0.1], zones: [[0.1, 0.2, 0.05, 0.08], [0.11, 0.2, 0.05, 0.08]] }];

/** Une source envoie une vidéo ; renvoie sa phrase (telle qu'elle l'a notée), l'envoi et son pseudonyme. */
async function envoyer(app: ReturnType<typeof construireApp>, finaliser = true, extra: object = {}) {
  const entropie = genererEntropie();
  const phrase = (await phraseDepuisEntropie(entropie)).join(' ');
  const s = await deriverSecrets(entropie);
  const morceaux: MorceauChiffre[] = [];
  const { sha256 } = await chiffrerOriginal(lecteurOctets(VIDEO), s.cleOriginal, async (m) => { morceaux.push(m); }, s.cleEmpreinte);
  const o = await app.inject({ method: 'POST', url: '/envois', payload: {
    ...extra, turnstile: 'x', conditions: CONDITIONS_VERSION, empreinteSuivi: s.empreinteSuivi, tailleOriginal: morceaux[0]!.octets.length, tailleCopie: VIDEO.length,
    sha256Original: sha256, schemaEmpreinte: 1, metadonnees: 'absentes',
    contexte: { date: '2026-11-03T14:12:00Z', lieu: { lat: 48.8566, lon: 2.3522 }, precision: 'exact', forces: 'unknown',
                situation: 'other', categorie: 'abuse', sousCategorie: 'other_abuse', description: 'Description d’essai, assez longue pour être acceptée.', langue: 'fr' },
  } });
  const { envoi, pseudonyme } = o.json();
  const h = { 'content-type': 'application/octet-stream', 'argos-suivi': s.jetonSuivi };
  await app.inject({ method: 'PUT', url: `/envois/${envoi}/original/0`, payload: Buffer.from(morceaux[0]!.octets), headers: h });
  await app.inject({ method: 'PUT', url: `/envois/${envoi}/copie/0`, payload: VIDEO, headers: h });
  if (finaliser) await app.inject({ method: 'POST', url: `/envois/${envoi}/finaliser`, headers: { 'argos-suivi': s.jetonSuivi },
                                    payload: { cleCopie: s.cleCopie } });
  return { phrase, jeton: s.jetonSuivi, cleCopie: s.cleCopie, envoi: envoi as string, pseudonyme: pseudonyme as string };
}

/** Ce que fera le navigateur sur la page de suivi : relire la phrase tapée et en dériver le jeton. */
async function jetonDepuisSaisie(saisie: string) {
  const l = await lirePhrase(saisie);
  assert.ok(l.ok, 'phrase illisible');
  return (await deriverSecrets(l.entropie)).jetonSuivi;
}

test('suivi depuis la phrase retapée (sans accents, en majuscules) : état, dates, rien de plus', async () => {
  const { app, post } = monter();
  const e = await envoyer(app);
  const jeton = await jetonDepuisSaisie(sansAccents(e.phrase).toUpperCase());
  assert.equal(jeton, e.jeton);
  const r = await post('/suivi', { jeton });
  assert.equal(r.statusCode, 200);
  const corps = r.json();
  assert.deepEqual(Object.keys(corps).sort(), ['avancement', 'envoyeeLe', 'etat', 'fileAttente', 'libelle', 'pseudonyme', 'transmission']);   // ni votes, ni scores
  assert.deepEqual({ ...corps.transmission, empreinte: undefined }, { autorisee: false, autoriseeLe: null, transmissions: [], telechargements: [], proposee: false, empreinte: undefined });
  assert.equal(corps.avancement, 0);
  assert.deepEqual([corps.pseudonyme, corps.etat, corps.libelle], [e.pseudonyme, 'floutage_en_cours', 'Floutage en cours']);
  proprietaire(`UPDATE core.videos SET status = 'published', decided_at = now(), decided_by_stage = 'review' WHERE id = '${e.envoi}'`);
  const publiee = (await post('/suivi', { jeton })).json();
  assert.equal(publiee.etat, 'publiee');
  assert.ok(publiee.decideeLe);
  await app.close();
});

test('envoi en cours : le suivi donne de quoi reprendre l\'envoi', async () => {
  const { app, post } = monter();
  const e = await envoyer(app, false);
  assert.deepEqual((await post('/suivi', { jeton: e.jeton })).json().envoi, e.envoi);
  await app.close();
});

test('jeton inconnu : réponse neutre', async () => {
  const { app, post } = monter();
  const inconnu = (await deriverSecrets(genererEntropie())).jetonSuivi;
  assert.deepEqual((await post('/suivi', { jeton: inconnu })).json(), { erreur: 'introuvable' });
  assert.deepEqual((await post('/suivi/retirer', { jeton: inconnu, confirmation: 'x' })).json(), { erreur: 'introuvable' });
  await app.close();
});

test('limites : le bon code n\'est pas freiné (actualisation), 30 codes faux par heure bloquent l\'adresse', async () => {
  const { app, post } = monter();
  const { jeton } = await envoyer(app);
  for (let i = 0; i < 40; i++) assert.equal((await post('/suivi', { jeton })).statusCode, 200, `consultation ${i + 1}`);
  for (let i = 0; i < 30; i++) {
    assert.equal((await post('/suivi', { jeton: (await deriverSecrets(genererEntropie())).jetonSuivi })).statusCode, 404);
  }
  assert.deepEqual((await post('/suivi', { jeton })).json(), { erreur: 'trop_de_demandes' });
  await app.close();
});

test('retrait : pseudonyme retapé exigé, fichiers et contenu effacés, trace minimale, irréversible', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  assert.ok(existsSync(stockage.chemin('originaux', e.envoi)));
  assert.deepEqual((await post('/suivi/retirer', { jeton: e.jeton, confirmation: 'Autre-Chose-1234' })).json(), { erreur: 'confirmation' });
  // Saisie tolérante : minuscules, sans accents.
  const r = await post('/suivi/retirer', { jeton: e.jeton, confirmation: sansAccents(e.pseudonyme) });
  assert.deepEqual([r.statusCode, r.json()], [200, { ok: true, etat: 'retiree' }]);
  assert.ok(!existsSync(stockage.chemin('originaux', e.envoi)) && !existsSync(stockage.chemin('quarantaine', e.envoi)));
  assert.equal(proprietaire(`SELECT status || ' ' || coalesce(description, '-') || ' ' || coalesce(location::text, '-')
                             FROM core.videos WHERE id = '${e.envoi}'`), 'withdrawn - -');
  assert.equal(proprietaire(`SELECT count(*) FROM ledger.entries WHERE kind = 'withdrawal' AND payload->>'video' = '${e.envoi}'`), '1');
  // B2 (0104) : après le retrait, le code ne désigne plus la vidéo (rien ne relie plus la source à elle).
  assert.equal((await post('/suivi', { jeton: e.jeton })).statusCode, 404);
  assert.equal((await post('/suivi/retirer', { jeton: e.jeton, confirmation: e.pseudonyme })).statusCode, 404);
  await app.close();
});

test('retrait : journal légal en panne → fichiers quand même effacés, retrait fait (contre-vérification du second audit)', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  // Sceau obligatoire sans clé posée : log_legal refuse toute écriture.
  proprietaire(`UPDATE identity.legal_seal_settings SET required = true`);
  try {
    const r = await post('/suivi/retirer', { jeton: e.jeton, confirmation: e.pseudonyme });
    assert.deepEqual([r.statusCode, r.json()], [200, { ok: true, etat: 'retiree' }]);
    assert.ok(!existsSync(stockage.chemin('originaux', e.envoi)) && !existsSync(stockage.chemin('quarantaine', e.envoi)));
  } finally {
    proprietaire(`UPDATE identity.legal_seal_settings SET required = false`);
  }
  await app.close();
});

test('retrait : stockage en panne → autres fichiers et journal faits, suppression reportée puis reprise (0127)', async () => {
  const { app, deps, stockage, post } = monter();
  const e = await envoyer(app);
  const vraie = stockage.supprimer.bind(stockage);
  let panne = true;
  stockage.supprimer = async (espace, id) => {
    if (panne && espace === 'originaux') throw Object.assign(new Error('R2 injoignable'), { code: 'ECONNRESET' });
    return vraie(espace, id);
  };
  const r = await post('/suivi/retirer', { jeton: e.jeton, confirmation: e.pseudonyme });
  assert.deepEqual([r.statusCode, r.json()], [200, { ok: true, etat: 'retiree' }]);
  assert.ok(existsSync(stockage.chemin('originaux', e.envoi)));          // pas encore effacé…
  assert.ok(!existsSync(stockage.chemin('quarantaine', e.envoi)));      // …mais les autres, si
  assert.equal(proprietaire(`SELECT espace FROM core.pending_deletions WHERE video_id = '${e.envoi}'`), 'originaux');
  panne = false;
  assert.equal(await reprendreSuppressions(deps), 1);
  assert.ok(!existsSync(stockage.chemin('originaux', e.envoi)));
  assert.equal(proprietaire(`SELECT count(*) FROM core.pending_deletions WHERE video_id = '${e.envoi}'`), '0');
  await app.close();
});

test('T1 : vidéo refusée depuis 30 jours effacée (fichiers, contenu, empreintes), ligne gardée ; gel légal et récentes épargnées', async () => {
  const { app, deps, stockage, post } = monter();
  const [a, gelee, recente] = [await envoyer(app), await envoyer(app), await envoyer(app)];
  for (const e of [a, gelee, recente]) {
    proprietaire(`UPDATE core.videos SET status = 'rejected', decided_at = now() - interval '31 days' WHERE id = '${e.envoi}';
                  INSERT INTO core.video_fingerprints (video_id, algo_version, origin, visual, visual_mirror)
                  VALUES ('${e.envoi}', 1, 'blurred', '\\x0000000000000000', '\\x0000000000000000')`);
  }
  proprietaire(`UPDATE core.videos SET legal_hold = true WHERE id = '${gelee.envoi}';
                UPDATE core.videos SET decided_at = now() - interval '29 days' WHERE id = '${recente.envoi}'`);
  // Traces qui relient la vidéo à sa source : compte, historique de description (les conversations : même fonction).
  proprietaire(`INSERT INTO core.video_owners (video_id, account_id) SELECT '${a.envoi}', id FROM core.accounts LIMIT 1;
                INSERT INTO core.description_corrections (video_id, justification) VALUES ('${a.envoi}', 'essai de justification')`);
  const journal = { error: () => {}, info: () => {} } as unknown as Parameters<typeof purgerNonPubliees>[1];
  assert.equal((await post('/suivi', { jeton: a.jeton })).statusCode, 200);
  assert.ok((await purgerNonPubliees(deps, journal)) >= 1);   // au moins celle-ci (d'éventuels restes d'autres essais aussi)
  assert.equal(proprietaire(`SELECT (SELECT count(*) FROM core.video_owners WHERE video_id = '${a.envoi}')
    + (SELECT count(*) FROM core.conversations c JOIN core.pseudonyms p ON p.id = c.pseudonym_id WHERE p.video_id = '${a.envoi}')
    + (SELECT count(*) FROM core.description_corrections WHERE video_id = '${a.envoi}')
    + (SELECT count(*) FROM core.videos WHERE id = '${a.envoi}' AND (original_sha256 IS NOT NULL OR blurred_sha256 IS NOT NULL))`), '0');
  assert.equal((await post('/suivi', { jeton: a.jeton })).statusCode, 404);   // les 12 mots ne désignent plus la vidéo
  assert.equal(proprietaire(`SELECT status || ' ' || coalesce(description, '-') || ' ' || coalesce(location::text, '-') || ' '
                             || (purged_on IS NOT NULL) FROM core.videos WHERE id = '${a.envoi}'`), 'rejected - - true');
  assert.equal(proprietaire(`SELECT count(*) FROM core.video_fingerprints WHERE video_id = '${a.envoi}'`), '0');
  assert.ok(!existsSync(stockage.chemin('originaux', a.envoi)) && !existsSync(stockage.chemin('quarantaine', a.envoi)));
  for (const e of [gelee, recente]) {
    assert.equal(proprietaire(`SELECT (purged_on IS NULL) || ' ' || (description IS NOT NULL) FROM core.videos WHERE id = '${e.envoi}'`), 'true true');
    assert.ok(existsSync(stockage.chemin('originaux', e.envoi)));
  }
  // Plus d'empreinte possible pour la vidéo effacée.
  assert.equal(proprietaire(`SELECT core.save_fingerprints('${a.envoi}', 1::smallint, 'blurred', '\\x00', '\\x00', NULL, NULL)`), 'f');
  assert.equal(await purgerNonPubliees(deps, journal), 0);   // une seule fois
  await app.close();
});

test('retrait d\'un envoi jamais finalisé : tout disparaît', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app, false);
  const r = await post('/suivi/retirer', { jeton: e.jeton, confirmation: e.pseudonyme });
  assert.deepEqual(r.json(), { ok: true, etat: 'effacee' });
  assert.equal(proprietaire(`SELECT count(*) FROM core.videos WHERE id = '${e.envoi}'`), '0');
  assert.deepEqual((await stockage.lister('originaux')).filter((f) => f.startsWith(e.envoi)), []);
  assert.equal((await post('/suivi', { jeton: e.jeton })).statusCode, 404);
  await app.close();
});

test('conservation légale : retrait bloqué, rien n\'est effacé', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  proprietaire(`UPDATE core.videos SET legal_hold = true WHERE id = '${e.envoi}'`);
  const r = await post('/suivi/retirer', { jeton: e.jeton, confirmation: e.pseudonyme });
  assert.deepEqual([r.statusCode, r.json()], [423, { erreur: 'retrait_bloque' }]);
  assert.ok(existsSync(stockage.chemin('originaux', e.envoi)));
  assert.equal((await post('/suivi', { jeton: e.jeton })).json().etat, 'floutage_en_cours');
  await app.close();
});

test('le jeton ne passe jamais par l\'adresse', async () => {
  const { app } = monter();
  const e = await envoyer(app);
  assert.equal((await app.inject({ method: 'GET', url: `/suivi?jeton=${e.jeton}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/suivi/${e.jeton}` })).statusCode, 404);
  await app.close();
});

test("file d'attente : place dans la file, puis 0 une fois la vidéo prise par le worker", async () => {
  const { app, post } = monter();
  const a = await envoyer(app);
  const b = await envoyer(app);
  const place = async (e: { jeton: string }) => (await post('/suivi', { jeton: e.jeton })).json().fileAttente as number;
  const pa = await place(a);
  assert.ok(pa >= 1);
  assert.equal(await place(b), pa + 1);   // la plus ancienne passe d'abord
  proprietaire(`UPDATE core.videos SET processing_started_at = now() WHERE id = '${a.envoi}'`);   // prise par le worker
  assert.equal(await place(a), 0);
  assert.equal(await place(b), pa);
  await app.close();
});

test('traitement : avancement en %, puis échec expliqué', async () => {
  const { app, post } = monter();
  const e = await envoyer(app);
  proprietaire(`UPDATE core.videos SET processing_progress = 45 WHERE id = '${e.envoi}'`);
  assert.equal((await post('/suivi', { jeton: e.jeton })).json().avancement, 45);
  proprietaire(`UPDATE core.videos SET status = 'failed', failure_reason = 'too_long', processing_progress = NULL WHERE id = '${e.envoi}'`);
  const echec = (await post('/suivi', { jeton: e.jeton })).json();
  assert.deepEqual([echec.etat, echec.raison], ['echec', 'La vidéo dépasse 20 minutes.']);
  await app.close();
});

test('retrait : les versions floutées sont effacées aussi', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  // Ce que le worker aurait produit.
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(stockage.chemin('floutees', e.envoi), { recursive: true });
  writeFileSync(`${stockage.chemin('floutees', e.envoi)}/apercu.mp4`, 'x');
  writeFileSync(`${stockage.chemin('floutees', e.envoi)}/video.mp4`, 'x');
  await post('/suivi/retirer', { jeton: e.jeton, confirmation: e.pseudonyme });
  assert.ok(!existsSync(stockage.chemin('floutees', e.envoi)));
  await app.close();
});

test('à vérifier : échéance à 7 jours et retouches restantes', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  traitee(stockage, e.envoi);
  const r = (await post('/suivi', { jeton: e.jeton })).json();
  assert.equal(r.etat, 'a_verifier');
  assert.equal(r.retouchesRestantes, 10);
  const jours = (Date.parse(r.echeance) - Date.now()) / 86_400_000;
  assert.ok(jours > 6.99 && jours <= 8, String(jours));   // échéance arrondie au jour suivant (0117)
  await app.close();
});

test("lien d'aperçu : 10 minutes, lecture par plages, aucune trace du lien dans Redis", async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  assert.deepEqual((await post('/suivi/apercu', { jeton: e.jeton })).json(), { erreur: 'pas_de_version_floutee' });   // encore en traitement
  traitee(stockage, e.envoi);
  const a = (await post('/suivi/apercu', { jeton: e.jeton })).json();
  assert.equal(a.expireDans, 600);
  const lien = /^\/apercu\/([A-Za-z0-9_-]{43})$/.exec(a.lien)![1]!;
  const cles = await redis.keys('argos:apercu:*');
  assert.equal(cles.length, 1);
  assert.ok(!cles[0]!.includes(lien) && !(await redis.get(cles[0]!.replace(/^argos:/, '')))!.includes(lien));
  const ttl = await redis.ttl(cles[0]!.replace(/^argos:/, ''));
  assert.ok(ttl > 590 && ttl <= 600);

  const get = (range?: string) => app.inject({ method: 'GET', url: a.lien, headers: range ? { range } : {} });
  const tout = await get();
  assert.deepEqual([tout.statusCode, tout.headers['content-type'], tout.headers['accept-ranges']], [200, 'video/mp4', 'bytes']);
  assert.deepEqual(tout.rawPayload, APERCU);
  const debut = await get('bytes=0-9');
  assert.deepEqual([debut.statusCode, debut.headers['content-range'], debut.rawPayload], [206, 'bytes 0-9/1000', APERCU.subarray(0, 10)]);
  assert.deepEqual((await get('bytes=990-')).rawPayload, APERCU.subarray(990));
  assert.deepEqual((await get('bytes=-5')).rawPayload, APERCU.subarray(995));
  assert.equal((await get('bytes=500-99999')).headers['content-range'], 'bytes 500-999/1000');
  for (const mauvaise of ['bytes=1000-', 'bytes=5-1', 'bytes=0-1,3-4', 'octets=0-1', 'bytes=-0', 'bytes=-']) {
    const r = await get(mauvaise);
    assert.deepEqual([r.statusCode, r.headers['content-range']], [416, 'bytes */1000'], mauvaise);
  }
  const complete = (await post('/suivi/apercu', { jeton: e.jeton, qualite: 'complete' })).json();
  assert.deepEqual((await app.inject({ method: 'GET', url: complete.lien })).rawPayload, COMPLETE);

  // Lien expiré (ou inventé) : rien.
  await redis.del(cles[0]!.replace(/^argos:/, ''));
  assert.deepEqual([(await get()).statusCode, (await get()).json()], [404, { erreur: 'lien_expire' }]);
  for (const faux of ['x', '../../etc/passwd', 'A'.repeat(43), 'A'.repeat(44)]) {
    assert.equal((await app.inject({ method: 'GET', url: `/apercu/${encodeURIComponent(faux)}` })).statusCode, faux === 'A'.repeat(43) ? 404 : 400, faux);
  }
  assert.equal((await post('/suivi/apercu', { jeton: e.jeton, qualite: '../originaux' })).statusCode, 400);
  await app.close();
});

test('plages : cas limites', () => {
  assert.equal(plage(undefined, 10), null);
  assert.deepEqual(plage('bytes=-20', 10), { debut: 0, fin: 9 });
  assert.equal(plage('bytes=0-0', 0), 'invalide');
  assert.equal(plage('bytes=' + '9'.repeat(16) + '-', 10), 'invalide');
});

test('pistes des flous : données pour les retouches, ou rien si aucune copie gardée', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  assert.deepEqual((await post('/suivi/masques', { jeton: e.jeton })).json(), { erreur: 'pas_a_verifier' });
  traitee(stockage, e.envoi);
  const m = (await post('/suivi/masques', { jeton: e.jeton })).json();
  assert.deepEqual([m.retouchable, m.pistes, m.retouchesRestantes], [true, PISTES, 10]);
  const f = await envoyer(app);
  traitee(stockage, f.envoi, false);
  assert.deepEqual((await post('/suivi/masques', { jeton: f.jeton })).json().retouchable, false);
  await app.close();
});

test('validation par la source : en relecture, copie de travail effacée, une seule fois', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  assert.deepEqual((await post('/suivi/valider', { jeton: e.jeton })).json(), { erreur: 'pas_a_verifier' });   // en traitement
  traitee(stockage, e.envoi);
  const v = await post('/suivi/valider', { jeton: e.jeton });
  assert.deepEqual([v.statusCode, v.json()], [200, { ok: true, etat: 'en_relecture' }]);
  assert.equal(proprietaire(`SELECT status FROM core.videos WHERE id = '${e.envoi}'`), 'in_review');
  assert.ok(!existsSync(stockage.chemin('copies', e.envoi)));
  assert.ok(existsSync(stockage.fichierVideo('floutees', e.envoi, 'video.mp4')));   // la version floutée reste
  assert.equal((await post('/suivi/valider', { jeton: e.jeton })).statusCode, 409);
  // La source peut toujours revoir la version floutée.
  assert.equal((await post('/suivi/apercu', { jeton: e.jeton })).statusCode, 200);
  await app.close();
});

test('sans réponse en 7 jours : départ en relecture ; copies orphelines effacées', async () => {
  const { app, deps, stockage } = monter();
  const vieille = await envoyer(app);
  const recente = await envoyer(app);
  const retiree = await envoyer(app);
  for (const e of [vieille, recente, retiree]) traitee(stockage, e.envoi);
  proprietaire(`UPDATE core.videos SET review_deadline = now() - interval '1 minute' WHERE id = '${vieille.envoi}'`);
  // Course : la source retire la vidéo pendant que le worker écrivait la copie.
  proprietaire(`UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '${retiree.envoi}'`);
  assert.ok((await validerSansReponse(deps)) >= 1);
  assert.equal(proprietaire(`SELECT status FROM core.videos WHERE id = '${vieille.envoi}'`), 'in_review');
  assert.equal(proprietaire(`SELECT status FROM core.videos WHERE id = '${recente.envoi}'`), 'awaiting_author');
  assert.ok(!existsSync(stockage.chemin('copies', vieille.envoi)));
  assert.ok(!existsSync(stockage.chemin('copies', retiree.envoi)));
  assert.ok(existsSync(stockage.chemin('copies', recente.envoi)));
  await app.close();
});

test('retrait : la copie de travail chiffrée est effacée aussi', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  traitee(stockage, e.envoi);
  await post('/suivi/retirer', { jeton: e.jeton, confirmation: e.pseudonyme });
  assert.ok(!existsSync(stockage.chemin('copies', e.envoi)) && !existsSync(stockage.chemin('floutees', e.envoi)));
  await app.close();
});

// --- Retouches (6c-2) ---------------------------------------------------------------------------

const ZONE = { debut: 1, fin: 3, de: [0.1, 0.1, 0.2, 0.2], a: [0.5, 0.3, 0.2, 0.2] };

test('retouche : demande enregistrée, clé de copie dans Redis le temps du traitement, compteur', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  await redis.del(`cle-copie:${e.envoi}`);   // le worker l'aurait déjà effacée
  traitee(stockage, e.envoi, true, e.cleCopie);
  const r = await post('/suivi/retoucher', { jeton: e.jeton, cleCopie: e.cleCopie, retirees: [0], zones: [ZONE] });
  assert.deepEqual([r.statusCode, r.json()], [200, { ok: true, etat: 'floutage_en_cours', retouchesRestantes: 9 }]);
  assert.equal(proprietaire(`SELECT status || ' ' || retouches || ' ' || processing_attempts FROM core.videos WHERE id = '${e.envoi}'`),
               'processing 1 0');
  assert.deepEqual(JSON.parse(readFileSync(stockage.fichierVideo('copies', e.envoi, 'demande.json'), 'utf8')),
                   { retirees: [0], zones: [ZONE] });
  assert.equal(await redis.get(`cle-copie:${e.envoi}`), e.cleCopie);
  assert.ok((await redis.ttl(`cle-copie:${e.envoi}`)) <= 24 * 3600);
  // Pendant le traitement : pas d'aperçu, pas de nouvelle retouche, pas de validation.
  assert.equal((await post('/suivi', { jeton: e.jeton })).json().etat, 'floutage_en_cours');
  assert.equal((await post('/suivi/retoucher', { jeton: e.jeton, cleCopie: e.cleCopie, retirees: [], zones: [] })).statusCode, 409);
  assert.equal((await post('/suivi/valider', { jeton: e.jeton })).statusCode, 409);
  // Retour du worker : la retouche appliquée est rendue à la source.
  proprietaire(`UPDATE core.videos SET status = 'awaiting_author' WHERE id = '${e.envoi}'`);
  writeFileSync(stockage.fichierVideo('copies', e.envoi, 'retouche.json'), JSON.stringify({ retirees: [0], zones: [ZONE] }));
  const m = (await post('/suivi/masques', { jeton: e.jeton })).json();
  assert.deepEqual([m.retouche, m.retouchesRestantes], [{ retirees: [0], zones: [ZONE] }, 9]);
  await app.close();
});

test('retouche : mauvaise clé, zones et pistes invalides, rien ne change', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  traitee(stockage, e.envoi, true, e.cleCopie);
  const essai = (corps: object) => post('/suivi/retoucher', { jeton: e.jeton, cleCopie: e.cleCopie, retirees: [], zones: [], ...corps });
  assert.deepEqual((await essai({ cleCopie: 'B'.repeat(43) })).json(), { erreur: 'cle_copie' });
  for (const zone of [{ ...ZONE, fin: 1 }, { ...ZONE, de: [0.9, 0.1, 0.2, 0.2] }, { ...ZONE, a: [0.1, 0.1, 0.001, 0.2] }]) {
    assert.deepEqual((await essai({ zones: [zone] })).json(), { erreur: 'zone_invalide' }, JSON.stringify(zone));
  }
  for (const zone of [{ ...ZONE, de: [0.1, 0.1, 0.2] }, { ...ZONE, de: [-0.1, 0.1, 0.2, 0.2] }, { ...ZONE, fin: 5000 }, { ...ZONE, x: 1 }]) {
    assert.equal((await essai({ zones: [zone] })).statusCode, 400, JSON.stringify(zone));
  }
  assert.equal((await essai({ zones: Array(501).fill(ZONE) })).statusCode, 400);
  assert.equal((await essai({ retirees: [0, 0] })).statusCode, 400);
  assert.deepEqual((await essai({ retirees: [7] })).json(), { erreur: 'piste_inconnue' });
  assert.equal(proprietaire(`SELECT status || ' ' || retouches FROM core.videos WHERE id = '${e.envoi}'`), 'awaiting_author 0');
  assert.ok(!existsSync(stockage.fichierVideo('copies', e.envoi, 'demande.json')));
  await app.close();
});

test('retouche : 10 au plus ; impossible sans copie gardée', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  traitee(stockage, e.envoi, true, e.cleCopie);
  proprietaire(`UPDATE core.videos SET retouches = 10 WHERE id = '${e.envoi}'`);
  const corps = { jeton: e.jeton, cleCopie: e.cleCopie, retirees: [], zones: [] };
  assert.deepEqual((await post('/suivi/retoucher', corps)).json(), { erreur: 'retouches_epuisees' });
  const f = await envoyer(app);
  traitee(stockage, f.envoi, false);
  assert.deepEqual((await post('/suivi/retoucher', { ...corps, jeton: f.jeton, cleCopie: f.cleCopie })).json(), { erreur: 'non_retouchable' });
  await app.close();
});

test('retouche : deux demandes simultanées, une seule passe', async () => {
  const { app, stockage, post } = monter();
  const e = await envoyer(app);
  traitee(stockage, e.envoi, true, e.cleCopie);
  const corps = (n: number) => ({ jeton: e.jeton, cleCopie: e.cleCopie, retirees: [], zones: Array(n).fill(ZONE) });
  const [a, b] = await Promise.all([post('/suivi/retoucher', corps(1)), post('/suivi/retoucher', corps(2))]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  const gagnante = a.statusCode === 200 ? 1 : 2;
  assert.equal(JSON.parse(readFileSync(stockage.fichierVideo('copies', e.envoi, 'demande.json'), 'utf8')).zones.length, gagnante);
  assert.equal(proprietaire(`SELECT retouches FROM core.videos WHERE id = '${e.envoi}'`), '1');
  await app.close();
});

test('nettoyage : la copie d\'une vidéo en cours de retouche est gardée', async () => {
  const { app, deps, stockage } = monter();
  const e = await envoyer(app);
  traitee(stockage, e.envoi);
  proprietaire(`UPDATE core.videos SET status = 'processing', retouches = 1 WHERE id = '${e.envoi}'`);
  await validerSansReponse(deps);
  assert.ok(existsSync(stockage.chemin('copies', e.envoi)));
  await app.close();
});

test('ressemblance : annoncée à la source seulement si l’autre vidéo est publiée', async () => {
  const { app, post } = monter();
  const a = await envoyer(app);
  const b = await envoyer(app);
  proprietaire(`UPDATE core.videos SET status = 'awaiting_author' WHERE id = '${a.envoi}';
                UPDATE core.videos SET status = 'in_review' WHERE id = '${b.envoi}';
                INSERT INTO core.video_matches (video_id, other_video_id, level) VALUES ('${a.envoi}', '${b.envoi}', 'strong')`);
  assert.equal((await post('/suivi', { jeton: a.jeton })).json().ressemblance, undefined);
  for (const statut of ['rejected', 'hidden', 'removed']) {
    proprietaire(`UPDATE core.videos SET status = '${statut}' WHERE id = '${b.envoi}'`);
    assert.equal((await post('/suivi', { jeton: a.jeton })).json().ressemblance, undefined, statut);
  }
  proprietaire(`UPDATE core.videos SET status = 'published' WHERE id = '${b.envoi}'`);
  assert.deepEqual((await post('/suivi', { jeton: a.jeton })).json().ressemblance, { video: b.envoi, pseudonyme: b.pseudonyme });

  proprietaire(`UPDATE core.video_matches SET level = 'possible' WHERE video_id = '${a.envoi}'`);
  assert.equal((await post('/suivi', { jeton: a.jeton })).json().ressemblance, undefined);
  proprietaire(`UPDATE core.video_matches SET level = 'strong', dismissed_at = now() WHERE video_id = '${a.envoi}'`);
  assert.equal((await post('/suivi', { jeton: a.jeton })).json().ressemblance, undefined);
  await app.close();
});

test('code unique : les vidéos d’un code, dans l’ordre des positions ; jeton inconnu sans effet', async () => {
  const { app, post } = monter();
  const a = await envoyer(app);
  const b = await envoyer(app);
  const inconnu = 'A'.repeat(43);
  const r = await post('/suivi/videos', { jetons: [a.jeton, inconnu, b.jeton] });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().videos.map((v: { position: number; pseudonyme: string }) => [v.position, v.pseudonyme]), [[0, a.pseudonyme], [2, b.pseudonyme]]);
  assert.deepEqual(Object.keys(r.json().videos[0]).sort(), ['envoyeeLe', 'libelle', 'position', 'pseudonyme']);
  assert.equal((await post('/suivi/videos', { jetons: [inconnu] })).statusCode, 404);
  assert.equal((await post('/suivi/videos', { jetons: Array(51).fill(inconnu) })).statusCode, 400);
  assert.equal((await post('/suivi/videos', { jetons: [] })).statusCode, 400);
  // Paquet suivant (places 5 à 9) : positions décalées ; vide → liste vide, pas un échec (0 en tête reste 404).
  const suite = await post('/suivi/videos', { jetons: [inconnu, b.jeton], depuis: 5 });
  assert.deepEqual(suite.json().videos.map((v: { position: number }) => v.position), [6]);
  assert.deepEqual((await post('/suivi/videos', { jetons: [inconnu], depuis: 5 })).json(), { videos: [] });
  assert.equal((await post('/suivi/videos', { jetons: Array(5).fill(inconnu), depuis: 46 })).statusCode, 400);   // au-delà de 50 places
  await app.close();
});

test('origine : un texte collé sur plusieurs lignes est accepté dans les précisions', async () => {
  const { app } = monter();
  const e = await envoyer(app, true, { origine: { publiePar: 'Une journaliste', precisions: 'Première ligne.\nDeuxième ligne.', publique: false } });
  assert.equal(proprietaire(`SELECT details FROM core.video_origins WHERE video_id = '${e.envoi}'`), 'Première ligne.\nDeuxième ligne.');
  await app.close();
});

test('origine : gardée à l’envoi, publique seulement si demandé et tant qu’elle n’est pas retirée', async () => {
  const { app, post } = monter();
  const ORIGINE = { publiePar: 'Une journaliste', lien: 'https://exemple.fr/post/1', precisions: 'Filmé place de la République.', publique: true };
  const e = await envoyer(app, true, { origine: ORIGINE });
  proprietaire(`UPDATE core.videos SET status = 'published', decided_at = now(), decided_by_stage = 'review' WHERE id = '${e.envoi}'`);
  const fiche = async (id: string) => (await app.inject({ method: 'GET', url: `/public/videos/${id}`, remoteAddress: '198.51.100.90' })).json();
  assert.deepEqual((await fiche(e.envoi)).origine, { publiePar: 'Une journaliste', lien: 'https://exemple.fr/post/1' });   // pas les précisions
  proprietaire(`UPDATE core.video_origins SET hidden_at = now() WHERE video_id = '${e.envoi}'`);
  assert.equal((await fiche(e.envoi)).origine, null);

  const privee = await envoyer(app, true, { origine: { ...ORIGINE, publique: false } });
  proprietaire(`UPDATE core.videos SET status = 'published', decided_at = now(), decided_by_stage = 'review' WHERE id = '${privee.envoi}'`);
  assert.equal((await fiche(privee.envoi)).origine, null);
  assert.equal(proprietaire(`SELECT details FROM core.video_origins WHERE video_id = '${privee.envoi}'`).trim(), ORIGINE.precisions);

  // Retrait par la source : effacée.
  proprietaire(`UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '${privee.envoi}'`);
  assert.equal(proprietaire(`SELECT count(*) FROM core.video_origins WHERE video_id = '${privee.envoi}'`).trim(), '0');
  void post;
  await app.close();
});

test('origine invalide refusée à l’envoi', async () => {
  const { app } = monter();
  const essai = async (origine: object) => {
    const s = await deriverSecrets(genererEntropie());
    return (await app.inject({ method: 'POST', url: '/envois', payload: {
      origine, turnstile: 'x', conditions: CONDITIONS_VERSION, empreinteSuivi: s.empreinteSuivi, tailleOriginal: 100, tailleCopie: 10, sha256Original: 'a'.repeat(64), schemaEmpreinte: 1, metadonnees: 'absentes',
      contexte: { date: '2026-11-03T14:12:00Z', lieu: { lat: 48.8566, lon: 2.3522 }, precision: 'exact', forces: 'unknown', situation: 'other', categorie: 'abuse', sousCategorie: 'other_abuse', description: 'Description d’essai, assez longue pour être acceptée.', langue: 'fr' },
    } })).statusCode;
  };
  assert.equal(await essai({ publique: false }), 400);
  assert.equal(await essai({ lien: 'https://x.fr/1', publique: true }), 400);       // citer exige un nom
  assert.equal(await essai({ publiePar: 'Nom', lien: 'javascript:alert(1)', publique: true }), 400);
  await app.close();
});

test('envoi par lien : passe directement en traitement, lien gardé hors de portée du site, clés pour le worker', async () => {
  const { app, post } = monter();
  const s = await deriverSecrets(genererEntropie());
  const corps = { turnstile: 'x', conditions: CONDITIONS_VERSION, empreinteSuivi: s.empreinteSuivi, metadonnees: 'absentes',
    contexte: { date: '2026-11-03T14:12:00Z', lieu: { lat: 48.8566, lon: 2.3522 }, precision: 'exact', forces: 'unknown', situation: 'other', categorie: 'abuse', sousCategorie: 'other_abuse', description: 'Description d’essai, assez longue pour être acceptée.', langue: 'fr' } };
  const envoi = (extra: object) => app.inject({ method: 'POST', url: '/envois', payload: { ...corps, ...extra } });
  const cles = { cleOriginal: 'A'.repeat(43), cleCopie: s.cleCopie };

  assert.deepEqual((await envoi({ lien: 'https://exemple.fr/v', ...cles })).json(), { erreur: 'lien_non_pris_en_charge' });
  assert.equal((await envoi({ lien: 'http://x.com/a', ...cles })).statusCode, 400);
  assert.equal((await envoi({ lien: 'https://x.com/a/status/1' })).statusCode, 400);   // clés manquantes
  assert.equal((await envoi({})).statusCode, 400);                                      // ni fichier, ni lien

  const r = await envoi({ lien: 'https://x.com/a/status/1', ...cles });
  assert.equal(r.statusCode, 201, r.body);
  const { envoi: id, pseudonyme } = r.json();
  assert.ok(pseudonyme);
  assert.equal(JSON.stringify(r.json()).includes('x.com'), false);
  assert.equal(proprietaire(`SELECT status FROM core.videos WHERE id = '${id}'`).trim(), 'processing');
  assert.equal(proprietaire(`SELECT url FROM core.video_fetches WHERE video_id = '${id}'`).trim(), 'https://x.com/a/status/1');
  assert.equal(await redis.get(`cle-original:${id}`), 'A'.repeat(43));
  assert.equal((await post('/suivi', { jeton: s.jetonSuivi })).json().pseudonyme, pseudonyme);
  await bases.app.query('SELECT 1 FROM core.video_fetches').then(() => assert.fail('le site ne doit pas lire les liens'), (e: { code?: string }) => assert.equal(e.code, '42501'));
  await app.close();
});

test('code gardé avec le compte : rendu à son propriétaire seulement, jamais sans compte', async () => {
  const { app, post, deps } = monter();
  const scelle = { v: 1, epk: Buffer.alloc(65, 4).toString('base64'), nonce: Buffer.alloc(12, 1).toString('base64'), chiffre: Buffer.alloc(32, 2).toString('base64') };
  const e = await envoyer(app);
  assert.equal((await post('/suivi/code', { jeton: e.jeton })).statusCode, 404);   // sans compte : rien à rendre
  const refus = await app.inject({ method: 'POST', url: '/envois', payload: { codeScelle: scelle, turnstile: 'x' } });
  assert.equal(refus.statusCode, 400);
  const compte = randomUUID();
  proprietaire(`INSERT INTO core.accounts (id, username, status, score) VALUES ('${compte}', 'code_${compte.slice(0, 8)}', 'active', 1);
                INSERT INTO core.video_owners (video_id, account_id) VALUES ('${e.envoi}', '${compte}')`);
  // Le code se lit avec la session du compte, jamais avec son seul identifiant (0115).
  const session = createHash('sha256').update(`jeton-${compte}`).digest();
  const autreSession = createHash('sha256').update(`autre-${compte}`).digest();
  proprietaire(`INSERT INTO core.sessions (account_id, expires_at, token_hash) VALUES ('${compte}', now() + interval '1 day', '\\x${session.toString('hex')}')`);
  // Un autre compte ne peut pas poser le code (0108) ; le propriétaire, si.
  assert.equal((await bases.app.query('SELECT core.set_owner_code($1, $2, $3) AS ok', [e.envoi, randomUUID(), JSON.stringify(scelle)])).rows[0]!.ok, false);
  assert.equal((await bases.app.query('SELECT core.set_owner_code($1, $2, $3) AS ok', [e.envoi, compte, JSON.stringify(scelle)])).rows[0]!.ok, true);
  assert.deepEqual((await bases.app.query('SELECT core.owned_code($1, $2) AS c', [session, e.envoi])).rows[0]!.c, scelle);
  assert.equal((await bases.app.query('SELECT core.owned_code($1, $2) AS c', [autreSession, e.envoi])).rows[0]?.c ?? null, null);
  await bases.app.query('SELECT token_hash FROM core.sessions LIMIT 1').then(() => assert.fail('le site ne doit pas lire les empreintes de session'), (x: { code?: string }) => assert.equal(x.code, '42501'));
  await bases.app.query('SELECT 1 FROM core.video_owners').then(() => assert.fail('le site ne doit pas lire cette table'), (x: { code?: string }) => assert.equal(x.code, '42501'));
  proprietaire(`UPDATE core.videos SET status = 'withdrawn', withdrawn_at = now() WHERE id = '${e.envoi}'`);
  assert.equal((await bases.app.query('SELECT core.owned_code($1, $2) AS c', [session, e.envoi])).rows[0]!.c, null);
  void deps;
  await app.close();
});

test('journal légal (0122) : envoi, retrait avec l’identifiant de la vidéo et l’heure exacte, jamais lisible par le site', async () => {
  const { app, post } = monter();
  const e = await envoyer(app);
  const lignes = () => proprietaire(`SELECT string_agg(action, ',' ORDER BY id) FROM identity.legal_connection_logs WHERE content_id = '${e.envoi}'`);
  assert.equal(lignes(), 'upload');
  assert.equal((await post('/suivi/retirer', { jeton: e.jeton, confirmation: e.pseudonyme })).statusCode, 200);
  assert.equal(lignes(), 'upload,delete');
  // Heure exacte (jamais arrondie dans le journal légal) : à la microseconde près, pas à l'heure ni au jour.
  assert.equal(proprietaire(`SELECT bool_and(occurred_at <> date_trunc('second', occurred_at)) FROM identity.legal_connection_logs WHERE content_id = '${e.envoi}'`), 't');
  await bases.app.query('SELECT 1 FROM identity.legal_connection_logs').then(() => assert.fail('lisible par le site'), () => {});
  await app.close();
});
