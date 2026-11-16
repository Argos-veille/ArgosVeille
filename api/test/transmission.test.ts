// Transmission de l'original (étape 3) : autorisation à l'envoi ou plus tard, enveloppe pour la clé
// d'administration, ouverture hors du serveur, transmission notée au journal, retrait de l'autorisation.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import {
  chiffrerOriginal, cleOriginalBrute, dechiffrerOriginal, deriverSecrets, envelopper, genererEntropie, lecteurOctets,
  ouvrirEnveloppe, type MorceauChiffre,
  cleEmpreinteOriginal,
} from '../../navigateur/src/index.ts';
import { construireApp } from '../src/app.ts';
import { genererCodes } from '../src/codes.ts';
import { CONDITIONS_VERSION } from '../src/conditions.ts';
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

const VIDEO = readFileSync(new URL('./fixtures/mini.mp4', import.meta.url));
type App = ReturnType<typeof construireApp>;

/** Clé d'administration logicielle (en production : dans la YubiKey). */
async function cleAdmin() {
  const paire = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { privee: paire.privateKey, publique: Buffer.from(await crypto.subtle.exportKey('raw', paire.publicKey)).toString('base64') };
}

async function compte(app: App, deps: ReturnType<typeof dependances>['deps']) {
  const pseudo = `Trans_${randomInt(10_000_000, 100_000_000)}`;
  const mdp = 'cheval correct pile agrafe';
  const r = await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(mdp), randomBytes(32), randomBytes(32), chiffrer(deps.cles, `${pseudo.toLowerCase()}@exemple.fr`),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null]);
  const rep = await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: mdp } });
  return { id: r.rows[0]!.id, mdp, headers: { cookie: String(rep.headers['set-cookie']).split(';')[0]! } };
}

/** Envoi complet (option : avec compte, avec autorisation). */
async function envoyer(app: App, publiques: string[], opts: { headers?: Record<string, string>; autoriser?: boolean } = {}) {
  const entropie = genererEntropie();
  const s = await deriverSecrets(entropie);
  const morceaux: MorceauChiffre[] = [];
  const { sha256 } = await chiffrerOriginal(lecteurOctets(VIDEO), s.cleOriginal, async (m) => { morceaux.push(m); }, s.cleEmpreinte);
  const autorisation = opts.autoriser ? await envelopper(await cleOriginalBrute(entropie), publiques, sha256) : undefined;
  const o = await app.inject({ method: 'POST', url: '/envois', headers: opts.headers ?? {}, payload: {
    turnstile: 'x', conditions: CONDITIONS_VERSION, empreinteSuivi: s.empreinteSuivi, tailleOriginal: morceaux[0]!.octets.length,
    tailleCopie: VIDEO.length, sha256Original: sha256, schemaEmpreinte: 1, metadonnees: 'absentes',
    ...(opts.headers ? { avecCompte: true } : {}), ...(autorisation ? { autorisation } : {}),
    contexte: { date: '2026-11-03T14:12:00Z', lieu: { lat: 48.8566, lon: 2.3522 }, precision: 'exact', forces: 'unknown',
                situation: 'other', categorie: 'abuse', sousCategorie: 'other_abuse', description: 'Description d’essai, assez longue pour être acceptée.', langue: 'fr' },
  } });
  assert.equal(o.statusCode, 201, o.body);
  const { envoi } = o.json();
  const h = { 'content-type': 'application/octet-stream', 'argos-suivi': s.jetonSuivi };
  await app.inject({ method: 'PUT', url: `/envois/${envoi}/original/0`, payload: Buffer.from(morceaux[0]!.octets), headers: h });
  await app.inject({ method: 'PUT', url: `/envois/${envoi}/copie/0`, payload: VIDEO, headers: h });
  await app.inject({ method: 'POST', url: `/envois/${envoi}/finaliser`, headers: { 'argos-suivi': s.jetonSuivi }, payload: { cleCopie: s.cleCopie } });
  return { envoi: envoi as string, entropie, jeton: s.jetonSuivi, sha256 };
}

test('autorisation à l’envoi : l’administration ouvre l’original hors du serveur, la transmission est publique et la source prévenue', async () => {
  const { deps, facteur } = dependances(socle);
  const cle = await cleAdmin();
  deps.reglages.clesAdmin = [cle.publique];
  const app = construireApp(deps);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/cles-admin' })).json(), { cles: [cle.publique] });

  const source = await compte(app, deps);
  const admin = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const physique = new CleLogicielle('https://argos.test', 'argos.test');
  const req = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: admin.headers, payload });
  await req('/2fa/cle/confirmer', { reponse: physique.enregistrer((await req('/2fa/cle/debut', { motDePasse: admin.mdp })).json().options), nom: 'YubiKey' });
  await req('/admin/session', { cle: physique.prouver((await req('/admin/decision/defi')).json().options) });
  const avecCle = async (url: string, corps: object) =>
    req(url, { ...corps, cle: physique.prouver((await req('/admin/decision/defi')).json().options) });

  const e = await envoyer(app, [cle.publique], { headers: source.headers, autoriser: true });
  const suivi = async () => (await app.inject({ method: 'POST', url: '/suivi', payload: { jeton: e.jeton } })).json().transmission;
  assert.equal((await suivi()).autorisee, true);

  // L'administration récupère l'original chiffré et l'enveloppe, et les ouvre « sur son PC ».
  assert.equal((await req(`/admin/videos/${e.envoi}/original`)).statusCode, 400);   // clé et motif obligatoires
  assert.equal((await avecCle(`/admin/videos/${e.envoi}/original`, { motif: 'court' })).statusCode, 400);
  const { prevenirSources } = await import('../src/mesvideos.ts');
  const avantTelechargement = (await suivi()).telechargements.length;
  const o = await avecCle(`/admin/videos/${e.envoi}/original`, { motif: 'Demande de l’avocat de la source.' });
  assert.equal(o.statusCode, 200, o.body);
  assert.equal((await suivi()).telechargements.length, avantTelechargement + 1);   // visible par la source
  assert.match(proprietaire(`SELECT payload ->> 'action' FROM ledger.entries WHERE kind = 'admin_action' AND payload ->> 'video' = '${e.envoi}' ORDER BY seq`), /original_downloaded/);
  await prevenirSources(deps);
  assert.ok(facteur.mails.some((m) => m.sujet.includes('original de votre vidéo a été téléchargé')));
  assert.equal(o.json().sha256Original, e.sha256);
  const fichier = await app.inject({ method: 'GET', url: o.json().lien });
  assert.equal(fichier.statusCode, 200);
  const brute = await ouvrirEnveloppe(o.json().enveloppe, cle.privee, cle.publique, e.sha256);
  const cleAes = await crypto.subtle.importKey('raw', brute as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['decrypt']);
  const parts: Uint8Array[] = [];
  const d = await dechiffrerOriginal(lecteurOctets(fichier.rawPayload), cleAes, async (c) => { parts.push(c); }, cleEmpreinteOriginal(brute));
  assert.ok(d.correspond(e.sha256));
  assert.deepEqual(Buffer.concat(parts), VIDEO);

  // Transmission notée : clé physique exigée, journal public sans nom, source prévenue.
  assert.equal((await avecCle(`/admin/videos/${e.envoi}/transmission`, { destinataire: 'association', motif: 'court' })).json().erreur, 'motif');
  const t = await avecCle(`/admin/videos/${e.envoi}/transmission`, { destinataire: 'association', motif: 'Plainte de la personne filmée, avec l’association.' });
  assert.equal(t.statusCode, 200, t.body);
  assert.equal(proprietaire(`SELECT payload ->> 'recipient' FROM ledger.entries WHERE payload ->> 'video' = '${e.envoi}'
                               AND payload ->> 'action' = 'original_released'`), 'association');
  assert.deepEqual((await suivi()).transmissions.map((x: { destinataire: string }) => x.destinataire), ['association']);
  facteur.mails.length = 0;
  await prevenirSources(deps);
  assert.ok(facteur.mails.some((m) => m.sujet.includes('original de votre vidéo a été transmis')));

  // Retrait de l'autorisation : plus d'enveloppe pour l'administration ; la transmission passée reste.
  assert.equal((await app.inject({ method: 'POST', url: '/suivi/autorisation/retirer', payload: { jeton: e.jeton } })).statusCode, 200);
  assert.equal((await avecCle(`/admin/videos/${e.envoi}/original`, { motif: 'Demande de l’avocat de la source.' })).json().erreur, 'pas_autorisee');
  assert.equal((await suivi()).autorisee, false);
  assert.equal((await suivi()).transmissions.length, 1);
  await app.close();
});

test('autoriser plus tard avec le code ; enveloppe pour une autre clé refusée ; retirer la vidéo efface l’autorisation', async () => {
  const { deps } = dependances(socle);
  const cle = await cleAdmin();
  const intrus = await cleAdmin();
  deps.reglages.clesAdmin = [cle.publique];
  const app = construireApp(deps);
  const e = await envoyer(app, [cle.publique]);
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
  const suivi = async () => (await post('/suivi', { jeton: e.jeton })).json().transmission;
  assert.deepEqual([(await suivi()).autorisee, (await suivi()).proposee], [false, true]);

  const brute = await cleOriginalBrute(e.entropie);
  assert.equal((await post('/suivi/autoriser', { jeton: e.jeton, enveloppe: await envelopper(brute, [intrus.publique], e.sha256) })).json().erreur,
               'enveloppe_invalide');
  assert.equal((await post('/suivi/autoriser', { jeton: e.jeton, enveloppe: await envelopper(brute, [cle.publique], e.sha256) })).statusCode, 200);
  assert.equal((await suivi()).autorisee, true);

  const pseudo = (await post('/suivi', { jeton: e.jeton })).json().pseudonyme;
  assert.equal((await post('/suivi/retirer', { jeton: e.jeton, confirmation: pseudo })).statusCode, 200);
  // Plus aucune enveloppe : la ligne est effacée avec les autres traces (0129).
  assert.equal(proprietaire(`SELECT count(*) FROM core.release_consents WHERE video_id = '${e.envoi}' AND envelope IS NOT NULL`), '0');
  await app.close();
});

test('sans clé d’administration configurée : l’autorisation n’est ni proposée ni acceptée', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const cle = await cleAdmin();
  const e = await envoyer(app, [cle.publique]);
  assert.equal((await app.inject({ method: 'POST', url: '/suivi', payload: { jeton: e.jeton } })).json().transmission.proposee, false);
  const env = await envelopper(await cleOriginalBrute(e.entropie), [cle.publique], e.sha256);
  assert.equal((await app.inject({ method: 'POST', url: '/suivi/autoriser', payload: { jeton: e.jeton, enveloppe: env } })).json().erreur,
               'enveloppe_invalide');
  await app.close();
});
