// Tests d'attaques : charges classiques (injections SQL, XSS, gabarits, chemins, caractères de
// contrôle, Unicode piégé, types inattendus, pollution de prototype) envoyées dans CHAQUE champ de
// CHAQUE appel. Aucune ne doit faire planter l'API, être recopiée dans une réponse, ni abîmer la base.
// À compléter à chaque nouvel appel de l'API.
import { CONDITIONS_VERSION } from '../src/conditions.ts';
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import type { Pool } from 'pg';
import { construireApp } from '../src/app.ts';
import { genererCodes } from '../src/codes.ts';
import { hacherMotDePasse } from '../src/crypto.ts';
import { dependances, preparer } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

const CHARGES = [
  "' OR '1'='1",
  "'; DROP TABLE core.accounts; --",
  "1); DELETE FROM core.sessions; --",
  "admin'--",
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  'javascript:alert(1)',
  '${7*7}{{7*7}}<%= 7*7 %>',
  '../../../../etc/passwd',
  'abc\u0000def',
  '\r\nSet-Cookie: pirate=1',
  '‮gnp.exe',                      // inversion du sens d'écriture
  'Ａｄｍｉｎ',                           // lettres pleine chasse
  'a'.repeat(5000),
  '😀'.repeat(100),
];
const TYPES_INATTENDUS: unknown[] = [null, 42, true, [], ['x'], { $ne: null }, { toString: 'x' }];

function monter() {
  const { deps, facteur } = dependances(socle);
  return { app: construireApp(deps), deps, facteur };
}

function valide() {
  const n = randomInt(10_000_000, 100_000_000);
  return {
    pseudo: `Attaque_${n}`, motDePasse: 'cheval correct pile agrafe', telephone: `061${String(n).slice(1, 8)}`,
    mail: `attaque.${n}@proton.me`, turnstile: 'x', conditions: CONDITIONS_VERSION,
  };
}

const APPELS: { url: string; corps: () => Record<string, unknown> }[] = [
  { url: '/inscription/debut', corps: valide },
  { url: '/inscription/sms', corps: () => ({ inscription: '00000000-0000-4000-8000-000000000000', code: '123456' }) },
  { url: '/inscription/mail', corps: () => ({ jeton: 'A'.repeat(43) }) },
  { url: '/connexion', corps: () => ({ pseudo: 'Quelqu_un', motDePasse: 'cheval correct pile agrafe' }) },
  { url: '/recuperation/demande', corps: () => ({ mail: 'quelqu.un@proton.me', turnstile: 'x' }) },
  { url: '/recuperation/nouveau-mot-de-passe', corps: () => ({ jeton: 'A'.repeat(43), motDePasse: 'cheval correct pile agrafe' }) },
  { url: '/recuperation/code', corps: () => ({ pseudo: 'Quelqu_un', code: 'ABCDE-FGHJK', motDePasse: 'cheval correct pile agrafe' }) },
  { url: '/connexion/2fa', corps: () => ({ attente: 'A'.repeat(43), code: '123456' }) },
  { url: '/connexion/2fa/cle', corps: () => ({ attente: 'A'.repeat(43) }) },
  { url: '/suivi', corps: () => ({ jeton: 'A'.repeat(43) }) },
  { url: '/suivi/retirer', corps: () => ({ jeton: 'A'.repeat(43), confirmation: 'Héron-Ambre-4821' }) },
  { url: '/suivi/apercu', corps: () => ({ jeton: 'A'.repeat(43), qualite: 'apercu' }) },
  { url: '/suivi/masques', corps: () => ({ jeton: 'A'.repeat(43) }) },
  { url: '/suivi/valider', corps: () => ({ jeton: 'A'.repeat(43) }) },
  { url: '/suivi/retoucher', corps: () => ({ jeton: 'A'.repeat(43), cleCopie: 'A'.repeat(43), retirees: [], zones: [] }) },
  { url: '/envois/00000000-0000-4000-8000-000000000000/finaliser', corps: () => ({ cleCopie: 'A'.repeat(43) }) },
  { url: '/envois', corps: () => ({
    turnstile: 'x', conditions: CONDITIONS_VERSION, empreinteSuivi: randomBytes(32).toString('hex'), tailleOriginal: 1000, tailleCopie: 900,
    sha256Original: 'a'.repeat(64), schemaEmpreinte: 1, metadonnees: 'absentes',
    contexte: { date: '2026-11-03T14:12:00Z', lieu: { lat: 48.85, lon: 2.35 }, precision: 'exact', forces: 'unknown',
                situation: 'other', categorie: 'abuse', sousCategorie: 'other_abuse', description: 'Description d’essai, assez longue pour être acceptée.', langue: 'fr' },
  }) },
];

// Appels réservés aux relecteurs connectés : testés avec une vraie session (voir plus bas).
const APPELS_CONNECTES: { url: string; corps: () => Record<string, unknown> }[] = [
  { url: '/mot-de-passe', corps: () => ({ ancien: mdpActuel, nouveau: 'girafe bleue sous la pluie' }) },
  { url: '/codes-secours', corps: () => ({ motDePasse: mdpActuel }) },
  { url: '/2fa/totp/debut', corps: () => ({ motDePasse: mdpActuel }) },
  { url: '/2fa/totp/confirmer', corps: () => ({ code: '123456', nom: 'Téléphone' }) },
  { url: '/2fa/retirer', corps: () => ({ methode: '00000000-0000-4000-8000-000000000000', motDePasse: mdpActuel, code: '123456' }) },
  { url: '/2fa/cle/debut', corps: () => ({ motDePasse: mdpActuel }) },
  { url: '/2fa/cle/confirmer', corps: () => ({ reponse: { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: {} }, nom: 'Clé' }) },
  { url: '/compte/notifications', corps: () => ({ convocations: true }) },
  { url: '/relecture/00000000-0000-4000-8000-000000000000/video', corps: () => ({ qualite: 'complete' }) },
  { url: '/relecture/00000000-0000-4000-8000-000000000000/vote',
    corps: () => ({ verdict: 'oui', raisons: ['authentique'], visageIdentifiable: false }) },
  { url: '/admin/videos/00000000-0000-4000-8000-000000000000/decision',
    corps: () => ({ decision: 'publier', motif: 'Vidéo vérifiée par mes soins.', cle: { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: {} } }) },
];
let mdpActuel = 'cheval correct pile agrafe';

/** Un relecteur connecté : renvoie l'en-tête cookie de sa session. */
async function session(app: ReturnType<typeof construireApp>, deps: ReturnType<typeof dependances>['deps']) {
  const pseudo = `Attaque_Session_${randomInt(10_000_000, 100_000_000)}`;
  mdpActuel = 'cheval correct pile agrafe';
  await bases.identity.query('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8)',
    [pseudo, await hacherMotDePasse(mdpActuel), randomBytes(32), randomBytes(32), randomBytes(40),
     genererCodes(deps.cles).empreintes, '192.0.2.1', null]);
  const rep = await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo, motDePasse: mdpActuel } });
  return { cookie: String(rep.headers['set-cookie']).split(';')[0]! };
}

async function etatBase() {
  const r = await bases.app.query(`SELECT (SELECT count(*) FROM core.accounts)::int AS comptes,
                                          (SELECT count(*) FROM core.sessions)::int AS sessions`);
  return r.rows[0] as { comptes: number; sessions: number };
}

test('charges malveillantes dans chaque champ : refus propre, rien de recopié, base intacte', async () => {
  const { app } = monter();
  const avant = await etatBase();
  let essais = 0;
  for (const { url, corps } of APPELS) {
    for (const champ of Object.keys(corps())) {
      for (const charge of CHARGES) {
        await redis.flushdb();   // les limites de fréquence ne doivent pas masquer la validation
        const rep = await app.inject({ method: 'POST', url, payload: { ...corps(), [champ]: charge } });
        essais++;
        const lieu = `${url} ${champ} ${JSON.stringify(charge).slice(0, 40)}`;
        assert.ok(rep.statusCode < 500, `${lieu} : ${rep.statusCode} ${rep.body}`);
        assert.match(String(rep.headers['content-type']), /^application\/json/, lieu);
        assert.ok(typeof rep.json().erreur === 'string' || rep.statusCode < 300, lieu);
        // Une charge n'est jamais renvoyée telle quelle (pas de XSS réfléchi).
        if (charge.length > 3) assert.ok(!rep.body.includes(charge), `${lieu} recopiée : ${rep.body}`);
        // Les pseudos piégés ne passent jamais la validation.
        if (url === '/inscription/debut' && champ === 'pseudo') assert.equal(rep.statusCode, 400, lieu);
      }
    }
  }
  assert.equal(essais, 42 * CHARGES.length);   // 42 champs en tout dans les 17 appels publics
  const apres = await etatBase();
  assert.ok(apres.comptes >= avant.comptes && apres.sessions >= avant.sessions, 'des lignes ont disparu');
  await app.close();
});

test('charges malveillantes dans les appels réservés aux connectés', async () => {
  const { app, deps } = monter();
  const headers = await session(app, deps);
  for (const { url, corps } of APPELS_CONNECTES) {
    for (const champ of Object.keys(corps())) {
      for (const charge of CHARGES) {
        await redis.flushdb();
        const payload = { ...corps(), [champ]: charge };
        const rep = await app.inject({ method: 'POST', url, headers, payload });
        const lieu = `${url} ${champ} ${JSON.stringify(charge).slice(0, 40)}`;
        assert.ok(rep.statusCode < 500, `${lieu} : ${rep.statusCode} ${rep.body}`);
        if (charge.length > 3) assert.ok(!rep.body.includes(charge), `${lieu} recopiée`);
        // Une charge acceptée comme nouveau mot de passe (c'en est un valable) devient le mot de passe actuel.
        if (url === '/mot-de-passe' && rep.statusCode === 200) mdpActuel = String(payload['nouveau']);
      }
    }
  }
  // La session est toujours valable : aucune charge ne l'a cassée.
  assert.equal((await app.inject({ method: 'GET', url: '/moi', headers })).statusCode, 200);
  await app.close();
});

test("envoi : charges dans le contexte, l'en-tête du jeton de suivi et l'adresse des morceaux", async () => {
  const { app } = monter();
  const base = APPELS.find((a) => a.url === '/envois')!.corps();
  for (const charge of CHARGES) {
    await redis.flushdb();
    for (const champ of ['date', 'precision', 'forces', 'situation', 'categorie', 'sousCategorie', 'description', 'langue']) {
      const contexte = { ...(base['contexte'] as object), [champ]: charge };
      const rep = await app.inject({ method: 'POST', url: '/envois', payload: { ...base, contexte } });
      assert.ok(rep.statusCode < 500 && !(charge.length > 3 && rep.body.includes(charge)), `contexte.${champ} : ${rep.statusCode}`);
    }
    let jeton = charge;
    try { new Headers({ x: jeton }); } catch { jeton = encodeURIComponent(charge); }   // un en-tête ne peut pas tout contenir
    const morceau = await app.inject({ method: 'PUT', url: '/envois/00000000-0000-4000-8000-000000000000/original/0',
      payload: Buffer.from('x'), headers: { 'content-type': 'application/octet-stream', 'argos-suivi': jeton } });
    assert.ok([404].includes(morceau.statusCode), `en-tête argos-suivi : ${morceau.statusCode}`);
    const adresse = await app.inject({ method: 'PUT', url: `/envois/${encodeURIComponent(charge)}/original/${encodeURIComponent(charge)}`,
      payload: Buffer.from('x'), headers: { 'content-type': 'application/octet-stream' } });
    assert.ok([400, 404, 414].includes(adresse.statusCode) && !adresse.body.includes(charge.slice(0, 50)), `adresse : ${adresse.statusCode}`);   // 414 : adresse trop longue
    const apercu = await app.inject({ method: 'GET', url: `/apercu/${encodeURIComponent(charge)}`, headers: { range: jeton } });
    assert.ok([400, 404, 414].includes(apercu.statusCode) && !apercu.body.includes(charge), `aperçu : ${apercu.statusCode}`);
  }
  await app.close();
});

test('types inattendus (objets, tableaux, null, nombres) : refusés', async () => {
  const { app, deps } = monter();
  const headers = await session(app, deps);
  for (const { url, corps } of [...APPELS, ...APPELS_CONNECTES]) {
    for (const champ of Object.keys(corps())) {
      for (const valeur of TYPES_INATTENDUS) {
        const attendu = corps()[champ];
        if (typeof valeur === typeof attendu && typeof valeur !== 'object') continue;   // un nombre là où on attend un nombre
        if (Array.isArray(attendu) && Array.isArray(valeur) && valeur.length === 0) continue;   // liste vide : valable
        const rep = await app.inject({ method: 'POST', url, headers, payload: { ...corps(), [champ]: valeur } });
        assert.deepEqual([rep.statusCode, rep.json()], [400, { erreur: 'requete_invalide' }], `${url} ${champ} ${JSON.stringify(valeur)}`);
      }
    }
  }
  await app.close();
});

test('pollution de prototype : refusée, rien de modifié', async () => {
  const { app } = monter();
  for (const { url } of APPELS) {
    for (const piege of ['{"__proto__": {"pollue": true}}', '{"constructor": {"prototype": {"pollue": true}}}']) {
      const rep = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: piege });
      assert.equal(rep.statusCode, 400, `${url} ${piege}`);
    }
  }
  assert.equal(({} as Record<string, unknown>)['pollue'], undefined);
  await app.close();
});

test('corps mal formés : JSON cassé, mauvais format, trop gros, imbrication profonde', async () => {
  const { app } = monter();
  const cas: [Record<string, string>, string, number, string][] = [
    [{ 'content-type': 'application/json' }, '{"pseudo": ', 400, 'requete_invalide'],
    [{ 'content-type': 'text/plain' }, 'pseudo=x', 415, 'format_non_accepte'],
    [{ 'content-type': 'application/xml' }, '<a/>', 415, 'format_non_accepte'],
    [{ 'content-type': 'application/json' }, JSON.stringify({ x: 'a'.repeat(70_000) }), 413, 'trop_volumineux'],
    [{ 'content-type': 'application/json' }, '['.repeat(5000) + ']'.repeat(5000), 400, 'requete_invalide'],
  ];
  for (const [headers, payload, statut, erreur] of cas) {
    const rep = await app.inject({ method: 'POST', url: '/connexion', headers, payload });
    assert.deepEqual([rep.statusCode, rep.json()], [statut, { erreur }], payload.slice(0, 30));
  }
  await app.close();
});

test('en-têtes de sécurité sur toutes les réponses, y compris les erreurs', async () => {
  const { app } = monter();
  const reponses = [
    await app.inject({ method: 'GET', url: '/sante' }),
    await app.inject({ method: 'GET', url: '/inconnu' }),
    await app.inject({ method: 'GET', url: '/moi' }),
    await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo: 'x', motDePasse: 'y' } }),
    await app.inject({ method: 'POST', url: '/connexion', headers: { origin: 'https://ailleurs.example' }, payload: {} }),
  ];
  for (const r of reponses) {
    assert.equal(r.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(String(r.headers['strict-transport-security']), /^max-age=\d{8}/);
    assert.equal(r.headers['x-powered-by'], undefined);
    assert.equal(r.headers['server'], undefined);
  }
  await app.close();
});

test('panne interne : aucun détail technique dans la réponse', async () => {
  const { deps } = dependances(socle);
  const enPanne = {
    query: async () => { throw new Error('relation "core.secret_interne" n\'existe pas — mot de passe pg=xyz'); },
  } as unknown as Pool;
  const app = construireApp({ ...deps, bases: { ...deps.bases, app: enPanne } });
  const rep = await app.inject({ method: 'POST', url: '/connexion', payload: { pseudo: 'Quelqu_un', motDePasse: 'x'.repeat(12) } });
  assert.deepEqual([rep.statusCode, rep.json()], [500, { erreur: 'erreur_interne' }]);
  assert.ok(!rep.body.includes('secret_interne') && !rep.body.includes('pg=xyz'));
  await app.close();
});
