<script lang="ts">
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import ListeSignalements from './ListeSignalements.svelte';
  import MessagesSignales from './MessagesSignales.svelte';
</script>

<svelte:head><title>Signalements — Administration — Argos Veille</title></svelte:head>

<div class="conteneur">
  <h1>Signalements</h1>
  <PorteAdmin><ListeSignalements /><MessagesSignales /></PorteAdmin>
</div>
