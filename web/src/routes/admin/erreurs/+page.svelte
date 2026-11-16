<script lang="ts">
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import ListeErreurs from './ListeErreurs.svelte';
</script>

<svelte:head><title>Erreurs du serveur — Administration — Argos Veille</title></svelte:head>

<div class="conteneur">
  <h1>Erreurs du serveur</h1>
  <PorteAdmin><ListeErreurs /></PorteAdmin>
</div>
