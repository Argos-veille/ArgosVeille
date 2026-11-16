// Indicateur montré aux relecteurs : les métadonnées de la vidéo sont-elles cohérentes avec la date
// et le lieu déclarés par la source ? Calculé dans le navigateur ; le serveur ne reçoit QUE le résultat.
// Les métadonnées ne prouvent rien (elles se falsifient) : c'est un indice, pas une preuve.
import type { Metadonnees } from './metadonnees.ts';

export type Indicateur = 'coherentes' | 'incoherentes' | 'absentes';

export interface Declaration {
  date: Date;
  lat: number;
  lon: number;
  precision: 'exact' | 'approx_100m' | 'municipality';
  heureConnue?: boolean;   // false : seule la date compte (la source ne connaît pas l'heure)
}

export const ECART_DATE_MAX_MS = 6 * 3600 * 1000;   // 6 heures
/** Sans heure, la date déclarée est prise à midi : 36 h d'écart couvrent le même jour et les fuseaux d'outre-mer. */
export const ECART_JOUR_MAX_MS = 36 * 3600 * 1000;
const DISTANCE_MAX_KM = { exact: 2, approx_100m: 2, municipality: 20 } as const;

/** Distance à vol d'oiseau (haversine), en km. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function indicateur(meta: Metadonnees, d: Declaration): Indicateur {
  if (!meta.date && !meta.position) return 'absentes';
  const ecartMax = d.heureConnue === false ? ECART_JOUR_MAX_MS : ECART_DATE_MAX_MS;
  if (meta.date && Math.abs(meta.date.getTime() - d.date.getTime()) > ecartMax) return 'incoherentes';
  if (meta.position && distanceKm(meta.position, d) > DISTANCE_MAX_KM[d.precision]) return 'incoherentes';
  return 'coherentes';
}
