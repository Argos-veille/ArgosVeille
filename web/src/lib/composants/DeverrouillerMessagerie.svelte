<script lang="ts">
  // Déverrouiller la messagerie : la clé du compte est protégée par le mot de passe, que le serveur ne connaît pas
  // en clair. Une fois ouverte, elle reste en mémoire jusqu'à la fermeture de l'onglet ou la déconnexion.
  import Manque from '#lib/composants/Manque.svelte';
  import type { CleOuverte } from 'argos-navigateur';
  import ChampMotDePasse from '#lib/composants/ChampMotDePasse.svelte';
  import { message } from '#lib/erreurs.ts';
  import { deverrouiller } from '#lib/messagerie.ts';

  let { ouverte }: { ouverte: (cle: CleOuverte) => void } = $props();
  let motDePasse = $state('');
  let enCours = $state(false);
  let erreur = $state('');

  async function valider(e: SubmitEvent) {
    e.preventDefault();
    erreur = ''; enCours = true;
    try {
      const cle = await deverrouiller(motDePasse);
      motDePasse = '';
      ouverte(cle);
    } catch (x) {
      erreur = x instanceof Error && x.message === 'mot_de_passe_incorrect' ? 'Mot de passe incorrect.' : message(x);
    } finally {
      enCours = false;
    }
  }
</script>

<form class="carte" onsubmit={valider}>
  <h3>Déverrouiller la messagerie</h3>
  <p class="second petit">Les messages sont chiffrés avec une clé que seul votre mot de passe ouvre. Saisissez-le pour les lire
    (une fois par visite).</p>
  {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
  <ChampMotDePasse id="mdp-messagerie" libelle="Mot de passe" bind:valeur={motDePasse} />
  <Manque raisons={[!motDePasse && 'votre mot de passe']}><button class="bouton principal" disabled={enCours || !motDePasse}>{enCours ? 'Ouverture…' : 'Déverrouiller'}</button></Manque>
</form>
