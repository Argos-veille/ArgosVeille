<script lang="ts">
  // Registre privé des demandes des autorités : jamais au journal public, seulement compté au rapport de transparence.
  import Manque from '#lib/composants/Manque.svelte';
  import { onMount } from 'svelte';
  import { get, post } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';
  import { preuveCle } from '#lib/admin.ts';

  interface Demande {
    id: string; recueLe: string; auteur: string; objet: string; video: { id: string; nom: string | null } | null;
    suite: string; notes: string | null;
  }
  const AUTEURS: Record<string, string> = { police: 'Police ou gendarmerie', judicial: 'Parquet ou juge', administration: 'Administration', other: 'Autre' };
  const OBJETS: Record<string, string> = { removal: 'Retrait d’une vidéo', identification: 'Données d’identification', preservation: 'Conservation', other: 'Autre' };
  const SUITES: Record<string, string> = { pending: 'En cours', complied: 'Satisfaite', partial: 'En partie', refused: 'Refusée ou contestée' };
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  let demandes = $state<Demande[]>([]);
  let erreur = $state('');
  let edition = $state<{ id?: string; recueLe: string; auteur: string; objet: string; video: string; suite: string; notes: string } | null>(null);
  let enCours = $state(false);

  async function charger() {
    try { demandes = (await get<{ demandes: Demande[] }>('/admin/autorites')).demandes; } catch (x) { erreur = message(x); }
  }
  onMount(charger);

  const aujourdhui = () => new Date().toLocaleDateString('sv-SE');
  const nouvelle = () => (edition = { recueLe: aujourdhui(), auteur: 'police', objet: 'removal', video: '', suite: 'pending', notes: '' });
  const modifier = (d: Demande) => (edition = { id: d.id, recueLe: d.recueLe, auteur: d.auteur, objet: d.objet, video: d.video?.id ?? '',
                                                suite: d.suite, notes: d.notes ?? '' });
  async function enregistrer(e: SubmitEvent) {
    e.preventDefault();
    if (!edition) return;
    erreur = '';
    const video = edition.video.trim() ? UUID.exec(edition.video)?.[0] ?? null : null;
    if (edition.video.trim() && !video) { erreur = 'Lien de fiche ou identifiant de vidéo non reconnu.'; return; }
    enCours = true;
    try {
      await post('/admin/autorites', { ...(edition.id ? { id: edition.id } : {}), recueLe: edition.recueLe, auteur: edition.auteur,
                                       objet: edition.objet, video, suite: edition.suite, notes: edition.notes.trim() || null });
      edition = null;
      await charger();
    } catch (x) { erreur = message(x); } finally { enCours = false; }
  }
  async function supprimer(d: Demande) {
    erreur = '';
    try { await post(`/admin/autorites/${d.id}/supprimer`, { cle: await preuveCle() }); if (edition?.id === d.id) edition = null; await charger(); } catch (x) { erreur = message(x); }
  }
  const dateLongue = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('fr-FR', { dateStyle: 'long' });
</script>

<div class="carte">
  {#if erreur}<div class="message erreur">{erreur}</div>{/if}
  {#each demandes as d (d.id)}
    <div class="ligne">
      <div>
        <strong>{dateLongue(d.recueLe)}</strong> · {AUTEURS[d.auteur]} · {OBJETS[d.objet]} ·
        <span class={d.suite === 'pending' ? 'rouge' : ''}>{SUITES[d.suite]}</span>
        {#if d.video}<div class="petit"><a href="/admin/videos/{d.video.id}">{d.video.nom ?? d.video.id}</a></div>{/if}
        {#if d.notes}<div class="petit second" style:white-space="pre-line">{d.notes}</div>{/if}
      </div>
      <div class="actions">
        <button class="bouton lien" onclick={() => modifier(d)}>Modifier</button>
        <button class="bouton lien" onclick={() => supprimer(d)}>Supprimer</button>
      </div>
    </div>
  {:else}
    <p class="petit second">Aucune demande.</p>
  {/each}

  {#if edition}
    <form class="edition" onsubmit={enregistrer}>
      <div class="grille">
        <div class="champ"><label for="aut-date">Reçue le</label>
          <input id="aut-date" type="date" bind:value={edition.recueLe} required max={aujourdhui()} /></div>
        <div class="champ"><label for="aut-auteur">De</label>
          <select id="aut-auteur" bind:value={edition.auteur}>{#each Object.entries(AUTEURS) as [c, t] (c)}<option value={c}>{t}</option>{/each}</select></div>
        <div class="champ"><label for="aut-objet">Objet</label>
          <select id="aut-objet" bind:value={edition.objet}>{#each Object.entries(OBJETS) as [c, t] (c)}<option value={c}>{t}</option>{/each}</select></div>
        <div class="champ"><label for="aut-suite">Suite</label>
          <select id="aut-suite" bind:value={edition.suite}>{#each Object.entries(SUITES) as [c, t] (c)}<option value={c}>{t}</option>{/each}</select></div>
      </div>
      <div class="champ"><label for="aut-video">Vidéo (lien de la fiche, facultatif)</label>
        <input id="aut-video" bind:value={edition.video} maxlength="300" /></div>
      <div class="champ"><label for="aut-notes">Notes (privées)</label>
        <textarea id="aut-notes" rows="3" maxlength="5000" bind:value={edition.notes}></textarea></div>
      <div class="boutons">
        <Manque raisons={[!edition.recueLe && 'date de réception']}><button class="bouton principal" type="submit" disabled={enCours || !edition.recueLe}>Enregistrer</button></Manque>
        <button class="bouton lien" type="button" onclick={() => (edition = null)}>Annuler</button>
      </div>
    </form>
  {:else}
    <button class="bouton" onclick={nouvelle}>Ajouter une demande</button>
  {/if}
</div>

<style>
  .ligne { display: flex; justify-content: space-between; gap: 1rem; padding: 0.5rem 0; border-bottom: 1px solid var(--trait); }
  .actions { display: flex; gap: 0.75rem; flex-shrink: 0; align-items: start; }
  .edition { margin-top: 1rem; }
  .grille { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 0 1rem; }
  .carte > .bouton { margin-top: 0.75rem; }
  .rouge { color: var(--danger); }
</style>
