// Règles de saisie : téléphone, mail, pseudo, mot de passe, et primitives cryptographiques.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { chiffrer, dechiffrer, empreinte, hacherMotDePasse, verifierMotDePasse } from '../src/crypto.ts';
import { chargerListes } from '../src/listes.ts';
import { validerMotDePasse } from '../src/motdepasse.ts';
import { normaliserMail, normaliserTelephone, validerPseudo } from '../src/normalisation.ts';

const listes = chargerListes();

test('téléphone : mobiles de métropole et d\'outre-mer, au format international', () => {
  const cas: [string, string][] = [
    ['06 12 34 56 78', '+33612345678'],
    ['+33 6 12 34 56 78', '+33612345678'],
    ['0033612345678', '+33612345678'],
    ['0690 12 34 56', '+590690123456'],   // Guadeloupe
    ['0692 12 34 56', '+262692123456'],   // La Réunion
    ['+262 692 12 34 56', '+262692123456'],
    ['87 12 34 56', '+68987123456'],      // Polynésie française
  ];
  for (const [saisie, attendu] of cas) assert.deepEqual(normaliserTelephone(saisie), { ok: true, numero: attendu }, saisie);
});

test('téléphone : fixe, étranger et saisie invalide refusés', () => {
  assert.deepEqual(normaliserTelephone('01 23 45 67 89'), { ok: false, erreur: 'telephone_non_mobile' });
  assert.deepEqual(normaliserTelephone('+32 470 12 34 56'), { ok: false, erreur: 'telephone_pays' });
  assert.deepEqual(normaliserTelephone('12'), { ok: false, erreur: 'telephone_invalide' });
  assert.deepEqual(normaliserTelephone('bonjour'), { ok: false, erreur: 'telephone_invalide' });
});

test('mail : les variantes d\'une même boîte donnent la même forme canonique', () => {
  const formes = ['Jean.Dupont+1@gmail.com', 'jeandupont+2@GMAIL.com', 'j.e.a.n.dupont@googlemail.com', 'jeandupont@gmail.com']
    .map((m) => { const r = normaliserMail(m); assert.ok(r.ok, m); return r.canonique; });
  assert.equal(new Set(formes).size, 1);
  // Hors Gmail, les points comptent ; l'étiquette « + » est retirée partout.
  const a = normaliserMail('jean.dupont+argos@proton.me');
  const b = normaliserMail('jeandupont@proton.me');
  assert.ok(a.ok && b.ok);
  assert.equal(a.canonique, 'jean.dupont@proton.me');
  assert.notEqual(a.canonique, b.canonique);
  // L'adresse gardée pour écrire au relecteur reste celle saisie.
  assert.equal(a.adresse, 'jean.dupont+argos@proton.me');
});

test('mail : adresses invalides refusées', () => {
  for (const m of ['', 'sans-arobase', 'a@b', 'a b@c.fr', '+tag@gmail.com', 'a@-x.fr', `${'a'.repeat(65)}@x.fr`]) {
    assert.deepEqual(normaliserMail(m), { ok: false, erreur: 'mail_invalide' }, m);
  }
});

test('pseudo : forme valide, accents acceptés', () => {
  for (const p of ['Corbeau', 'Héron.Ambré-42', 'abc', 'x_y-z.0']) assert.ok(validerPseudo(p, listes.pseudosInterdits).ok, p);
  for (const p of ['ab', 'a'.repeat(31), 'avec espace', '<b>', 'emoji😀', 'Аdmin_cyrillique', 'Ωmega', '١٢٣abc']) {
    assert.deepEqual(validerPseudo(p, listes.pseudosInterdits), { ok: false, erreur: 'pseudo_invalide' }, p);
  }
});

test('pseudo : les lettres pleine chasse sont ramenées à la normale', () => {
  assert.deepEqual(validerPseudo('Ｃｏｒｂｅａｕ', listes.pseudosInterdits), { ok: true, pseudo: 'Corbeau' });
});

test('pseudo : mots interdits, même déguisés, sans faux positifs', () => {
  for (const p of ['Admin', 'Le_Vrai_Argos', 'Modérateur', 'C0nnard', 'pute_75', 'N1QUE', 'h1tl3r', 'Ａｄｍｉｎ']) {
    assert.deepEqual(validerPseudo(p, listes.pseudosInterdits), { ok: false, erreur: 'pseudo_interdit' }, p);
  }
  for (const p of ['Computer', 'Technique', 'Unique.42', 'Speedy', 'Reputation']) {
    assert.ok(validerPseudo(p, listes.pseudosInterdits).ok, p);
  }
});

test('mot de passe : 12 caractères, ni courant, ni répétitif, ni le pseudo', () => {
  const v = (m: string) => validerMotDePasse(m, 'Corbeau', listes.motsDePasseCourants);
  assert.deepEqual(v('court'), { ok: false, erreur: 'mdp_trop_court' });
  assert.deepEqual(v('a'.repeat(129)), { ok: false, erreur: 'mdp_trop_long' });
  assert.deepEqual(v('ironmaiden123'), { ok: false, erreur: 'mdp_courant' });
  assert.deepEqual(v('IronMaiden123'), { ok: false, erreur: 'mdp_courant' });   // insensible à la casse
  assert.deepEqual(v('abababababab'), { ok: false, erreur: 'mdp_repetitif' });
  assert.deepEqual(v('corbeau-mon-mot-2026'), { ok: false, erreur: 'mdp_contient_pseudo' });
  assert.deepEqual(v('cheval correct pile agrafe'), { ok: true });   // une phrase suffit, sans symbole imposé
  assert.ok(listes.motsDePasseCourants.size > 30_000);
});

test('Argon2id : empreinte au format PHC, vérification', async () => {
  const h = await hacherMotDePasse('cheval correct pile agrafe');
  assert.match(h, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.ok(await verifierMotDePasse('cheval correct pile agrafe', h));
  assert.ok(!(await verifierMotDePasse('cheval correct pile agrafE', h)));
  assert.ok(!(await verifierMotDePasse('x', 'pas une empreinte')));
  assert.notEqual(h, await hacherMotDePasse('cheval correct pile agrafe'));   // sel aléatoire
});

test('chiffrement des mails : aller-retour, falsification détectée', () => {
  const cles = { hmac: randomBytes(32), mail: randomBytes(32), mfa: randomBytes(32) };
  const c = chiffrer(cles, 'jean.dupont@proton.me');
  assert.equal(dechiffrer(cles, c), 'jean.dupont@proton.me');
  assert.notDeepEqual(c, chiffrer(cles, 'jean.dupont@proton.me'));   // nonce aléatoire
  c[14]! ^= 1;
  assert.throws(() => dechiffrer(cles, c));
});

test('empreintes HMAC séparées par domaine et par clé', () => {
  const k1 = { hmac: randomBytes(32), mail: randomBytes(32), mfa: randomBytes(32) };
  const k2 = { hmac: randomBytes(32), mail: randomBytes(32), mfa: randomBytes(32) };
  assert.deepEqual(empreinte(k1, 'tel', 'x'), empreinte(k1, 'tel', 'x'));
  assert.notDeepEqual(empreinte(k1, 'tel', 'x'), empreinte(k1, 'mail', 'x'));
  assert.notDeepEqual(empreinte(k1, 'tel', 'x'), empreinte(k2, 'tel', 'x'));
});
