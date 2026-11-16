// Enveloppe de la clé de l'original pour l'administration (ECDH P-256).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { chiffrerOriginal, dechiffrerOriginal } from '../src/chiffrement.ts';
import { deriverSecrets } from '../src/derivation.ts';
import { cleEmpreinteOriginal } from '../src/empreinte.ts';
import { cleOriginalBrute, envelopper, ouvrirEnveloppe } from '../src/enveloppe.ts';
import { lecteurOctets } from '../src/lecteur.ts';
import { genererEntropie } from '../src/phrase.ts';

async function cleAdmin() {
  const paire = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publique = Buffer.from(await crypto.subtle.exportKey('raw', paire.publicKey)).toString('base64');
  return { privee: paire.privateKey, publique };
}

test('la clé brute est bien celle qui chiffre l’original, et l’enveloppe la rend à l’administration', async () => {
  const entropie = genererEntropie();
  const clair = new Uint8Array(5000).map((_, i) => i % 251);
  const morceaux: Uint8Array[] = [];
  const secrets = await deriverSecrets(entropie);
  const { sha256 } = await chiffrerOriginal(lecteurOctets(clair), secrets.cleOriginal,
    async (m) => { morceaux.push(m.octets); }, secrets.cleEmpreinte);
  // Empreinte clée (H10) : jamais le SHA-256 du clair, mais retrouvable par qui a la clé brute (l'enveloppe).
  assert.notEqual(sha256, createHash('sha256').update(clair).digest('hex'));

  const a = await cleAdmin();
  const secours = await cleAdmin();
  const e = await envelopper(await cleOriginalBrute(entropie), [a.publique, secours.publique], sha256);
  assert.equal(e.destinataires.length, 2);
  for (const k of [a, secours]) {
    const brute = await ouvrirEnveloppe(e, k.privee, k.publique, sha256);
    const cle = await crypto.subtle.importKey('raw', brute as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['decrypt']);
    const parts: Uint8Array[] = [];
    const d = await dechiffrerOriginal(lecteurOctets(Buffer.concat(morceaux)), cle, async (c) => { parts.push(c); }, cleEmpreinteOriginal(brute));
    assert.deepEqual(Buffer.concat(parts), Buffer.from(clair));
    assert.ok(d.correspond(sha256));
  }
});

test('enveloppe liée à sa vidéo et à sa clé : autre empreinte ou autre clé → refus', async () => {
  const a = await cleAdmin();
  const autre = await cleAdmin();
  const brute = await cleOriginalBrute(genererEntropie());
  const sha = 'ab'.repeat(32);
  const e = await envelopper(brute, [a.publique], sha);
  await assert.rejects(ouvrirEnveloppe(e, a.privee, a.publique, 'cd'.repeat(32)));
  await assert.rejects(ouvrirEnveloppe(e, autre.privee, autre.publique, sha), /aucune enveloppe/);
  await assert.rejects(envelopper(brute, ['AAAA'], sha), /invalide/);
});
