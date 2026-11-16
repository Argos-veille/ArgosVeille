// Données de démonstration pour la base de DÉVELOPPEMENT (jamais en production).
//   node --env-file=.env --import tsx scripts/demo.ts
// Crée des comptes de test (s'ils n'existent pas), avec leurs codes de secours affichés une fois.
// Les vidéos de démo (mires générées, jamais de vraies images) sont ajoutées par db/demo.py, qui
// appelle ce script en premier.
import { lireConfig } from '../src/config.ts';
import { genererCodes } from '../src/codes.ts';
import { chiffrer, empreinte, hacherMotDePasse, lireCle } from '../src/crypto.ts';
import { ouvrirBases } from '../src/db.ts';

const config = lireConfig();
if (process.env['NODE_ENV'] === 'production' || config.facteur !== 'fichier' || !/_dev$/.test(config.pg.database)) {
  throw new Error('données de démo : base de développement seulement (argos_dev)');
}
const cles = { hmac: lireCle(config.cles.hmacFichier), mail: lireCle(config.cles.mailFichier), mfa: lireCle(config.cles.mfaFichier) };
const bases = ouvrirBases(config);

const COMPTES = [
  { pseudo: 'demo_relecteur', motDePasse: 'demo argos relecteur', telephone: '+33600000001', mail: 'relecteur@demo.argos.invalid' },
  { pseudo: 'demo_analyste', motDePasse: 'demo argos analyste osint', telephone: '+33600000002', mail: 'analyste@demo.argos.invalid' },
];

try {
  for (const c of COMPTES) {
    const deja = await bases.app.query('SELECT 1 FROM core.accounts WHERE lower(username) = lower($1)', [c.pseudo]);
    if (deja.rowCount) {
      console.log(`${c.pseudo} : existe déjà (mot de passe : « ${c.motDePasse} »)`);
      continue;
    }
    const { codes, empreintes } = genererCodes(cles);
    const r = await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
      [c.pseudo, await hacherMotDePasse(c.motDePasse), empreinte(cles, 'tel', c.telephone), empreinte(cles, 'mail', c.mail),
       chiffrer(cles, c.mail), empreintes, '127.0.0.1', null]);
    console.log(`${c.pseudo} : créé (id ${r.rows[0]!.id})`);
    console.log(`  mot de passe : « ${c.motDePasse} »`);
    console.log(`  codes de secours : ${codes.join(' ')}`);
  }
} finally {
  await bases.fermer();
}
