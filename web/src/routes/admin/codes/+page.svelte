<script lang="ts">
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import CodesComptes from './CodesComptes.svelte';
</script>

<svelte:head><title>Gestion des codes — Administration — Argos Veille</title></svelte:head>

<div class="conteneur">
  <h1>Gestion des codes</h1>
  <PorteAdmin>
    <CodesComptes />
  </PorteAdmin>
</div>
