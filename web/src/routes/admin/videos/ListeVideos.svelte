<script lang="ts">
  // Liste des vidéos de l'administration, filtrée côté serveur. Les filtres vivent dans l'adresse
  // (lien partageable, retour arrière qui les garde).
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { STATUTS_VIDEO, tonStatut, videosAdmin, type VideoListe } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { CATEGORIES, FORCES, SOUS_CATEGORIES, libellesChoix } from '#lib/libelles.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  const PAR_CATEGORIE: Record<string, string[]> = {
    violence: ['strikes', 'disproportionate_force', 'weapons', 'chokehold', 'other_violence'],
    abuse: ['contested_arrest', 'discriminatory_stop', 'insults', 'intimidation', 'filming_obstruction', 'property_destruction',
            'complaint_refused', 'other_abuse'],
  };
  const CHAMPS = ['statut', 'categorie', 'sousCategorie', 'forces', 'du', 'au', 'signalees', 'gel', 'texte'] as const;
  type Champ = (typeof CHAMPS)[number];

  let videos = $state<VideoListe[] | null>(null);
  let erreur = $state('');
  // Formulaire, initialisé depuis l'adresse.
  const lus = () => Object.fromEntries(CHAMPS.map((c) => [c, page.url.searchParams.get(c) ?? ''])) as Record<Champ, string>;
  let f = $state(lus());
  const sousCategories = $derived(f.categorie ? PAR_CATEGORIE[f.categorie] ?? [] : Object.keys(SOUS_CATEGORIES));
  const actifs = $derived(CHAMPS.filter((c) => f[c]).length);
  const quand = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });

  function appliquer() {
    if (f.sousCategorie && !sousCategories.includes(f.sousCategorie)) f.sousCategorie = '';
    const q = new URLSearchParams(CHAMPS.filter((c) => f[c].trim()).map((c) => [c, f[c].trim()]));
    goto(`/admin/videos${q.size ? `?${q}` : ''}`, { replace: true });
  }
  function effacer() {
    f = Object.fromEntries(CHAMPS.map((c) => [c, ''])) as Record<Champ, string>;
    appliquer();
  }
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  function saisie() {   // recherche texte : on attend la fin de la frappe
    clearTimeout(minuterie);
    minuterie = setTimeout(appliquer, 400);
  }

  $effect(() => {
    const q = page.url.searchParams.toString();
    videosAdmin(q).then((r) => { videos = r.videos; erreur = ''; })
      .catch((x) => { if (!sessionExpiree(x)) erreur = message(x); });
  });
</script>

<form class="carte filtres" onsubmit={(e) => { e.preventDefault(); appliquer(); }}>
  <label class="large">Recherche
    <input type="search" bind:value={f.texte} oninput={saisie} maxlength="100" placeholder="Pseudonyme, mot de la description ou identifiant" />
  </label>
  <label>Statut
    <select bind:value={f.statut} onchange={appliquer}>
      <option value="">Tous</option>
      {#each Object.entries(STATUTS_VIDEO) as [cle, texte] (cle)}<option value={cle}>{texte}</option>{/each}
    </select>
  </label>
  <label>Nature
    <select bind:value={f.categorie} onchange={appliquer}>
      <option value="">Toutes</option>
      {#each Object.entries(CATEGORIES) as [cle, texte] (cle)}<option value={cle}>{texte}</option>{/each}
    </select>
  </label>
  <label>Précision
    <select bind:value={f.sousCategorie} onchange={appliquer}>
      <option value="">Toutes</option>
      {#each sousCategories as cle (cle)}<option value={cle}>{SOUS_CATEGORIES[cle]}</option>{/each}
    </select>
  </label>
  <label>Forces
    <select bind:value={f.forces} onchange={appliquer}>
      <option value="">Toutes</option>
      {#each Object.entries(FORCES) as [cle, texte] (cle)}<option value={cle}>{texte}</option>{/each}
    </select>
  </label>
  <label>Envoyée du
    <input type="date" bind:value={f.du} onchange={appliquer} />
  </label>
  <label>au
    <input type="date" bind:value={f.au} onchange={appliquer} />
  </label>
  <div class="cases">
    <label class="case"><input type="checkbox" checked={f.signalees === 'true'}
      onchange={(e) => { f.signalees = e.currentTarget.checked ? 'true' : ''; appliquer(); }} /> Avec un signalement ouvert</label>
    <label class="case"><input type="checkbox" checked={f.gel === 'true'}
      onchange={(e) => { f.gel = e.currentTarget.checked ? 'true' : ''; appliquer(); }} /> Sous gel légal</label>
  </div>
  {#if actifs}<button type="button" class="bouton lien" onclick={effacer}>Effacer les filtres ({actifs})</button>{/if}
</form>

{#if erreur}<div class="message erreur">{erreur}</div>{/if}
{#if videos}
  <p class="petit discret">{videos.length} vidéo{videos.length > 1 ? 's' : ''}{videos.length === 300 ? ' (les 300 plus récentes : affinez les filtres)' : ''}</p>
  {#each videos as v (v.id)}
    <a class="carte ligne" href="/admin/videos/{v.id}">
      <div>
        <span class="pastille {tonStatut(v.statut)}">{STATUTS_VIDEO[v.statut] ?? v.statut}</span>
        {#if v.signalements}<span class="pastille rouge">{v.signalements} signalement{v.signalements > 1 ? 's' : ''}</span>{/if}
        {#if v.gelLegal}<span class="pastille accent">Gel légal</span>{/if}
        <strong>{v.categorie ? CATEGORIES[v.categorie] : 'Nature non précisée'}{#if v.sousCategorie}{' · '}{libellesChoix(v.sousCategories, SOUS_CATEGORIES)}{/if}</strong>
        <div class="second petit">{v.extrait ?? ''}</div>
        <div class="petit discret">{v.pseudonyme ?? '—'}{#if v.forces} · {FORCES[v.forces]}{/if} · envoyée le {quand(v.envoyeeLe)}{#if v.decideeLe} · décidée le {quand(v.decideeLe)}{/if}</div>
      </div>
    </a>
  {:else}
    <div class="carte"><p class="second">Aucune vidéo ne correspond.</p></div>
  {/each}
{/if}

<style>
  .filtres { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: 0.75rem 1rem; align-items: end; margin-bottom: 1rem; }
  .filtres label:not(.case) { display: grid; gap: 0.25rem; font-size: 0.875rem; font-weight: 600; }
  .filtres .large { grid-column: 1 / -1; }
  .cases { display: grid; gap: 0.25rem; font-size: 0.875rem; }
  .ligne { display: block; margin-bottom: 0.75rem; color: var(--texte); text-decoration: none; }
  .ligne:hover { border-color: var(--trait-fort); }
  .ligne strong { margin-left: 0.25rem; }
  .pastille { margin-right: 0.25rem; }
  .pastille.rouge { background: var(--danger-doux); color: var(--danger); border-color: var(--danger); }
</style>
