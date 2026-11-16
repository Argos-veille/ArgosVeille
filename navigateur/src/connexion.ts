// Secret de connexion (revue de sécurité du 14 novembre 2026, A5).
// Le mot de passe protège la clé de messagerie du compte (messagerie.ts) : il ne doit donc jamais partir au serveur,
// sinon un serveur saisi ou contraint pourrait l'intercepter et ouvrir la messagerie. Le navigateur en tire un secret de
// connexion distinct (PBKDF2, sel fixe lié au pseudo), et c'est lui seul qui est envoyé, puis haché par le serveur.
// Le secret ne permet pas de retrouver le mot de passe sans le deviner, et la clé de messagerie utilise un autre sel.
const ITERATIONS_CONNEXION = 300_000;

const b64url = (o: Uint8Array) => btoa(String.fromCharCode(...o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Secret envoyé au serveur à la place du mot de passe (43 caractères base64url). */
export async function secretDeConnexion(pseudo: string, motDePasse: string): Promise<string> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(motDePasse.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const sel = new TextEncoder().encode(`argos/connexion/v1:${pseudo.trim().toLowerCase()}`);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sel, iterations: ITERATIONS_CONNEXION }, base, 256);
  return b64url(new Uint8Array(bits));
}
