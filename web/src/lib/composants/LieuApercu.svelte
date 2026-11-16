<script lang="ts">
  // Lieu annoncé : adresse la plus proche (service d'adresses de l'État, via notre API) et petite carte
  // avec le cercle de précision. Lecture seule ; pour choisir un lieu, voir CarteLieu.
  import { onDestroy, onMount } from 'svelte';
  import { post } from '#lib/api.ts';
  import { cercle, changerTheme, creerCarte, maplibregl, RAYON_PRECISION } from '#lib/carte.ts';
  import { theme } from '#lib/theme.svelte.ts';

  type Precision = keyof typeof RAYON_PRECISION;
  let { lieu, carte: avecCarte = true, adresse: avecAdresse = true }: {
    lieu: { lat: number; lon: number; precision: string };
    carte?: boolean;
    adresse?: boolean;
  } = $props();

  interface AdresseProche { label: string; commune: string; codePostal: string; distance: number }
  let adresse: AdresseProche | null = $state(null);
  const rayon = $derived(RAYON_PRECISION[lieu.precision as Precision] ?? RAYON_PRECISION.approx_100m);
  const texte = $derived.by(() => {
    if (!adresse) return '';
    if (lieu.precision === 'municipality') return `${adresse.codePostal} ${adresse.commune}`.trim();
    if (lieu.precision === 'exact' && adresse.distance <= 30) return adresse.label;
    return `Vers ${adresse.label}`;
  });

  // Nouvelle adresse à chaque changement de lieu (correction par un analyste). Panne : rien d'affiché.
  $effect(() => {
    const { lat, lon } = lieu;
    adresse = null;
    if (!avecAdresse) return;
    post<{ adresse: AdresseProche | null }>('/adresse/inverse', { lat, lon })
      .then((r) => { if (lieu.lat === lat && lieu.lon === lon) adresse = r.adresse; })
      .catch(() => {});
  });

  let conteneur: HTMLDivElement | undefined = $state();
  let mini: maplibregl.Map | undefined;
  let repere: maplibregl.Marker | undefined;
  let prete = $state(false);
  $effect(() => { const sombre = theme.valeur === 'sombre'; if (mini) changerTheme(mini, sombre); });

  onMount(() => {
    if (!avecCarte || !conteneur) return;
    mini = creerCarte(conteneur, { sombre: theme.valeur === 'sombre', centre: [lieu.lon, lieu.lat], zoom: lieu.precision === 'municipality' ? 13 : 16 });
    mini.scrollZoom.disable();
    mini.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    repere = new maplibregl.Marker({ color: '#E8A33D' }).setLngLat([lieu.lon, lieu.lat]).addTo(mini);
    mini.on('load', () => {
      mini!.addSource('zone', { type: 'geojson', data: cercle(lieu.lat, lieu.lon, rayon) });
      mini!.addLayer({ id: 'zone', type: 'fill', source: 'zone', paint: { 'fill-color': '#E8A33D', 'fill-opacity': 0.18 } });
      mini!.addLayer({ id: 'zone-bord', type: 'line', source: 'zone', paint: { 'line-color': '#E8A33D', 'line-width': 2 } });
      prete = true;
    });
  });
  // Lieu corrigé pendant que la page est ouverte : la carte suit.
  $effect(() => {
    const { lat, lon } = lieu;
    const r = rayon;
    if (!mini || !prete) return;
    repere?.setLngLat([lon, lat]);
    (mini.getSource('zone') as maplibregl.GeoJSONSource | undefined)?.setData(cercle(lat, lon, r));
    mini.jumpTo({ center: [lon, lat] });
  });
  onDestroy(() => mini?.remove());
</script>

{#if texte}<p class="adresse">{texte}</p>{/if}
{#if avecCarte}
  <div class="mini-carte" bind:this={conteneur} role="img" aria-label="Lieu des faits"></div>
{/if}

<style>
  .adresse { margin: 0; }
  .adresse + .mini-carte { margin-top: 0.5rem; }
  .mini-carte { height: 14rem; border: 1px solid var(--trait); border-radius: var(--rayon-grand); overflow: hidden; }
</style>
