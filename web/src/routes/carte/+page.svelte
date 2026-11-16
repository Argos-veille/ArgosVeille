<script lang="ts">
  // Carte publique des vidéos publiées. À la première ouverture : avertissement sur les contenus
  // (« J’ai compris » gardé dans ce navigateur : plus d’avertissement ensuite). Points regroupés quand on dézoome, couleur
  // selon la nature des faits ; un clic ouvre un résumé et le lien vers la fiche.
  import Manque from '#lib/composants/Manque.svelte';
  import RechercheAdresse from '#lib/composants/RechercheAdresse.svelte';
  import { onDestroy, onMount } from 'svelte';
  import { get } from '#lib/api.ts';
  import { changerTheme, creerCarte, maplibregl } from '#lib/carte.ts';
  import { message } from '#lib/erreurs.ts';
  import { CATEGORIES, FORCES, SITUATIONS, SOUS_CATEGORIES, libellesChoix } from '#lib/libelles.ts';
  import { theme } from '#lib/theme.svelte.ts';

  interface Point { id: string; nom: string | null; lat: number; lon: number; date: string; categorie: string; sousCategorie: string; sousCategories: string[]; forces: string; situation: string; situations: string[] }

  const CLE_AVERTISSEMENT = 'argos-avertissement-carte';
  const COULEURS = { violence: '#C2410C', abuse: '#2459A8' } as const;
  let conteneur: HTMLDivElement | undefined = $state();
  let dialogue: HTMLDialogElement | undefined = $state();
  let carte: maplibregl.Map | undefined;
  // Le thème du site change (bouton clair/sombre) : la carte suit, sans être rechargée.
  $effect(() => { const sombre = theme.valeur === 'sombre'; if (carte) changerTheme(carte, sombre); });
  let categorie = $state('');
  let periode = $state('tout');
  let forces = $state('');
  let situation = $state('');
  let du = $state('');          // AAAA-MM-JJ
  let au = $state('');
  let heure = $state('');       // 0 à 23 : à une heure près
  let nombre = $state<number | null>(null);
  // Recherche d'une vidéo par son nom (« Loutre-Ambre-1203 ») parmi celles affichées.
  let points: Point[] = [];
  let recherche = $state('');
  let introuvable = $state(false);
  let erreur = $state('');

  // Raccourcis vers les territoires (l'outre-mer n'est pas dans le cadre de la métropole).
  const TERRITOIRES: [string, [number, number], number][] = [
    ['Corse', [9.1, 42.15], 7], ['Guadeloupe', [-61.55, 16.2], 8.5],
    ['Martinique', [-61.0, 14.65], 9], ['Guyane', [-53.1, 4.0], 6.3], ['La Réunion', [55.53, -21.12], 8.7],
    ['Mayotte', [45.15, -12.82], 9.5], ['Nouvelle-Calédonie', [165.6, -21.3], 6.3], ['Polynésie', [-149.5, -17.6], 8.5],
  ];
  const METROPOLE: [[number, number], [number, number]] = [[-5.2, 41.3], [9.6, 51.15]];
  let observateur: ResizeObserver | undefined;
  const jour = (d: string) => new Date(`${d}T12:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  async function charger() {
    erreur = '';
    const q = new URLSearchParams({ periode, ...(categorie ? { categorie } : {}), ...(forces ? { forces } : {}),
      ...(situation ? { situation } : {}), ...(du ? { du } : {}), ...(au ? { au } : {}), ...(heure ? { heure } : {}) });
    try {
      const { videos } = await get<{ videos: Point[] }>(`/public/videos?${q}`);
      nombre = videos.length;
      points = videos;
      (carte?.getSource('videos') as maplibregl.GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: videos.map((v) => ({ type: 'Feature', properties: v, geometry: { type: 'Point', coordinates: [v.lon, v.lat] } })),
      });
    } catch (x) {
      erreur = message(x);
    }
  }

  function resume(p: Point) {
    const div = document.createElement('div');
    div.className = 'resume';
    const lignes: [string, string][] = [
      ['', p.nom ?? ''], ['', `${CATEGORIES[p.categorie] ?? ''} · ${libellesChoix(p.sousCategories, SOUS_CATEGORIES)}`],
      ['Date', jour(p.date)], ['Forces', FORCES[p.forces] ?? ''], ['Situation', libellesChoix(p.situations, SITUATIONS)],
    ];
    for (const [t, v] of lignes) {
      const l = document.createElement('p');
      if (t) { const b = document.createElement('span'); b.textContent = `${t} : `; l.append(b); }
      l.append(v);   // textContent : aucun HTML venu des données
      div.append(l);
    }
    const a = Object.assign(document.createElement('a'), { href: `/videos/${p.id}`, textContent: 'Voir la fiche →' });
    div.append(a);
    const n = document.createElement('p');
    n.className = 'allegue';
    n.textContent = 'Faits allégués, non jugés.';
    div.append(n);
    return div;
  }

  let bulle: maplibregl.Popup | undefined;
  function montrer(p: Point, ou: [number, number]) {
    bulle?.remove();
    bulle = new maplibregl.Popup({ offset: 12, maxWidth: '18rem' }).setLngLat(ou).setDOMContent(resume(p)).addTo(carte!);
  }
  const simple = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function chercher(e: SubmitEvent) {
    e.preventDefault();
    const q = simple(recherche);
    const p = q ? points.find((x) => simple(x.nom ?? '') === q) ?? points.find((x) => simple(x.nom ?? '').includes(q)) : undefined;
    introuvable = !p;
    if (!p || !carte) return;
    carte.flyTo({ center: [p.lon, p.lat], zoom: Math.max(carte.getZoom(), 13) });
    carte.once('moveend', () => montrer(p, [p.lon, p.lat]));
  }

  function ouvrirCarte() {
    carte = creerCarte(conteneur!, { sombre: theme.valeur === 'sombre' });
    carte.fitBounds(METROPOLE, { padding: 20, duration: 0 });
    // La zone de la carte prend sa taille définitive après coup : on suit ses changements.
    observateur = new ResizeObserver(() => carte?.resize());
    observateur.observe(conteneur!);
    carte.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    carte.on('load', () => {
      carte!.addSource('videos', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, cluster: true, clusterRadius: 45, clusterMaxZoom: 13 });
      carte!.addLayer({ id: 'groupes', type: 'circle', source: 'videos', filter: ['has', 'point_count'],
        paint: { 'circle-color': '#1F2328', 'circle-opacity': 0.85, 'circle-stroke-color': '#E8A33D', 'circle-stroke-width': 3,
                 'circle-radius': ['step', ['get', 'point_count'], 16, 10, 22, 50, 30] } });
      carte!.addLayer({ id: 'groupes-nombre', type: 'symbol', source: 'videos', filter: ['has', 'point_count'],
        layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Medium'], 'text-size': 13 },
        paint: { 'text-color': '#ffffff' } });
      carte!.addLayer({ id: 'points', type: 'circle', source: 'videos', filter: ['!', ['has', 'point_count']],
        paint: { 'circle-color': ['match', ['get', 'categorie'], 'violence', COULEURS.violence, COULEURS.abuse],
                 'circle-radius': 8, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
      carte!.on('click', 'groupes', async (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const zoom = await (carte!.getSource('videos') as maplibregl.GeoJSONSource).getClusterExpansionZoom(f.properties['cluster_id'] as number);
        carte!.easeTo({ center: (f.geometry as { coordinates: [number, number] }).coordinates, zoom });
      });
      carte!.on('click', 'points', (e) => {
        const f = e.features?.[0];
        if (f) montrer(f.properties as unknown as Point, (f.geometry as { coordinates: [number, number] }).coordinates);
      });
      for (const c of ['groupes', 'points']) {
        carte!.on('mouseenter', c, () => (carte!.getCanvas().style.cursor = 'pointer'));
        carte!.on('mouseleave', c, () => (carte!.getCanvas().style.cursor = ''));
      }
      void charger();
    });
  }

  onMount(() => {
    let prevenu = false;
    try { prevenu = localStorage.getItem(CLE_AVERTISSEMENT) === '1'; } catch { /* stockage indisponible : on prévient */ }
    if (prevenu) ouvrirCarte();
    else dialogue?.showModal();
  });
  onDestroy(() => { observateur?.disconnect(); carte?.remove(); });

  function accepter() {
    try { localStorage.setItem(CLE_AVERTISSEMENT, '1'); } catch { /* pour cette visite seulement */ }
    dialogue?.close();
    ouvrirCarte();
  }
</script>

<svelte:head><title>Carte — Argos Veille</title></svelte:head>

<dialog bind:this={dialogue} class="avertissement" aria-labelledby="titre-avertissement" oncancel={(e) => e.preventDefault()}>
  <h2 id="titre-avertissement">Avant d’ouvrir la carte</h2>
  <p>Ces vidéos peuvent montrer des <strong>violences réelles</strong>. Certaines images peuvent choquer.</p>
  <p class="second">Visages floutés, aucune lecture automatique. Faits allégués, non jugés.</p>
  <div class="boutons">
    <button class="bouton principal" onclick={accepter}>J’ai compris, voir la carte</button>
    <a class="bouton lien" href="/">Revenir à l’accueil</a>
  </div>
</dialog>

<div class="page-carte">
  <div class="panneau">
    <h1>La carte</h1>
    <p class="petit second">{nombre === null ? 'Chargement…' : `${nombre} vidéo${nombre > 1 ? 's' : ''} publiée${nombre > 1 ? 's' : ''}`}</p>
    <form class="recherche" onsubmit={chercher}>
      <label for="recherche-video">Nom de la vidéo</label>
      <div class="ligne-recherche">
        <input id="recherche-video" bind:value={recherche} oninput={() => (introuvable = false)} placeholder="Loutre-Ambre-1203"
               autocomplete="off" spellcheck="false" />
        <Manque raisons={[!recherche.trim() && 'un texte à chercher']}><button class="bouton" disabled={!recherche.trim()}>Chercher</button></Manque>
      </div>
      {#if introuvable}<span class="petit erreur-texte">Aucune vidéo publiée de ce nom avec ces filtres.</span>{/if}
    </form>
    <RechercheAdresse onchoisir={(r) => carte?.flyTo({ center: [r.lon, r.lat], zoom: 15 })} />
    <div class="filtres">
      <label>Nature
        <select bind:value={categorie} onchange={charger}>
          <option value="">Toutes</option>
          {#each Object.entries(CATEGORIES) as [cle, texte] (cle)}<option value={cle}>{texte}</option>{/each}
        </select>
      </label>
      <label>Période
        <select bind:value={periode} onchange={charger}>
          <option value="7j">7 derniers jours</option><option value="30j">30 derniers jours</option>
          <option value="1an">12 derniers mois</option><option value="tout">Depuis le début</option>
        </select>
      </label>
      <label>Forces
        <select bind:value={forces} onchange={charger}>
          <option value="">Toutes</option>
          {#each Object.entries(FORCES) as [cle, texte] (cle)}<option value={cle}>{texte}</option>{/each}
        </select>
      </label>
      <label>Situation
        <select bind:value={situation} onchange={charger}>
          <option value="">Toutes</option>
          {#each Object.entries(SITUATIONS) as [cle, texte] (cle)}<option value={cle}>{texte}</option>{/each}
        </select>
      </label>
      <div class="deux">
        <label>Du <input type="date" bind:value={du} onchange={charger} max={au || undefined} /></label>
        <label>Au <input type="date" bind:value={au} onchange={charger} min={du || undefined} /></label>
      </div>
      <label>Heure (à 1 h près)
        <select bind:value={heure} onchange={charger}>
          <option value="">Toutes</option>
          {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}<option value={String(h)}>vers {h} h</option>{/each}
        </select>
      </label>
      {#if situation || du || au || heure || categorie || forces || periode !== 'tout'}
        <button class="bouton lien petit" onclick={() => { categorie = forces = situation = du = au = heure = ''; periode = 'tout'; void charger(); }}>
          Effacer les filtres</button>
      {/if}
    </div>
    <div class="territoires" aria-label="Aller à">
      <button class="bouton lien petit" onclick={() => carte?.fitBounds(METROPOLE, { padding: 20 })}>Métropole</button>
      {#each TERRITOIRES as [nom, centre, zoom] (nom)}
        <button class="bouton lien petit" onclick={() => carte?.flyTo({ center: centre, zoom })}>{nom}</button>
      {/each}
    </div>
    <ul class="legende">
      <li><span style:background={COULEURS.violence}></span>{CATEGORIES['violence']}</li>
      <li><span style:background={COULEURS.abuse}></span>{CATEGORIES['abuse']}</li>
    </ul>
    {#if erreur}<div class="message erreur">{erreur}</div>{/if}
    <p class="petit"><a href="/en-debat">Vidéos en débat</a> · <a href="/journal">Journal public</a></p>
    <p class="petit discret">Faits allégués, non jugés. Lieux arrondis (à 100 m ou à la commune).</p>
  </div>
  <div class="carte-publique" bind:this={conteneur} role="application" aria-label="Carte des vidéos publiées"></div>
</div>

<style>
  .page-carte { display: grid; grid-template-columns: 19rem 1fr; height: calc(100vh - 4rem); margin-top: -2.5rem; margin-bottom: -4rem; }
  @media (max-width: 52rem) { .page-carte { grid-template-columns: 1fr; grid-template-rows: auto 70vh; height: auto; } }
  .panneau { padding: 1.25rem; border-right: 1px solid var(--trait); background: var(--surface); overflow: auto; }
  .panneau h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .filtres { display: grid; gap: 0.75rem; margin: 1rem 0; }
  .recherche { display: grid; gap: 0.25rem; margin: 1rem 0 0; }
  .deux { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
  .deux input { min-width: 0; width: 100%; }
  .recherche label { font-size: 0.875rem; font-weight: 600; }
  .ligne-recherche { display: flex; gap: 0.5rem; }
  .ligne-recherche input { flex: 1; min-width: 0; }
  .erreur-texte { color: var(--danger); }
  .filtres label { display: grid; gap: 0.25rem; font-size: 0.875rem; font-weight: 600; }
  .territoires { display: flex; flex-wrap: wrap; gap: 0.125rem 0.75rem; margin: 0 0 1rem; }
  .legende { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; gap: 0.375rem; font-size: 0.875rem; }
  .legende span { display: inline-block; width: 0.875rem; height: 0.875rem; border-radius: 50%; margin-right: 0.5rem; vertical-align: -2px; border: 2px solid #fff; box-shadow: 0 0 0 1px var(--trait-fort); }
  .carte-publique { width: 100%; height: 100%; min-height: 20rem; }
  .carte-publique :global(.maplibregl-popup-content) { background: var(--surface); color: var(--texte); border-radius: var(--rayon); padding: 0.75rem 1rem; font-family: var(--police); }
  .carte-publique :global(.maplibregl-popup-tip) { border-top-color: var(--surface); border-bottom-color: var(--surface); }
  .carte-publique :global(.resume p) { margin: 0 0 0.25rem; font-size: 0.875rem; }
  .carte-publique :global(.resume span) { color: var(--texte-3); }
  .carte-publique :global(.resume a) { font-weight: 600; display: inline-block; margin-top: 0.25rem; }
  .carte-publique :global(.resume .allegue) { color: var(--texte-3); font-size: 0.75rem; margin-top: 0.375rem; }
  .avertissement { width: min(32rem, calc(100vw - 2rem)); border: 1px solid var(--trait); border-radius: var(--rayon-grand);
                   padding: 1.75rem; background: var(--surface); color: var(--texte); box-shadow: var(--ombre); }
  .avertissement::backdrop { background: rgb(18 20 23 / 0.75); }
  .avertissement h2 { border-left: 4px solid var(--accent); padding-left: 0.75rem; }
</style>
