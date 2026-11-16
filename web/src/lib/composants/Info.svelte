<script lang="ts">
  // Petit « i » à placer juste après un texte principal : un clic ouvre l'explication en dessous, un second la referme.
  import type { Snippet } from 'svelte';
  let { children, titre = 'En savoir plus' }: { children: Snippet; titre?: string } = $props();
  let ouvert = $state(false);
  const id = `info-${Math.random().toString(36).slice(2, 9)}`;
</script>

<button type="button" class="info" aria-expanded={ouvert} aria-controls={id} title={titre} aria-label={titre}
        onclick={(e) => { e.preventDefault(); e.stopPropagation(); ouvert = !ouvert; }}>i</button>
{#if ouvert}<span class="explication" {id}>{@render children()}</span>{/if}

<style>
  .info { display: inline-grid; place-items: center; width: 1.15rem; height: 1.15rem; margin-left: 0.375rem; padding: 0;
          vertical-align: 0.1em; border-radius: 999px; border: 1px solid var(--trait-fort); background: var(--surface);
          color: var(--texte-2); cursor: pointer; font: italic 700 0.7rem/1 Georgia, serif; }
  .info:hover, .info[aria-expanded='true'] { border-color: var(--accent); color: var(--accent-texte); }
  .explication { display: block; margin-top: 0.375rem; font-size: 0.8125rem; color: var(--texte-2); line-height: 1.5;
                 font-weight: 400; font-style: normal; }
</style>
