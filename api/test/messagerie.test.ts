// Messagerie avec les sources (M1) : clés de compte, comptes vérifiés ↔ source, administration ↔ source.
// Les messages sont chiffrés par le module du navigateur, comme sur le site.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { chiffrerMessage, chiffrerOriginal, cleDuMessage, cleOriginalBrute, cleVideoPourCompte, creerCleCompte, dechiffrerOriginal, lecteurOctets,
         ouvrirPartageOriginal, partagerOriginal, creerCleVideo, dechiffrerMessage, deriverSecrets, genererEntropie, ouvrirCleCompte,
         ouvrirCleVideoParCompte, ouvrirCleVideoParPhrase, rechiffrerCleCompte, type CleOuverte } from '../../navigateur/src/index.ts';
import { construireApp } from '../src/app.ts';
import { genererCodes } from '../src/codes.ts';
import { changerMotDePasse } from '../src/compte.ts';
import { prevenirMessages } from '../src/messagerie.ts';
import { chiffrer, hacherMotDePasse } from '../src/crypto.ts';
import { dependances, preparer, proprietaire } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => { await bases.fermer(); await redis.quit(); });

const MDP = 'cheval correct pile agrafe';
const IT = 100_000;   // minimum accepté par l'API (600 000 sur le site)
type App = ReturnType<typeof construireApp>;
type Compte = { id: string; headers: { cookie: string } };

async function compte(app: App, deps: ReturnType<typeof dependances>['deps']): Promise<Compte> {
  const pseudo = `Msg_${randomInt(10_000_000, 100_000_000)}`;
  const r = await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(MDP), randomBytes(32), randomBytes(32), chiffrer(deps.cles, `${pseudo.toLowerCase()}@exemple.fr`),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null]);
  const rep = await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: MDP } });
  return { id: r.rows[0]!.id, headers: { cookie: String(rep.headers['set-cookie']).split(';')[0]! } };
}
// Compte vérifié : double authentification obligatoire (revue de sécurité, A3).
const verifier = (c: Compte, statut = 'journalist') =>
  proprietaire(`INSERT INTO core.verifications (account_id, category, expires_at) VALUES ('${c.id}', '${statut}', now() + interval '1 year');
                INSERT INTO core.mfa_factors (account_id, kind, totp_secret_enc)
                SELECT '${c.id}', 'totp', '\\x00' WHERE NOT EXISTS (SELECT 1 FROM core.mfa_factors WHERE account_id = '${c.id}' AND revoked_at IS NULL)`);

/** Crée la clé de messagerie d'un compte par l'API, et la renvoie ouverte. */
async function cleDeCompte(app: App, c: Compte): Promise<CleOuverte> {
  const { stockee, ouverte } = await creerCleCompte(MDP, IT);
  const r = await app.inject({ method: 'POST', url: '/messagerie/cle', headers: c.headers, payload: { motDePasse: MDP, cle: stockee } });
  assert.equal(r.statusCode, 200, r.body);
  return ouverte;
}

/** Une vidéo publiée suivie par un code de 12 mots, avec sa clé de messagerie (comme à l'envoi). */
async function videoSource(statut = 'published', publiqueCompte?: string) {
  const entropie = genererEntropie();
  const s = await deriverSecrets(entropie);
  const id = randomUUID();
  const cle = await creerCleVideo(entropie, publiqueCompte);
  const hash = createHash('sha256').update(Buffer.from(s.jetonSuivi, 'base64url')).digest('hex');
  proprietaire(`INSERT INTO core.videos (id, status, category, subcategory, forces, situation, occurred_at, location, location_precision, language)
                VALUES ('${id}', '${statut}', 'violence', 'weapons', 'national_police', 'demonstration', '2026-11-01T15:00:00Z',
                        ST_GeogFromText('POINT(2.352 48.857)'), 'approx_100m', 'fr');
                INSERT INTO core.pseudonyms (video_id, pseudonym, tracking_code_hash) VALUES ('${id}', 'Loutre-${id.slice(0, 6)}', '\\x${hash}');
                INSERT INTO core.public_keys (pseudonym_id, public_key, wrapped_private, owner_wrapped)
                SELECT id, decode('${Buffer.from(cle.publique, 'base64').toString('hex')}', 'hex'),
                       decode('${Buffer.from(cle.parPhrase, 'base64').toString('hex')}', 'hex'),
                       ${cle.pourCompte ? `'${JSON.stringify(cle.pourCompte)}'::jsonb` : 'NULL'}
                  FROM core.pseudonyms WHERE video_id = '${id}'`);
  return { id, jeton: s.jetonSuivi, entropie, cle, ouverte: await ouvrirCleVideoParPhrase(cle, entropie) };
}

test('clé de messagerie du compte : mot de passe vérifié, une seule, rechiffrée au changement, effacée à la réinitialisation', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const moi = await compte(app, deps);
  const get = () => app.inject({ method: 'GET', url: '/messagerie/cle', headers: moi.headers });
  assert.deepEqual((await get()).json(), { cle: null });
  const { stockee } = await creerCleCompte(MDP, IT);
  const faux = await app.inject({ method: 'POST', url: '/messagerie/cle', headers: moi.headers, payload: { motDePasse: 'pas le bon', cle: stockee } });
  assert.equal(faux.statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/messagerie/cle', headers: moi.headers, payload: { motDePasse: MDP, cle: stockee } })).statusCode, 200);
  const autre = (await creerCleCompte(MDP, IT)).stockee;
  assert.equal((await app.inject({ method: 'POST', url: '/messagerie/cle', headers: moi.headers, payload: { motDePasse: MDP, cle: autre } })).statusCode, 409);
  assert.deepEqual((await get()).json().cle, stockee);

  // Changement de mot de passe : la clé rechiffrée est exigée, et doit être la même paire.
  const NOUVEAU = 'autre phrase de passe bien longue';
  const mdp = (payload: object) => app.inject({ method: 'POST', url: '/mot-de-passe', headers: moi.headers, payload });
  assert.equal((await mdp({ ancien: MDP, nouveau: NOUVEAU })).json().erreur, 'cle_messagerie_requise');
  assert.equal((await mdp({ ancien: MDP, nouveau: NOUVEAU, cleMessagerie: autre })).json().erreur, 'cle_messagerie_differente');
  const rechiffree = await rechiffrerCleCompte(stockee, MDP, NOUVEAU, IT);
  assert.equal((await mdp({ ancien: MDP, nouveau: NOUVEAU, cleMessagerie: rechiffree })).statusCode, 200);
  const apres = (await get()).json().cle;
  assert.equal(apres.publique, stockee.publique);
  await ouvrirCleCompte(apres, NOUVEAU);

  // Réinitialisation (lien par mail, code de secours) : la clé et ses enveloppes de vidéo sont effacées.
  const v = await videoSource('published', stockee.publique);
  proprietaire(`INSERT INTO core.video_owners (video_id, account_id) VALUES ('${v.id}', '${moi.id}')`);
  await changerMotDePasse(deps, moi.id, 'encore un autre mot de passe', undefined, 'effacer');
  assert.equal(proprietaire(`SELECT count(*) FROM core.public_keys WHERE account_id = '${moi.id}'`), '0');
  assert.equal(proprietaire(`SELECT owner_wrapped IS NULL FROM core.public_keys k JOIN core.pseudonyms p ON p.id = k.pseudonym_id
                              WHERE p.video_id = '${v.id}'`), 't');
  await app.close();
});

test('compte vérifié ↔ source : accord exigé, messages lisibles par les deux seulement, fermeture', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const journaliste = await compte(app, deps);
  const curieux = await compte(app, deps);
  verifier(journaliste);
  verifier(curieux, 'osint_analyst');   // un analyste n'est pas un compte vérifié pour la messagerie
  const cleJ = await cleDeCompte(app, journaliste);
  const v = await videoSource();
  const req = (methode: 'GET' | 'POST', url: string, qui: Compte, payload?: object) =>
    app.inject({ method: methode, url, headers: qui.headers, ...(payload ? { payload } : {}) });
  const source = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, payload: { jeton: v.jeton, ...payload } });

  assert.equal((await req('GET', `/messagerie/videos/${v.id}`, curieux)).statusCode, 403);
  assert.deepEqual((await req('GET', `/messagerie/videos/${v.id}`, journaliste)).json(), { possible: false, conversation: null, cle: true });
  assert.equal((await req('POST', `/messagerie/videos/${v.id}`, journaliste)).json().erreur, 'contact_refuse');

  // La source accepte d'être contactée.
  assert.deepEqual((await source('/suivi/messagerie/contact', { autoriser: true })).json(), { contact: true });
  const ouverture = (await req('POST', `/messagerie/videos/${v.id}`, journaliste)).json();
  assert.equal(ouverture.cleSource, v.cle.publique);
  const conv = ouverture.conversation as string;
  assert.equal((await req('POST', `/messagerie/videos/${v.id}`, journaliste)).json().conversation, conv);   // la même

  const m1 = await chiffrerMessage('Bonjour, je suis journaliste. Accepteriez-vous un échange ?', conv, 'verified', [cleJ.publique, v.cle.publique]);
  assert.equal((await req('POST', `/messagerie/${conv}`, journaliste, { message: m1 })).statusCode, 200);
  // Chiffré pour quelqu'un d'autre que la source : refusé (elle ne pourrait pas le lire).
  const tiers = (await creerCleCompte(MDP, IT)).ouverte;
  const mauvais = await chiffrerMessage('test', conv, 'verified', [cleJ.publique, tiers.publique]);
  assert.equal((await req('POST', `/messagerie/${conv}`, journaliste, { message: mauvais })).json().erreur, 'message_chiffre_invalide');

  // Côté source : la conversation, qui écrit (statut + pseudo), le message.
  const etat = (await source('/suivi/messagerie')).json();
  assert.equal(etat.contact, true);
  assert.equal(etat.cle.publique, v.cle.publique);
  assert.equal(etat.cle.pourCompte, undefined);
  assert.equal(etat.conversations.length, 1);
  assert.equal(etat.conversations[0].avec.libelle, 'Journaliste');
  assert.equal(etat.conversations[0].nonLu, true);
  const lu = (await source('/suivi/messagerie/lire', { conversation: conv })).json();
  assert.equal(lu.cleAutre, cleJ.publique);
  assert.equal(await dechiffrerMessage(lu.messages[0].chiffre, conv, lu.messages[0].de, v.ouverte),
               'Bonjour, je suis journaliste. Accepteriez-vous un échange ?');
  assert.equal((await source('/suivi/messagerie')).json().conversations[0].nonLu, false);

  const m2 = await chiffrerMessage('Oui, d’accord.', conv, 'witness', [v.cle.publique, cleJ.publique]);
  assert.equal((await source('/suivi/messagerie/ecrire', { conversation: conv, message: m2 })).statusCode, 200);
  const cote = (await req('GET', `/messagerie/${conv}`, journaliste)).json();
  assert.equal(cote.messages.length, 2);
  assert.equal(await dechiffrerMessage(cote.messages[1].chiffre, conv, 'witness', cleJ), 'Oui, d’accord.');
  assert.equal(await dechiffrerMessage(cote.messages[0].chiffre, conv, 'verified', cleJ),   // l'expéditeur relit le sien
               'Bonjour, je suis journaliste. Accepteriez-vous un échange ?');
  assert.equal((await req('GET', '/messagerie', journaliste)).json().conversations[0].id, conv);
  assert.equal((await req('GET', `/messagerie/${conv}`, curieux)).statusCode, 403);
  const autreJ = await compte(app, deps);
  verifier(autreJ, 'lawyer');
  assert.equal((await req('GET', `/messagerie/${conv}`, autreJ)).statusCode, 404);   // pas sa conversation

  // La source retire son accord : plus de message du compte vérifié ; puis elle ferme la conversation.
  await source('/suivi/messagerie/contact', { autoriser: false });
  assert.equal((await req('POST', `/messagerie/${conv}`, journaliste, { message: m1 })).json().erreur, 'contact_refuse');
  await source('/suivi/messagerie/contact', { autoriser: true });
  assert.equal((await source('/suivi/messagerie/fermer', { conversation: conv })).statusCode, 200);
  assert.equal((await req('POST', `/messagerie/${conv}`, journaliste, { message: m1 })).json().erreur, 'conversation_fermee');
  assert.equal((await source('/suivi/messagerie/ecrire', { conversation: conv, message: m2 })).json().erreur, 'conversation_fermee');

  // Vidéo pas encore publique : aucun contact possible.
  const enRelecture = await videoSource('in_review');
  await app.inject({ method: 'POST', url: '/suivi/messagerie/contact', payload: { jeton: enRelecture.jeton, autoriser: true } });
  assert.equal((await req('POST', `/messagerie/videos/${enRelecture.id}`, journaliste)).json().erreur, 'contact_refuse');
  await app.close();
});

test('administration ↔ source : sans accord, session d’administration exigée, la source ne peut pas fermer', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const admin = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const cleA = await cleDeCompte(app, admin);
  const v = await videoSource('in_review');   // pas d'accord de contact, pas publique : l'admin peut quand même écrire
  const req = (methode: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method: methode, url, headers: admin.headers, ...(payload ? { payload } : {}) });

  assert.equal((await req('POST', `/admin/videos/${v.id}/messagerie`)).json().erreur, 'session_admin_requise');
  const session = proprietaire(`SELECT id FROM core.sessions WHERE account_id = '${admin.id}' ORDER BY created_at DESC LIMIT 1`);
  proprietaire(`INSERT INTO core.admin_sessions (session_id) VALUES ('${session}') ON CONFLICT (session_id) DO UPDATE SET started_at = now(), last_at = now()`);

  const conv = (await req('POST', `/admin/videos/${v.id}/messagerie`)).json().conversation as string;
  const m = await chiffrerMessage('Bonjour, ici l’administration d’Argos Veille.', conv, 'verified', [cleA.publique, v.cle.publique]);
  assert.equal((await req('POST', `/admin/messagerie/${conv}`, { message: m })).statusCode, 200);
  assert.equal((await req('GET', '/admin/messagerie')).json().conversations[0].id, conv);
  // Pas par les routes des comptes vérifiés.
  assert.equal((await req('GET', `/messagerie/${conv}`)).statusCode, 403);

  const etat = (await app.inject({ method: 'POST', url: '/suivi/messagerie', payload: { jeton: v.jeton } })).json();
  assert.equal(etat.contact, false);
  assert.deepEqual(etat.conversations[0].avec, { statut: 'admin', libelle: 'Administration d’Argos Veille', pseudo: null });
  const lu = (await app.inject({ method: 'POST', url: '/suivi/messagerie/lire', payload: { jeton: v.jeton, conversation: conv } })).json();
  assert.equal(await dechiffrerMessage(lu.messages[0].chiffre, conv, 'verified', v.ouverte), 'Bonjour, ici l’administration d’Argos Veille.');
  const fermer = await app.inject({ method: 'POST', url: '/suivi/messagerie/fermer', payload: { jeton: v.jeton, conversation: conv } });
  assert.equal(fermer.json().erreur, 'conversation_admin');
  const lus = (await app.inject({ method: 'GET', url: '/moi', headers: admin.headers })).json().messagerieSources;
  assert.equal(lus.statut, 'admin');
  await app.close();
});

test('source qui a envoyé avec son compte : clé de la vidéo ouverte par la clé du compte, sans les 12 mots', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const moi = await compte(app, deps);
  const cleMoi = await cleDeCompte(app, moi);
  const v = await videoSource('published', cleMoi.publique);
  proprietaire(`INSERT INTO core.video_owners (video_id, account_id) VALUES ('${v.id}', '${moi.id}')`);
  const parCompte = (await app.inject({ method: 'POST', url: '/suivi/messagerie', headers: moi.headers, payload: { video: v.id } })).json();
  assert.ok(parCompte.cle.pourCompte);
  const ouverte = await ouvrirCleVideoParCompte(parCompte.cle, cleMoi);
  assert.equal(ouverte.publique, v.cle.publique);
  // Avec le code seul, l'enveloppe pour le compte n'est pas donnée (inutile, et elle relierait la vidéo au compte).
  const parCode = (await app.inject({ method: 'POST', url: '/suivi/messagerie', payload: { jeton: v.jeton } })).json();
  assert.equal(parCode.cle.pourCompte, undefined);
  // Un autre compte ne voit pas la messagerie de cette vidéo.
  const autre = await compte(app, deps);
  assert.equal((await app.inject({ method: 'POST', url: '/suivi/messagerie', headers: autre.headers, payload: { video: v.id } })).statusCode, 404);

  // Page « Messages » : les conversations reçues au sujet de ses vidéos, et le compteur des non-lus.
  const liste = () => app.inject({ method: 'GET', url: '/compte/messagerie-videos', headers: moi.headers });
  assert.deepEqual((await liste()).json(), { videos: [] });
  const j = await compte(app, deps);
  verifier(j);
  const cleJ = await cleDeCompte(app, j);
  proprietaire(`UPDATE core.pseudonyms SET contact_allowed = true WHERE video_id = '${v.id}'`);
  const conv = (await app.inject({ method: 'POST', url: `/messagerie/videos/${v.id}`, headers: j.headers })).json().conversation;
  const m = await chiffrerMessage('Bonjour', conv, 'verified', [cleJ.publique, v.cle.publique]);
  assert.equal((await app.inject({ method: 'POST', url: `/messagerie/${conv}`, headers: j.headers, payload: { message: m } })).statusCode, 200);
  const vues = (await liste()).json().videos;
  assert.equal(vues.length, 1);
  assert.deepEqual([vues[0].video, vues[0].conversations, vues[0].nonLus], [v.id, 1, 1]);
  assert.equal((await app.inject({ method: 'GET', url: '/moi', headers: moi.headers })).json().messagesVideosNonLus, 1);
  await app.inject({ method: 'POST', url: '/suivi/messagerie/lire', headers: moi.headers, payload: { video: v.id, conversation: conv } });
  assert.equal((await liste()).json().videos[0].nonLus, 0);
  await app.close();
});

test('base : clé de vidéo immuable, conversation impossible sans compte vérifié, messages inaltérables par le site', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const v = await videoSource();
  const k = await bases.app.query<{ id: string }>(
    'SELECT k.id FROM core.public_keys k JOIN core.pseudonyms p ON p.id = k.pseudonym_id WHERE p.video_id = $1', [v.id]);
  await assert.rejects(bases.app.query('UPDATE core.public_keys SET public_key = $2 WHERE id = $1',
    [k.rows[0]!.id, Buffer.concat([Buffer.from([4]), randomBytes(64)])]), /modification_interdite|permission|droit/);
  await assert.rejects(bases.app.query('DELETE FROM core.public_keys WHERE id = $1', [k.rows[0]!.id]), /modification_interdite|permission|droit/);
  // Audit H5 (0121) : la clé d'un compte (vérifié, administration) ne se remplace ni ne se supprime par le site.
  await assert.rejects(bases.app.query('UPDATE core.public_keys SET public_key = $1 WHERE account_id IS NOT NULL',
    [Buffer.concat([Buffer.from([4]), randomBytes(64)])]), /permission|droit/);
  await assert.rejects(bases.app.query('DELETE FROM core.public_keys WHERE account_id IS NOT NULL'), /permission|droit/);
  const simple = await compte(app, deps);
  await cleDeCompte(app, simple);
  proprietaire(`UPDATE core.pseudonyms SET contact_allowed = true WHERE video_id = '${v.id}'`);
  await assert.rejects(bases.app.query(
    'INSERT INTO core.conversations (pseudonym_id, verified_account_id) SELECT id, $2 FROM core.pseudonyms WHERE video_id = $1',
    [v.id, simple.id]), /compte_non_verifie/);
  await assert.rejects(bases.app.query(
    'INSERT INTO core.conversations (pseudonym_id, verified_account_id, with_admin) SELECT id, $2, true FROM core.pseudonyms WHERE video_id = $1',
    [v.id, simple.id]), /reserve_super_admin/);
  await assert.rejects(bases.app.query("UPDATE core.messages SET ciphertext = '\\x00'"), /permission|droit/);
  await assert.rejects(bases.app.query('DELETE FROM core.messages'), /permission|droit/);
  await app.close();
});

test('M3 : mails sans contenu (source avec compte, compte vérifié), jamais pour un envoi anonyme ; signalement vérifié', async () => {
  const { deps, facteur } = dependances(socle);
  const app = construireApp(deps);
  const proprio = await compte(app, deps);
  const cleP = await cleDeCompte(app, proprio);
  const j = await compte(app, deps);
  verifier(j);
  const cleJ = await cleDeCompte(app, j);
  const v = await videoSource('published', cleP.publique);
  proprietaire(`INSERT INTO core.video_owners (video_id, account_id) VALUES ('${v.id}', '${proprio.id}');
                UPDATE core.pseudonyms SET contact_allowed = true WHERE video_id = '${v.id}'`);
  const anonyme = await videoSource();
  proprietaire(`UPDATE core.pseudonyms SET contact_allowed = true WHERE video_id = '${anonyme.id}'`);
  const ouvrir = async (video: string) => (await app.inject({ method: 'POST', url: `/messagerie/videos/${video}`, headers: j.headers })).json();
  const ecrireJ = async (conv: string, texte: string, cleSource: string) =>
    app.inject({ method: 'POST', url: `/messagerie/${conv}`, headers: j.headers,
                 payload: { message: await chiffrerMessage(texte, conv, 'verified', [cleJ.publique, cleSource]) } });
  const c1 = (await ouvrir(v.id)).conversation;
  const c2 = (await ouvrir(anonyme.id)).conversation;
  await ecrireJ(c1, 'Bonjour', v.cle.publique);
  await ecrireJ(c2, 'Bonjour', anonyme.cle.publique);

  // Mails : la source avec compte seulement (rien ne dit de quelle vidéo il s'agit) ; une fois par jour au plus.
  const avant = facteur.mails.length;
  await prevenirMessages(deps);
  const nouveaux = facteur.mails.slice(avant);
  const mesMails = nouveaux.filter((m) => m.sujet.includes('un message vous attend'));
  assert.equal(mesMails.length, 1);
  assert.ok(!mesMails[0]!.texte.includes(v.id) && !mesMails[0]!.texte.includes('Loutre'));
  await ecrireJ(c1, 'Encore moi', v.cle.publique);
  const avant2 = facteur.mails.length;
  await prevenirMessages(deps);
  assert.equal(facteur.mails.slice(avant2).filter((m) => m.sujet.includes('un message vous attend')).length, 0);   // déjà prévenu aujourd'hui

  // La source répond : le compte vérifié est prévenu ; préférence coupée : plus de mail.
  const rep = await chiffrerMessage('Bonjour à vous', c2, 'witness', [anonyme.cle.publique, cleJ.publique]);
  await app.inject({ method: 'POST', url: '/suivi/messagerie/ecrire', payload: { jeton: anonyme.jeton, conversation: c2, message: rep } });
  const avant3 = facteur.mails.length;
  await prevenirMessages(deps);
  assert.equal(facteur.mails.slice(avant3).filter((m) => m.sujet.includes('une source vous a répondu')).length, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/compte/notifications', headers: j.headers, payload: { reponseSource: false } })).json().reponseSource, false);

  // Signalement par la source (message reçu), texte révélé avec la clé du message : vérifié par le serveur.
  const lu = (await app.inject({ method: 'POST', url: '/suivi/messagerie/lire', payload: { jeton: anonyme.jeton, conversation: c2 } })).json();
  const recu = lu.messages.find((m: { de: string }) => m.de === 'verified');
  const sien = lu.messages.find((m: { de: string }) => m.de === 'witness');
  const signaler = (payload: object) => app.inject({ method: 'POST', url: '/suivi/messagerie/signaler', payload: { jeton: anonyme.jeton, conversation: c2, ...payload } });
  assert.equal((await signaler({ message: sien.id })).statusCode, 404);                          // pas son propre message
  assert.equal((await signaler({ message: recu.id, cle: Buffer.alloc(32, 7).toString('base64') })).json().erreur, 'cle_message_invalide');
  const cle = await cleDuMessage(recu.chiffre, c2, 'verified', anonyme.ouverte);
  assert.equal((await signaler({ message: recu.id, cle })).statusCode, 200);
  assert.equal((await signaler({ message: recu.id })).json().erreur, 'message_deja_signale');

  // Administration : le message signalé, avec son texte vérifié ; traité, conversation fermée.
  const admin = await compte(app, deps);
  proprietaire(`UPDATE core.accounts SET is_superadmin = false WHERE is_superadmin;
                UPDATE core.accounts SET is_superadmin = true WHERE id = '${admin.id}'`);
  const session = proprietaire(`SELECT id FROM core.sessions WHERE account_id = '${admin.id}' ORDER BY created_at DESC LIMIT 1`);
  proprietaire(`INSERT INTO core.admin_sessions (session_id) VALUES ('${session}') ON CONFLICT (session_id) DO UPDATE SET started_at = now(), last_at = now()`);
  const liste = (await app.inject({ method: 'GET', url: '/admin/messages-signales', headers: admin.headers })).json().messages;
  const x = liste.find((m: { message: string }) => m.message === recu.id);
  assert.equal(x.texte, 'Bonjour');
  assert.equal(x.de, 'compte');
  assert.equal((await app.inject({ method: 'POST', url: `/admin/messages-signales/${recu.id}/traiter`, headers: admin.headers, payload: { fermer: true } })).statusCode, 200);
  assert.equal(proprietaire(`SELECT closed_at IS NOT NULL FROM core.conversations WHERE id = '${c2}'`), 't');
  assert.ok(!(await app.inject({ method: 'GET', url: '/admin/messages-signales', headers: admin.headers })).json().messages
    .some((m: { message: string }) => m.message === recu.id));
  await app.close();
});

test('rattacher après coup un envoi anonyme : connecté, avec le code ; définitif ; messages lisibles par le compte', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const moi = await compte(app, deps);
  const cleMoi = await cleDeCompte(app, moi);
  const v = await videoSource('in_review');
  const rattacher = (headers: Record<string, string>, payload: object) => app.inject({ method: 'POST', url: '/suivi/rattacher', headers, payload });
  assert.equal((await rattacher({}, { jeton: v.jeton })).statusCode, 401);                                    // connecté seulement
  const faux = (await deriverSecrets(genererEntropie())).jetonSuivi;
  assert.equal((await rattacher(moi.headers, { jeton: faux })).statusCode, 404);
  const pourCompte = await cleVideoPourCompte(v.cle, v.entropie, cleMoi.publique);
  const r = await rattacher(moi.headers, { jeton: v.jeton, cleCopie: 'A'.repeat(43), pourCompte });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().video, v.id);
  // Dans « Mes vidéos », et la messagerie s'ouvre par la clé du compte.
  const mes = (await app.inject({ method: 'GET', url: '/compte/videos', headers: moi.headers })).json().videos;
  assert.ok(mes.some((x: { video: string }) => x.video === v.id));
  const etat = (await app.inject({ method: 'POST', url: '/suivi/messagerie', headers: moi.headers, payload: { video: v.id } })).json();
  assert.equal((await ouvrirCleVideoParCompte(etat.cle, cleMoi)).publique, v.cle.publique);
  // Définitif : ni un second rattachement, ni par un autre compte.
  assert.equal((await rattacher(moi.headers, { jeton: v.jeton })).json().erreur, 'deja_rattachee');
  const autre = await compte(app, deps);
  assert.equal((await rattacher(autre.headers, { jeton: v.jeton })).json().erreur, 'deja_rattachee');
  await app.close();
});

test('la source transmet l\'original à un compte vérifié : partage, retrait, téléchargement déchiffré, journal', async () => {
  const { deps, stockage } = dependances(socle);
  const app = construireApp(deps);
  const j = await compte(app, deps);
  verifier(j, 'lawyer');
  const cleJ = await cleDeCompte(app, j);
  const v = await videoSource();
  // L'original chiffré, comme à l'envoi.
  const clair = new Uint8Array(Buffer.concat([0, 1].map(() => Buffer.from(crypto.getRandomValues(new Uint8Array(30_000))))));
  const sha = Buffer.from(await crypto.subtle.digest('SHA-256', clair)).toString('hex');
  const morceaux: Uint8Array[] = [];
  const secV = await deriverSecrets(v.entropie);
  await chiffrerOriginal(lecteurOctets(clair), secV.cleOriginal, async (m) => { morceaux.push(m.octets); }, secV.cleEmpreinte, 16_384);
  const chemin = (stockage as unknown as { chemin(e: string, id: string): string }).chemin('originaux', v.id);
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, Buffer.concat(morceaux));
  proprietaire(`UPDATE core.videos SET original_sha256 = '\\x${sha}' WHERE id = '${v.id}';
                UPDATE core.pseudonyms SET contact_allowed = true WHERE video_id = '${v.id}'`);
  const conv = (await app.inject({ method: 'POST', url: `/messagerie/videos/${v.id}`, headers: j.headers })).json().conversation;
  const source = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, payload: { jeton: v.jeton, conversation: conv, ...payload } });

  // Pas encore partagé.
  assert.equal((await app.inject({ method: 'POST', url: `/messagerie/${conv}/original`, headers: j.headers })).statusCode, 404);
  const etat = (await app.inject({ method: 'POST', url: '/suivi/messagerie', payload: { jeton: v.jeton } })).json();
  assert.equal(etat.sha256Original, sha);
  const env = await partagerOriginal(await cleOriginalBrute(v.entropie), cleJ.publique, sha);
  assert.equal((await source('/suivi/messagerie/partager', { enveloppe: env })).statusCode, 200);
  // Retiré avant téléchargement : plus accessible ; partagé de nouveau.
  assert.equal((await source('/suivi/messagerie/partage/retirer')).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/messagerie/${conv}/original`, headers: j.headers })).statusCode, 404);
  assert.equal((await source('/suivi/messagerie/partager', { enveloppe: env })).statusCode, 200);
  assert.ok((await source('/suivi/messagerie/lire')).json().partage);

  // Le compte vérifié télécharge et déchiffre.
  const o = (await app.inject({ method: 'POST', url: `/messagerie/${conv}/original`, headers: j.headers })).json();
  assert.equal(o.sha256Original, sha);
  const fichier = await app.inject({ method: 'GET', url: o.lien, headers: j.headers });
  assert.equal(fichier.statusCode, 200);
  const cle = await ouvrirPartageOriginal(o.enveloppe, cleJ, sha);
  const sortie: Uint8Array[] = [];
  // Empreinte simple enregistrée (vidéo d'avant H10) : encore vérifiable.
  assert.ok((await dechiffrerOriginal(lecteurOctets(new Uint8Array(fichier.rawPayload)), cle, async (x) => { sortie.push(x); }, secV.cleEmpreinte)).correspond(sha));
  assert.deepEqual(Buffer.concat(sortie), Buffer.from(clair));
  // Transmission inscrite (une seule fois), plus de retrait possible ; un autre compte n'y a pas accès.
  await app.inject({ method: 'POST', url: `/messagerie/${conv}/original`, headers: j.headers });
  assert.equal(proprietaire(`SELECT count(*) FROM ledger.entries WHERE kind = 'original_shared' AND payload->>'video' = '${v.id}'`), '1');
  assert.equal(proprietaire(`SELECT recipient_kind FROM core.original_releases WHERE video_id = '${v.id}'`), 'lawyer');
  assert.equal((await source('/suivi/messagerie/partage/retirer')).json().erreur, 'deja_telecharge');
  const autre = await compte(app, deps);
  verifier(autre);
  assert.equal((await app.inject({ method: 'POST', url: `/messagerie/${conv}/original`, headers: autre.headers })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: o.lien, headers: autre.headers })).statusCode, 200);   // lien à usage court…
  await app.close();
});
