<script lang="ts">
  import '../app.css';
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount, type Snippet } from 'svelte';
  import BandeauConditions from '#lib/composants/BandeauConditions.svelte';
  import EnTete from '#lib/composants/EnTete.svelte';
  import PiedDePage from '#lib/composants/PiedDePage.svelte';
  import SignalerBug from '#lib/composants/SignalerBug.svelte';
  import Confirmation from '#lib/composants/Confirmation.svelte';
  import { rafraichir, session } from '#lib/session.svelte.ts';
  import { surveiller } from '#lib/surveiller.ts';
  import { installer, noterPage } from '#lib/telemetrie.ts';
  import { PAGES_LIBRES } from '#lib/pages-libres.ts';

  let { children }: { children: Snippet } = $props();
  let bug: SignalerBug | undefined = $state();

  // Lecteur intégré sur d'autres sites : la page seule, sans en-tête, session ni télémétrie.
  const integre = page.url.pathname.startsWith('/integrer/');

  onMount(() => {
    if (integre) return;
    installer();
    void rafraichir();
    // Pastille des messages non lus (enveloppe) à jour sans recharger : chaque minute, si connecté et onglet visible.
    return surveiller(() => (session.moi ? rafraichir() : undefined), 60_000);
  });
  // Bêta : depuis une page libre vue sans accès, la navigation interne ne repassait pas par le contrôle du serveur.
  beforeNavigate((nav) => {
    const cible = nav.to?.url;
    if (!cible || cible.origin !== location.origin || PAGES_LIBRES.has(cible.pathname)) return;
    if (document.documentElement.hasAttribute('data-sans-acces') && !nav.willUnload) {
      nav.cancel();
      location.assign(cible);
    }
  });
  afterNavigate((nav) => { if (!integre) noterPage(nav.to?.route.id ?? null); });
</script>

{#if integre}
  {@render children()}
{:else}
  <a class="aller-au-contenu" href="#contenu">Aller au contenu</a>
  <EnTete />
  <BandeauConditions />
  <main id="contenu">
    {@render children()}
  </main>
  <PiedDePage signaler={() => bug?.ouvrir()} />
  <SignalerBug bind:this={bug} />
  <Confirmation />
{/if}

<style>
  main { min-height: 60vh; padding: 2.5rem 0 0; }
  .aller-au-contenu { position: absolute; left: -999px; top: 0.5rem; background: var(--surface); padding: 0.5rem 1rem; z-index: 20; }
  .aller-au-contenu:focus { left: 0.5rem; }
</style>
