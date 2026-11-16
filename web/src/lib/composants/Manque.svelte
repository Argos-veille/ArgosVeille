<script lang="ts">
  // Explique pourquoi un bouton est grisé (15 novembre 2026, demande de l’administrateur, pour tous les boutons du site).
  //   <Manque raisons={[!titre && 'un titre', texte.length < 10 && 'un texte de 10 caractères']}><button disabled={…}>…</button></Manque>
  // Les raisons fausses sont ignorées ; sans raison, rien n'est ajouté. Avec un pointeur (ordinateur) : bulle au survol
  // ou au focus (la zone devient atteignable au clavier, un bouton grisé ne l'étant pas). Sans survol (téléphone) :
  // une ligne « Il manque : … » sous le bouton. Le texte est lu par les lecteurs d'écran dans les deux cas.
  import type { Snippet } from 'svelte';

  // large : le bouton prend toute la largeur (classe pleine-largeur).
  let { raisons, large = false, children }: { raisons: (string | false | null | undefined | 0 | '')[]; large?: boolean; children: Snippet } = $props();

  const liste = $derived(raisons.filter((r): r is string => typeof r === 'string' && r.length > 0));
  const texte = $derived(liste.length ? `Il manque : ${liste.join(', ')}.` : '');
</script>

{#if texte}
  <!-- Atteignable au clavier exprès : le bouton grisé, lui, ne peut pas recevoir le focus. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <span class="manque" class:large tabindex="0" role="group" aria-label={texte}>
    {@render children()}
    <span class="bulle" aria-hidden="true">{texte}</span>
    <span class="ligne petit second" aria-hidden="true">{texte}</span>
  </span>
{:else}
  {@render children()}
{/if}

<style>
  .manque { position: relative; display: inline-flex; flex-direction: column; align-items: flex-start; gap: 0.25rem; max-width: 100%; }
  .manque.large { display: flex; width: 100%; align-items: stretch; }
  .manque:focus-visible { outline: 2px solid var(--accent, currentColor); outline-offset: 3px; border-radius: 6px; }
  .bulle {
    display: none; position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 20; width: max-content; max-width: min(22rem, 80vw);
    padding: 0.4rem 0.6rem; border-radius: 6px; font-size: 0.85rem; line-height: 1.3;
    background: var(--primaire); color: var(--sur-primaire); box-shadow: 0 2px 8px rgb(0 0 0 / 0.2); pointer-events: none;
  }
  .ligne { display: none; max-width: 22rem; }
  @media (hover: hover) {
    .manque:hover .bulle, .manque:focus-visible .bulle, .manque:focus-within .bulle { display: block; }
  }
  @media (hover: none) {
    .ligne { display: block; }
  }
</style>
