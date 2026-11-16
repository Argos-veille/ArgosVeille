// Crée le compte du super-administrateur (un seul possible sur le site).
//   node --env-file=.env --import tsx scripts/creer-super-admin.ts <pseudo> <adresse mail>
// Le pseudo n'est pas soumis au filtre des inscriptions (qui refuse « argos » et « admin »). Un mot de
// passe temporaire est affiché UNE fois, avec les codes de secours : à changer dans « Mon compte »,
// puis y enregistrer la clé physique (YubiKey), exigée pour ouvrir l'administration.
// Le statut de super-administrateur est posé par le propriétaire de la base (le site n'en a pas le droit).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { genererCodes } from '../src/codes.ts';
import { lireConfig } from '../src/config.ts';
import { chiffrer, empreinte, hacherMotDePasse, lireCle } from '../src/crypto.ts';
import { ouvrirBases } from '../src/db.ts';
import { normaliserMail } from '../src/normalisation.ts';

const [pseudo, saisie] = process.argv.slice(2);
const mail = normaliserMail(saisie ?? '');
if (!pseudo || !/^[A-Za-z0-9._-]{3,30}$/.test(pseudo) || !mail.ok) {
  console.error('usage : creer-super-admin.ts <pseudo> <adresse mail>');
  process.exit(2);
}
const config = lireConfig();
const cles = { hmac: lireCle(config.cles.hmacFichier), mail: lireCle(config.cles.mailFichier), mfa: lireCle(config.cles.mfaFichier) };
const bases = ouvrirBases(config);

function proprietaire(requete: string): string {
  const script = 'import sys; sys.path.insert(0, sys.argv[1]); import migrate; '
    + 'r = migrate.psql(sys.argv[2], sys.argv[3]); sys.stderr.write(r.stderr); print(r.stdout.strip()); sys.exit(r.returncode)';
  return execFileSync('python3', ['-c', script, fileURLToPath(new URL('../../db', import.meta.url)), config.pg.database, requete],
                      { encoding: 'utf8' }).trim();
}

try {
  if ((await bases.app.query('SELECT 1 FROM core.accounts WHERE is_superadmin')).rowCount) {
    throw new Error('un super-administrateur existe déjà');
  }
  if ((await bases.app.query('SELECT 1 FROM core.accounts WHERE lower(username) = lower($1)', [pseudo])).rowCount) {
    throw new Error(`le pseudo ${pseudo} est déjà pris`);
  }
  const motDePasse = randomBytes(15).toString('base64url');   // 20 caractères
  const { codes, empreintes } = genererCodes(cles);
  // Pas de numéro de téléphone : une empreinte aléatoire, qui ne correspond à aucun numéro.
  const r = await bases.identity.query<{ id: string }>('SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
    [pseudo, await hacherMotDePasse(motDePasse), randomBytes(32), empreinte(cles, 'mail', mail.canonique),
     chiffrer(cles, mail.adresse), empreintes, '127.0.0.1', null]);
  const id = r.rows[0]!.id;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('identifiant inattendu');
  proprietaire(`UPDATE core.accounts SET is_superadmin = true WHERE id = '${id}'`);
  console.log(`${pseudo} : super-administrateur créé (id ${id})`);
  console.log(`  mot de passe temporaire : ${motDePasse}`);
  console.log(`  codes de secours : ${codes.join(' ')}`);
  console.log('  → connexion, puis « Mon compte » : changer le mot de passe et enregistrer la clé physique.');
} finally {
  await bases.fermer();
}
