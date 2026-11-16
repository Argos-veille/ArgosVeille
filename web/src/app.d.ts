// Types globaux de SvelteKit.
declare global {
  /** Commit du site, joint aux rapports de bug. */
  const __ARGOS_VERSION__: string;
  /** Clé de site Turnstile (publique) ; vide en développement (jeton factice). */
  const __ARGOS_TURNSTILE__: string;
  /** Adresse des tuiles de la carte en production (vide en dev : /carte/france.pmtiles du serveur de dev). */
  const __ARGOS_TUILES__: string;
  namespace App {}
}
export {};
