<script lang="ts">
  import { page } from '$app/state';
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import FicheVideo from './FicheVideo.svelte';
</script>

<svelte:head><title>Fiche vidéo — Administration — Argos Veille</title></svelte:head>

<div class="conteneur">
  <p class="petit"><a href="/admin/videos">← Vidéos</a></p>
  <PorteAdmin>{#key page.params['id']}<FicheVideo id={page.params['id']!} />{/key}</PorteAdmin>
</div>
