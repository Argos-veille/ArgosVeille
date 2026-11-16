// API publique v1 : lecture seule, CORS ouvert, licence jointe, vidéos masquées ou retirées absentes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { dependances, preparer, proprietaire } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

test('API v1 : liste, fiche, export CSV, oEmbed, CORS et licence', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const site = deps.reglages.urlPublique;
  const vid = randomUUID();
  const cachee = randomUUID();
  // Date des faits propre à cette exécution : la base de test garde les vidéos des exécutions précédentes.
  const jour = new Date(Date.UTC(1990 + Math.floor(Math.random() * 30), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28)))
    .toISOString().slice(0, 10);
  proprietaire(`INSERT INTO core.videos (id, status, decided_at, category, subcategory, forces, occurred_at, occurred_time_known,
                                         location, location_precision, description)
                VALUES ('${vid}', 'published', now() + interval '1 day', 'violence', 'weapons', 'national_police',
                        '${jour} 15:40 Europe/Paris', true, ST_GeogFromText('POINT(-1.5536 47.2184)'), 'approx_100m', '=CMD() tir de LBD'),
                       ('${cachee}', 'hidden', now() + interval '1 day', 'abuse', 'insults', 'gendarmerie', now(), true, NULL, NULL, 'masquée')`);
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { origin: 'https://journal.exemple' } });

  const l = await get(`/v1/videos?du=${jour}&au=${jour}`);
  assert.equal(l.statusCode, 200);
  assert.equal(l.headers['access-control-allow-origin'], '*');
  assert.equal(l.json().licence, 'CC BY 4.0');
  const v = l.json().videos.find((x: { id: string }) => x.id === vid);
  assert.deepEqual([v.fiche, v.date, v.lieu.lon], [`${site}/videos/${vid}`, `${jour}T15:00`, -1.5536]);   // heure arrondie
  assert.ok(!l.json().videos.some((x: { id: string }) => x.id === cachee));
  assert.ok(!('description' in v) && !('pseudonyme' in v));
  assert.equal((await get(`/v1/videos?forces=gendarmerie&du=${jour}&au=${jour}`)).json().videos.length, 0);
  // La douane est une force au choix (0093).
  proprietaire(`UPDATE core.videos SET forces = 'customs' WHERE id = '${vid}'`);
  assert.equal((await get(`/v1/videos?forces=customs&du=${jour}&au=${jour}`)).json().videos[0].forces, 'customs');
  proprietaire(`UPDATE core.videos SET forces = 'national_police' WHERE id = '${vid}'`);

  const f = (await get(`/v1/videos/${vid}`)).json();
  assert.match(f.integration.html, new RegExp(`src="${site}/integrer/${vid}"`));
  assert.equal(f.avertissement.startsWith('Faits allégués'), true);
  assert.deepEqual([(await get(`/v1/videos/${cachee}`)).statusCode, (await get(`/v1/videos/${cachee}`)).json().erreur], [410, 'video_masquee']);

  const csv = (await get('/v1/export.csv')).body.split('\r\n');
  assert.match(csv[0]!, /^# CC BY 4\.0/);
  assert.ok(csv.some((ligne) => ligne.startsWith(`${vid},`) && ligne.includes(',-1.5536,')));

  const o = await get(`/v1/oembed?url=${encodeURIComponent(`${site}/videos/${vid}`)}&maxwidth=480`);
  assert.deepEqual([o.json().type, o.json().width, o.json().provider_name], ['video', 480, 'Argos Veille']);
  assert.equal((await get(`/v1/oembed?url=${encodeURIComponent(`https://autre.site/videos/${vid}`)}`)).statusCode, 404);
  assert.equal((await get(`/v1/oembed?url=${encodeURIComponent(`${site}/videos/${cachee}`)}`)).statusCode, 404);
  await app.close();
});

test('statistiques : publiées seulement, sans doublon, plusieurs choix comptés, mois continus, cache', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  // Une année propre à cette exécution (la base de test garde les vidéos précédentes).
  const an = 1900 + Math.floor(Math.random() * 80);
  const [a, b, dbl, deb, rej] = Array.from({ length: 5 }, () => randomUUID());
  proprietaire(`INSERT INTO core.videos (id, status, decided_at, category, subcategory, extra_subcategories, forces, situation,
                                         extra_situations, occurred_at, occurred_time_known, description, duplicate_of, is_control)
                VALUES ('${a}', 'published', now(), 'violence', 'strikes', '{weapons}', 'national_police', 'demonstration', '{arrest}',
                        '${an}-01-10 12:00 Europe/Paris', true, 'a', NULL, false),
                       ('${b}', 'published', now() - interval '60 days', 'abuse', 'insults', '{}', NULL, 'stop', '{}',
                        '${an}-03-05 12:00 Europe/Paris', true, 'b', NULL, false),
                       ('${dbl}', 'published', now(), 'violence', 'strikes', '{}', 'gendarmerie', 'other', '{}',
                        '${an}-01-11 12:00 Europe/Paris', true, 'doublon', '${a}', false),
                       ('${deb}', 'under_debate', now(), 'violence', 'strikes', '{}', 'gendarmerie', 'other', '{}',
                        '${an}-02-01 12:00 Europe/Paris', true, 'débat', NULL, false),
                       ('${rej}', 'rejected', now(), 'violence', 'strikes', '{}', 'gendarmerie', 'other', '{}',
                        '${an}-02-02 12:00 Europe/Paris', true, 'rejetée', NULL, false)`);
  const url = `/v1/statistiques?du=${an}-01-01&au=${an}-12-31`;
  const r = await app.inject({ method: 'GET', url });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers['access-control-allow-origin'], '*');
  const s = r.json();
  assert.equal(s.licence, 'CC BY 4.0');
  assert.deepEqual([s.publiees, s.enDebat, s.publieesCes30Jours], [2, 1, 1]);
  assert.deepEqual(s.parMois, [{ mois: `${an}-01`, videos: 1 }, { mois: `${an}-02`, videos: 0 }, { mois: `${an}-03`, videos: 1 }]);
  assert.deepEqual(s.categories, { violence: 1, abuse: 1 });
  assert.deepEqual(s.sousCategories, { strikes: 1, weapons: 1, insults: 1 });
  assert.deepEqual(s.forces, { national_police: 1, unknown: 1 });
  assert.deepEqual(s.situations, { demonstration: 1, arrest: 1, stop: 1 });

  // Gardé 5 minutes : une vidéo publiée entre-temps n'apparaît pas tout de suite.
  proprietaire(`UPDATE core.videos SET status = 'published' WHERE id = '${deb}'`);
  assert.equal((await app.inject({ method: 'GET', url })).json().publiees, 2);
  await redis.flushdb();
  assert.equal((await app.inject({ method: 'GET', url })).json().publiees, 3);

  const pub = await app.inject({ method: 'GET', url: '/public/statistiques?periode=30j' });
  assert.equal(pub.statusCode, 200);
  assert.ok(!('licence' in pub.json()));
  assert.equal((await app.inject({ method: 'GET', url: '/public/statistiques?periode=2j' })).statusCode, 400);
  await app.close();
});
