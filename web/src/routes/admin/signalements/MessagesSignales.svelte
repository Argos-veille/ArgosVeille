<script lang="ts">
  // Messages signalés par leur destinataire (messagerie avec les sources). Le texte n'apparaît que si la personne a
  // accepté de le montrer ; le site l'a alors vérifié (il ne peut pas avoir été inventé).
  import { get, post } from '#lib/api.ts';
  import { confirmer } from '#lib/confirmer.svelte.ts';
  import { message } from '#lib/erreurs.ts';

  interface Signale { message: string; conversation: string; video: string; pseudonyme: string; de: 'source' | 'compte' | 'administration';
                      compte: string | null; envoyeLe: string; signaleLe: string; texte: string | null; conversationOuverte: boolean }
  let liste = $state<Signale[] | null>(null);
  let erreur = $state('');
  const charger = () => get<{ messages: Signale[] }>('/admin/messages-signales').then((r) => (liste = r.messages)).catch((x) => (erreur = message(x)));
  $effect(() => { void charger(); });
  const quand = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

  async function traiter(s: Signale, fermer: boolean) {
    if (fermer && !(await confirmer({ titre: 'Fermer la conversation ?', texte: 'Plus personne ne pourra y écrire. C’est définitif.',
                                      oui: 'Fermer et classer', ton: 'danger' }))) return;
    try { await post(`/admin/messages-signales/${s.message}/traiter`, { fermer }); await charger(); } catch (x) { erreur = message(x); }
  }
</script>

<section class="messages">
  <h2>Messages signalés</h2>
  {#if erreur}<div class="message erreur">{erreur}</div>{/if}
  {#if liste?.length}
    {#each liste as s (s.message)}
      <article class="carte">
        <div class="petit discret">
          Écrit par {s.de === 'source' ? 'la source' : s.de === 'administration' ? 'l’administration' : `le compte ${s.compte}`}
          · vidéo <a href="/admin/videos/{s.video}">{s.pseudonyme}</a> · envoyé {quand(s.envoyeLe)} · signalé {quand(s.signaleLe)}
        </div>
        {#if s.texte !== null}
          <blockquote>{s.texte}</blockquote>
        {:else}
          <p class="second petit">Texte non montré.</p>
        {/if}
        <div class="boutons">
          <button class="bouton" onclick={() => traiter(s, false)}>Classer</button>
          {#if s.conversationOuverte}<button class="bouton danger" onclick={() => traiter(s, true)}>Fermer la conversation</button>{/if}
          {#if s.de === 'compte' && s.compte}<a class="bouton lien" href="/admin/comptes?texte={encodeURIComponent(s.compte)}">Fiche du compte</a>{/if}
        </div>
      </article>
    {/each}
  {:else if liste}
    <p class="second petit">Aucun message signalé.</p>
  {/if}
</section>

<style>
  .messages { display: grid; gap: 0.75rem; margin-top: 2rem; }
  .messages h2 { margin: 0; }
  blockquote { margin: 0.5rem 0; padding: 0.5rem 0.75rem; border-left: 3px solid var(--danger); background: var(--surface-2);
               white-space: pre-line; overflow-wrap: anywhere; }
</style>
