// Messagerie avec les sources (M2) : clé de messagerie du compte, côté navigateur.
// Elle est protégée par le mot de passe : créée ou ouverte quand celui-ci est connu (connexion, ou demande
// « déverrouiller »), puis gardée en mémoire pour la durée de l'onglet seulement (session.svelte.ts).
import { creerCleCompte, ouvrirCleCompte, type CleCompte, type CleOuverte } from 'argos-navigateur';
import { get, post } from './api.ts';
import { cleMessagerie } from './session.svelte.ts';
import { secretDuCompte } from './motdepasse.ts';

/**
 * Clé publique du compte connecté TELLE QUE RENVOYÉE PAR LE SERVEUR (null s'il n'en a pas encore). Affichage seulement :
 * ne JAMAIS chiffrer pour elle (audit du 15 novembre, N1 : un site compromis pourrait y mettre la sienne).
 */
export async function publiqueDuCompte(): Promise<string | null> {
  return (await get<{ cle: CleCompte | null }>('/messagerie/cle')).cle?.publique ?? null;
}

/**
 * Clé publique pour CHIFFRER vers le compte (code de la vidéo, clé de messagerie de la vidéo) : celle que le mot de passe
 * vient d'ouvrir dans ce navigateur, authentifiée par lui (la partie privée est chiffrée avec la clé publique en données
 * associées). null tant que la messagerie n'est pas déverrouillée.
 */
export function publiqueOuverte(): string | null {
  return cleMessagerie.ouverte?.publique ?? null;
}

/**
 * Ouvre la clé du compte avec le mot de passe, ou la crée si le compte n'en a pas encore.
 * Erreur « mot_de_passe_incorrect » si le mot de passe ne l'ouvre pas.
 */
export async function deverrouiller(motDePasse: string): Promise<CleOuverte> {
  const { cle } = await get<{ cle: CleCompte | null }>('/messagerie/cle');
  let ouverte: CleOuverte;
  if (cle) {
    ouverte = await ouvrirCleCompte(cle, motDePasse);
  } else {
    const nouvelle = await creerCleCompte(motDePasse);
    await post('/messagerie/cle', { motDePasse: await secretDuCompte(motDePasse), cle: nouvelle.stockee });   // le serveur revérifie le secret
    ouverte = nouvelle.ouverte;
  }
  cleMessagerie.ouverte = ouverte;
  return ouverte;
}

/** À la connexion : prépare la clé sans jamais bloquer ni faire échouer la connexion. */
export function preparerALaConnexion(motDePasse: string): void {
  if (!motDePasse) return;
  deverrouiller(motDePasse).catch(() => { /* réessayé plus tard par « déverrouiller la messagerie » */ });
}
