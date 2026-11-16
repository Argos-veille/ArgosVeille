<script lang="ts">
  import { messagesContact, traiterContact, type MessageContact } from '#lib/admin.ts';
  import { message as texteErreur } from '#lib/erreurs.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  const MOTIFS: Record<string, string> = {
    content: 'Signalement', right_of_reply: 'Droit de réponse', certification: 'Certification', personal_data: 'Données personnelles',
    authority: 'Autorité', press: 'Presse', other: 'Autre',
  };
  let traites = $state(false);
  let liste = $state<MessageContact[] | null>(null);
  let erreur = $state('');
  let enCours = $state(false);

  async function charger() {
    try {
      liste = (await messagesContact(traites)).messages;
      erreur = '';
    } catch (x) {
      if (!sessionExpiree(x)) erreur = texteErreur(x);
    }
  }
  $effect(() => { void traites; charger(); });

  async function basculer(m: MessageContact) {
    enCours = true;
    try {
      await traiterContact(m.id, !traites);
      await charger();
    } catch (x) {
      if (!sessionExpiree(x)) erreur = texteErreur(x);
    } finally {
      enCours = false;
    }
  }
</script>

<div class="onglets" role="tablist">
  <button role="tab" class="bouton" aria-selected={!traites} onclick={() => (traites = false)}>À traiter</button>
  <button role="tab" class="bouton" aria-selected={traites} onclick={() => (traites = true)}>Traités</button>
</div>
{#if erreur}<div class="message erreur">{erreur}</div>{/if}
{#if liste}
  <div class="carte">
    {#each liste as m (m.id)}
      <div class="ligne">
        <div class="tete">
          <div>
            <span class="pastille {['right_of_reply', 'authority'].includes(m.motif) ? 'accent' : ''}">{MOTIFS[m.motif] ?? m.motif}</span>
            <span class="petit discret">{new Date(m.le).toLocaleString('fr-FR')}</span>
          </div>
          <div class="actions">
            {#if m.mail}<button class="bouton" onclick={() => navigator.clipboard.writeText(m.mail!)}>Copier le mail</button>{/if}
            <button class="bouton" disabled={enCours} onclick={() => basculer(m)}>{traites ? 'Rouvrir' : 'Traité'}</button>
          </div>
        </div>
        {#if m.mail}<p class="petit">{m.mail}</p>{/if}
        <p class="texte">{m.message}</p>
      </div>
    {:else}
      <p class="second">Aucun message.</p>
    {/each}
  </div>
{/if}

<style>
  .onglets { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .onglets [aria-selected='true'] { border-color: var(--accent); background: var(--accent-doux); }
  .ligne { padding: 0.75rem 0; border-bottom: 1px solid var(--trait); }
  .ligne:last-child { border-bottom: 0; }
  .tete { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .actions { display: flex; gap: 0.5rem; }
  .texte { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
