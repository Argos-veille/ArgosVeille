<script lang="ts">
  // Conversation avec l'administration : elle écrit la première, vous répondez ici. Votre adresse mail
  // ne lui est jamais montrée.
  import Manque from '#lib/composants/Manque.svelte';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { surveiller } from '#lib/surveiller.ts';
  import { ErreurApi, get, post } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';
  import { rafraichir, session } from '#lib/session.svelte.ts';

  interface Message { id: string; deLAdmin: boolean; texte: string; le: string; luLe: string | null }
  let messages = $state<Message[] | null>(null);
  let texte = $state('');
  let enCours = $state(false);
  let erreur = $state('');
  const quand = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

  // Comptes vérifiés (journaliste, avocat, association) : leurs conversations avec des sources.
  interface ConvSource { id: string; video: string; pseudonyme: string; ouverte: boolean; dernier: string; nonLu: boolean }
  let sources = $state<ConvSource[] | null>(null);
  // Source qui a envoyé avec son compte : les conversations au sujet de ses vidéos (lues dans le suivi de chacune).
  interface ConvVideo { video: string; pseudonyme: string; conversations: number; nonLus: number; dernier: string }
  let mesVideos = $state<ConvVideo[]>([]);
  const verifie = $derived(!!session.moi?.messagerieSources && session.moi.messagerieSources.statut !== 'admin');

  async function charger() {
    try {
      if (!session.chargee) await rafraichir();   // savoir qui est connecté avant de choisir quoi charger
      if (session.moi?.messagerieSources && session.moi.messagerieSources.statut !== 'admin') {
        sources = (await get<{ conversations: ConvSource[] }>('/messagerie')).conversations;
      }
      mesVideos = (await get<{ videos: ConvVideo[] }>('/compte/messagerie-videos')).videos;
      messages = (await get<{ messages: Message[] }>('/compte/messages')).messages;
      void rafraichir();   // le compteur de messages non lus repasse à zéro
    } catch (x) {
      if (x instanceof ErreurApi && x.statut === 401) return goto('/connexion');
      erreur = message(x);
    }
  }
  async function repondre(e: SubmitEvent) {
    e.preventDefault();
    erreur = ''; enCours = true;
    try {
      await post('/compte/messages', { texte: texte.trim() });
      texte = '';
      await charger();
    } catch (x) {
      erreur = message(x);
    } finally {
      enCours = false;
    }
  }
  onMount(() => { void charger(); return surveiller(charger, 30_000); });   // nouvelles conversations sans recharger
</script>

<svelte:head><title>Messages — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">Messagerie</span>
  <h1>Messages</h1>
  <div class="blocs">
  {#if verifie}
    <section class="blocs">
      <h2>Sources</h2>
      <p class="second intro">Vos échanges avec les sources des vidéos, chiffrés de bout en bout. Pour en commencer un, ouvrez la
        fiche publique d’une vidéo dont la source accepte d’être contactée.</p>
      {#if sources?.length}
        <ul class="liste">
          {#each sources as c (c.id)}
            <li><a class="carte ligne" href="/compte/messages/{c.id}">
              <span><strong>Source de {c.pseudonyme}</strong>{#if c.nonLu} <span class="pastille accent">nouveau</span>{/if}
                {#if !c.ouverte} <span class="pastille">fermée</span>{/if}</span>
              <span class="petit discret">{new Date(c.dernier).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</span>
            </a></li>
          {/each}
        </ul>
      {:else if sources}
        <div class="carte"><p class="second">Aucune conversation pour l’instant.</p></div>
      {/if}
    </section>
  {/if}
  {#if mesVideos.length}
    <section class="blocs">
      <h2>Au sujet de vos vidéos</h2>
      <p class="second intro">Des journalistes, avocats, associations ou l’administration vous ont écrit au sujet d’une vidéo envoyée
        avec votre compte. Les messages se lisent dans le suivi de la vidéo.</p>
      <ul class="liste">
        {#each mesVideos as v (v.video)}
          <li><a class="carte ligne" href="/compte/videos/{v.video}">
            <span><strong>{v.pseudonyme}</strong> · {v.conversations} conversation{v.conversations > 1 ? 's' : ''}
              {#if v.nonLus} <span class="pastille accent">{v.nonLus} nouveau{v.nonLus > 1 ? 'x' : ''}</span>{/if}</span>
            <span class="petit discret">{new Date(v.dernier).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</span>
          </a></li>
        {/each}
      </ul>
    </section>
  {/if}
  {#if verifie || mesVideos.length}
    <h2>Administration d’Argos Veille</h2>
  {/if}
  <p class="second intro">L’administration ne voit pas votre adresse mail : elle vous prévient par mail, et vous lui répondez ici.</p>
  {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
  {#if messages}
    {#each messages as m (m.id)}
      <article class="carte bulle" class:admin={m.deLAdmin}>
        <div class="petit discret">{m.deLAdmin ? 'Administration' : 'Vous'} · {quand(m.le)}</div>
        <p>{m.texte}</p>
      </article>
    {:else}
      <div class="carte"><p class="second">Aucun message.</p></div>
    {/each}
    {#if messages.some((m) => m.deLAdmin)}
      <form class="carte" onsubmit={repondre}>
        <div class="champ">
          <label for="reponse">Votre réponse</label>
          <textarea id="reponse" rows="4" maxlength="5000" bind:value={texte}></textarea>
        </div>
        <Manque raisons={[texte.trim().length < 2 && 'un message']}><button class="bouton principal" disabled={enCours || texte.trim().length < 2}>{enCours ? 'Envoi…' : 'Répondre'}</button></Manque>
      </form>
    {/if}
  {/if}
  </div>
</div>

<style>
  /* Même largeur de blocs que « Mon compte ». */
  .blocs { display: grid; gap: 1.25rem; }
  .blocs h2 { margin: 0; }
  .liste { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
  .ligne { display: flex; justify-content: space-between; align-items: center; gap: 1rem; text-decoration: none; color: inherit; margin: 0; }
  .ligne:hover { border-color: var(--accent); }
  .bulle { margin: 0; }
  .intro { margin: 0; }
  .bulle.admin { box-shadow: inset 3px 0 0 var(--accent); }
  .bulle p { margin: 0.375rem 0 0; white-space: pre-line; }
</style>
