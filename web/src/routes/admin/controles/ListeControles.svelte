<script lang="ts">
  import { activerControle, controles, type Controle } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  const SEUIL = 30;
  let liste = $state<Controle[] | null>(null);
  let erreur = $state('');
  let enCours = $state(false);
  const actives = $derived(liste?.filter((c) => c.active).length ?? 0);
  const votes = $derived(liste?.reduce((n, c) => n + c.votes, 0) ?? 0);
  const corrects = $derived(liste?.reduce((n, c) => n + c.corrects, 0) ?? 0);

  async function charger() {
    try {
      liste = (await controles()).controles;
      erreur = '';
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    }
  }
  $effect(() => { charger(); });

  async function basculer(c: Controle) {
    enCours = true;
    try {
      await activerControle(c.video, c.retiree);
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
  <p class="petit">{actives} vidéo{actives > 1 ? 's' : ''} active{actives > 1 ? 's' : ''}{actives < SEUIL ? ` · inactif sous ${SEUIL}` : ''}
    · {votes} réponse{votes > 1 ? 's' : ''}{#if votes} · {Math.round((corrects / votes) * 100)} % correctes{/if}</p>
  <div class="carte">
    {#each liste as c (c.video)}
      <div class="ligne">
        <div>
          <span class="pastille {c.reponse ? '' : 'accent'}">{c.reponse ? 'Publiée' : 'Rejetée'}</span>
          <a class="petit" href="/admin/videos/{c.video}">{c.pseudonyme ?? 'Vidéo'}</a>
          <span class="petit discret">affichée « {c.nomAffiche} » · {c.corrects}/{c.votes}{c.active ? '' : ' · inactive'}</span>
        </div>
        <button class="bouton" disabled={enCours} onclick={() => basculer(c)}>{c.retiree ? 'Remettre' : 'Retirer'}</button>
      </div>
    {:else}
      <p class="second">Aucune vidéo pour l’instant.</p>
    {/each}
  </div>
{/if}

<style>
  .ligne { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.75rem 0; border-bottom: 1px solid var(--trait); flex-wrap: wrap; }
  .ligne:last-child { border-bottom: 0; }
</style>
