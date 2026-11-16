import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joursRestants } from '../src/lib/jours.ts';

test('jours restants comptés au jour près', () => {
  const ici = new Date(2026, 10, 14, 23, 30);   // 14 novembre 2026, tard le soir
  assert.equal(joursRestants('2026-11-14', ici), 0);
  assert.equal(joursRestants('2026-11-15', ici), 1);
  assert.equal(joursRestants('2026-11-10', ici), -4);
});
