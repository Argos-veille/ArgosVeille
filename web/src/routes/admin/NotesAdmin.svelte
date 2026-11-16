<script lang="ts">
  // Notes de l'administration, en tête du tableau de bord : pense-bêtes privés, date facultative (échéance).
  import Manque from '#lib/composants/Manque.svelte';
  import { onMount } from 'svelte';
  import { enregistrerNoteAdmin, notesAdmin, supprimerNoteAdmin, type NoteAdmin } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { joursRestants } from '#lib/jours.ts';

  let notes = $state<NoteAdmin[]>([]);
  let erreur = $state('');
  let edition = $state<{ id?: string; titre: string; date: string; detail: string } | null>(null);
  let enCours = $state(false);

  async function charger() {
    try { notes = (await notesAdmin()).notes; } catch (x) { erreur = message(x); }
  }
  onMount(charger);

  const nouvelle = () => (edition = { titre: '', date: '', detail: '' });
  const modifier = (n: NoteAdmin) => (edition = { id: n.id, titre: n.titre, date: n.date ?? '', detail: n.detail ?? '' });
  async function enregistrer(e: SubmitEvent) {
    e.preventDefault();
    if (!edition) return;
    erreur = ''; enCours = true;
    try {
      await enregistrerNoteAdmin({ ...(edition.id ? { id: edition.id } : {}), titre: edition.titre.trim(),
                                   date: edition.date || null, detail: edition.detail.trim() || null });
      edition = null;
      await charger();
    } catch (x) { erreur = message(x); } finally { enCours = false; }
  }
  async function supprimer(n: NoteAdmin) {
    erreur = '';
    try { await supprimerNoteAdmin(n.id); if (edition?.id === n.id) edition = null; await charger(); } catch (x) { erreur = message(x); }
  }
  const dateLongue = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('fr-FR', { dateStyle: 'long' });
  const reste = (n: number) => (n < 0 ? `dépassée de ${-n} j` : n === 0 ? 'aujourd’hui' : `dans ${n} j`);
</script>

<div class="carte">
  {#if erreur}<div class="message erreur">{erreur}</div>{/if}
  {#each notes as n (n.id)}
    {@const j = n.date ? joursRestants(n.date) : null}
    <div class="note">
      <div>
        <strong>{n.titre}</strong>
        {#if n.date}<span class={j !== null && j <= 14 ? 'rouge' : 'discret'}> · {dateLongue(n.date)} ({reste(j!)})</span>{/if}
        {#if n.detail}<div class="petit second" style:white-space="pre-line">{n.detail}</div>{/if}
      </div>
      <div class="actions">
        <button class="bouton lien" onclick={() => modifier(n)}>Modifier</button>
        <button class="bouton lien" onclick={() => supprimer(n)}>Supprimer</button>
      </div>
    </div>
  {:else}
    <p class="petit second">Aucune note.</p>
  {/each}

  {#if edition}
    <form class="edition" onsubmit={enregistrer}>
      <div class="champ"><label for="note-titre">Titre</label>
        <input id="note-titre" bind:value={edition.titre} required maxlength="200" /></div>
      <div class="champ"><label for="note-date">Date (facultative)</label>
        <input id="note-date" type="date" bind:value={edition.date} /></div>
      <div class="champ"><label for="note-detail">Détail (facultatif)</label>
        <textarea id="note-detail" rows="3" maxlength="2000" bind:value={edition.detail}></textarea></div>
      <div class="boutons">
        <Manque raisons={[!edition.titre.trim() && 'titre']}><button class="bouton principal" type="submit" disabled={enCours || !edition.titre.trim()}>Enregistrer</button></Manque>
        <button class="bouton lien" type="button" onclick={() => (edition = null)}>Annuler</button>
      </div>
    </form>
  {:else}
    <button class="bouton" onclick={nouvelle}>Ajouter une note</button>
  {/if}
</div>

<style>
  .note { display: flex; justify-content: space-between; gap: 1rem; padding: 0.5rem 0; border-bottom: 1px solid var(--trait); }
  .actions { display: flex; gap: 0.75rem; flex-shrink: 0; align-items: start; }
  .edition { margin-top: 1rem; }
  .carte > .bouton { margin-top: 0.75rem; }
  .rouge { color: var(--danger); }
</style>
