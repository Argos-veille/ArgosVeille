<script lang="ts">
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import ListeDoublons from './ListeDoublons.svelte';
  import ListeEvenements from './ListeEvenements.svelte';
</script>

<svelte:head><title>Doublons — Administration — Argos Veille</title></svelte:head>

<div class="conteneur">
  <h1>Doublons</h1>
  <PorteAdmin><ListeDoublons /><h2>Même événement</h2><ListeEvenements /></PorteAdmin>
</div>
