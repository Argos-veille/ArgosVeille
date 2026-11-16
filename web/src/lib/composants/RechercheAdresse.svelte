<script lang="ts">
  // Recherche d'une adresse (France) sur une carte. Pas de <form> : ce composant se trouve aussi dans le formulaire d'envoi.
  import Manque from '#lib/composants/Manque.svelte';
  import { appelSource } from '#lib/envoi.ts';
  import { message } from '#lib/erreurs.ts';

  interface Resultat { label: string; lat: number; lon: number }
  let { onchoisir }: { onchoisir: (r: Resultat) => void } = $props();
  let q = $state('');
  let resultats = $state<Resultat[] | null>(null);
  let erreur = $state('');
  let occupe = $state(false);

  async function chercher() {
    if (q.trim().length < 3) return;
    erreur = ''; occupe = true;
    try {
      resultats = (await appelSource<{ resultats: Resultat[] }>('/adresse', { q: q.trim() })).resultats;
    } catch (x) {
      erreur = message(x);
    } finally {
      occupe = false;
    }
  }
  function choisir(r: Resultat) {
    q = r.label;
    resultats = null;
    onchoisir(r);
  }
</script>

<div class="adresse">
  <label for="recherche-adresse">Adresse</label>
  <div class="ligne">
    <input id="recherche-adresse" bind:value={q} maxlength="200" autocomplete="off" placeholder="10 rue de Rivoli, Paris"
           onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void chercher(); } }} />
    <Manque raisons={[q.trim().length < 3 && '3 caractères au moins']}><button class="bouton" type="button" disabled={occupe || q.trim().length < 3} onclick={chercher}>Chercher</button></Manque>
  </div>
  {#if erreur}<p class="message erreur petit" role="alert">{erreur}</p>{/if}
  {#if resultats}
    {#if resultats.length}
      <ul>{#each resultats as r, i (i)}<li><button class="bouton lien" type="button" onclick={() => choisir(r)}>{r.label}</button></li>{/each}</ul>
    {:else}<p class="petit second">Aucune adresse trouvée.</p>{/if}
  {/if}
</div>

<style>
  .adresse { display: grid; gap: 0.25rem; margin: 0 0 0.75rem; }
  label { font-size: 0.875rem; font-weight: 600; }
  .ligne { display: flex; gap: 0.5rem; }
  .ligne input { flex: 1; min-width: 0; }
  ul { list-style: none; margin: 0; padding: 0; }
</style>
