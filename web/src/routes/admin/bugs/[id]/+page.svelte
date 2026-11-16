<script lang="ts">
  // Un rapport de bug : description, capture, télémétrie jointe et erreurs du serveur liées.
  import { page } from '$app/state';
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import DetailBug from './DetailBug.svelte';
</script>

<svelte:head><title>Rapport de bug — Argos Veille</title></svelte:head>

<div class="conteneur">
  <a class="petit" href="/admin#bugs">← Administration</a>
  <h1>Rapport de bug</h1>
  <PorteAdmin><DetailBug id={page.params['id']!} /></PorteAdmin>
</div>
