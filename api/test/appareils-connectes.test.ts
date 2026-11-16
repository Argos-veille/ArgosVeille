// Appareils connectés (« Mon compte ») : liste des sessions ouvertes, fermeture de l'une d'elles.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { genererCodes } from '../src/codes.ts';
import { chiffrer, hacherMotDePasse } from '../src/crypto.ts';
import { dependances, preparer } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => { await bases.fermer(); await redis.quit(); });

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';

test('appareils connectés : description approximative, session en cours repérée, fermeture des autres seulement', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const pseudo = `Appareils_${randomInt(10_000_000, 100_000_000)}`;
  const mdp = 'cheval correct pile agrafe';
  await bases.identity.query('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8)',
    [pseudo, await hacherMotDePasse(mdp), randomBytes(32), randomBytes(32), chiffrer(deps.cles, `${pseudo.toLowerCase()}@exemple.fr`),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null]);
  const connexion = async (ua: string) => {
    const r = await app.inject({ method: 'POST', url: '/connexion', headers: { 'user-agent': ua }, payload: { pseudo, motDePasse: mdp } });
    return { cookie: String(r.headers['set-cookie']).split(';')[0]! };
  };
  const pc = await connexion(FIREFOX);
  const tel = await connexion(ANDROID);
  const liste = (await app.inject({ method: 'GET', url: '/compte/sessions', headers: pc })).json().sessions;
  assert.equal(liste.length, 2);
  const moi = liste.find((s: { actuelle: boolean }) => s.actuelle);
  const autre = liste.find((s: { actuelle: boolean }) => !s.actuelle);
  assert.equal(moi.appareil, 'Firefox sous Linux');
  assert.equal(autre.appareil, 'Chrome sous Android');
  assert.deepEqual(Object.keys(moi).sort(), ['actuelle', 'appareil', 'connecteLe', 'derniereActivite', 'id']);   // ni IP ni en-tête complet
  assert.equal((await app.inject({ method: 'POST', url: `/compte/sessions/${moi.id}/fermer`, headers: pc })).json().erreur, 'session_en_cours');
  assert.equal((await app.inject({ method: 'POST', url: `/compte/sessions/${autre.id}/fermer`, headers: pc })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/moi', headers: tel })).statusCode, 401);   // le téléphone est déconnecté
  assert.equal((await app.inject({ method: 'GET', url: '/compte/sessions', headers: pc })).json().sessions.length, 1);
  // Un autre compte ne peut pas fermer cette session.
  assert.equal((await app.inject({ method: 'POST', url: `/compte/sessions/${moi.id}/fermer`, headers: tel })).statusCode, 401);
  await app.close();
});
