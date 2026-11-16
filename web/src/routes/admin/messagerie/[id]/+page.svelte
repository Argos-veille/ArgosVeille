<script lang="ts">
  // Administration : une conversation avec la source d'une vidéo.
  import { surveiller } from '#lib/surveiller.ts';
  import { page } from '$app/state';
  import type { MessageChiffre } from 'argos-navigateur';
  import { get, post } from '#lib/api.ts';
  import Conversation, { type MessageRecu } from '#lib/composants/Conversation.svelte';
  import DeverrouillerMessagerie from '#lib/composants/DeverrouillerMessagerie.svelte';
  import PorteAdmin from '#lib/composants/PorteAdmin.svelte';
  import { message } from '#lib/erreurs.ts';
  import { cleMessagerie } from '#lib/session.svelte.ts';

  interface Detail { id: string; ouverte: boolean; cleAutre: string | null; messages: MessageRecu[]; video: string; pseudonyme: string }
  let d = $state<Detail | null>(null);
  let erreur = $state('');
  const id = $derived(page.params.id!);
  const charger = async () => { try { d = await get<Detail>(`/admin/messagerie/${id}`); } catch (x) { erreur = message(x); } };
  $effect(() => surveiller(charger, 15_000));   // nouveaux messages sans recharger la page
  const envoyer = async (m: MessageChiffre) => { await post(`/admin/messagerie/${id}`, { message: m }); await charger(); };
</script>

<svelte:head><title>Conversation — Administration — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <p class="petit"><a href="/admin/messagerie">← Messagerie des sources</a>{#if d} · <a href="/admin/videos/{d.video}">Fiche de la vidéo</a>{/if}</p>
  <PorteAdmin>
    {#await charger() then}
      <span class="surtitre">Administration</span>
      <h1>{d ? `Source de ${d.pseudonyme}` : 'Conversation'}</h1>
      <div class="blocs">
        {#if erreur}<div class="message erreur">{erreur}</div>{/if}
        {#if d}
          {#if !cleMessagerie.ouverte}
            <DeverrouillerMessagerie ouverte={() => {}} />
          {:else}
            <Conversation conversation={d.id} moi="verified" cle={cleMessagerie.ouverte} cleAutre={d.cleAutre} messages={d.messages}
                          ouverte={d.ouverte} nomAutre="La source" {envoyer} />
          {/if}
        {/if}
      </div>
    {/await}
  </PorteAdmin>
</div>

<style>
  .blocs { display: grid; gap: 1.25rem; }
</style>
