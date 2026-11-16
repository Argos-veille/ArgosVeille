// Envoi d'un mail d'essai réel par SMTP, pour vérifier les réglages d'Infomaniak.
//   node --import tsx scripts/essai-mail.ts <adresse de destination>
// Lit les réglages ARGOS_SMTP_* dans l'environnement et le mot de passe dans le fichier indiqué par
// ARGOS_SMTP_MOT_DE_PASSE_FICHIER (à créer soi-même, droits 600, jamais dans le dépôt).
import { readFileSync, statSync } from 'node:fs';
import { FacteurMail } from '../src/facteur.ts';

const [adresse] = process.argv.slice(2);
const env = (cle: string, defaut?: string) => {
  const v = process.env[cle] ?? defaut;
  if (!v) throw new Error(`réglage manquant : ${cle}`);
  return v;
};
if (!adresse || !/^[^@\s]+@[^@\s]+$/.test(adresse)) {
  console.error('usage : essai-mail.ts <adresse>');
  process.exit(2);
}
const fichier = env('ARGOS_SMTP_MOT_DE_PASSE_FICHIER', '.secrets/smtp');
if ((statSync(fichier).mode & 0o077) !== 0) throw new Error(`${fichier} doit être lisible par vous seul (chmod 600)`);
const mails = new FacteurMail({
  hote: env('ARGOS_SMTP_HOTE', 'mail.infomaniak.com'), port: Number(env('ARGOS_SMTP_PORT', '587')),
  utilisateur: env('ARGOS_SMTP_UTILISATEUR', 'contact@argos-veille.fr'), motDePasse: readFileSync(fichier, 'utf8').trim(),
  expediteur: env('ARGOS_SMTP_EXPEDITEUR', 'Argos Veille <contact@argos-veille.fr>'),
});
await mails.verifier();
console.log('connexion et identification SMTP : OK');
await mails.mail(adresse, 'Argos Veille : mail d\'essai', 'Ceci est un mail d\'essai envoyé par le serveur d\'Argos Veille.\nAccents : é è à ç ô — tout va bien.');
console.log(`mail d'essai envoyé à ${adresse}`);
