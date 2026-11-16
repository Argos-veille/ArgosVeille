// Fond de carte servi par le site lui-même (aucun service de cartographie extérieur) : tuiles
// Protomaps (données OpenStreetMap) lues dans /carte/france.pmtiles, polices et icônes dans /carte/.
import { layers, namedFlavor } from '@protomaps/basemaps';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import adresseWorker from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { Protocol } from 'pmtiles';

let protocole = false;

export const CENTRE_FRANCE: [number, number] = [2.45, 46.6];

/** Une carte MapLibre au thème du site. `sombre` : thème sombre. */
export function creerCarte(conteneur: HTMLElement, options: { sombre: boolean; centre?: [number, number]; zoom?: number }) {
  if (!protocole) {
    maplibregl.setWorkerUrl(adresseWorker);   // le worker est un fichier à part : on dit à MapLibre où il est
    maplibregl.addProtocol('pmtiles', new Protocol().tile);
    protocole = true;
  }
  const sombre = options.sombre;
  const carte = new maplibregl.Map({
    container: conteneur,
    center: options.centre ?? CENTRE_FRANCE,
    zoom: options.zoom ?? 4.6,
    maxZoom: 18,
    attributionControl: { compact: true, customAttribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> · Protomaps' },
    style: styleCarte(sombre),
  });
  themes.set(carte, sombre);
  return carte;
}

/** Thème actuel de chaque carte (pour ne rien refaire si le thème n'a pas changé). */
const themes = new WeakMap<maplibregl.Map, boolean>();

/** Style du fond de carte, clair ou sombre. */
function styleCarte(sombre: boolean): maplibregl.StyleSpecification {
  const origine = location.origin;
  const theme = sombre ? 'dark' : 'light';
  const saveur = namedFlavor(theme);
  // Hors de l'extrait (France et outre-mer, avec une marge), il n'y a pas de tuiles : le fond prend la
  // couleur de la mer plutôt qu'un gris qui ferait croire à une panne.
  const couches = layers('protomaps', saveur, { lang: 'fr' }).map((c) =>
    c.type === 'background' ? { ...c, paint: { ...c.paint, 'background-color': saveur.water } } : c);
  return {
    version: 8,
    glyphs: `${origine}/carte/polices/{fontstack}/{range}.pbf`,
    sprite: `${origine}/carte/icones/${theme}`,
    sources: {
      protomaps: { type: 'vector', url: `pmtiles://${__ARGOS_TUILES__ || `${origine}/carte/france.pmtiles`}`, attribution: '' },
    },
    layers: couches as maplibregl.LayerSpecification[],
  };
}

/** Change le thème d'une carte déjà ouverte, en gardant ce que la page y a ajouté (points, zones). */
export function changerTheme(carte: maplibregl.Map, sombre: boolean) {
  if (themes.get(carte) === sombre) return;
  themes.set(carte, sombre);
  carte.setStyle(styleCarte(sombre), {
    transformStyle: (avant, apres) => {
      if (!avant) return apres;
      const sources = Object.fromEntries(Object.entries(avant.sources).filter(([id]) => !(id in apres.sources)));
      const ajoutees = avant.layers.filter((c) => !apres.layers.some((n) => n.id === c.id));
      return { ...apres, sources: { ...apres.sources, ...sources }, layers: [...apres.layers, ...ajoutees] };
    },
  });
}

/** Rayon du cercle montré autour d'un lieu, selon sa précision. */
export const RAYON_PRECISION = { exact: 10, approx_100m: 110, municipality: 1100 } as const;

/** Cercle (polygone GeoJSON) de `metres` autour d'un point. */
export function cercle(lat: number, lon: number, metres: number) {
  const points: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    points.push([lon + (metres / (111_320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (metres / 110_574) * Math.sin(a)]);
  }
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [points] } };
}

export { maplibregl };
