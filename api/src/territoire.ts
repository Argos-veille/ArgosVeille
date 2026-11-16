// La position déclarée est-elle en France (métropole, Corse, outre-mer) ?
// Contours Natural Earth 1:10m (domaine public, data/france.json), avec une tolérance de 2 km pour
// les points filmés sur la côte, un quai ou un pont, que le tracé simplifié peut laisser « en mer ».
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Point = [number, number];   // [longitude, latitude]
interface Polygone { anneaux: Point[][]; boite: [number, number, number, number] }   // [lonMin, latMin, lonMax, latMax]

const TOLERANCE_KM = 2;
const DEG_LAT_KM = 111.32;

function charger(): Polygone[] {
  const f = fileURLToPath(new URL('../data/france.json', import.meta.url));
  const d = JSON.parse(readFileSync(f, 'utf8')) as { polygones: Point[][][] };
  return d.polygones.map((anneaux) => {
    const ext = anneaux[0]!;
    return {
      anneaux,
      boite: [Math.min(...ext.map((p) => p[0])), Math.min(...ext.map((p) => p[1])),
              Math.max(...ext.map((p) => p[0])), Math.max(...ext.map((p) => p[1]))],
    };
  });
}
const POLYGONES = charger();

/** Lancer de rayon : le point est-il dans l'anneau ? */
function dansAnneau(lon: number, lat: number, a: Point[]): boolean {
  let dedans = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    const [xi, yi] = a[i]!, [xj, yj] = a[j]!;
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
}

/** Distance approximative (km) du point au bord de l'anneau (projection locale, suffisante à 2 km près). */
function distanceAuBord(lon: number, lat: number, a: Point[]): number {
  const kx = DEG_LAT_KM * Math.cos((lat * Math.PI) / 180);
  let min = Infinity;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    const ax = (a[j]![0] - lon) * kx, ay = (a[j]![1] - lat) * DEG_LAT_KM;
    const bx = (a[i]![0] - lon) * kx, by = (a[i]![1] - lat) * DEG_LAT_KM;
    const dx = bx - ax, dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
    min = Math.min(min, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return min;
}

export function enFrance(lat: number, lon: number): boolean {
  const margeLat = TOLERANCE_KM / DEG_LAT_KM;
  const margeLon = margeLat / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
  for (const p of POLYGONES) {
    const [x0, y0, x1, y1] = p.boite;
    if (lon < x0 - margeLon || lon > x1 + margeLon || lat < y0 - margeLat || lat > y1 + margeLat) continue;
    const [exterieur, ...trous] = p.anneaux;
    if (dansAnneau(lon, lat, exterieur!) && !trous.some((t) => dansAnneau(lon, lat, t))) return true;
    if (distanceAuBord(lon, lat, exterieur!) <= TOLERANCE_KM) return true;
  }
  return false;
}
