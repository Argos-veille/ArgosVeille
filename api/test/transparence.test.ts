// Rapport de transparence : trimestres terminés seulement, petits nombres masqués, masquage secondaire.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { bornes, rapport, repartition } from '../src/transparence.ts';
import { dependances, preparer, proprietaire } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

test('masquage : 1 à 4 → <5, et une case de plus quand une seule est masquée', () => {
  assert.deepEqual(repartition({ a: 0, b: 7 }), { a: 0, b: 7 });
  assert.deepEqual(repartition({ a: 3, b: 7, c: 12 }), { a: '<5', b: '<5', c: 12 });
  assert.deepEqual(repartition({ a: 3, b: 2, c: 12 }), { a: '<5', b: '<5', c: 12 });
  assert.deepEqual(repartition({ a: 3, z: 0 }), { a: '<5', z: 0 });
  assert.deepEqual(bornes('2026-T4'), { du: '2026-10-01', au: '2027-01-01' });
  assert.deepEqual(bornes('2027-T1'), { du: '2027-01-01', au: '2027-04-01' });
});

test('rapport : envois et signalements du trimestre, petits nombres masqués', async () => {
  const { deps } = dependances(socle);
  // Un trimestre propre à cette exécution (la base de test garde les données précédentes).
  const an = 1900 + Math.floor(Math.random() * 80);
  const videos = Array.from({ length: 7 }, () => randomUUID());
  // La base de test garde les exécutions précédentes : on vide d'abord cette année-là.
  proprietaire(`DELETE FROM core.authority_requests WHERE received_on BETWEEN '${an}-01-01' AND '${an}-12-31';
                DELETE FROM core.reports WHERE created_at BETWEEN '${an}-01-01' AND '${an}-12-31 23:59';
                DELETE FROM core.videos WHERE submitted_at BETWEEN '${an}-01-01' AND '${an}-12-31 23:59'`);
  proprietaire(`INSERT INTO core.videos (id, status, submitted_at, description, failure_reason)
                SELECT id, CASE WHEN i = 1 THEN 'failed' ELSE 'in_review' END, '${an}-05-10 12:00 Europe/Paris', 'x',
                       CASE WHEN i = 1 THEN 'unreadable' END
                  FROM unnest('{${videos.join(',')}}'::uuid[]) WITH ORDINALITY AS t(id, i)`);
  proprietaire(`INSERT INTO core.reports (video_id, severity, reason_code, created_at)
                SELECT v, 'normal', CASE WHEN i <= 5 THEN 'visible_identity' WHEN i = 6 THEN 'defamation' ELSE 'other' END,
                       '${an}-06-30 23:30 Europe/Paris'
                  FROM unnest('{${videos.join(',')}}'::uuid[]) WITH ORDINALITY AS t(v, i)`);
  proprietaire(`INSERT INTO core.authority_requests (received_on, requester, nature, outcome)
                SELECT ('${an}-04-0' || i)::date, 'police', 'removal', 'pending' FROM generate_series(1, 5) i
                UNION ALL SELECT '${an}-04-09'::date, 'judicial', 'identification', 'refused'`);
  const r = await rapport(deps, `${an}-T2`) as any;
  assert.deepEqual(r.envois, { recues: 7, echecs: '<5', retireesParLaSource: 0 });
  assert.deepEqual(r.signalements.parMotif, { visible_identity: 5, defamation: '<5', other: '<5' });
  assert.deepEqual(r.signalements.parSuite, { open: 7 });
  assert.equal(r.decisions.delaiMedianJours, null);
  // Demandes des autorités : 5 + 1 → la seule masquée en entraîne une autre (masquage secondaire).
  assert.deepEqual(r.autorites.parAuteur, { police: '<5', judicial: '<5' });
  assert.deepEqual(r.autorites.parObjet, { removal: '<5', identification: '<5' });
  // Le trimestre suivant ne voit rien (heure de Paris : 30 juin 23 h 30 reste au 2e trimestre).
  assert.equal((await rapport(deps, `${an}-T3`) as any).envois.recues, 0);
});

test('API : seulement les trimestres terminés', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  proprietaire(`SELECT ledger.append('rule_change', '{"test": true}'::jsonb)`);   // au moins une entrée au journal
  const r = await app.inject({ method: 'GET', url: '/public/transparence' });
  assert.equal(r.statusCode, 200, r.body);
  const jour = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const encours = `${jour.slice(0, 4)}-T${Math.floor((Number(jour.slice(5, 7)) - 1) / 3) + 1}`;
  assert.ok(!r.json().trimestres.includes(encours));
  assert.match(r.json().prochain, /^\d{4}-\d{2}-01$/);
  assert.equal((await app.inject({ method: 'GET', url: `/public/transparence?trimestre=${encours}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/public/transparence?trimestre=2026-T5' })).statusCode, 400);
  const v1 = await app.inject({ method: 'GET', url: '/v1/transparence' });
  assert.deepEqual([v1.statusCode, v1.json().licence, v1.headers['access-control-allow-origin']], [200, 'CC BY 4.0', '*']);
  await app.close();
});
