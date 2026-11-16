<script lang="ts">
  // Comptes qui n'ont pas accepté la version en vigueur des conditions d'utilisation (inscrits avant
  // leur création, ou après un changement du texte) : bandeau en haut de chaque page, jusqu'à l'acceptation.
  import { post } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';
  import { rafraichir, session } from '#lib/session.svelte.ts';

  let occupe = $state(false);
  let erreur = $state('');

  async function accepter() {
    if (!session.moi?.conditionsAAccepter) return;
    occupe = true;
    erreur = '';
    try {
      await post('/compte/conditions', { version: session.moi.conditionsAAccepter });
      await rafraichir();
    } catch (x) {
      erreur = message(x);
    } finally {
      occupe = false;
    }
  }
</script>

{#if session.moi?.conditionsAAccepter}
  <div class="conteneur">
    <div class="message attention bandeau" role="status">
      <span>Les conditions d’utilisation d’Argos Veille ont été mises à jour. Merci de les
        <a href="/conditions">lire</a> et de les accepter.</span>
      <button class="bouton principal" onclick={accepter} disabled={occupe} data-trace="accepter les conditions">
        {occupe ? 'Envoi…' : 'J’ai lu et j’accepte'}</button>
    </div>
    {#if erreur}<div class="message erreur">{erreur}</div>{/if}
  </div>
{/if}

<style>
  .bandeau { display: flex; gap: 1rem; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-top: 1rem; }
</style>
