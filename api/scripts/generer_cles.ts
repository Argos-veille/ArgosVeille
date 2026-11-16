// Génère les clés secrètes de l'API (développement) si elles n'existent pas encore.
//   node scripts/generer_cles.ts            (lancé depuis api/)
// Ne remplace JAMAIS une clé existante : perdre la clé HMAC empêcherait de reconnaître les
// numéros et mails bannis. En production, les clés passent par systemd-creds.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('.secrets', { recursive: true, mode: 0o700 });
for (const nom of ['hmac.key', 'mail.key', 'mfa.key']) {
  const f = `.secrets/${nom}`;
  if (existsSync(f)) {
    console.log(`${f} existe déjà, conservée`);
    continue;
  }
  writeFileSync(f, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`${f} créée`);
}
