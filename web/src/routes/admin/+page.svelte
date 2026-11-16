<script lang="ts">
  // Administration : session par la clé physique, puis tableau de bord, alertes de jurés, rapports de bug.
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import TableauAdmin from './TableauAdmin.svelte';
</script>

<svelte:head><title>Administration — Argos Veille</title></svelte:head>

<div class="conteneur">
  <span class="surtitre">Super-administrateur</span>
  <h1>Administration</h1>
  <PorteAdmin><TableauAdmin /></PorteAdmin>
</div>
