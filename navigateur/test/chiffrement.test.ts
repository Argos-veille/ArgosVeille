import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { chiffrerOriginal, dechiffrerOriginal, tailleChiffree, TAILLE_ENTETE } from '../src/chiffrement.ts';
import { deriverSecrets } from '../src/derivation.ts';
import { lecteurOctets } from '../src/lecteur.ts';
import { genererEntropie } from '../src/phrase.ts';

const PETIT = 1024;   // petits morceaux pour tester les cas limites sans gros fichiers

// Clé d'empreinte de test (H10) : l'empreinte renvoyée est clée, jamais le SHA-256 simple du clair.
const CE = new Uint8Array(32).fill(7);

async function chiffrer(clair: Uint8Array, cle: CryptoKey) {
  const morceaux: { index: number; octets: Uint8Array; dernier: boolean }[] = [];
  const r = await chiffrerOriginal(lecteurOctets(clair), cle, async (m) => { morceaux.push(m); }, CE, PETIT);
  return { ...r, morceaux, fichier: Buffer.concat(morceaux.map((m) => m.octets)) };
}

async function dechiffrer(fichier: Uint8Array, cle: CryptoKey) {
  const parts: Uint8Array[] = [];
  const r = await dechiffrerOriginal(lecteurOctets(fichier), cle, async (c) => { parts.push(c); }, CE);
  return { ...r, clair: Buffer.concat(parts) };
}

test('aller-retour pour toutes les tailles limites, empreinte du clair exacte', async () => {
  const { cleOriginal } = await deriverSecrets(genererEntropie());
  for (const taille of [1, 15, PETIT - 1, PETIT, PETIT + 1, 3 * PETIT, 3 * PETIT + 7]) {
    const clair = randomBytes(taille);
    const c = await chiffrer(clair, cleOriginal);
    assert.equal(c.sha256, createHmac('sha256', CE).update(clair).digest('hex'), `taille ${taille}`);
    assert.equal(c.fichier.length, tailleChiffree(taille, PETIT));
    assert.equal(c.morceaux.at(-1)!.dernier, true);
    const d = await dechiffrer(c.fichier, cleOriginal);
    assert.deepEqual(d.clair, clair);
    assert.equal(d.sha256, c.sha256);
  }
});

test('le fichier chiffré ne contient rien du clair', async () => {
  const { cleOriginal } = await deriverSecrets(genererEntropie());
  const clair = Buffer.from('Visage de la victime, plaque AB-123-CD, rue de Rivoli. '.repeat(100));
  const c = await chiffrer(clair, cleOriginal);
  assert.ok(!c.fichier.includes(Buffer.from('plaque')));
  assert.ok(!c.fichier.includes(Buffer.from('Rivoli')));
});

test('falsifications détectées : octet modifié, morceau retiré, ajouté, échangé, fin coupée', async () => {
  const { cleOriginal } = await deriverSecrets(genererEntropie());
  const c = await chiffrer(randomBytes(4 * PETIT), cleOriginal);
  const pas = PETIT + 16;
  const m = (i: number) => c.fichier.subarray(TAILLE_ENTETE + i * pas, TAILLE_ENTETE + (i + 1) * pas);
  const entete = c.fichier.subarray(0, TAILLE_ENTETE);
  const cas: [string, Buffer][] = [
    ['octet modifié', (() => { const f = Buffer.from(c.fichier); f[TAILLE_ENTETE + 2 * pas + 5]! ^= 1; return f; })()],
    ['en-tête modifié', (() => { const f = Buffer.from(c.fichier); f[15]! ^= 1; return f; })()],
    ['dernier morceau retiré', Buffer.concat([entete, m(0), m(1), m(2)])],
    ['morceau du milieu retiré', Buffer.concat([entete, m(0), m(2), m(3)])],
    ['morceaux échangés', Buffer.concat([entete, m(1), m(0), m(2), m(3)])],
    ['morceau dupliqué', Buffer.concat([entete, m(0), m(1), m(2), m(3), m(3)])],
    ['fin coupée', c.fichier.subarray(0, c.fichier.length - 10)],
  ];
  for (const [nom, fichier] of cas) await assert.rejects(dechiffrer(fichier, cleOriginal), Error, nom);
});

test('mauvaise phrase : déchiffrement impossible', async () => {
  const a = await deriverSecrets(genererEntropie());
  const b = await deriverSecrets(genererEntropie());
  const c = await chiffrer(randomBytes(100), a.cleOriginal);
  await assert.rejects(dechiffrer(c.fichier, b.cleOriginal), /mauvaise phrase/);
});

test('deux chiffrements du même fichier diffèrent (nonce aléatoire), même empreinte du clair', async () => {
  const { cleOriginal } = await deriverSecrets(genererEntropie());
  const clair = randomBytes(2000);
  const x = await chiffrer(clair, cleOriginal);
  const y = await chiffrer(clair, cleOriginal);
  assert.notDeepEqual(x.fichier, y.fichier);
  assert.equal(x.sha256, y.sha256);
});

test('fichier vide, trop gros ou étranger refusés', async () => {
  const { cleOriginal } = await deriverSecrets(genererEntropie());
  await assert.rejects(chiffrerOriginal(lecteurOctets(new Uint8Array(0)), cleOriginal, async () => {}, CE), /vide/);
  const geant = { taille: 2 * 1024 ** 3 + 1, lire: async () => new Uint8Array(0) };
  await assert.rejects(chiffrerOriginal(geant, cleOriginal, async () => {}, CE), /trop volumineux/);
  await assert.rejects(dechiffrer(Buffer.from('pas du tout un fichier Argos, non non'), cleOriginal), /Argos/);
});
