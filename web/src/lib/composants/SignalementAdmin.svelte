<script lang="ts">
  // Un signalement, vu par l'administration, avec le classement (la réponse part par mail à la
  // personne qui a signalé ; qui a signalé n'est jamais affiché).
  import Manque from '#lib/composants/Manque.svelte';
  import { classerSignalement, MOTIFS_SIGNALEMENT, STATUTS_VIDEO, type Signalement } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  let { s, video, apres = () => {} }: {
    s: Signalement & { note?: string | null; origine?: 'compte' | 'relecture' };
    video?: { id: string; pseudonyme: string | null; statut: string };
    apres?: () => void;
  } = $props();

  const ETATS = { open: 'À traiter', handled: 'Traité', dismissed: 'Écarté' } as const;
  const quand = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  let ouvert = $state(false);
  let note = $state('');
  let enCours = $state(false);
  let erreur = $state('');
  let info = $state('');

  async function classer(statut: 'handled' | 'dismissed') {
    erreur = ''; enCours = true;
    try {
      const r = await classerSignalement(s.id, statut, note.trim());
      info = r.prevenu ? 'Classé ; la personne a été prévenue par mail.' : 'Classé (signalement venu de la relecture : personne à prévenir).';
      ouvert = false;
      apres();
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    } finally {
      enCours = false;
    }
  }
</script>

<div class="signalement">
  <div class="tete">
    <div>
      <span class="pastille {s.gravite === 'serious' ? 'rouge' : ''}">{s.gravite === 'serious' ? 'Grave' : 'Normal'}</span>
      <strong>{MOTIFS_SIGNALEMENT[s.motif] ?? s.motif}</strong>
      <span class="petit discret"> · {quand(s.le)} · {ETATS[s.statut]}{#if s.origine} · {s.origine === 'compte' ? 'par un compte' : 'pendant la relecture'}{/if}</span>
      {#if video}<div class="petit"><a href="/admin/videos/{video.id}">{video.pseudonyme ?? 'Vidéo'}</a>
        <span class="discret">({STATUTS_VIDEO[video.statut] ?? video.statut})</span></div>{/if}
    </div>
    {#if s.statut === 'open' && !ouvert && !info}<button class="bouton" onclick={() => (ouvert = true)}>Classer</button>{/if}
  </div>
  {#if s.details}<p class="petit second details">{s.details}</p>{/if}
  {#if s.note}<p class="petit">Réponse : <span class="second">{s.note}</span></p>{/if}
  {#if info}<div class="message succes petit">{info}</div>{/if}
  {#if ouvert}
    <div class="champ">
      <label for="note-{s.id}">Réponse (envoyée par mail à la personne qui a signalé)</label>
      <textarea id="note-{s.id}" rows="3" maxlength="2000" bind:value={note}
                placeholder="Par exemple : floutage refait, le visage n’est plus visible."></textarea>
    </div>
    {#if erreur}<div class="message erreur">{erreur}</div>{/if}
    <div class="boutons">
      <Manque raisons={[note.trim().length < 10 && 'note (10 car.)']}><button class="bouton principal" disabled={enCours || note.trim().length < 10} onclick={() => classer('handled')}>Traité</button></Manque>
      <Manque raisons={[note.trim().length < 10 && 'note (10 car.)']}><button class="bouton" disabled={enCours || note.trim().length < 10} onclick={() => classer('dismissed')}>Sans suite</button></Manque>
      <button class="bouton" onclick={() => (ouvert = false)}>Annuler</button>
    </div>
  {/if}
</div>

<style>
  .signalement { padding: 0.75rem 0; border-bottom: 1px solid var(--trait); }
  .tete { display: flex; justify-content: space-between; gap: 1rem; align-items: start; }
  .details { margin: 0.375rem 0 0; white-space: pre-line; }
  .pastille.rouge { background: var(--danger-doux); color: var(--danger); border-color: var(--danger); }
</style>
