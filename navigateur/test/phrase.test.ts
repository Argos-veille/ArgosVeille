import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriverSecrets } from '../src/derivation.ts';
import { MOTS } from '../src/mots-fr.ts';
import { genererEntropie, lirePhrase, phraseDepuisEntropie, sansAccents } from '../src/phrase.ts';

test('liste de mots : 2048 mots NFC, distincts sans accents et dès 4 lettres', () => {
  assert.equal(MOTS.length, 2048);
  assert.ok(MOTS.every((m) => m === m.normalize('NFC')));
  assert.equal(new Set(MOTS.map(sansAccents)).size, 2048);
  assert.equal(new Set(MOTS.map((m) => sansAccents(m).slice(0, 4))).size, 2048);
});

test('vecteur BIP39 : 16 octets nuls → « abaisser » ×11 + « abeille » (index 3, comme « about » en anglais)', async () => {
  const mots = await phraseDepuisEntropie(new Uint8Array(16));
  assert.deepEqual(mots, [...Array(11).fill('abaisser'), 'abeille']);
});

test('aller-retour : 200 phrases aléatoires relues à l\'identique', async () => {
  for (let i = 0; i < 200; i++) {
    const e = genererEntropie();
    const mots = await phraseDepuisEntropie(e);
    const r = await lirePhrase(mots.join(' '));
    assert.ok(r.ok);
    assert.deepEqual(r.entropie, e);
  }
});

test('saisie tolérante : majuscules, sans accents, abréviations à 4 lettres, séparateurs variés', async () => {
  const e = genererEntropie();
  const mots = await phraseDepuisEntropie(e);
  for (const saisie of [
    mots.join(' ').toUpperCase(),
    mots.map(sansAccents).join('-'),
    mots.map((m) => sansAccents(m).slice(0, 4)).join('  '),
    `  ${mots.join(',\n')}  `,
  ]) {
    const r = await lirePhrase(saisie);
    assert.ok(r.ok, saisie);
    assert.deepEqual(r.entropie, e);
    assert.deepEqual(r.mots, mots);   // les mots complets, accents compris, pour l'affichage
  }
});

test('erreurs de saisie détectées : nombre de mots, mot inconnu, mots inversés (contrôle)', async () => {
  const mots = await phraseDepuisEntropie(genererEntropie());
  assert.deepEqual(await lirePhrase(mots.slice(0, 11).join(' ')), { ok: false, erreur: 'nombre_de_mots', nombre: 11 });
  assert.deepEqual(await lirePhrase([...mots.slice(0, 4), 'chaussette', ...mots.slice(5)].join(' ')),
                   { ok: false, erreur: 'mot_inconnu', position: 5 });
  // Une faute qui tombe sur un autre mot valide est presque toujours attrapée par le contrôle (15 chances sur 16).
  let detectees = 0;
  for (let i = 0; i < 64; i++) {
    const m = await phraseDepuisEntropie(genererEntropie());
    const faute = [...m];
    faute[3] = MOTS[(MOTS.indexOf(m[3]!) + 1) % 2048]!;
    if (!(await lirePhrase(faute.join(' '))).ok) detectees++;
  }
  assert.ok(detectees >= 48, `${detectees}/64 fautes détectées`);
});

test('dérivation : déterministe, deux secrets indépendants, clé non exportable', async () => {
  const e = new Uint8Array(16).fill(7);
  const a = await deriverSecrets(e);
  const b = await deriverSecrets(e);
  assert.equal(a.jetonSuivi, b.jetonSuivi);
  assert.match(a.jetonSuivi, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.empreinteSuivi, /^[0-9a-f]{64}$/);
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(Buffer.from(a.jetonSuivi, 'base64url')).digest('hex'), a.empreinteSuivi);
  await assert.rejects(crypto.subtle.exportKey('raw', a.cleOriginal));
  const autre = await deriverSecrets(new Uint8Array(16).fill(8));
  assert.notEqual(autre.jetonSuivi, a.jetonSuivi);
  // Clé de copie : déterministe, distincte du jeton, de 32 octets.
  assert.equal(a.cleCopie, b.cleCopie);
  assert.match(a.cleCopie, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.cleCopie, a.jetonSuivi);
  assert.notEqual(a.cleCopie, autre.cleCopie);
  // La même phrase chiffre et déchiffre : la clé dérivée deux fois est la même.
  const iv = new Uint8Array(12);
  const c = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a.cleOriginal, new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b.cleOriginal, c)), new Uint8Array([1, 2, 3]));
});
