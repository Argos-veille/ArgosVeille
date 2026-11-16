<script lang="ts">
  // Aperçu de la carte sur l'accueil : la France métropolitaine et les vidéos publiées (points), sans
  // interaction ; un clic ouvre la vraie carte. Suit le thème clair / sombre.
  import { onDestroy, onMount } from 'svelte';
  import { get } from '#lib/api.ts';
  import { changerTheme, creerCarte, maplibregl } from '#lib/carte.ts';
  import { theme } from '#lib/theme.svelte.ts';

  let { nombre = $bindable(null) }: { nombre?: number | null } = $props();
  const COULEURS = { violence: '#C2410C', abuse: '#2459A8' } as const;
  const METROPOLE: [[number, number], [number, number]] = [[-5.2, 41.3], [9.6, 51.15]];
  let conteneur: HTMLDivElement | undefined = $state();
  let carte: maplibregl.Map | undefined;
  $effect(() => { const sombre = theme.valeur === 'sombre'; if (carte) changerTheme(carte, sombre); });

  onMount(() => {
    carte = creerCarte(conteneur!, { sombre: theme.valeur === 'sombre' });
    carte.fitBounds(METROPOLE, { padding: 10, duration: 0 });
    for (const h of ['scrollZoom', 'boxZoom', 'dragRotate', 'dragPan', 'keyboard', 'doubleClickZoom', 'touchZoomRotate'] as const) carte[h].disable();
    carte.on('load', async () => {
      carte!.addSource('videos', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      carte!.addLayer({ id: 'points', type: 'circle', source: 'videos',
        paint: { 'circle-color': ['match', ['get', 'categorie'], 'violence', COULEURS.violence, COULEURS.abuse],
                 'circle-radius': 5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } });
      try {
        const { videos } = await get<{ videos: { lat: number; lon: number; categorie: string }[] }>('/public/videos');
        nombre = videos.length;
        (carte!.getSource('videos') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection',
          features: videos.map((v) => ({ type: 'Feature', properties: { categorie: v.categorie }, geometry: { type: 'Point', coordinates: [v.lon, v.lat] } })) });
      } catch { /* aperçu sans points : la carte reste accessible */ }
    });
    new ResizeObserver(() => carte?.resize()).observe(conteneur!);
  });
  onDestroy(() => carte?.remove());
</script>

<a class="apercu" href="/carte" aria-label="Ouvrir la carte des vidéos vérifiées">
  <div class="fond" bind:this={conteneur} aria-hidden="true"></div>
  <span class="etiquette-carte">Voir la carte →</span>
</a>

<style>
  .apercu { position: relative; display: block; height: 22rem; border: 1px solid var(--trait); border-radius: var(--rayon-grand);
            overflow: hidden; text-decoration: none; }
  .apercu:hover, .apercu:focus-visible { border-color: var(--accent); }
  .fond { position: absolute; inset: 0; pointer-events: none; }
  .fond :global(.maplibregl-ctrl-attrib) { pointer-events: auto; }
  .etiquette-carte { position: absolute; left: 1rem; bottom: 1rem; padding: 0.5rem 0.875rem; border-radius: var(--rayon);
                     background: var(--texte); color: var(--fond); font-weight: 700; font-size: 0.9375rem; }
  @media (max-width: 52rem) { .apercu { height: 16rem; } }
</style>
