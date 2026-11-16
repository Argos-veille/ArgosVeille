// Envoi d'un SMS d'essai réel par l'API d'OVHcloud.
//   ARGOS_OVH_SMS_SERVICE=sms-xx00000-1 node --import tsx scripts/essai-sms.ts +33612345678
// Clés lues dans ARGOS_OVH_SECRETS_FICHIER (par défaut .secrets/ovh.json, droits 600) :
//   { "cleApplication": "…", "secretApplication": "…", "cleConsommateur": "…" }
import { readFileSync, statSync } from 'node:fs';
import { SmsOvh } from '../src/sms.ts';

const [numero] = process.argv.slice(2);
if (!numero || !/^\+[1-9]\d{7,14}$/.test(numero)) {
  console.error('usage : essai-sms.ts +33612345678 (format international)');
  process.exit(2);
}
const service = process.env['ARGOS_OVH_SMS_SERVICE'];
if (!service) throw new Error('réglage manquant : ARGOS_OVH_SMS_SERVICE');
const fichier = process.env['ARGOS_OVH_SECRETS_FICHIER'] ?? '.secrets/ovh.json';
if ((statSync(fichier).mode & 0o077) !== 0) throw new Error(`${fichier} doit être lisible par vous seul (chmod 600)`);
const cles = JSON.parse(readFileSync(fichier, 'utf8')) as { cleApplication: string; secretApplication: string; cleConsommateur: string };
await new SmsOvh({ point: 'https://eu.api.ovh.com/1.0', service, ...cles })
  .sms(numero, "Argos Veille : SMS d'essai. Votre code d'inscription serait 123456.");
console.log(`SMS d'essai envoyé au ${numero.slice(0, 4)}…${numero.slice(-2)}`);
