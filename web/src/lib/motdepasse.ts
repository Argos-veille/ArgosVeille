// Mot de passe côté navigateur (revue de sécurité A5, 0101) : il ne part plus jamais au serveur. On envoie à la place le
// secret de connexion qui en est tiré ; et les règles d'un nouveau mot de passe (mêmes que api/src/motdepasse.ts) sont
// donc vérifiées ici, le serveur ne voyant plus le mot de passe.
import { secretDeConnexion } from 'argos-navigateur';
import { ErreurApi } from './api.ts';
import { session } from './session.svelte.ts';

export { secretDeConnexion };

/** Secret de connexion du compte connecté, pour les actions qui redemandent le mot de passe. */
export function secretDuCompte(motDePasse: string): Promise<string> {
  const pseudo = session.moi?.pseudo;
  if (!pseudo) throw new ErreurApi(401, 'session_requise', {});
  return secretDeConnexion(pseudo, motDePasse);
}

let courants: Promise<Set<string>> | null = null;
const listeCourants = () => (courants ??= fetch('/api/public/mots-de-passe-courants')
  .then((r) => (r.ok ? r.text() : ''))
  .then((t) => new Set(t.split('\n').filter(Boolean)))
  .catch(() => { courants = null; return new Set<string>(); }));

/** Vérifie un nouveau mot de passe ; lève une ErreurApi (même code que le serveur) s'il ne convient pas. */
export async function verifierNouveau(motDePasse: string, pseudo: string): Promise<void> {
  const caracteres = [...motDePasse];
  const refus = (code: string) => { throw new ErreurApi(400, code, {}); };
  if (caracteres.length < 12) refus('mdp_trop_court');
  if (caracteres.length > 128) refus('mdp_trop_long');
  const bas = motDePasse.toLowerCase();
  if ((await listeCourants()).has(bas)) refus('mdp_courant');
  if (new Set(caracteres).size < 5) refus('mdp_repetitif');
  if (pseudo.length >= 3 && bas.includes(pseudo.toLowerCase())) refus('mdp_contient_pseudo');
}
