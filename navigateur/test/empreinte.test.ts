// Empreinte clée de l'original (H10) : vecteur commun au navigateur, au worker et à ouvrir-original.py (même valeurs,
// calculées indépendamment avec hmac/hashlib de Python), pour qu'une divergence d'encodage ne passe pas inaperçue.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { calculEmpreinte, chiffrerOriginal, cleEmpreinteOriginal, cleOriginalBrute, creerCleCompte, dechiffrerOriginal, deriverSecrets, entropieVideo, lecteurBlob, ouvrirPartageOriginalAvecEmpreinte, partagerOriginal, verificationEmpreinte } from '../src/index.ts';

export const VECTEUR = {
  cleBrute: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
  cleEmpreinte: '9301c2416686e1b2b9b43d31a6e26949ad3c453942919808a0ba5a1dfbeb145d',
  contenu: new TextEncoder().encode('contenu de la video'.repeat(1000)),
  empreinte: 'd428d0f532ba0f438322421e811aecffbdde41b9cc38377e6f8c668447d0615e',
};

test('vecteur commun : clé d’empreinte et empreinte clée', () => {
  const ce = cleEmpreinteOriginal(VECTEUR.cleBrute);
  assert.equal([...ce].map((o) => o.toString(16).padStart(2, '0')).join(''), VECTEUR.cleEmpreinte);
  const h = calculEmpreinte(ce);
  // En plusieurs morceaux : même résultat qu'en un seul.
  h.update(VECTEUR.contenu.slice(0, 7000)); h.update(VECTEUR.contenu.slice(7000));
  assert.equal(h.hex(), VECTEUR.empreinte);
});

test('chiffrer puis déchiffrer : même empreinte clée, différente du SHA-256 simple et propre à chaque envoi', async () => {
  const a = await deriverSecrets(new Uint8Array(16).fill(1));
  const b = await deriverSecrets(new Uint8Array(16).fill(2));
  const fichier = new Blob([VECTEUR.contenu]);
  const morceaux: Uint8Array[] = [];
  const c = await chiffrerOriginal(lecteurBlob(fichier), a.cleOriginal, async (m) => { morceaux.push(m.octets); }, a.cleEmpreinte, 4096);
  const d = await dechiffrerOriginal(lecteurBlob(new Blob(morceaux as BlobPart[])), a.cleOriginal, async () => {}, a.cleEmpreinte);
  assert.equal(d.sha256, c.sha256);
  assert.ok(d.correspond(c.sha256));
  assert.notEqual(c.sha256, createHash('sha256').update(VECTEUR.contenu).digest('hex'));   // jamais le SHA-256 du clair
  const autre = calculEmpreinte(b.cleEmpreinte); autre.update(VECTEUR.contenu);
  assert.notEqual(c.sha256, autre.hex());    // un autre code : une autre empreinte pour le même fichier
});

test('relecteurs : clé de dérivation identique à celle de l’enveloppe, clé obligatoire, vidéos d’un même code distinctes', async () => {
  const code = new Uint8Array(16).fill(9);
  const s = await deriverSecrets(code);
  assert.deepEqual(s.cleEmpreinte, cleEmpreinteOriginal(await cleOriginalBrute(code)));
  // Clé absente ou mal formée : erreur, jamais de repli silencieux sur le SHA-256 simple.
  assert.throws(() => calculEmpreinte(undefined as unknown as Uint8Array), /32 octets/);
  assert.throws(() => calculEmpreinte(new Uint8Array(16)), /32 octets/);
  const v1 = await deriverSecrets(await entropieVideo(code, 1));
  assert.notDeepEqual(s.cleEmpreinte, v1.cleEmpreinte);   // deux vidéos d'un même code : deux clés
});

test('vidéo d’avant H10 : la vérification accepte encore le SHA-256 simple (schéma 0), sans jamais le renvoyer', () => {
  const v = verificationEmpreinte(new Uint8Array(32).fill(3));
  v.update(VECTEUR.contenu);
  const simple = createHash('sha256').update(VECTEUR.contenu).digest('hex');
  assert.ok(v.correspond(simple));
  assert.notEqual(v.empreinte(), simple);
  assert.ok(!v.correspond('0'.repeat(64)));
});

test('aller-retour partage → ouverture avec empreinte → déchiffrement vérifié', async () => {
  const code = new Uint8Array(16).fill(5);
  const s = await deriverSecrets(code);
  const morceaux: Uint8Array[] = [];
  const c = await chiffrerOriginal(lecteurBlob(new Blob([VECTEUR.contenu])), s.cleOriginal, async (m) => { morceaux.push(m.octets); }, s.cleEmpreinte, 4096);
  const compte = await creerCleCompte('mot de passe du journaliste', 100_000);
  const partage = await partagerOriginal(await cleOriginalBrute(code), compte.stockee.publique, c.sha256);
  const o = await ouvrirPartageOriginalAvecEmpreinte(partage, compte.ouverte, c.sha256);
  const d = await dechiffrerOriginal(lecteurBlob(new Blob(morceaux as BlobPart[])), o.cle, async () => {}, o.cleEmpreinte);
  assert.ok(d.correspond(c.sha256));
});
