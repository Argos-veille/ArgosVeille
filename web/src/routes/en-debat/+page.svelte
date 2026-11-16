<script lang="ts">
  // Vidéos « en débat » : la communauté n'a pas tranché ; elles restent hors de la carte.
  import { onMount } from 'svelte';
  import { get } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';
  import { CATEGORIES, FORCES, SOUS_CATEGORIES, libellesChoix } from '#lib/libelles.ts';

  interface EnDebat { id: string; date: string; categorie: string; sousCategorie: string; sousCategories: string[]; forces: string; enDebatDepuis: string | null; description: string | null }
  let videos = $state<EnDebat[] | null>(null);
  let erreur = $state('');
  const jour = (d: string) => new Date(`${d.slice(0, 10)}T12:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  onMount(async () => {
    try { videos = (await get<{ videos: EnDebat[] }>('/public/en-debat')).videos; } catch (x) { erreur = message(x); }
  });
</script>

<svelte:head><title>En débat — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">En débat</span>
  <h1>Les vidéos sur lesquelles la communauté n’a pas tranché</h1>
  <p class="second">Vote trop serré, même devant un jury : ni confirmées ni démenties, hors de la carte.</p>
  {#if erreur}<div class="message erreur">{erreur}</div>{/if}
  {#each videos ?? [] as v (v.id)}
    <a class="ligne" href="/videos/{v.id}">
      <strong>{CATEGORIES[v.categorie]} · {libellesChoix(v.sousCategories, SOUS_CATEGORIES)}</strong>
      <span class="petit second">{jour(v.date)} · {FORCES[v.forces]}</span>
      {#if v.description}<span class="petit discret">{v.description}</span>{/if}
    </a>
  {:else}
    {#if videos}<p class="discret">Aucune vidéo en débat.</p>{/if}
  {/each}
</div>

<style>
  .ligne { display: grid; gap: 0.25rem; padding: 1rem 1.25rem; background: var(--surface); border: 1px solid var(--trait);
           border-radius: var(--rayon-grand); text-decoration: none; color: var(--texte); margin-bottom: 0.75rem; }
  .ligne:hover { border-color: var(--trait-fort); box-shadow: var(--ombre); }
</style>
