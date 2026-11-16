<script lang="ts">
  import { deciderEvenement, propositionsEvenement, STATUTS_VIDEO, type PropositionEvenement } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  const ORIGINES: Record<PropositionEvenement['origine'], string> = { source: 'Source', reviewer: 'Relecteur', analyst: 'Analyste', admin: 'Administration' };
  let liste = $state<PropositionEvenement[] | null>(null);
  let erreur = $state('');
  let enCours = $state(false);
  let ouvert = $state<string | null>(null);
  let motif = $state('');

  async function charger() {
    try {
      liste = (await propositionsEvenement()).propositions;
      erreur = '';
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    }
  }
  $effect(() => { charger(); });

  async function decider(p: PropositionEvenement, accepter: boolean) {
    enCours = true;
    erreur = '';
    try {
      await deciderEvenement(p.id, accepter, motif.trim());
      ouvert = null;
      motif = '';
      await charger();
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    } finally {
      enCours = false;
    }
  }
</script>

{#if erreur}<div class="message erreur">{erreur}</div>{/if}
{#if liste}
  <div class="carte">
    {#each liste as p (p.id)}
      <div class="ligne">
        <div>
          <span class="pastille">{ORIGINES[p.origine]}</span>
          <span class="petit discret">{new Date(p.le).toLocaleString('fr-FR')} · Oui {p.oui} · Non {p.non}</span>
          <div class="petit">
            <a href="/admin/videos/{p.video.id}">{p.video.pseudonyme ?? 'Vidéo'}</a> <span class="discret">({STATUTS_VIDEO[p.video.statut] ?? p.video.statut})</span>
            ↔
            <a href="/admin/videos/{p.fiche.id}">{p.fiche.pseudonyme ?? 'Vidéo'}</a>
          </div>
          {#if p.justification}<div class="petit second">{p.justification}</div>{/if}
        </div>
        <button class="bouton" aria-pressed={ouvert === p.id} onclick={() => { ouvert = ouvert === p.id ? null : p.id; motif = ''; }}>Décider</button>
        {#if ouvert === p.id}
          <div class="panneau">
            <div class="champ">
              <label for="motif-ev-{p.id}">Motif (public, inscrit au journal)</label>
              <textarea id="motif-ev-{p.id}" placeholder="Public : aucun nom ni détail identifiant" rows="2" maxlength="2000" bind:value={motif}></textarea>
            </div>
            <div class="boutons">
              <button class="bouton principal" onclick={() => decider(p, true)} disabled={enCours || motif.trim().length < 10}>Valider</button>
              <button class="bouton" onclick={() => decider(p, false)} disabled={enCours || motif.trim().length < 10}>Refuser</button>
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <p class="second">Aucune proposition.</p>
    {/each}
  </div>
{/if}

<style>
  .ligne { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.75rem 0; border-bottom: 1px solid var(--trait); flex-wrap: wrap; }
  .ligne:last-child { border-bottom: 0; }
  .panneau { flex-basis: 100%; }
</style>
