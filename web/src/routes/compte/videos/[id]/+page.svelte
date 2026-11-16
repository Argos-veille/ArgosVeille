<script lang="ts">
  // Une vidéo envoyée avec ce compte : le même suivi que par le code, sans le code.
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import SuiviVideo from '#lib/composants/SuiviVideo.svelte';
  import { session } from '#lib/session.svelte.ts';

  const id = $derived(page.params.id ?? '');
  let perdue = $state(false);
  $effect(() => { if (session.chargee && !session.moi) void goto('/connexion'); });
</script>

<svelte:head><title>Ma vidéo — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre"><a href="/compte/videos">Mes vidéos</a></span>
  <h1>Suivi de ma vidéo</h1>
  {#if perdue}
    <div class="message erreur">Cette vidéo n’est pas rattachée à votre compte.</div>
  {:else if session.moi}
    {#key id}<SuiviVideo cible={{ video: id }} introuvable={() => (perdue = true)} />{/key}
  {/if}
</div>
