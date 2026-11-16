// Copie de travail sans lieu ni date, préparée dans le navigateur de la source avant l'envoi.
//
// Dans un MP4 / MOV, le lieu et les autres métadonnées vivent dans des boîtes à part (udta, meta, uuid/XMP),
// et les dates dans les en-têtes mvhd, tkhd et mdhd. On renomme ces boîtes en « free » (ignorées par tous
// les lecteurs) et on met les dates à zéro : la taille et la position de chaque octet restent identiques,
// la vidéo reste lisible, et rien d'autre n'est réécrit. Seuls les en-têtes des boîtes sont lus, quelle que
// soit la taille du fichier. L'original, chiffré à part, n'est pas modifié.
//
// Pistes de données (revue de sécurité B8) : GPS des GoPro (gpmd), télémétrie des drones DJI, mouvements de la caméra
// (camm, Android), sous-titres de télémétrie… Toute piste qui n'est ni de l'image ni du son voit ses données effacées
// (les octets de ses échantillons, dans mdat) puis sa description (trak devient « free »). Image et son ne bougent pas.
//
// Format non reconnu (WebM…) : aucune modification ; le serveur retire de toute façon les métadonnées au traitement.
import type { Lecteur } from './lecteur.ts';

/** Octets à remplacer à partir de `position` : `octets`, ou `longueur` zéros. */
export type Correctif = { position: number; octets: Uint8Array } | { position: number; longueur: number };

/** Boîtes de premier niveau gardées telles quelles ; toutes les autres deviennent « free ». */
const GARDEES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'moof', 'mfra', 'styp', 'sidx', 'pdin']);
/** Boîtes parcourues à la recherche de métadonnées. */
const CONTENEURS = new Set(['moov', 'trak', 'mdia', 'minf']);
/** Boîtes de métadonnées, effacées où qu'elles soient dans ces conteneurs. */
const METADONNEES = new Set(['udta', 'meta', 'uuid']);
/** En-têtes portant une date de création et de modification. */
const DATES = new Set(['mvhd', 'tkhd', 'mdhd']);
const FREE = new Uint8Array([0x66, 0x72, 0x65, 0x65]);   // « free »
const MAX_BOITES = 4096;

interface Entete { type: string; position: number; debut: number; fin: number }   // debut = début du contenu
const MAX_ENTREES = 2_000_000;   // tables d'échantillons : au-delà, fichier refusé au nettoyage (le serveur s'en charge)

async function entete(f: Lecteur, i: number, fin: number): Promise<Entete | null> {
  if (i + 8 > fin) return null;
  const e = await f.lire(i, Math.min(i + 16, fin));
  if (e.length < 8) return null;
  const v = new DataView(e.buffer, e.byteOffset, e.byteLength);
  let taille = v.getUint32(0);
  let tailleEntete = 8;
  if (taille === 1) {
    if (e.length < 16) return null;
    taille = Number(v.getBigUint64(8));
    tailleEntete = 16;
  } else if (taille === 0) {
    taille = fin - i;
  }
  if (taille < tailleEntete || i + taille > fin) return null;
  const type = String.fromCharCode(e[4]!, e[5]!, e[6]!, e[7]!);
  if (!/^[\x20-\x7e\xa9]{4}$/.test(type)) return null;   // pas une boîte : format non reconnu
  return { type, position: i, debut: i + tailleEntete, fin: i + taille };
}

async function enfants(f: Lecteur, debut: number, fin: number): Promise<Entete[]> {
  const r: Entete[] = [];
  for (let i = debut; i < fin && r.length < MAX_BOITES;) {
    const b = await entete(f, i, fin);
    if (!b) break;
    r.push(b);
    i = b.fin;
  }
  return r;
}

const u32 = (o: Uint8Array, i: number) => new DataView(o.buffer, o.byteOffset, o.byteLength).getUint32(i);
const u64 = (o: Uint8Array, i: number) => Number(new DataView(o.buffer, o.byteOffset, o.byteLength).getBigUint64(i));

/** Type de piste (« vide », « soun », « meta »…) lu dans mdia/hdlr, ou null. */
async function typePiste(f: Lecteur, trak: Entete): Promise<string | null> {
  const mdia = (await enfants(f, trak.debut, trak.fin)).find((b) => b.type === 'mdia');
  const hdlr = mdia && (await enfants(f, mdia.debut, mdia.fin)).find((b) => b.type === 'hdlr');
  if (!hdlr || hdlr.fin - hdlr.debut < 12) return null;
  const o = await f.lire(hdlr.debut + 8, hdlr.debut + 12);
  return String.fromCharCode(o[0]!, o[1]!, o[2]!, o[3]!);
}

/** Plages d'octets des échantillons d'une piste (d'après stsz, stsc et stco/co64), une par paquet (chunk). */
async function plagesEchantillons(f: Lecteur, trak: Entete): Promise<{ position: number; longueur: number }[] | null> {
  const descendre = async (b: Entete | undefined, type: string) => b && (await enfants(f, b.debut, b.fin)).find((x) => x.type === type);
  const stbl = await descendre(await descendre(await descendre(trak, 'mdia'), 'minf'), 'stbl');
  if (!stbl) return [];
  const tables = await enfants(f, stbl.debut, stbl.fin);
  const lire = async (type: string) => { const b = tables.find((x) => x.type === type); return b ? f.lire(b.debut, b.fin) : null; };
  const [stsz, stsc, stco, co64] = [await lire('stsz'), await lire('stsc'), await lire('stco'), await lire('co64')];
  if (!stsz || !stsc || (!stco && !co64)) return null;
  const tailleFixe = u32(stsz, 4), nEchantillons = u32(stsz, 8);
  const nPaquets = u32((stco ?? co64)!, 4), nRegles = u32(stsc, 4);
  if (nEchantillons > MAX_ENTREES || nPaquets > MAX_ENTREES || nRegles > MAX_ENTREES) return null;
  const taille = (i: number) => (tailleFixe ? tailleFixe : u32(stsz, 12 + 4 * i));
  const decalage = (i: number) => (stco ? u32(stco, 8 + 4 * i) : u64(co64!, 8 + 8 * i));
  const plages: { position: number; longueur: number }[] = [];
  let echantillon = 0;
  for (let r = 0; r < nRegles; r++) {
    const premier = u32(stsc, 8 + 12 * r) - 1, parPaquet = u32(stsc, 12 + 12 * r);
    const dernier = r + 1 < nRegles ? u32(stsc, 8 + 12 * (r + 1)) - 1 : nPaquets;
    for (let p = premier; p < dernier && p < nPaquets; p++) {
      let longueur = 0;
      for (let k = 0; k < parPaquet && echantillon < nEchantillons; k++, echantillon++) longueur += taille(echantillon);
      const position = decalage(p);
      if (longueur > 0 && position + longueur <= f.taille) plages.push({ position, longueur });
    }
  }
  return plages;
}

/** Correctifs à appliquer à la copie, ou null si le fichier n'est pas un MP4 / MOV reconnu. */
export async function correctifsCopie(f: Lecteur): Promise<Correctif[] | null> {
  const racine = await enfants(f, 0, f.taille);
  const derniere = racine.at(-1);
  // Un MP4 / MOV commence par ftyp (ou wide/free/mdat pour de vieux MOV), contient moov, et ses boîtes couvrent le fichier.
  if (!racine.length || !['ftyp', 'wide', 'free', 'mdat', 'moov'].includes(racine[0]!.type)
      || !racine.some((b) => b.type === 'moov') || derniere!.fin !== f.taille) return null;

  const correctifs: Correctif[] = [];
  const effacer = (b: Entete) => {
    correctifs.push({ position: b.position + 4, octets: FREE });
    if (b.fin > b.debut) correctifs.push({ position: b.debut, longueur: b.fin - b.debut });
  };
  const parcourir = async (parent: Entete, profondeur: number) => {
    for (const b of await enfants(f, parent.debut, parent.fin)) {
      if (b.type === 'trak' && profondeur === 0) {
        const piste = await typePiste(f, b);
        if (piste !== null && piste !== 'vide' && piste !== 'soun') {
          // Piste de données (B8) : ses échantillons sont effacés, puis la piste elle-même.
          const plages = await plagesEchantillons(f, b);
          if (plages === null) throw new Error('piste de données illisible');
          correctifs.push(...plages);
          effacer(b);
          continue;
        }
      }
      if (METADONNEES.has(b.type) || b.type === 'loci' || b.type.startsWith('\xa9')) {   // ©xyz, ©day… hors de udta
        effacer(b);
      } else if (DATES.has(b.type) && b.fin - b.debut >= 12) {
        // version 0 : création et modification sur 4 octets chacune ; version 1 : 8 octets chacune.
        const longueur = (await f.lire(b.debut, b.debut + 1))[0] === 1 ? 16 : 8;
        if (b.debut + 4 + longueur <= b.fin) correctifs.push({ position: b.debut + 4, longueur });
      } else if (CONTENEURS.has(b.type) && profondeur < 6) {
        await parcourir(b, profondeur + 1);
      }
    }
  };
  for (const b of racine) {
    if (b.type === 'moov') await parcourir(b, 0);
    else if (!GARDEES.has(b.type)) effacer(b);
  }
  return correctifs;
}

/** Applique les correctifs qui tombent dans le morceau [debut, debut + octets.length[ (le morceau est modifié). */
export function appliquerCorrectifs(octets: Uint8Array, debut: number, correctifs: Correctif[]): Uint8Array {
  const fin = debut + octets.length;
  for (const c of correctifs) {
    const longueur = 'octets' in c ? c.octets.length : c.longueur;
    const de = Math.max(c.position, debut), a = Math.min(c.position + longueur, fin);
    if (de >= a) continue;
    if ('octets' in c) octets.set(c.octets.subarray(de - c.position, a - c.position), de - debut);
    else octets.fill(0, de - debut, a - debut);
  }
  return octets;
}
