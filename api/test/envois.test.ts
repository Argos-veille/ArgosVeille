// Envoi d'une vidéo par une source sans compte, de bout en bout : le VRAI module du navigateur
// (phrase, dérivation, chiffrement) produit les morceaux, l'API les reçoit, et l'original stocké
// est déchiffré à la fin avec la phrase pour vérifier qu'il est intact.
import { CONDITIONS_VERSION } from '../src/conditions.ts';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { after, before, beforeEach, test } from 'node:test';
import {
  chiffrerOriginal, dechiffrerOriginal, deriverSecrets, genererEntropie, lecteurOctets, TAILLE_ENTETE as ENTETE_NAV,
  TAILLE_MAX as MAX_NAV, TAILLE_MORCEAU as MORCEAU_NAV, type MorceauChiffre,
} from '../../navigateur/src/index.ts';
import { construireApp } from '../src/app.ts';
import { arrondir, enFrance, nettoyerEnvois, ressembleAUneVideo, TAILLE_ENTETE, TAILLE_MAX, TAILLE_MORCEAU } from '../src/envois.ts';
import { pseudonymeAleatoire, TAILLE_ESPACE_PSEUDONYMES } from '../src/pseudonymes.ts';
import { dependances, preparer, proprietaire } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

const VIDEO = readFileSync(new URL('./fixtures/mini.mp4', import.meta.url));   // vraie vidéo ffmpeg (24 Ko)
/** Une « vidéo » de plus de 4 Mio : la vraie en tête (signature MP4), puis du remplissage. */
const GROSSE = Buffer.concat([VIDEO, randomBytes(9 * 1024 * 1024)]);

function monter(envoisParHeure = 1000) {
  const { deps, turnstile, stockage, racine } = dependances(socle, 1000, envoisParHeure);
  const app = construireApp(deps);
  return { app, deps, turnstile, stockage, racine };
}

const CONTEXTE = {
  date: '2026-11-03T14:12:00.000Z', lieu: { lat: 48.856612, lon: 2.352219 }, precision: 'exact',
  forces: 'national_police', situation: 'demonstration', categorie: 'violence', sousCategorie: 'weapons',
  description: 'Tir de LBD sur un manifestant, rue de Rivoli.', langue: 'fr',
};

/** Prépare un envoi côté navigateur : phrase, secrets, original chiffré en morceaux. */
async function preparerEnvoi(original: Buffer = VIDEO) {
  const secrets = await deriverSecrets(genererEntropie());
  const morceaux: MorceauChiffre[] = [];
  const { sha256 } = await chiffrerOriginal(lecteurOctets(original), secrets.cleOriginal, async (m) => { morceaux.push(m); }, secrets.cleEmpreinte);
  const tailleOriginal = morceaux.reduce((t, m) => t + m.octets.length, 0);
  return { secrets, morceaux, sha256, tailleOriginal, copie: original };
}
type Envoi = Awaited<ReturnType<typeof preparerEnvoi>>;

const ouvrir = (app: ReturnType<typeof construireApp>, e: Envoi, plus: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/envois', payload: {
    turnstile: 'x', conditions: CONDITIONS_VERSION, empreinteSuivi: e.secrets.empreinteSuivi, tailleOriginal: e.tailleOriginal, tailleCopie: e.copie.length,
    sha256Original: e.sha256, schemaEmpreinte: 1, metadonnees: 'coherentes', contexte: CONTEXTE, ...plus,
  } });

const deposer = (app: ReturnType<typeof construireApp>, id: string, chemin: 'original' | 'copie', n: number, octets: Uint8Array, jeton: string) =>
  app.inject({ method: 'PUT', url: `/envois/${id}/${chemin}/${n}`, payload: Buffer.from(octets),
               headers: { 'content-type': 'application/octet-stream', 'argos-suivi': jeton } });

const morceauxCopie = (copie: Buffer) => {
  const r: Buffer[] = [];
  for (let i = 0; i < copie.length; i += TAILLE_MORCEAU) r.push(copie.subarray(i, i + TAILLE_MORCEAU));
  return r;
};

async function toutEnvoyer(app: ReturnType<typeof construireApp>, id: string, e: Envoi) {
  for (const m of e.morceaux) assert.equal((await deposer(app, id, 'original', m.index, m.octets, e.secrets.jetonSuivi)).statusCode, 200);
  for (const [i, m] of morceauxCopie(e.copie).entries()) assert.equal((await deposer(app, id, 'copie', i, m, e.secrets.jetonSuivi)).statusCode, 200);
}

const CLE_COPIE = 'k'.repeat(43);
const finaliser = (app: ReturnType<typeof construireApp>, id: string, jeton: string, cleCopie = CLE_COPIE) =>
  app.inject({ method: 'POST', url: `/envois/${id}/finaliser`, headers: { 'argos-suivi': jeton }, payload: { cleCopie } });

test('le format du serveur correspond exactement à celui du navigateur', () => {
  assert.equal(TAILLE_ENTETE, ENTETE_NAV);
  assert.equal(TAILLE_MORCEAU, MORCEAU_NAV);
  assert.equal(TAILLE_MAX, MAX_NAV);
});

test("parcours complet (plusieurs morceaux) : l'original stocké se déchiffre avec la phrase, à l'identique", async () => {
  const { app, stockage } = monter();
  const e = await preparerEnvoi(GROSSE);
  assert.equal(e.morceaux.length, 3);
  const o = await ouvrir(app, e);
  assert.equal(o.statusCode, 201, o.body);
  const { envoi: id, pseudonyme } = o.json();
  assert.match(pseudonyme, /^\p{L}[\p{L}-]*-\p{L}+-\d{4}$/u);
  assert.deepEqual([o.json().original.morceaux, o.json().copie.morceaux], [3, 3]);
  assert.equal(proprietaire(`SELECT status FROM core.videos WHERE id = '${id}'`), 'uploading');
  assert.equal(proprietaire(`SELECT terms_version FROM core.videos WHERE id = '${id}'`), CONDITIONS_VERSION);

  await toutEnvoyer(app, id, e);
  const f = await finaliser(app, id, e.secrets.jetonSuivi);
  assert.deepEqual([f.statusCode, f.json()], [200, { ok: true, statut: 'traitement' }]);

  // L'original chiffré stocké : son empreinte est enregistrée, et il se déchiffre à l'identique.
  const fichier = readFileSync(stockage.chemin('originaux', id));
  assert.equal(proprietaire(`SELECT encode(original_enc_sha256, 'hex') FROM core.videos WHERE id = '${id}'`),
               createHash('sha256').update(fichier).digest('hex'));
  const parts: Uint8Array[] = [];
  const d = await dechiffrerOriginal(lecteurOctets(fichier), e.secrets.cleOriginal, async (c) => { parts.push(c); }, e.secrets.cleEmpreinte);
  assert.deepEqual(Buffer.concat(parts), GROSSE);
  assert.equal(d.sha256, e.sha256);
  assert.equal(proprietaire(`SELECT encode(original_sha256, 'hex') FROM core.videos WHERE id = '${id}'`), e.sha256);
  // La copie de travail attend le floutage en quarantaine.
  assert.deepEqual(readFileSync(stockage.chemin('quarantaine', id)), GROSSE);
  assert.equal(proprietaire(`SELECT status || ' ' || coalesce(upload_expires_at::text, 'aucune') FROM core.videos WHERE id = '${id}'`),
               'processing aucune');
  // Rattachée au jeton de suivi, à aucun compte ; journal légal sans compte.
  assert.equal(proprietaire(`SELECT encode(tracking_code_hash, 'hex') FROM core.pseudonyms WHERE video_id = '${id}'`), e.secrets.empreinteSuivi);
  assert.equal(proprietaire(`SELECT count(*) FROM identity.legal_connection_logs WHERE action = 'upload' AND account_id IS NULL
                             AND occurred_at > now() - interval '1 minute'`) !== '0', true);
  assert.deepEqual(await redis.keys('argos:envoi:*'), []);
  await app.close();
});

test('reprise après coupure : état des morceaux reçus, renvoi sans dommage', async () => {
  const { app } = monter();
  const e = await preparerEnvoi(GROSSE);
  const id = (await ouvrir(app, e)).json().envoi;
  const jeton = e.secrets.jetonSuivi;
  await deposer(app, id, 'original', 2, e.morceaux[2]!.octets, jeton);
  await deposer(app, id, 'original', 0, e.morceaux[0]!.octets, jeton);
  await deposer(app, id, 'original', 0, e.morceaux[0]!.octets, jeton);   // renvoyé deux fois
  const etat = await app.inject({ method: 'GET', url: `/envois/${id}/etat`, headers: { 'argos-suivi': jeton } });
  assert.deepEqual(etat.json(), { original: { attendus: 3, recus: [0, 2] }, copie: { attendus: 3, recus: [] } });
  const tot = await finaliser(app, id, jeton);
  assert.deepEqual([tot.statusCode, tot.json()], [409, { erreur: 'morceaux_manquants', manquants: { original: 1, copie: 3 } }]);
  await toutEnvoyer(app, id, e);
  assert.equal((await finaliser(app, id, jeton)).statusCode, 200);
  assert.equal((await finaliser(app, id, jeton)).statusCode, 404);   // déjà finalisé : l'envoi n'est plus ouvert
  await app.close();
});

test('sans le bon jeton de suivi : rien (même réponse que pour un envoi inexistant)', async () => {
  const { app } = monter();
  const e = await preparerEnvoi();
  const id = (await ouvrir(app, e)).json().envoi;
  const autre = (await deriverSecrets(genererEntropie())).jetonSuivi;
  for (const jeton of [autre, 'x', '']) {
    const p = await deposer(app, id, 'original', 0, e.morceaux[0]!.octets, jeton);
    assert.deepEqual([p.statusCode, p.json()], [404, { erreur: 'envoi_introuvable' }]);
  }
  assert.equal((await app.inject({ method: 'GET', url: `/envois/${id}/etat` })).statusCode, 404);
  assert.equal((await finaliser(app, id, autre)).statusCode, 404);
  const inexistant = await deposer(app, '00000000-0000-4000-8000-000000000000', 'original', 0, e.morceaux[0]!.octets, e.secrets.jetonSuivi);
  assert.deepEqual(inexistant.json(), { erreur: 'envoi_introuvable' });
  await app.close();
});

test('morceaux : taille exacte exigée, numéro borné, octets bruts seulement', async () => {
  const { app } = monter();
  const e = await preparerEnvoi(GROSSE);
  const id = (await ouvrir(app, e)).json().envoi;
  const jeton = e.secrets.jetonSuivi;
  const trop = await deposer(app, id, 'original', 0, Buffer.concat([e.morceaux[0]!.octets, Buffer.from([1])]), jeton);
  assert.equal(trop.statusCode, 413);   // au-delà de la taille maximale d'un morceau
  const court = await deposer(app, id, 'original', 1, e.morceaux[1]!.octets.subarray(1), jeton);
  assert.equal(court.json().erreur, 'taille_de_morceau');
  assert.equal((await deposer(app, id, 'original', 3, e.morceaux[2]!.octets, jeton)).json().erreur, 'morceau_inconnu');
  for (const n of ['-1', '01', '1.5', 'abc', '999999']) {
    assert.equal((await app.inject({ method: 'PUT', url: `/envois/${id}/original/${n}`, payload: Buffer.from('x'),
      headers: { 'content-type': 'application/octet-stream', 'argos-suivi': jeton } })).statusCode, 400, n);
  }
  const json = await app.inject({ method: 'PUT', url: `/envois/${id}/original/0`, payload: { a: 1 }, headers: { 'argos-suivi': jeton } });
  assert.equal(json.statusCode, 415);
  await app.close();
});

test("copie de travail qui n'est pas une vidéo : envoi refusé et entièrement effacé", async () => {
  const { app, stockage } = monter();
  const faux = Buffer.from('#!/bin/sh\nrm -rf /\n'.repeat(100));
  const e = await preparerEnvoi(faux);
  const id = (await ouvrir(app, e)).json().envoi;
  await toutEnvoyer(app, id, e);
  const f = await finaliser(app, id, e.secrets.jetonSuivi);
  assert.deepEqual([f.statusCode, f.json()], [400, { erreur: 'fichier_invalide' }]);
  assert.equal(proprietaire(`SELECT count(*) FROM core.videos WHERE id = '${id}'`), '0');
  assert.ok(!existsSync(stockage.chemin('originaux', id)) && !existsSync(stockage.chemin('quarantaine', id)));
  await app.close();
});

test('contexte : France seulement, date plausible, catégorie cohérente, lieu arrondi selon la précision', async () => {
  const { app } = monter();
  const essai = async (contexte: object) => {
    await redis.flushdb();   // la limite de 5 envois par heure et par IP ne doit pas masquer la validation
    return ouvrir(app, await preparerEnvoi(), { contexte: { ...CONTEXTE, ...contexte } });
  };
  assert.deepEqual((await essai({ lieu: { lat: 50.8503, lon: 4.3517 } })).json(), { erreur: 'lieu_hors_de_france' });   // Bruxelles
  assert.deepEqual((await essai({ date: '2099-01-01T00:00:00Z' })).json(), { erreur: 'date_invalide' });
  assert.deepEqual((await essai({ date: '1999-12-31T00:00:00Z' })).json(), { erreur: 'date_invalide' });
  assert.deepEqual((await essai({ categorie: 'abuse', sousCategorie: 'weapons' })).json(), { erreur: 'contexte_invalide' });
  // Plusieurs choix : 3 au plus, sans répétition, tous dans la nature choisie.
  assert.deepEqual((await essai({ autresSousCategories: ['insults'] })).json(), { erreur: 'contexte_invalide' });
  assert.deepEqual((await essai({ autresSousCategories: ['weapons'] })).json(), { erreur: 'contexte_invalide' });
  assert.deepEqual((await essai({ autresSituations: ['demonstration'] })).json(), { erreur: 'contexte_invalide' });
  assert.equal((await essai({ autresSousCategories: ['strikes', 'chokehold', 'other_violence'] })).statusCode, 400);
  assert.equal((await essai({ autresSituations: ['stop', 'stop'] })).statusCode, 400);
  assert.equal((await essai({ autresSituations: ['inventee'] })).statusCode, 400);
  const plusieurs = (await essai({ autresSousCategories: ['strikes', 'chokehold'], autresSituations: ['arrest'] })).json().envoi;
  assert.equal(proprietaire(`SELECT array_to_string(extra_subcategories, ',') || ' ' || array_to_string(extra_situations, ',') FROM core.videos WHERE id = '${plusieurs}'`),
               'strikes,chokehold arrest');
  assert.equal((await essai({ description: 'a'.repeat(5001) })).statusCode, 400);
  // Description obligatoire, 20 caractères au moins (espaces autour non comptés).
  assert.equal((await essai({ description: undefined })).statusCode, 400);
  assert.equal((await essai({ description: 'Trop court' })).statusCode, 400);
  assert.deepEqual((await essai({ description: `   ${'b'.repeat(15)}      ` })).json(), { erreur: 'description_trop_courte' });
  assert.equal((await essai({ lieu: { lat: -21.1151, lon: 55.5364 } })).statusCode, 201);   // La Réunion
  const r = await essai({ precision: 'approx_100m' });
  const id = r.json().envoi;
  assert.equal(proprietaire(`SELECT ST_Y(location::geometry) || ' ' || ST_X(location::geometry) FROM core.videos WHERE id = '${id}'`),
               '48.857 2.352');
  await app.close();
});

test('choix du son : gardé par défaut, coupé si la source le demande', async () => {
  const { app } = monter();
  const parDefaut = (await ouvrir(app, await preparerEnvoi())).json().envoi;
  const coupe = (await ouvrir(app, await preparerEnvoi(), { garderSon: false })).json().envoi;
  assert.equal(proprietaire(`SELECT keep_audio FROM core.videos WHERE id = '${parDefaut}'`), 't');
  assert.equal(proprietaire(`SELECT keep_audio FROM core.videos WHERE id = '${coupe}'`), 'f');
  assert.equal((await ouvrir(app, await preparerEnvoi(), { garderSon: 'non' })).statusCode, 400);
  await app.close();
});

test('masquage des visages : oui par défaut, désactivable par la source', async () => {
  const { app } = monter();
  const parDefaut = (await ouvrir(app, await preparerEnvoi())).json().envoi;
  const sans = (await ouvrir(app, await preparerEnvoi(), { masquerVisages: false })).json().envoi;
  assert.equal(proprietaire(`SELECT mask_faces FROM core.videos WHERE id = '${parDefaut}'`), 't');
  assert.equal(proprietaire(`SELECT mask_faces FROM core.videos WHERE id = '${sans}'`), 'f');
  await app.close();
});

test('une même phrase ne sert qu\'à un seul envoi', async () => {
  const { app } = monter();
  const e = await preparerEnvoi();
  assert.equal((await ouvrir(app, e)).statusCode, 201);
  const encore = await ouvrir(app, e);
  assert.deepEqual([encore.statusCode, encore.json()], [409, { erreur: 'phrase_deja_utilisee' }]);
  await app.close();
});

test("heure inconnue : la date seule est gardée, signalée comme telle", async () => {
  const { app } = monter();
  const e = await preparerEnvoi();
  const o = await ouvrir(app, e, { contexte: { ...CONTEXTE, heureConnue: false } });
  assert.equal(o.statusCode, 201);
  assert.equal(proprietaire(`SELECT occurred_time_known FROM core.videos WHERE id = '${o.json().envoi}'`), 'f');
  const e2 = await preparerEnvoi();
  const o2 = await ouvrir(app, e2);   // sans précision : heure connue
  assert.equal(proprietaire(`SELECT occurred_time_known FROM core.videos WHERE id = '${o2.json().envoi}'`), 't');
  await app.close();
});

test('lieu et date à établir : gardés comme tels, lieu ramené à la commune, heure inconnue', async () => {
  const { app } = monter();
  const o = await ouvrir(app, await preparerEnvoi(), { contexte: { ...CONTEXTE, precision: 'exact', dateAEtablir: true, lieuAEtablir: true } });
  assert.equal(o.statusCode, 201);
  assert.equal(proprietaire(`SELECT date_to_establish || '|' || location_to_establish || '|' || location_precision || '|' || occurred_time_known
                               FROM core.videos WHERE id = '${o.json().envoi}'`), 'true|true|municipality|false');
  const o2 = await ouvrir(app, await preparerEnvoi());
  assert.equal(proprietaire(`SELECT date_to_establish OR location_to_establish FROM core.videos WHERE id = '${o2.json().envoi}'`), 'f');
  await app.close();
});

test('limites : Turnstile, 5 envois par heure et par IP, plafond global par heure', async () => {
  const { app, turnstile } = monter();
  turnstile.accepte = false;
  assert.deepEqual((await ouvrir(app, await preparerEnvoi())).json(), { erreur: 'turnstile' });
  turnstile.accepte = true;
  for (let i = 0; i < 4; i++) assert.equal((await ouvrir(app, await preparerEnvoi())).statusCode, 201);
  const limite = (await ouvrir(app, await preparerEnvoi())).json();
  assert.deepEqual([limite.erreur, limite.limite], ['limite_envois', 5]);
  assert.ok(limite.disponibleDans > 3_500 && limite.disponibleDans <= 3_600);   // fenêtre d'une heure
  await app.close();
  await redis.flushdb();
  const plafond = monter(2);
  assert.equal((await ouvrir(plafond.app, await preparerEnvoi())).statusCode, 201);
  assert.equal((await ouvrir(plafond.app, await preparerEnvoi())).statusCode, 201);
  assert.deepEqual((await ouvrir(plafond.app, await preparerEnvoi())).json(), { erreur: 'envois_satures' });
  await plafond.app.close();
});

test('nettoyage : un envoi abandonné depuis 24 h disparaît, base et fichiers', async () => {
  const { app, deps, stockage } = monter();
  const e = await preparerEnvoi(GROSSE);
  const id = (await ouvrir(app, e)).json().envoi;
  await deposer(app, id, 'original', 0, e.morceaux[0]!.octets, e.secrets.jetonSuivi);
  proprietaire(`UPDATE core.videos SET upload_expires_at = now() - interval '1 minute' WHERE id = '${id}'`);
  assert.ok((await nettoyerEnvois(deps)) >= 1);
  assert.equal(proprietaire(`SELECT count(*) FROM core.videos WHERE id = '${id}'`), '0');
  assert.deepEqual((await stockage.lister('originaux')).filter((f) => f.startsWith(id)), []);
  await app.close();
});

test('outils : France, arrondi, signature vidéo, pseudonymes', async () => {
  const enFranceAttendu: [string, number, number][] = [
    ['Paris', 48.8566, 2.3522], ['Bastia', 42.7, 9.45], ['Strasbourg', 48.5734, 7.7521], ['Lille', 50.6292, 3.0573],
    ['Menton', 43.7764, 7.5048], ['Hendaye', 43.3586, -1.7744], ['Brest', 48.3904, -4.4861],
    ['Marseille, Vieux-Port', 43.2951, 5.3740], ['Pointe-à-Pitre', 16.2411, -61.5331], ['Fort-de-France', 14.6161, -61.0588],
    ['Cayenne', 4.9224, -52.3135], ['Saint-Denis (Réunion)', -20.8821, 55.4507], ['Mamoudzou', -12.7806, 45.2279],
    ['Papeete', -17.5516, -149.5585], ['Nouméa', -22.2758, 166.458], ['Saint-Pierre', 46.7811, -56.1764],
  ];
  for (const [nom, lat, lon] of enFranceAttendu) assert.ok(enFrance(lat, lon), nom);
  const horsDeFrance: [string, number, number][] = [
    ['Bruxelles', 50.8503, 4.3517], ['Genève', 46.2044, 6.1432], ['Bâle', 47.5596, 7.5886], ['Luxembourg', 49.6116, 6.1319],
    ['Saint-Sébastien', 43.3183, -1.9812], ['Turin', 45.0703, 7.6869], ['Andorre', 42.5063, 1.5218],
    ['Douvres', 51.1279, 1.3134], ['Madrid', 40.4168, -3.7038], ['Golfe de Gascogne, au large', 45.5, -3.0], ['Golfe de Guinée', 0, 0],
  ];
  for (const [nom, lat, lon] of horsDeFrance) assert.ok(!enFrance(lat, lon), nom);
  // Cas limite assumé : à moins de 2 km de la frontière (Monaco entier, enclavé), la tolérance prévue pour
  // les côtes accepte le point ; les relecteurs jugent ces rares cas.
  assert.ok(enFrance(43.7384, 7.4246), 'Monaco, dans la tolérance de 2 km');
  assert.deepEqual(arrondir(48.856612, 2.352219, 'approx_100m'), { lat: 48.857, lon: 2.352 });
  assert.deepEqual(arrondir(48.856612, 2.352219, 'municipality'), { lat: 48.86, lon: 2.35 });
  assert.ok(ressembleAUneVideo(VIDEO.subarray(0, 16)));
  assert.ok(ressembleAUneVideo(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])));   // WebM
  assert.ok(!ressembleAUneVideo(Buffer.from('%PDF-1.7 blabla')));
  assert.ok(TAILLE_ESPACE_PSEUDONYMES > 18_000_000);
  const vus = new Set(Array.from({ length: 2000 }, pseudonymeAleatoire));
  assert.ok(vus.size > 1990);
});

test('aucun fichier ne sort des dossiers de stockage', async () => {
  const { racine } = monter();
  const { StockageFichier } = await import('../src/stockage.ts');
  const s = new StockageFichier({ originaux: join(racine, 'o'), quarantaine: join(racine, 'q'), floutees: join(racine, 'f'), copies: join(racine, 'c') });
  for (const id of ['../../etc', '00000000-0000-4000-8000-000000000000/../x', 'abc']) {
    await assert.rejects(s.ecrireMorceau('originaux', id, 0, Buffer.from('x')), /refusé/);
  }
  await assert.rejects(s.ecrireMorceau('originaux', '00000000-0000-4000-8000-000000000000', -1, Buffer.from('x')), /refusé/);
  assert.deepEqual(await readdir(racine), []);
});

test('clé de copie : exigée, gardée 24 h au plus dans Redis seulement, jamais en base ni au journal', async () => {
  const lignes: string[] = [];
  const { deps } = dependances(socle);
  const app = construireApp(deps, { journal: { stream: new Writable({ write(c, _e, fin) { lignes.push(String(c)); fin(); } }) } });
  const e = await preparerEnvoi();
  const id = (await ouvrir(app, e)).json().envoi;
  await toutEnvoyer(app, id, e);
  const sans = await app.inject({ method: 'POST', url: `/envois/${id}/finaliser`, headers: { 'argos-suivi': e.secrets.jetonSuivi } });
  assert.equal(sans.statusCode, 400);
  for (const cle of ['court', 'k'.repeat(44), 'é'.repeat(43)]) {
    assert.equal((await finaliser(app, id, e.secrets.jetonSuivi, cle)).statusCode, 400, cle);
  }
  assert.equal((await finaliser(app, id, e.secrets.jetonSuivi, e.secrets.cleCopie)).statusCode, 200);
  assert.equal(await redis.get(`cle-copie:${id}`), e.secrets.cleCopie);
  const ttl = await redis.ttl(`cle-copie:${id}`);
  assert.ok(ttl > 23 * 3600 && ttl <= 24 * 3600, String(ttl));
  const base = proprietaire(`SELECT row_to_json(v)::text FROM core.videos v WHERE id = '${id}'`);
  const hexCle = Buffer.from(e.secrets.cleCopie, 'base64url').toString('hex');
  assert.ok(!base.includes(e.secrets.cleCopie) && !base.includes(hexCle), 'clé de copie en base');
  assert.ok(!lignes.join('').includes(e.secrets.cleCopie), 'clé de copie au journal');
  await app.close();
});

test("conditions d'utilisation : obligatoires, et seulement la version en vigueur", async () => {
  const { app } = monter();
  const e = await preparerEnvoi();
  const perimee = await ouvrir(app, e, { conditions: '2000-01-01' });
  assert.deepEqual([perimee.statusCode, perimee.json()], [409, { erreur: 'conditions_perimees', version: CONDITIONS_VERSION }]);
  const sans = await app.inject({ method: 'POST', url: '/envois', payload: {
    turnstile: 'x', empreinteSuivi: e.secrets.empreinteSuivi, tailleOriginal: e.tailleOriginal, tailleCopie: e.copie.length,
    sha256Original: e.sha256, schemaEmpreinte: 1, metadonnees: 'coherentes', contexte: CONTEXTE } });
  assert.equal(sans.statusCode, 400);
  await app.close();
});

test('disques : un envoi est refusé si la place libre ne peut pas le recevoir avec les envois en cours (B14)', async () => {
  const { app, stockage } = monter();
  const e = await preparerEnvoi();
  const s = stockage as unknown as { espaceLibre: (espace: string) => Promise<number | null> };
  const avant = s.espaceLibre.bind(s);
  try {
    s.espaceLibre = async () => 2 * 1024 ** 3 + e.copie.length + e.tailleOriginal + 10;   // juste assez pour un envoi
    const premier = await ouvrir(app, e);
    assert.equal(premier.statusCode, 201, premier.body);
    const second = await ouvrir(app, await preparerEnvoi());   // le premier, pas terminé, réserve sa place
    assert.deepEqual([second.statusCode, second.json().erreur], [503, 'serveur_plein']);
  } finally {
    s.espaceLibre = avant;
  }
  await app.close();
});

test('laissez-passer anti-robot (B11) : obtenu avant, valable pour un seul envoi, gardé si l’envoi échoue', async () => {
  const { app } = monter();
  const passe = (await app.inject({ method: 'POST', url: '/envois/laissez-passer', payload: { turnstile: 'x' } })).json().passe as string;
  assert.match(passe, /^[A-Za-z0-9_-]{43}$/);
  const e = await preparerEnvoi();
  const sans = { ...e };
  const mauvais = await app.inject({ method: 'POST', url: '/envois', payload: {
    passe: 'A'.repeat(43), conditions: CONDITIONS_VERSION, empreinteSuivi: e.secrets.empreinteSuivi, tailleOriginal: e.tailleOriginal,
    tailleCopie: e.copie.length, sha256Original: e.sha256, schemaEmpreinte: 1, metadonnees: 'coherentes', contexte: CONTEXTE } });
  assert.deepEqual([mauvais.statusCode, mauvais.json().erreur], [400, 'turnstile']);
  const corps = (c: object) => ({ passe, conditions: CONDITIONS_VERSION, empreinteSuivi: sans.secrets.empreinteSuivi, tailleOriginal: e.tailleOriginal,
                                  tailleCopie: e.copie.length, sha256Original: e.sha256, schemaEmpreinte: 1, metadonnees: 'coherentes', contexte: { ...CONTEXTE, ...c } });
  // Erreur de saisie : refusé, mais le laissez-passer reste valable.
  assert.equal((await app.inject({ method: 'POST', url: '/envois', payload: corps({ lieu: { lat: 40.4, lon: -3.7 } }) })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/envois', payload: corps({}) })).statusCode, 201);
  const encore = await app.inject({ method: 'POST', url: '/envois', payload: { ...corps({}), empreinteSuivi: (await preparerEnvoi()).secrets.empreinteSuivi } });
  assert.deepEqual([encore.statusCode, encore.json().erreur], [400, 'turnstile']);   // un seul envoi
  await app.close();
});
