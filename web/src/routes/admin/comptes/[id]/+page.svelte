<script lang="ts">
  import { page } from '$app/state';
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import FicheCompte from './FicheCompte.svelte';
</script>

<svelte:head><title>Compte — Administration — Argos Veille</title></svelte:head>

<div class="conteneur">
  <p class="petit"><a href="/admin/comptes">← Comptes</a></p>
  <PorteAdmin><FicheCompte id={page.params['id']!} /></PorteAdmin>
</div>
