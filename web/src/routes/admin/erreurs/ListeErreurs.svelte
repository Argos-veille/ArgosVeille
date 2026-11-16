<script lang="ts">
  import { erreursServeur, type ErreurRecente } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  const DUREES: [number, string][] = [[24, '24 h'], [168, '7 jours'], [336, '14 jours']];
  let heures = $state(24);
  let liste = $state<ErreurRecente[] | null>(null);
  let erreur = $state('');

  // Regroupées par route et message : une même panne apparaît sur une seule ligne.
  const groupes = $derived.by(() => {
    const m = new Map<string, ErreurRecente[]>();
    for (const e of liste ?? []) {
      const k = `${e.route} ${e.message ?? ''}`;
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.values()];
  });

  async function charger() {
    try {
      liste = (await erreursServeur(heures)).erreurs;
      erreur = '';
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    }
  }
  $effect(() => { void heures; charger(); });
  const quand = (d: string) => new Date(d).toLocaleString('fr-FR');
</script>

<div class="onglets" role="tablist">
  {#each DUREES as [h, texte] (h)}
    <button role="tab" class="bouton" aria-selected={heures === h} onclick={() => (heures = h)}>{texte}</button>
  {/each}
</div>
{#if erreur}<div class="message erreur">{erreur}</div>{/if}
{#if liste}
  <div class="carte">
    {#each groupes as g (g[0]!.requete)}
      <div class="ligne">
        <div><span class="pastille accent">× {g.length}</span> <code>{g[0]!.route}</code> <span class="petit discret">{g[0]!.statut}</span></div>
        <p class="petit">{g[0]!.message ?? g[0]!.nom ?? 'Erreur sans message'}</p>
        <p class="petit discret">Dernière : {quand(g[0]!.le)}{#if g.length > 1} · première : {quand(g[g.length - 1]!.le)}{/if}</p>
        {#if g[0]!.trace}<details class="petit"><summary>Trace</summary><pre>{g[0]!.trace}</pre></details>{/if}
        <details class="petit"><summary>Numéros de requête</summary><ul>{#each g as e (e.requete)}<li><code>{e.requete}</code></li>{/each}</ul></details>
      </div>
    {:else}
      <p class="second">Aucune erreur sur cette période.</p>
    {/each}
  </div>
{/if}

<style>
  .onglets { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .onglets [aria-selected='true'] { border-color: var(--accent); background: var(--accent-doux); }
  .ligne { padding: 0.75rem 0; border-bottom: 1px solid var(--trait); overflow-wrap: anywhere; }
  .ligne:last-child { border-bottom: 0; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
