<script lang="ts">
  // Choisir un lieu sur la carte : un clic place le repère, qu'on peut ensuite déplacer. Le cercle
  // montre ce qui sera gardé selon la précision choisie (le lieu exact n'est jamais conservé s'il
  // n'est pas demandé).
  import { onDestroy, onMount } from 'svelte';
  import { cercle, changerTheme, creerCarte, maplibregl, RAYON_PRECISION as RAYON } from '#lib/carte.ts';
  import { theme } from '#lib/theme.svelte.ts';
  import RechercheAdresse from './RechercheAdresse.svelte';

  let { lieu = $bindable(null), precision = 'approx_100m', suggestion = null }: {
    lieu?: { lat: number; lon: number } | null;
    precision?: 'exact' | 'approx_100m' | 'municipality';
    suggestion?: { lat: number; lon: number } | null;
  } = $props();

  let conteneur: HTMLDivElement | undefined = $state();
  let carte: maplibregl.Map | undefined;
  // Le thème du site change (bouton clair/sombre) : la carte suit, sans être rechargée.
  $effect(() => { const sombre = theme.valeur === 'sombre'; if (carte) changerTheme(carte, sombre); });
  let repere: maplibregl.Marker | undefined;
  function dessiner() {
    if (!carte || !lieu) return;
    const src = carte.getSource('zone') as maplibregl.GeoJSONSource | undefined;
    src?.setData(cercle(lieu.lat, lieu.lon, RAYON[precision]));
  }

  function placer(lat: number, lon: number) {
    lieu = { lat, lon };
    if (!repere) {
      repere = new maplibregl.Marker({ color: '#E8A33D', draggable: true }).setLngLat([lon, lat]).addTo(carte!);
      repere.on('dragend', () => { const p = repere!.getLngLat(); lieu = { lat: p.lat, lon: p.lng }; dessiner(); });
    } else {
      repere.setLngLat([lon, lat]);
    }
    dessiner();
  }

  onMount(() => {
    const depart = lieu ?? suggestion;
    carte = creerCarte(conteneur!, { sombre: theme.valeur === 'sombre', ...(depart ? { centre: [depart.lon, depart.lat], zoom: 15 } : {}) });
    carte.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    carte.on('load', () => {
      carte!.addSource('zone', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      carte!.addLayer({ id: 'zone', type: 'fill', source: 'zone', paint: { 'fill-color': '#E8A33D', 'fill-opacity': 0.18 } });
      carte!.addLayer({ id: 'zone-bord', type: 'line', source: 'zone', paint: { 'line-color': '#E8A33D', 'line-width': 2 } });
      if (lieu) placer(lieu.lat, lieu.lon);
    });
    carte.on('click', (e) => placer(e.lngLat.lat, e.lngLat.lng));
  });
  onDestroy(() => carte?.remove());
  $effect(() => { void precision; dessiner(); });
</script>

<RechercheAdresse onchoisir={(r) => { placer(r.lat, r.lon); carte?.flyTo({ center: [r.lon, r.lat], zoom: 16 }); }} />
<div class="carte-lieu" bind:this={conteneur} role="application" aria-label="Carte : cliquez pour placer le lieu des faits"></div>

<style>
  .carte-lieu { width: 100%; height: 22rem; border: 1px solid var(--trait); border-radius: var(--rayon-grand); overflow: hidden; }
  .carte-lieu :global(.maplibregl-ctrl-attrib a) { color: inherit; }
</style>
