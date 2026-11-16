// Messagerie avec les sources : clés (mot de passe, 12 mots, compte) et messages chiffrés de bout en bout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { empreinteLongue, expediteurVerifie, chiffrerMessage, clePubliqueValable, cleVideoPourCompte, ouvrirPartageOriginal, partagerOriginal, creerCleCompte, creerCleVideo, dechiffrerMessage, ouvrirCleCompte,
         ouvrirCleVideoParCompte, ouvrirCleVideoParPhrase, rechiffrerCleCompte } from '../src/messagerie.ts';
import { genererEntropie } from '../src/phrase.ts';

const IT = 1000;   // itérations réduites pour la vitesse des tests (600 000 en vrai)

test('clé de compte : ouverte avec le bon mot de passe seulement, rechiffrée au changement', async () => {
  const { stockee, ouverte } = await creerCleCompte('cheval correct pile agrafe', IT);
  assert.ok(await clePubliqueValable(stockee.publique));
  assert.equal((await ouvrirCleCompte(stockee, 'cheval correct pile agrafe')).publique, ouverte.publique);
  await assert.rejects(ouvrirCleCompte(stockee, 'mauvais mot de passe'), /mot_de_passe_incorrect/);
  const nouvelle = await rechiffrerCleCompte(stockee, 'cheval correct pile agrafe', 'autre phrase de passe longue', IT);
  assert.equal(nouvelle.publique, stockee.publique);   // même paire : les anciens messages restent lisibles
  await assert.rejects(ouvrirCleCompte(nouvelle, 'cheval correct pile agrafe'), /mot_de_passe_incorrect/);
  await assert.rejects(rechiffrerCleCompte(stockee, 'faux', 'x', IT), /mot_de_passe_incorrect/);
  // Partie privée recollée sur une autre clé publique : refusée.
  const autre = await creerCleCompte('cheval correct pile agrafe', IT);
  await assert.rejects(ouvrirCleCompte({ ...stockee, publique: autre.stockee.publique }, 'cheval correct pile agrafe'));
});

test('clé de vidéo : ouverte avec les 12 mots, et avec la clé du compte pour un envoi avec compte', async () => {
  const entropie = genererEntropie();
  const compte = await creerCleCompte('cheval correct pile agrafe', IT);
  const anonyme = await creerCleVideo(entropie);
  assert.equal(anonyme.pourCompte, undefined);
  assert.equal((await ouvrirCleVideoParPhrase(anonyme, entropie)).publique, anonyme.publique);
  await assert.rejects(ouvrirCleVideoParPhrase(anonyme, genererEntropie()), /code_incorrect/);
  const avecCompte = await creerCleVideo(entropie, compte.stockee.publique);
  assert.equal((await ouvrirCleVideoParCompte(avecCompte, compte.ouverte)).publique, avecCompte.publique);
  assert.equal((await ouvrirCleVideoParPhrase(avecCompte, entropie)).publique, avecCompte.publique);
  const intrus = await creerCleCompte('autre phrase de passe longue', IT);
  await assert.rejects(ouvrirCleVideoParCompte(avecCompte, intrus.ouverte));
  await assert.rejects(ouvrirCleVideoParCompte(anonyme, compte.ouverte), /pas_de_cle_pour_le_compte/);
});

test('message : lisible par les deux parties seulement, lié à sa conversation et à son expéditeur', async () => {
  const entropie = genererEntropie();
  const source = await ouvrirCleVideoParPhrase(await creerCleVideo(entropie), entropie);
  const journaliste = (await creerCleCompte('cheval correct pile agrafe', IT)).ouverte;
  const tiers = (await creerCleCompte('autre phrase de passe longue', IT)).ouverte;
  const conv = crypto.randomUUID();
  const m = await chiffrerMessage('  Bonjour, accepteriez-vous de témoigner ?  ', conv, 'verified', [journaliste.publique, source.publique]);
  assert.equal(m.destinataires.length, 2);
  assert.equal(await dechiffrerMessage(m, conv, 'verified', source), 'Bonjour, accepteriez-vous de témoigner ?');
  assert.equal(await dechiffrerMessage(m, conv, 'verified', journaliste), 'Bonjour, accepteriez-vous de témoigner ?');
  await assert.rejects(dechiffrerMessage(m, conv, 'verified', tiers), /message_pas_pour_moi/);
  await assert.rejects(dechiffrerMessage(m, crypto.randomUUID(), 'verified', source));   // déplacé dans une autre conversation
  await assert.rejects(dechiffrerMessage(m, conv, 'witness', source));                   // expéditeur changé
  const altere = { ...m, texte: Buffer.from(Buffer.from(m.texte, 'base64').map((o, i) => (i === 3 ? o ^ 1 : o))).toString('base64') };
  await assert.rejects(dechiffrerMessage(altere, conv, 'verified', source));
  await assert.rejects(chiffrerMessage('   ', conv, 'witness', [source.publique]), /message_vide/);
  await assert.rejects(chiffrerMessage('x'.repeat(4001), conv, 'witness', [source.publique]), /message_trop_long/);
  assert.equal(await clePubliqueValable('AAAA'), false);
});

test('N2 : preuve de l\'expéditeur, vérifiable par les deux parties seulement, impossible à fabriquer pour un tiers', async () => {
  const conv = '7f4c1c2e-6b1a-4d2f-9a3e-1c2b3d4e5f60';
  const source = (await creerCleCompte('cheval correct pile agrafe', IT)).ouverte;
  const journaliste = (await creerCleCompte('cheval correct pile agrafe', IT)).ouverte;
  const serveur = (await creerCleCompte('autre phrase de passe longue', IT)).ouverte;
  const m = await chiffrerMessage('Bonjour', conv, 'verified', [journaliste.publique, source.publique],
                                  { moi: journaliste, autre: source.publique });
  assert.equal(m.v, 2);
  assert.equal(await expediteurVerifie(m, conv, 'verified', source, journaliste.publique), true);
  assert.equal(await expediteurVerifie(m, conv, 'verified', journaliste, source.publique), true);
  // Le serveur (qui connaît les deux clés publiques) fabrique un message « du journaliste » : refusé.
  const faux = await chiffrerMessage('Envoyez-moi l\'original', conv, 'verified', [journaliste.publique, source.publique],
                                     { moi: serveur, autre: source.publique });
  assert.equal(await expediteurVerifie(faux, conv, 'verified', source, journaliste.publique), false);
  // Modifié, déplacé vers une autre conversation, ou attribué à l'autre partie : refusé.
  assert.equal(await expediteurVerifie({ ...m, texte: faux.texte }, conv, 'verified', source, journaliste.publique), false);
  assert.equal(await expediteurVerifie(m, '00000000-0000-4000-8000-000000000000', 'verified', source, journaliste.publique), false);
  assert.equal(await expediteurVerifie(m, conv, 'witness', source, journaliste.publique), false);
  // Message d'avant la preuve : lisible, mais « non vérifié ».
  const ancien = await chiffrerMessage('Ancien', conv, 'verified', [journaliste.publique, source.publique]);
  assert.equal(ancien.v, 1);
  assert.equal(await expediteurVerifie(ancien, conv, 'verified', source, journaliste.publique), false);
  assert.equal((await empreinteLongue(source.publique)).length, 32);
});

test('rattachement après coup : la clé de la vidéo, ouverte par les 12 mots, est chiffrée pour le compte', async () => {
  const entropie = genererEntropie();
  const cle = await creerCleVideo(entropie);
  const compte = await creerCleCompte('cheval correct pile agrafe', IT);
  const pourCompte = await cleVideoPourCompte(cle, entropie, compte.stockee.publique);
  assert.equal((await ouvrirCleVideoParCompte({ ...cle, pourCompte }, compte.ouverte)).publique, cle.publique);
  await assert.rejects(cleVideoPourCompte(cle, genererEntropie(), compte.stockee.publique), /code_incorrect/);
});

test('partage de l\'original : la clé, ouverte par le compte vérifié seulement, liée à l\'empreinte de cet original', async () => {
  const { cleOriginalBrute } = await import('../src/enveloppe.ts');
  const { chiffrerOriginal, dechiffrerOriginal } = await import('../src/chiffrement.ts');
  const { deriverSecrets } = await import('../src/derivation.ts');
  const { lecteurOctets } = await import('../src/lecteur.ts');
  const entropie = genererEntropie();
  const clair = new Uint8Array(Buffer.concat([0, 1].map(() => Buffer.from(crypto.getRandomValues(new Uint8Array(35_000))))));
  const sha = Buffer.from(await crypto.subtle.digest('SHA-256', clair)).toString('hex');
  const morceaux: Uint8Array[] = [];
  const sec = await deriverSecrets(entropie);
  await chiffrerOriginal(lecteurOctets(clair), sec.cleOriginal, async (m) => { morceaux.push(m.octets); }, sec.cleEmpreinte, 16_384);
  const chiffre = Buffer.concat(morceaux);
  const journaliste = await creerCleCompte('cheval correct pile agrafe', IT);
  const env = await partagerOriginal(await cleOriginalBrute(entropie), journaliste.stockee.publique, sha);
  const cle = await ouvrirPartageOriginal(env, journaliste.ouverte, sha);
  const sortie: Uint8Array[] = [];
  const r = await dechiffrerOriginal(lecteurOctets(chiffre), cle, async (o) => { sortie.push(o); }, sec.cleEmpreinte);
  assert.ok(r.correspond(sha));   // vidéo d'avant H10 (SHA-256 simple) : encore vérifiable
  assert.deepEqual(Buffer.concat(sortie), Buffer.from(clair));
  await assert.rejects(ouvrirPartageOriginal(env, journaliste.ouverte, 'a'.repeat(64)));   // autre original
  const intrus = await creerCleCompte('autre phrase de passe longue', IT);
  await assert.rejects(ouvrirPartageOriginal(env, intrus.ouverte, sha));
});
