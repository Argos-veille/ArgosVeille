// Statuts des comptes : code de compte spécial saisi après l'inscription ; tous les statuts gérés par
// l'administration (clé physique), y compris le compte de confiance.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { normaliserCodeBeta, nouveauCodeBeta } from '../src/beta.ts';
import { genererCodes } from '../src/codes.ts';
import { chiffrer, empreinte, hacherMotDePasse } from '../src/crypto.ts';
import { dependances, preparer, proprietaire } from './aide.ts';
import { CleLogicielle } from './cle-logicielle.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => { await bases.fermer(); await redis.quit(); });
type App = ReturnType<typeof construireApp>;

async function compte(app: App, deps: ReturnType<typeof dependances>['deps']) {
  const pseudo = `Statut_${randomInt(10_000_000, 100_000_000)}`;
  const mdp = 'cheval correct pile agrafe';
  const r = await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(mdp), randomBytes(32), randomBytes(32), chiffrer(deps.cles, `${pseudo.toLowerCase()}@exemple.fr`),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null]);
  const rep = await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: mdp } });
  return { id: r.rows[0]!.id, pseudo, mdp, headers: { cookie: String(rep.headers['set-cookie']).split(';')[0]! } };
}

test('code de compte spécial saisi dans « Mon compte » : certifié, catégorie attribuée, code consommé', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const u = await compte(app, deps);
  const code = nouveauCodeBeta();
  proprietaire(`INSERT INTO core.account_codes (code_hmac, label, category)
                VALUES ('\\x${empreinte(deps.cles, 'code-compte', normaliserCodeBeta(code)!).toString('hex')}', 'Journaliste X', 'journalist')`);
  const faux = await app.inject({ method: 'POST', url: '/compte/code-special', headers: u.headers, payload: { code: 'AAAA-BBBB-CCCC' } });
  assert.deepEqual(faux.json(), { erreur: 'code_invitation_invalide' });
  // Sans double authentification : refusé, et le code reste valable (0102).
  const sans = await app.inject({ method: 'POST', url: '/compte/code-special', headers: u.headers, payload: { code } });
  assert.deepEqual([sans.statusCode, sans.json().erreur], [403, 'double_auth_requise']);
  proprietaire(`INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('${u.id}', 'totp', '\\x00')`);
  const ok = await app.inject({ method: 'POST', url: '/compte/code-special', headers: u.headers, payload: { code } });
  assert.deepEqual(ok.json(), { certification: 'journalist' });
  assert.equal((await app.inject({ method: 'GET', url: '/moi', headers: u.headers })).json().certification, 'journalist');
  assert.equal((await app.inject({ method: 'POST', url: '/compte/code-special', headers: u.headers, payload: { code } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/compte/code-special', payload: { code } })).statusCode, 401);
  await app.close();
});

test('administration : accorder et retirer chaque statut (clé physique exigée)', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  const u = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin; UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const cle = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: admin.headers, payload });
  await req('/2fa/cle/confirmer', { reponse: cle.enregistrer((await req('/2fa/cle/debut', { motDePasse: admin.mdp })).json().options), nom: 'YubiKey' });
  proprietaire(`INSERT INTO core.admin_sessions (session_id)
                SELECT id FROM core.sessions WHERE account_id = '${admin.id}' ORDER BY created_at DESC LIMIT 1`);
  const statut = async (s: string, accorder: boolean) =>
    req(`/admin/comptes/${u.pseudo}/statut`, { statut: s, accorder, cle: cle.prouver((await req('/admin/decision/defi')).json().options) });
  const fiche = async () => (await app.inject({ method: 'GET', url: `/admin/comptes/${u.id}`, headers: admin.headers })).json().statuts;

  assert.equal((await req(`/admin/comptes/${u.pseudo}/statut`, { statut: 'avocat', accorder: true, cle: cle.prouver({ challenge: 'x', allowCredentials: [] } as never) })).json().erreur, 'cle_invalide');
  // Sans double authentification : aucun statut vérifié (0102) ; « confiance » reste possible.
  assert.equal((await statut('avocat', true)).json().erreur, 'double_auth_requise');
  proprietaire(`INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc) VALUES ('${u.id}', 'totp', '\\x00')`);
  assert.equal((await statut('avocat', true)).statusCode, 200);
  assert.deepEqual(await fiche(), ['avocat', 'confiance']);   // une catégorie certifie aussi le compte
  assert.equal((await statut('avocat', true)).json().erreur, 'deja_ainsi');
  assert.equal((await statut('association', true)).statusCode, 200);
  assert.equal((await statut('analyste', true)).statusCode, 200);
  assert.equal((await statut('analyste', false)).statusCode, 200);
  assert.equal((await statut('avocat', false)).statusCode, 200);
  assert.equal((await statut('confiance', false)).statusCode, 200);
  assert.deepEqual(await fiche(), ['association']);
  await app.close();
});
