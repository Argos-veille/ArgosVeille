// Compteur du premier visionnage : la part UNIQUE de la vidéo regardée.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ajouterPassage, dureeVue, type Passage } from '../src/lib/visionnage.ts';

/** Simule une lecture par pas de 0,25 s entre deux instants, comme les événements timeupdate. */
function lire(liste: Passage[], de: number, a: number): Passage[] {
  for (let t = de; t < a; t += 0.25) liste = ajouterPassage(liste, t, Math.min(a, t + 0.25));
  return liste;
}

test('revoir le début en boucle ne compte qu’une fois', () => {
  let p: Passage[] = [];
  for (let i = 0; i < 20; i++) p = lire(p, 0, 10);   // 20 fois les 10 premières secondes d'une vidéo de 60 s
  assert.equal(dureeVue(p), 10);
  assert.ok(dureeVue(p) / 60 < 0.9);
});

test('lecture complète, avec retours en arrière : 100 %', () => {
  let p: Passage[] = [];
  p = lire(p, 0, 30); p = lire(p, 20, 45); p = lire(p, 40, 60);
  assert.deepEqual(p, [[0, 60]]);
});

test('passages disjoints puis comblés', () => {
  let p = ajouterPassage([], 10, 20);
  p = ajouterPassage(p, 30, 40);
  assert.deepEqual(p, [[10, 20], [30, 40]]);
  p = ajouterPassage(p, 15, 35);
  assert.deepEqual(p, [[10, 40]]);
  assert.equal(dureeVue(p), 30);
});
