<script lang="ts">
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import ListeVideos from './ListeVideos.svelte';
</script>

<svelte:head><title>Vidéos — Administration — Argos Veille</title></svelte:head>

<div class="conteneur">
  <h1>Vidéos</h1>
  <PorteAdmin><ListeVideos /></PorteAdmin>
</div>
