// Envoi d'une vidéo par une source, sans compte : tout le travail sensible se fait ici, dans le
// navigateur. Le serveur ne reçoit que l'empreinte du jeton de suivi, l'original CHIFFRÉ (clé dérivée
// de la phrase, qui ne quitte jamais le navigateur), une copie de travail à flouter (gardée 24 h au plus,
// en quarantaine) et, à la fin, la clé de copie qui permettra les retouches du floutage.
import { appliquerCorrectifs, calculEmpreinte, chiffrerOriginal, cleOriginalBrute, correctifsCopie, deriverSecrets, entropieVideo, envelopper, lecteurBlob, tailleChiffree, SCHEMA_EMPREINTE, TAILLE_MORCEAU, VIDEOS_PAR_CODE, type CleVideo, type Secrets } from 'argos-navigateur';
import { ErreurApi } from './api.ts';
import { noterAppel, routeGenerique } from './telemetrie.ts';
import { oublierPasse, passeOuErreur } from './passe-envoi.ts';
import { CONDITIONS_VERSION } from './conditions.ts';

export type Precision = 'exact' | 'approx_100m' | 'municipality';
export interface Contexte {
  date: string; lieu: { lat: number; lon: number }; precision: Precision;
  forces: string; situation: string; categorie: string; sousCategorie: string; autresSousCategories: string[]; autresSituations: string[]; description?: string; langue: 'fr' | 'en';
  heureConnue?: boolean;
  dateAEtablir?: boolean;   // la source ne connaît pas la date : « au plus tard le », à établir par un analyste
  lieuAEtablir?: boolean;   // la source ne connaît pas le lieu : repère approximatif, à établir par un analyste
}
export type Phase = 'preparation' | 'original' | 'copie' | 'finalisation';

/** Arrondi du lieu selon la précision choisie, avant tout envoi (le serveur arrondit aussi). */
export function arrondir(lat: number, lon: number, p: Precision) {
  const f = 10 ** (p === 'exact' ? 5 : p === 'approx_100m' ? 3 : 2);
  return { lat: Math.round(lat * f) / f, lon: Math.round(lon * f) / f };
}

/** Code d'accès à la bêta (cookie lisible posé par l'API), à joindre aux appels anonymes. */
const codeBeta = () => /(?:^|;\s*)__Host-argos_beta=([0-9A-Z]{12})/.exec(document.cookie)?.[1];

/** Requête de l'envoi : JSON ou octets, avec le jeton de suivi en en-tête (jamais dans l'adresse). */
async function requete<T>(methode: 'POST' | 'PUT', chemin: string, corps: unknown, suivi?: string, avecCompte = false): Promise<T> {
  const debut = performance.now();
  const octets = corps instanceof Uint8Array;
  const r = await fetch(`/api${chemin}`, {
    method: methode,
    // Envoi anonyme : jamais le cookie de session, même connecté. Envoi avec son compte : l'ouverture seulement.
    credentials: avecCompte ? 'same-origin' : 'omit',
    headers: { 'content-type': octets ? 'application/octet-stream' : 'application/json', ...(suivi ? { 'argos-suivi': suivi } : {}),
               // Pendant la bêta : le code d'accès seul (sans le cookie de session) pour les appels anonymes.
               ...(!avecCompte && codeBeta() ? { 'argos-beta': codeBeta()! } : {}) },
    body: octets ? (corps as Uint8Array<ArrayBuffer>) : JSON.stringify(corps),
  }).catch(() => null);
  if (!r) {
    noterAppel({ route: `${methode} ${routeGenerique(chemin)}`, statut: 0, erreur: 'reseau', duree: Math.round(performance.now() - debut) });
    throw new ErreurApi(0, 'reseau', {});
  }
  const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  const erreur = typeof json['erreur'] === 'string' ? json['erreur'] : undefined;
  noterAppel({ route: `${methode} ${routeGenerique(chemin)}`, statut: r.status, duree: Math.round(performance.now() - debut),
               ...(erreur ? { erreur } : {}), ...(r.headers.get('x-argos-requete') ? { requete: r.headers.get('x-argos-requete')! } : {}) });
  if (!r.ok) throw new ErreurApi(r.status, erreur ?? 'erreur_inconnue', json);
  return json as T;
}

/** Un morceau, renvoyé jusqu'à 6 fois en cas de coupure (attente croissante : 1, 2, 4, 8, 16 s). */
async function deposer(chemin: string, octets: Uint8Array, suivi: string) {
  for (let essai = 0; ; essai++) {
    try {
      return await requete('PUT', chemin, octets, suivi);
    } catch (e) {
      const passager = e instanceof ErreurApi && (e.statut === 0 || e.statut === 429 || e.statut >= 500);
      if (!passager || essai >= 5) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** essai));
    }
  }
}

// `empreinte` : celle enregistrée à l'ouverture (gardée en mémoire seulement), pour qu'un « Réessayer » ne puisse pas
// déposer un autre fichier que celui annoncé.
export interface Ouvert { envoi: string; pseudonyme: string; copie: { morceaux: number }; empreinte?: string }

export async function envoyerVideo(fichier: File | null, secrets: Secrets, contexte: Contexte,
                                   options: { metadonnees: 'coherentes' | 'incoherentes' | 'absentes'; garderSon: boolean; masquerVisages: boolean; avecCompte?: boolean; evenement?: string;
                                             origine?: { publiePar?: string; lien?: string; precisions?: string; publique: boolean };
                                             // autoriser la transmission de l'original : enveloppe pour les clés d'administration
                                             autoriser?: { cles: string[]; entropie: Uint8Array };
                                             // messagerie : clé de la vidéo (ouvrable par les 12 mots, et par la clé du compte) ; contact accepté ?
                                             messagerie?: CleVideo; contact?: boolean;
                                             // envoi par lien : le serveur récupère la vidéo, à la place du fichier
                                             lien?: { url: string; entropie: Uint8Array };
                                             codeScelle?: object;   // envoi avec un compte : code chiffré pour la clé du compte
                                             // « Réessayer » : l'envoi déjà ouvert, dont les morceaux sont simplement renvoyés
                                             ouvert?: Ouvert; surOuverture?: (o: Ouvert) => void },
                                   progres: (phase: Phase, part: number) => void): Promise<{ envoi: string; pseudonyme: string }> {
  if (options.lien) {
    progres('finalisation', 0);
    const cle = btoa(String.fromCharCode(...await cleOriginalBrute(options.lien.entropie))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const fait = await requete<{ envoi: string; pseudonyme: string }>('POST', '/envois', {
      passe: passeOuErreur(), conditions: CONDITIONS_VERSION, empreinteSuivi: secrets.empreinteSuivi,
      lien: options.lien.url, cleOriginal: cle, cleCopie: secrets.cleCopie,
      metadonnees: 'absentes', garderSon: options.garderSon, masquerVisages: options.masquerVisages,
      contexte: { ...contexte, lieu: arrondir(contexte.lieu.lat, contexte.lieu.lon, contexte.precision) },
      ...(options.avecCompte ? { avecCompte: true } : {}),
      ...(options.codeScelle ? { codeScelle: options.codeScelle } : {}),
      ...(options.evenement ? { evenement: options.evenement } : {}),
      ...(options.origine ? { origine: options.origine } : {}),
      ...(options.messagerie ? { messagerie: options.messagerie } : {}),
      ...(options.contact ? { contact: true } : {}),
    }, undefined, options.avecCompte ?? false);
    oublierPasse();   // un laissez-passer par envoi
    progres('finalisation', 1);
    return fait;
  }
  if (!fichier) throw new Error('fichier manquant');
  // 1. Empreinte CLÉE de l'original (H10) : seuls ceux qui ont la clé de l'original peuvent la recalculer ; elle lie
  // les autorisations de transmission à CE fichier. Lue morceau par morceau.
  const h = calculEmpreinte(secrets.cleEmpreinte);
  for (let debut = 0; debut < fichier.size; debut += TAILLE_MORCEAU) {
    h.update(new Uint8Array(await fichier.slice(debut, debut + TAILLE_MORCEAU).arrayBuffer()));
    progres('preparation', Math.min(1, (debut + TAILLE_MORCEAU) / fichier.size));
  }
  const empreinte = h.hex();

  // Autorisation de transmettre l'original : la clé de l'original, chiffrée pour l'administration.
  const autorisation = options.autoriser
    ? await envelopper(await cleOriginalBrute(options.autoriser.entropie), options.autoriser.cles, empreinte) : undefined;

  // 2. Ouverture de l'envoi. « Réessayer » : le fichier doit être celui de l'ouverture d'origine.
  if (options.ouvert?.empreinte && options.ouvert.empreinte !== empreinte) {
    throw new Error('Ce n’est pas le fichier de l’envoi commencé. Reprenez avec le même fichier, ou recommencez l’envoi.');
  }
  const ouvert = options.ouvert ?? { ...await requete<Ouvert>('POST', '/envois', {
    passe: passeOuErreur(), conditions: CONDITIONS_VERSION, empreinteSuivi: secrets.empreinteSuivi,
    tailleOriginal: tailleChiffree(fichier.size), tailleCopie: fichier.size, sha256Original: empreinte, schemaEmpreinte: SCHEMA_EMPREINTE,
    metadonnees: options.metadonnees, garderSon: options.garderSon, masquerVisages: options.masquerVisages,
    contexte: { ...contexte, lieu: arrondir(contexte.lieu.lat, contexte.lieu.lon, contexte.precision) },
    ...(options.avecCompte ? { avecCompte: true } : {}),
    ...(options.codeScelle ? { codeScelle: options.codeScelle } : {}),
    ...(options.evenement ? { evenement: options.evenement } : {}),
    ...(options.origine ? { origine: options.origine } : {}),
    ...(autorisation ? { autorisation } : {}),
    ...(options.messagerie ? { messagerie: options.messagerie } : {}),
    ...(options.contact ? { contact: true } : {}),
  }, undefined, options.avecCompte ?? false), empreinte };
  if (!options.ouvert) oublierPasse();   // un laissez-passer par envoi
  options.surOuverture?.(ouvert);

  // 3. L'original, chiffré dans le navigateur, morceau par morceau.
  const n = Math.max(1, Math.ceil(fichier.size / TAILLE_MORCEAU));
  const chiffre = await chiffrerOriginal(lecteurBlob(fichier), secrets.cleOriginal, async (m) => {
    await deposer(`/envois/${ouvert.envoi}/original/${m.index}`, m.octets, secrets.jetonSuivi);
    progres('original', (m.index + 1) / n);
  }, secrets.cleEmpreinte);
  // Même empreinte qu'au premier passage : le fichier n'a pas changé entre les deux lectures.
  if (chiffre.sha256 !== empreinte) throw new Error('Le fichier a changé pendant l’envoi. Recommencez avec le fichier d’origine.');

  // 4. La copie de travail, que le serveur floutera (effacée après le traitement), sans lieu ni date :
  //    retirés ici pour un MP4 / MOV ; sinon (format non reconnu), par le serveur au traitement.
  const correctifs = await correctifsCopie(lecteurBlob(fichier)).catch(() => null) ?? [];
  for (let i = 0; i < ouvert.copie.morceaux; i++) {
    const octets = appliquerCorrectifs(new Uint8Array(await fichier.slice(i * TAILLE_MORCEAU, (i + 1) * TAILLE_MORCEAU).arrayBuffer()),
                                       i * TAILLE_MORCEAU, correctifs);
    await deposer(`/envois/${ouvert.envoi}/copie/${i}`, octets, secrets.jetonSuivi);
    progres('copie', (i + 1) / ouvert.copie.morceaux);
  }

  // 5. Fin de l'envoi : la clé de copie permettra de retoucher le floutage.
  progres('finalisation', 0);
  await requete('POST', `/envois/${ouvert.envoi}/finaliser`, { cleCopie: secrets.cleCopie }, secrets.jetonSuivi);
  progres('finalisation', 1);
  return { envoi: ouvert.envoi, pseudonyme: ouvert.pseudonyme };
}

/** Appel de la page de suivi : le jeton voyage dans le corps de la requête, jamais dans l'adresse. */
export const appelSource = <T = Record<string, unknown>>(chemin: string, corps: unknown) => requete<T>('POST', chemin, corps);

const PAQUET_JETONS = 5;

/** Les vidéos d'un code de 12 mots. Les jetons partent par paquets de 5 places, jusqu'au premier paquet vide : le
 *  serveur ne voit pas d'avance ceux des vidéos futures. Une nouvelle vidéo prend la première place libre, donc les
 *  vidéos d'un code occupent les premières places. Aucune vidéo : erreur « Introuvable. », comme avant. */
export async function videosDuCode<T extends { position: number }>(code: Uint8Array): Promise<T[]> {
  const toutes: T[] = [];
  for (let depuis = 0; depuis < VIDEOS_PAR_CODE; depuis += PAQUET_JETONS) {
    const places = Array.from({ length: Math.min(PAQUET_JETONS, VIDEOS_PAR_CODE - depuis) }, (_, i) => depuis + i);
    const jetons = await Promise.all(places.map(async (n) => (await deriverSecrets(await entropieVideo(code, n))).jetonSuivi));
    const { videos } = await appelSource<{ videos: T[] }>('/suivi/videos', { jetons, ...(depuis ? { depuis } : {}) });
    toutes.push(...videos);
    if (!videos.length) break;
  }
  return toutes;
}

const SITES_LIEN = ['x.com', 'twitter.com', 'bsky.app', 'facebook.com', 'tiktok.com', 'instagram.com', 'youtube.com', 'youtu.be'];
/** Le lien vient-il d'un site dont on sait récupérer les vidéos ? (l'API et le worker refont ce contrôle) */
export function lienPrisEnCharge(lien: string): boolean {
  try {
    const u = new URL(lien.trim());
    return u.protocol === 'https:' && SITES_LIEN.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
