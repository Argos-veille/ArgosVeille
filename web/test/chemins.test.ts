import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aplatir, interpoler, poser, regrouper, type Point } from '../src/lib/chemins.ts';

const A = [0.1, 0.1, 0.2, 0.2];
const B = [0.5, 0.1, 0.2, 0.2];
const C = [0.5, 0.6, 0.2, 0.2];

test('un chemin à 3 points donne 2 segments qui se suivent, et se regroupe à l’identique', () => {
  const chemin: Point[] = [{ t: 1, rect: A }, { t: 2, rect: B }, { t: 4, rect: C }];
  const segments = aplatir([chemin]);
  assert.deepEqual(segments, [{ debut: 1, fin: 2, de: A, a: B }, { debut: 2, fin: 4, de: B, a: C }]);
  assert.deepEqual(regrouper(segments), [chemin]);
});

test('deux zones distinctes ne se mélangent pas', () => {
  const a = { debut: 1, fin: 2, de: A, a: B };
  const b = { debut: 2, fin: 3, de: C, a: A };   // commence quand l'autre finit, mais ailleurs
  assert.equal(regrouper([a, b]).length, 2);
});

test('le cadre suit le chemin, y compris un changement de direction', () => {
  const chemin: Point[] = [{ t: 0, rect: A }, { t: 1, rect: B }, { t: 2, rect: A }];
  assert.deepEqual(interpoler(chemin, 1), B);
  assert.ok(Math.abs(interpoler(chemin, 0.5)![0]! - 0.3) < 1e-9);
  assert.ok(Math.abs(interpoler(chemin, 1.5)![0]! - 0.3) < 1e-9);
  assert.equal(interpoler(chemin, 3), null);
  assert.deepEqual(interpoler(chemin, 3, true), A);
});

test('poser : rangé dans le temps, remplace le point de la même image', () => {
  let p = poser([], 2, A);
  p = poser(p, 1, B);
  assert.deepEqual(p.map((x) => x.t), [1, 2]);
  p = poser(p, 2.005, C);
  assert.equal(p.length, 2);
  assert.deepEqual(p[1]!.rect, C);
});
