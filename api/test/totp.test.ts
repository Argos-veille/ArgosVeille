// TOTP : vecteurs de test officiels des normes (RFC 4226 annexe D, RFC 6238 annexe B).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base32, deBase32, hotp, lienOtpauth, nouveauSecret, totp, verifierTotp } from '../src/totp.ts';

const SECRET_RFC = Buffer.from('12345678901234567890');

test('HOTP : vecteurs de la RFC 4226', () => {
  const attendus = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  attendus.forEach((code, compteur) => assert.equal(hotp(SECRET_RFC, compteur), code, `compteur ${compteur}`));
});

test('TOTP : vecteurs de la RFC 6238 (SHA-1, 8 chiffres)', () => {
  const cas: [number, string][] = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ];
  for (const [secondes, code] of cas) assert.equal(totp(SECRET_RFC, secondes * 1000, 8), code, `t=${secondes}`);
});

test('base32 : aller-retour et vecteurs de la RFC 4648', () => {
  assert.equal(base32(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.deepEqual(deBase32('MZXW6YTBOI'), Buffer.from('foobar'));
  assert.deepEqual(deBase32('mzxw6ytboi'), Buffer.from('foobar'));
  const s = nouveauSecret();
  assert.match(s, /^[A-Z2-7]{32}$/);   // 160 bits
  assert.equal(deBase32(s).length, 20);
  assert.throws(() => deBase32('MZXW1'));
});

test('vérification : ±30 secondes tolérées, pas au-delà', () => {
  const secret = deBase32(nouveauSecret());
  const t = 1_800_000_000_000;
  assert.notEqual(verifierTotp(secret, totp(secret, t), t), null);
  assert.notEqual(verifierTotp(secret, totp(secret, t - 30_000), t), null);
  assert.notEqual(verifierTotp(secret, totp(secret, t + 30_000), t), null);
  assert.equal(verifierTotp(secret, totp(secret, t - 90_000), t), null);
  assert.equal(verifierTotp(secret, totp(secret, t + 90_000), t), null);
  for (const faux of ['', '12345', '1234567', 'abcdef', '12 345']) assert.equal(verifierTotp(secret, faux, t), null);
});

test('lien otpauth : émetteur Argos Veille, pseudo encodé', () => {
  assert.equal(lienOtpauth('MZXW6YTBOI', 'Héron.42'),
    'otpauth://totp/Argos%20Veille%3AH%C3%A9ron.42?secret=MZXW6YTBOI&issuer=Argos%20Veille&algorithm=SHA1&digits=6&period=30');
});
