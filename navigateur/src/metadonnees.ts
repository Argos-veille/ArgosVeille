// Lecture des métadonnées de date et de lieu d'une vidéo MP4 / MOV, dans le navigateur de la source.
// Elles ne quittent jamais le navigateur : elles servent à préremplir le formulaire et à calculer
// l'indicateur de cohérence (coherence.ts). Seule la boîte « moov » est lue (bornée à 32 Mio).
//
// Emplacements reconnus :
//   moov/mvhd                         date de création (secondes depuis 1904) — souvent l'heure d'enregistrement
//   moov/udta/©xyz                    position ISO 6709 (Android, fichiers .mov)
//   moov/udta/loci                    position 3GPP (ffmpeg en .mp4, certains téléphones)
//   moov/meta (keys + ilst)           com.apple.quicktime.location.ISO6709, com.apple.quicktime.creationdate (iPhone)
import type { Lecteur } from './lecteur.ts';

export interface Metadonnees {
  date?: Date | undefined;
  position?: { lat: number; lon: number } | undefined;
}

const MOOV_MAX = 32 * 1024 * 1024;
const PROFONDEUR_MAX = 8;
const EPOQUE_1904 = Date.UTC(1904, 0, 1);

interface Boite { type: string; debut: number; fin: number }   // debut = début du contenu

const texte = (o: Uint8Array) => new TextDecoder('utf-8', { fatal: false }).decode(o);
const typeBoite = (o: Uint8Array, i: number) => String.fromCharCode(o[i]!, o[i + 1]!, o[i + 2]!, o[i + 3]!);

/** Boîtes contenues entre [debut, fin[ d'un tampon. Ignore proprement toute taille incohérente. */
function boites(o: Uint8Array, debut: number, fin: number): Boite[] {
  const v = new DataView(o.buffer, o.byteOffset, o.byteLength);
  const r: Boite[] = [];
  let i = debut;
  while (i + 8 <= fin && r.length < 4096) {
    let taille = v.getUint32(i);
    let entete = 8;
    if (taille === 1) {
      if (i + 16 > fin) break;
      taille = Number(v.getBigUint64(i + 8));
      entete = 16;
    } else if (taille === 0) {
      taille = fin - i;
    }
    if (taille < entete || i + taille > fin) break;
    r.push({ type: typeBoite(o, i + 4), debut: i + entete, fin: i + taille });
    i += taille;
  }
  return r;
}

/** ISO 6709 : « +48.8566+002.3522+035.000/ ». */
export function lireIso6709(s: string): { lat: number; lon: number } | undefined {
  const m = /^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/.exec(s.trim());
  if (!m) return undefined;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  if (lat === 0 && lon === 0) return undefined;   // valeur par défaut de certains appareils
  return { lat, lon };
}

function lireDateTexte(s: string): Date | undefined {
  // « 2026-11-03T14:12:00+0100 » (Apple) ; Date.parse veut « +01:00 ».
  const d = new Date(s.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function lireMvhd(o: Uint8Array, b: Boite): Date | undefined {
  const v = new DataView(o.buffer, o.byteOffset, o.byteLength);
  if (b.fin - b.debut < 12) return undefined;
  const version = o[b.debut]!;
  const secondes = version === 1 ? Number(v.getBigUint64(b.debut + 4)) : v.getUint32(b.debut + 4);
  if (secondes === 0) return undefined;   // pas de date
  const d = new Date(EPOQUE_1904 + secondes * 1000);
  return d.getUTCFullYear() >= 2000 && d.getTime() <= Date.now() + 86_400_000 ? d : undefined;
}

/** Boîte 3GPP « loci » : version/drapeaux (4), langue (2), nom terminé par 0, rôle (1), longitude, latitude (virgule fixe 16.16). */
function lireLoci(o: Uint8Array, b: Boite): { lat: number; lon: number } | undefined {
  let i = b.debut + 6;
  while (i < b.fin && o[i] !== 0) i++;   // nom du lieu
  i += 2;                                 // octet nul + rôle
  if (i + 8 > b.fin) return undefined;
  const v = new DataView(o.buffer, o.byteOffset, o.byteLength);
  const lon = v.getInt32(i) / 65536, lat = v.getInt32(i + 4) / 65536;
  const s = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(5);
  return lireIso6709(`${s(lat)}${s(lon)}/`);   // mêmes contrôles de vraisemblance
}

/** Métadonnées Apple : boîte « meta » avec « keys » (noms) et « ilst » (valeurs, indexées à partir de 1). */
function lireMetaApple(o: Uint8Array, meta: Boite): Record<string, string> {
  const v = new DataView(o.buffer, o.byteOffset, o.byteLength);
  // Dans un .mov, « meta » n'a pas d'en-tête version/drapeaux ; dans un .mp4, si (4 octets).
  let enfants = boites(o, meta.debut, meta.fin);
  if (!enfants.some((b) => b.type === 'keys')) enfants = boites(o, meta.debut + 4, meta.fin);
  const keys = enfants.find((b) => b.type === 'keys');
  const ilst = enfants.find((b) => b.type === 'ilst');
  if (!keys || !ilst || keys.fin - keys.debut < 8) return {};
  const noms: string[] = [];
  const nombre = v.getUint32(keys.debut + 4);
  let i = keys.debut + 8;
  for (let k = 0; k < nombre && k < 256 && i + 8 <= keys.fin; k++) {
    const t = v.getUint32(i);
    if (t < 8 || i + t > keys.fin) break;
    noms.push(texte(o.subarray(i + 8, i + t)));
    i += t;
  }
  const r: Record<string, string> = {};
  for (const item of boites(o, ilst.debut, ilst.fin)) {
    const index = v.getUint32(item.debut - 4);   // le type de l'élément est son numéro (1, 2…)
    const nom = noms[index - 1];
    const data = boites(o, item.debut, item.fin).find((b) => b.type === 'data');
    if (nom && data && data.fin - data.debut > 8) r[nom] = texte(o.subarray(data.debut + 8, data.fin));
  }
  return r;
}

export async function lireMetadonnees(fichier: Lecteur): Promise<Metadonnees> {
  // Trouver « moov » parmi les boîtes de premier niveau, en ne lisant que leurs en-têtes.
  let i = 0;
  let moov: { debut: number; fin: number } | undefined;
  for (let n = 0; n < 1024 && i + 8 <= fichier.taille; n++) {
    const e = await fichier.lire(i, i + 16);
    if (e.length < 8) break;
    const v = new DataView(e.buffer, e.byteOffset, e.byteLength);
    let taille = v.getUint32(0);
    if (taille === 1 && e.length >= 16) taille = Number(v.getBigUint64(8));
    else if (taille === 0) taille = fichier.taille - i;
    if (taille < 8) break;
    if (typeBoite(e, 4) === 'moov') { moov = { debut: i, fin: Math.min(i + taille, fichier.taille) }; break; }
    i += taille;
  }
  if (!moov || moov.fin - moov.debut > MOOV_MAX) return {};

  const o = await fichier.lire(moov.debut, moov.fin);
  const racine = boites(o, 0, o.length).find((b) => b.type === 'moov');
  if (!racine) return {};
  const r: Metadonnees = {};

  const parcourir = (parent: Boite, profondeur: number) => {
    if (profondeur > PROFONDEUR_MAX) return;
    for (const b of boites(o, parent.debut, parent.fin)) {
      if (b.type === 'mvhd' && !r.date) {
        const d = lireMvhd(o, b);
        if (d) r.date = d;
      } else if (b.type === '©xyz' && !r.position && b.fin - b.debut > 4) {
        const p = lireIso6709(texte(o.subarray(b.debut + 4, b.fin)));   // 2 octets de longueur + 2 de langue
        if (p) r.position = p;
      } else if (b.type === 'loci' && !r.position) {
        const p = lireLoci(o, b);
        if (p) r.position = p;
      } else if (b.type === 'meta') {
        const apple = lireMetaApple(o, b);
        const pos = apple['com.apple.quicktime.location.ISO6709'];
        const date = apple['com.apple.quicktime.creationdate'];
        const position = pos ? lireIso6709(pos) : undefined;
        const quand = date ? lireDateTexte(date) : undefined;
        if (position) r.position = position;
        if (quand) r.date = quand;   // la date d'Apple (avec son fuseau) prime sur mvhd
      } else if (b.type === 'udta' || b.type === 'trak') {
        parcourir(b, profondeur + 1);
      }
    }
  };
  parcourir(racine, 0);
  return r;
}
