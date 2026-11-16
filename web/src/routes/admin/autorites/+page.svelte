<script lang="ts">
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import ListeAutorites from './ListeAutorites.svelte';
</script>

<svelte:head><title>Autorités — Administration — Argos Veille</title></svelte:head>

<div class="conteneur">
  <h1>Demandes des autorités</h1>
  <PorteAdmin><ListeAutorites /></PorteAdmin>
</div>
