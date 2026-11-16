<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head><title>{page.status === 404 ? 'Page introuvable' : 'Erreur'} — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">{page.status}</span>
  <h1>{page.status === 404 ? 'Cette page n’existe pas' : 'Une erreur est survenue'}</h1>
  <p class="second">{page.status === 404 ? 'Le lien est peut-être incomplet.' : 'Réessayez ; si cela continue, utilisez le bouton « Signaler un bug » en bas de page.'}</p>
  <p><a href="/">Retour à l’accueil</a></p>
</div>
