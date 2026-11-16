<script lang="ts">
  import { onMount } from 'svelte';
  import { changerStatutBug, rapportBug, STATUTS_BUG, themesBug, type DetailBug, type StatutBug, type ThemeBug } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  let { id }: { id: string } = $props();

  let b = $state<DetailBug | null>(null);
  let themes = $state<ThemeBug[]>([]);
  let erreur = $state('');
  let copie = $state(false);

  const theme = $derived(themes.find((x) => x.cle === b?.theme));
  const quand = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });

  async function statut(s: StatutBug) {
    try {
      await changerStatutBug(id, s);
      b!.statut = s;
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    }
  }

  /** Le rapport en texte, à copier. */
  async function copier() {
    if (!b) return;
    const texte = [`Rapport de bug ${b.id} (${quand(b.le)})`, `Thème : ${b.theme} / ${b.precis}${b.urgent ? ' (URGENT)' : ''}`,
      `Page : ${b.page}${b.pageSource ? ' (page des sources)' : ''}`, `Compte : ${b.pseudo ?? 'anonyme'}`, '', b.description, '',
      `Télémétrie : ${JSON.stringify(b.telemetrie, null, 2)}`,
      ...b.erreursServeur.map((e) => `\nErreur serveur ${e.request_id} — ${e.method} ${e.route}\n${e.error_name}: ${e.message}\n${e.stack}`)]
      .join('\n');
    await navigator.clipboard.writeText(texte);
    copie = true;
    setTimeout(() => (copie = false), 2000);
  }

  onMount(async () => {
    themesBug().then((r) => (themes = r.themes)).catch(() => {});
    try {
      b = await rapportBug(id);
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    }
  });
</script>

{#if erreur}<div class="message erreur">{erreur}</div>{/if}

{#if b}
  <div class="carte">
    <div class="entete">
      <div>
        {#if b.urgent}<span class="pastille urgent">Urgent</span>{/if}
        <strong>{theme?.libelle ?? b.theme}</strong> · {theme?.precis.find((p) => p.cle === b!.precis)?.libelle ?? b.precis}
        <div class="petit discret">{quand(b.le)} · {b.page}{b.pageSource ? ' (page des sources)' : ''} · {b.pseudo ?? 'anonyme'}</div>
      </div>
      <span class="pastille">{STATUTS_BUG[b.statut]}</span>
    </div>
    <p class="description">{b.description}</p>
    <div class="boutons">
      {#if b.statut === 'open'}<button class="bouton principal" onclick={() => statut('handled')}>Marquer comme traité</button>{/if}
      {#if b.statut === 'open'}<button class="bouton" onclick={() => statut('dismissed')}>Écarter</button>{/if}
      {#if b.statut !== 'open'}<button class="bouton" onclick={() => statut('open')}>Rouvrir</button>{/if}
      <button class="bouton" onclick={copier}>{copie ? 'Copié' : 'Copier le rapport'}</button>
    </div>
  </div>

  {#if b.capture}
    <h2>Capture d’écran</h2>
    <img class="capture" src={b.capture} alt="Capture jointe au rapport" />
  {/if}

  <h2>Erreurs du serveur liées</h2>
  {#each b.erreursServeur as e (e.request_id)}
    <div class="carte erreur-serveur">
      <div class="petit discret">{quand(e.created_at)} · {e.method} {e.route} · requête {e.request_id}</div>
      <strong>{e.error_name} : {e.message}</strong>
      <pre>{e.stack}</pre>
    </div>
  {:else}
    <p class="second">Aucune.</p>
  {/each}

  <h2>Télémétrie</h2>
  <pre class="carte">{JSON.stringify(b.telemetrie, null, 2) ?? 'aucune'}</pre>
{/if}

<style>
  .entete { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; flex-wrap: wrap; }
  .entete > .pastille { white-space: nowrap; flex: none; }
  .description { white-space: pre-line; margin: 1rem 0 0; }
  .capture { max-width: 100%; border: 1px solid var(--trait); border-radius: var(--rayon); }
  pre { font-family: var(--police-mono); font-size: 0.8125rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  .erreur-serveur { margin-bottom: 0.75rem; }
  .pastille.urgent { background: var(--danger-doux); color: var(--danger); border-color: var(--danger); margin-right: 0.5rem; }
  h2 { margin-top: 2rem; }
</style>
