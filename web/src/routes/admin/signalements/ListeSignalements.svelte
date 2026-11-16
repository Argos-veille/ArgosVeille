<script lang="ts">
  import { signalements, STATUTS_BUG, type SignalementAdmin, type StatutBug } from '#lib/admin.ts';
  import SignalementAdminC from '#lib/composants/SignalementAdmin.svelte';
  import { message } from '#lib/erreurs.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  let statut = $state<StatutBug>('open');
  let liste = $state<SignalementAdmin[] | null>(null);
  let erreur = $state('');

  async function charger() {
    try {
      liste = (await signalements(statut)).signalements;
      erreur = '';
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    }
  }
  $effect(() => { void statut; charger(); });
</script>

<div class="onglets" role="tablist">
  {#each Object.entries(STATUTS_BUG) as [cle, texte] (cle)}
    <button role="tab" class="bouton" aria-selected={statut === cle} onclick={() => (statut = cle as StatutBug)}>{texte}</button>
  {/each}
</div>
{#if erreur}<div class="message erreur">{erreur}</div>{/if}
{#if liste}
  <div class="carte">
    {#each liste as s (s.id)}
      <SignalementAdminC {s} video={{ id: s.video, pseudonyme: s.pseudonyme, statut: s.statutVideo }} />
    {:else}
      <p class="second">Aucun signalement.</p>
    {/each}
  </div>
{/if}

<style>
  .onglets { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .onglets [aria-selected='true'] { border-color: var(--accent); background: var(--accent-doux); }
</style>
