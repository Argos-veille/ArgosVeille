<script lang="ts">
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import ListeComptes from './ListeComptes.svelte';
</script>

<svelte:head><title>Comptes — Administration — Argos Veille</title></svelte:head>

<div class="conteneur">
  <h1>Comptes</h1>
  <PorteAdmin><ListeComptes /></PorteAdmin>
</div>
