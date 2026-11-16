<script lang="ts">
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import ListeControles from './ListeControles.svelte';
</script>

<svelte:head><title>Vidéos de contrôle — Administration — Argos Veille</title></svelte:head>

<div class="conteneur">
  <h1>Vidéos de contrôle</h1>
  <PorteAdmin><ListeControles /></PorteAdmin>
</div>
