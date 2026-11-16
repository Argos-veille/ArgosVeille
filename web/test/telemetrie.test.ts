// Le filtre de la télémétrie ne laisse passer ni identifiant, ni jeton, ni mail, ni numéro.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nettoyer, noterAction, noterAppel, noterPage, noteEnMemoire, routeGenerique } from '../src/lib/telemetrie.ts';

test('routes génériques : identifiants et nombres remplacés, requête et ancre retirées', () => {
  assert.equal(routeGenerique('/relecture/3f2b8c1e-1d2a-4b3c-9d8e-0123456789ab/vote'), '/relecture/:id/vote');
  assert.equal(routeGenerique('/inscription/mail#AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde'), '/inscription/mail');
  assert.equal(routeGenerique('/osint/videos?page=2'), '/osint/videos');
  assert.equal(routeGenerique('/apercu/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), '/apercu/:jeton');
});

test('textes libres (erreurs, piles) : mail, numéro, jeton et ancre retirés', () => {
  const t = nettoyer('échec pour jean.dupont@exemple.fr au 06 12 34 56 78, jeton AbCdEfGhIjKlMnOpQrStUvWxYz, lien /suivi#mot1-mot2');
  assert.ok(!t.includes('dupont') && !t.includes('34 56') && !t.includes('AbCdEf') && !t.includes('mot1'), t);
  assert.ok(nettoyer('x'.repeat(5000)).length <= 2000);
});

test('envoi et suivi : rien n’est noté (ni page, ni action, ni appel)', () => {
  noterPage('/carte');
  noterAppel({ route: 'GET /public/videos', statut: 200, duree: 3 });
  noterAppel({ route: 'POST /envois/:id/finaliser', statut: 200, duree: 3 });   // depuis une autre page aussi
  noterPage('/envoyer');
  noterAction('clic Envoyer');
  noterAppel({ route: 'POST /turnstile', statut: 200, duree: 3 });
  noterPage('/suivi/[code]');
  noterAppel({ route: 'GET /suivi/:jeton', statut: 200, duree: 3 });
  const { actions, appels } = noteEnMemoire();
  assert.deepEqual(actions.map((a) => a.quoi), ['page /carte']);
  assert.deepEqual(appels.map((a) => a.route), ['GET /public/videos']);
});
