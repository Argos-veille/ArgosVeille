// Même événement filmé sous un autre angle : relecteurs, analystes, administration, fiche publique.
import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { genererCodes } from '../src/codes.ts';
import { chiffrer, hacherMotDePasse } from '../src/crypto.ts';
import { dependances, preparer, proprietaire } from './aide.ts';
import { CleLogicielle } from './cle-logicielle.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

type App = ReturnType<typeof construireApp>;
type Deps = ReturnType<typeof dependances>['deps'];

async function compte(app: App, deps: Deps) {
  const pseudo = `Evenement_${randomInt(10_000_000, 100_000_000)}`;
  const mdp = 'cheval correct pile agrafe';
  const r = await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(mdp), randomBytes(32), randomBytes(32), chiffrer(deps.cles, `${pseudo.toLowerCase()}@exemple.fr`),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null]);
  const rep = await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: mdp } });
  return { id: r.rows[0]!.id, pseudo, mdp, headers: { cookie: String(rep.headers['set-cookie']).split(';')[0]! } };
}

function video(statut = 'published') {
  const id = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status, category, subcategory, forces, situation, occurred_at, location, location_precision, description, decided_at)
                VALUES ('${id}', '${statut}', 'violence', 'weapons', 'national_police', 'demonstration', '2026-11-01T15:00:00Z',
                        ST_GeogFromText('POINT(${(2 + Math.random()).toFixed(6)} 48.857)'), 'approx_100m', 'Scène', now());
                INSERT INTO core.pseudonyms (video_id, pseudonym, tracking_code_hash)
                VALUES ('${id}', 'Geai-${id.slice(0, 6)}', '\\x${randomBytes(32).toString('hex')}')`);
  return id;
}

async function analyste(app: App, deps: Deps) {
  const a = await compte(app, deps);
  proprietaire(`INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('${a.id}', 'totp', '\\x00');
                INSERT INTO core.verifications (account_id, category, expires_at) VALUES ('${a.id}', 'osint_analyst', now() + interval '1 year')`);
  return a;
}

const fiche = async (app: App, id: string) => (await app.inject({ method: 'GET', url: `/public/videos/${id}`, remoteAddress: '198.51.100.80' })).json();

test('relecteur : propositions à vérifier, réponses après le vote, fiche inconnue refusée', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const moi = await compte(app, deps);
  const f = video();
  const brouillon = video('in_review');
  const v = video('in_review');
  const c = randomUUID();
  proprietaire(`SELECT core.propose_event('${v}', '${f}', 'source', NULL, NULL);
                INSERT INTO core.summons (id, video_id, account_id, round, expires_at, video_opened_at)
                VALUES ('${c}', '${v}', '${moi.id}', 'review', now() + interval '2 days', now() - interval '1 hour')`);
  const liste = (await app.inject({ method: 'GET', url: '/relecture', headers: moi.headers })).json();
  const conv = liste.convocations.find((x: { convocation: string }) => x.convocation === c);
  assert.ok(conv.evenements.map((x: { video: string }) => x.video).includes(f));   // d'autres vidéos proches peuvent être suggérées

  const base = { verdict: 'oui', raisons: ['intervention_visible'], visageIdentifiable: false };
  const vote = (corps: object) => app.inject({ method: 'POST', url: `/relecture/${c}/vote`, headers: moi.headers, payload: { ...base, ...corps } });
  assert.deepEqual((await vote({ memeEvenement: brouillon })).json(), { erreur: 'fiche_introuvable' });
  assert.equal((await vote({ evenements: [{ fiche: f, oui: true }] })).statusCode, 200);
  assert.equal(proprietaire(`SELECT agrees FROM core.event_proposal_answers a JOIN core.event_proposals q ON q.id = a.proposal_id WHERE q.video_id = '${v}'`).trim(), 't');
  await app.close();
});

test('analystes : proposition puis accord de 2 autres, visible sur les deux fiches et au journal', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const [a, b, c] = [await analyste(app, deps), await analyste(app, deps), await analyste(app, deps)];
  const v1 = video();
  const v2 = video();
  const appel = (qui: typeof a, url: string, payload?: object) =>
    app.inject({ method: payload ? 'POST' : 'GET', url, headers: qui.headers, ...(payload ? { payload } : {}) });

  assert.equal((await appel(a, '/osint/evenements', { video: 'Inconnue', fiche: v2, justification: 'Même façade et même heure.' })).json().erreur, 'fiche_introuvable');
  assert.equal((await appel(a, '/osint/evenements', { video: v1, fiche: v2, justification: 'court' })).json().erreur, 'justification');
  const p = (await appel(a, '/osint/evenements', { video: v1, fiche: v2, justification: 'Même façade et même heure.' })).json().proposition;

  const file = async (qui: typeof a) => (await appel(qui, '/osint/evenements')).json().propositions.map((x: { id: string }) => x.id);
  assert.ok(!(await file(a)).includes(p));
  assert.ok((await file(b)).includes(p));
  assert.equal((await appel(a, `/osint/evenements/${p}`, { accord: true })).json().erreur, 'propre_proposition');
  assert.equal((await appel(b, `/osint/evenements/${p}`, { accord: true })).json().etat, 'pending');
  assert.ok(!(await file(b)).includes(p));
  assert.deepEqual((await fiche(app, v1)).memeEvenement, []);
  assert.equal((await appel(c, `/osint/evenements/${p}`, { accord: true })).json().etat, 'validated');
  assert.equal((await fiche(app, v1)).memeEvenement[0].id, v2);
  assert.equal((await fiche(app, v2)).memeEvenement[0].id, v1);
  assert.match(proprietaire(`SELECT payload ->> 'target' FROM ledger.entries WHERE kind = 'event_link' AND payload ->> 'video' = '${v1}'`), new RegExp(v2));

  const seul = await compte(app, deps);
  assert.equal((await appel(seul, '/osint/evenements')).json().erreur, 'reserve_analyste');
  await app.close();
});

test('administration : décider une proposition, relier directement, retirer de l’événement (clé et motif)', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'; DELETE FROM core.event_proposals`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (url: string, payload?: object) => app.inject({ method: payload ? 'POST' : 'GET', url, headers: admin.headers, ...(payload ? { payload } : {}) });
  const debut = await req('/2fa/cle/debut', { motDePasse: admin.mdp });
  await req('/2fa/cle/confirmer', { reponse: cle.enregistrer(debut.json().options), nom: 'YubiKey' });
  await req('/admin/session', { cle: cle.prouver((await req('/admin/decision/defi', {})).json().options) });
  const signer = async (url: string, corps: object) => req(url, { ...corps, cle: cle.prouver((await req('/admin/decision/defi', {})).json().options) });

  const [a, b, c] = [video(), video(), video('in_review')];
  proprietaire(`SELECT core.propose_event('${a}', '${b}', 'source', NULL, NULL)`);
  const [p] = (await req('/admin/evenements')).json().propositions;
  assert.equal(p.video.id, a);
  assert.equal((await signer(`/admin/evenements/${p.id}`, { accepter: true, motif: 'court' })).statusCode, 400);
  assert.equal((await signer(`/admin/evenements/${p.id}`, { accepter: true, motif: 'Même scène, vérifiée image par image.' })).statusCode, 200);
  assert.equal((await fiche(app, a)).memeEvenement[0].id, b);
  assert.equal((await req('/admin/evenements')).json().propositions.length, 0);

  assert.equal((await signer(`/admin/videos/${c}/evenement`, { fiche: 'Inconnue', motif: 'Même scène, vérifiée.' })).json().erreur, 'fiche_introuvable');
  assert.equal((await signer(`/admin/videos/${c}/evenement`, { fiche: a, motif: 'Même scène, vérifiée.' })).statusCode, 200);
  assert.equal((await req(`/admin/videos/${a}`)).json().memeEvenement.length, 2);
  assert.equal((await fiche(app, a)).memeEvenement.length, 1);   // pas encore publiée : invisible du public

  assert.equal((await signer(`/admin/videos/${a}/evenement/retirer`, { motif: 'Finalement une autre scène.' })).statusCode, 200);
  assert.deepEqual((await fiche(app, b)).memeEvenement, []);
  assert.equal((await signer(`/admin/videos/${a}/evenement/retirer`, { motif: 'Finalement une autre scène.' })).statusCode, 404);
  await app.close();
});
