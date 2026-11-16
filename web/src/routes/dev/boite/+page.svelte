<script lang="ts">
  // Développement seulement : SMS et mails écrits par le faux facteur local de l'API.
  import { dev } from '$app/env';
  import { onMount } from 'svelte';
  import { get } from '#lib/api.ts';

  type Envoi = Record<string, string>;
  let boite = $state<{ sms: Envoi[]; mails: Envoi[] } | null>(null);
  let erreur = $state('');

  async function charger() {
    try {
      boite = await get('/dev/boite');
    } catch {
      erreur = 'La boîte de développement n’est pas disponible (API en production, ou arrêtée).';
    }
  }
  onMount(() => { if (dev) void charger(); });
  // Un lien du mail, rendu cliquable vers le site local.
  const liens = (t: string) => t.match(/https?:\/\/\S+/g) ?? [];
</script>

<svelte:head><title>Boîte de développement — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">Développement</span>
  <h1>Boîte de développement</h1>
  <p class="second">Les SMS et mails que l’API enverrait. Cette page n’existe pas en production.</p>
  <button class="bouton" onclick={charger}>Rafraîchir</button>
  {#if erreur}<div class="message erreur">{erreur}</div>{/if}
  {#if boite}
    <h2>SMS</h2>
    {#each boite.sms as s, i (i)}
      <div class="carte"><div class="petit discret">{s['date']} · {s['numero']}</div><p>{s['texte']}</p></div>
    {:else}<p class="discret">Aucun SMS.</p>{/each}
    <h2>Mails</h2>
    {#each boite.mails as m, i (i)}
      <div class="carte">
        <div class="petit discret">{m['date']} · {m['adresse']}</div>
        <h3>{m['sujet']}</h3>
        <pre>{m['texte']}</pre>
        {#each liens(m['texte'] ?? '') as l (l)}<a class="bouton" href={l}>Ouvrir le lien</a>{/each}
      </div>
    {:else}<p class="discret">Aucun mail.</p>{/each}
  {/if}
</div>

<style>
  h2 { margin-top: 2rem; }
  pre { white-space: pre-wrap; font-family: var(--police); color: var(--texte-2); }
</style>
