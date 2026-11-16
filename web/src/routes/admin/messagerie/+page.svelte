<script lang="ts">
  // Administration : conversations avec les sources (chiffrées de bout en bout).
  import { get } from '#lib/api.ts';
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import { message } from '#lib/erreurs.ts';

  interface Conv { id: string; video: string; pseudonyme: string; ouverte: boolean; dernier: string; nonLu: boolean }
  let conversations = $state<Conv[] | null>(null);
  let erreur = $state('');
  const charger = () => get<{ conversations: Conv[] }>('/admin/messagerie').then((r) => (conversations = r.conversations))
    .catch((x) => (erreur = message(x)));
</script>

<svelte:head><title>Messagerie des sources — Administration — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <PorteAdmin>
    {#await charger() then}
      <span class="surtitre">Administration</span>
      <h1>Messagerie des sources</h1>
      {#if erreur}<div class="message erreur">{erreur}</div>{/if}
      {#if conversations?.length}
        <ul class="liste">
          {#each conversations as c (c.id)}
            <li><a class="carte ligne" href="/admin/messagerie/{c.id}">
              <span><strong>Source de {c.pseudonyme}</strong>{#if c.nonLu} <span class="pastille accent">nouveau</span>{/if}
                {#if !c.ouverte} <span class="pastille">fermée</span>{/if}</span>
              <span class="petit discret">{new Date(c.dernier).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</span>
            </a></li>
          {/each}
        </ul>
      {:else if conversations}
        <div class="carte"><p class="second">Aucune conversation.</p></div>
      {/if}
    {/await}
  </PorteAdmin>
</div>

<style>
  .liste { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
  .ligne { display: flex; justify-content: space-between; align-items: center; gap: 1rem; text-decoration: none; color: inherit; margin: 0; }
  .ligne:hover { border-color: var(--accent); }
</style>
