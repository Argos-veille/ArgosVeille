// Télémétrie des rapports de bug.
//
// Rien n'est envoyé ni stocké : tout reste en mémoire dans l'onglet ouvert et disparaît à sa
// fermeture. Le formulaire « Signaler un bug » montre ce qui serait joint, et ne l'envoie que si la
// personne clique sur « Envoyer ». On garde des noms génériques (pages, routes, boutons) et jamais
// ce qui est tapé dans un champ, ni l'adresse complète (elle peut contenir un code de suivi).

const MAX_ACTIONS = 30;
const MAX_APPELS = 20;
const MAX_ERREURS = 10;

export interface Appel { quand: string; route: string; statut: number; erreur?: string; duree: number; requete?: string }
export interface Action { quand: string; quoi: string }
export interface ErreurNavigateur { quand: string; message: string; pile?: string }

const actions: Action[] = [];
const appels: Appel[] = [];
const erreurs: ErreurNavigateur[] = [];
let pageCourante = '/';

const maintenant = () => new Date().toISOString();
function pousser<T>(liste: T[], x: T, max: number) {
  liste.push(x);
  if (liste.length > max) liste.shift();
}

/** Retire de n'importe quel texte ce qui ressemble à un identifiant, un jeton, un mail ou un numéro. */
export function nettoyer(texte: string): string {
  return texte
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ':mail')
    .replace(/#[^\s"']+/g, '#:jeton')
    .replace(/[A-Za-z0-9_-]{24,}/g, ':jeton')
    .replace(/\+?\d[\d .-]{7,}\d/g, ':numero')
    .slice(0, 2000);
}

/** Route d'API générique : « /relecture/3f2…/vote » → « /relecture/:id/vote ». */
export function routeGenerique(chemin: string): string {
  const sansRequete = chemin.split(/[?#]/)[0] ?? chemin;
  return nettoyer(sansRequete).replace(/\/\d+(?=\/|$)/g, '/:n');
}

// Envoi et suivi d'une vidéo : rien n'est noté (ni page, ni action, ni appel). Un rapport de bug envoyé depuis un compte
// relierait sinon ce compte à un envoi anonyme (heure, numéro d'envoi).
const PAGE_SENSIBLE = /^\/(envoyer|suivi)(\/|$)/;
const APPEL_SENSIBLE = /^(?:[A-Z]+ )?\/(envois|suivi)(\/|$)/;
const sensible = () => PAGE_SENSIBLE.test(pageCourante);

export function noterPage(routeId: string | null) {
  pageCourante = routeId ?? 'inconnue';
  if (sensible()) return;
  pousser(actions, { quand: maintenant(), quoi: `page ${pageCourante}` }, MAX_ACTIONS);
}
export const page = () => pageCourante;
/** Pour les tests : ce qui est noté en mémoire. */
export const noteEnMemoire = () => ({ actions: [...actions], appels: [...appels] });

export function noterAction(quoi: string) {
  if (sensible()) return;
  pousser(actions, { quand: maintenant(), quoi: nettoyer(quoi).slice(0, 120) }, MAX_ACTIONS);
}

export function noterAppel(a: Omit<Appel, 'quand'>) {
  if (sensible() || APPEL_SENSIBLE.test(a.route)) return;
  pousser(appels, { quand: maintenant(), ...a }, MAX_APPELS);
}

export function noterErreur(message: string, pile?: string) {
  // Pas plus les erreurs que le reste sur une page de source (contre-vérification du second audit) : gardées en mémoire,
  // elles partiraient ensuite dans un rapport envoyé depuis une autre page, avec le pseudo.
  if (sensible()) return;
  pousser(erreurs, { quand: maintenant(), message: nettoyer(message), ...(pile ? { pile: nettoyer(pile) } : {}) }, MAX_ERREURS);
}

let installee = false;
/** Écoute les erreurs du navigateur et les clics sur les boutons et liens (leur nom affiché, rien d'autre). */
export function installer() {
  if (installee || typeof window === 'undefined') return;
  installee = true;
  window.addEventListener('error', (e) => noterErreur(e.message || 'erreur', e.error?.stack));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined;
    noterErreur(r?.message ?? String(e.reason), r?.stack);
  });
  document.addEventListener('click', (e) => {
    const cible = (e.target as Element | null)?.closest('button, a, [role="button"], summary');
    if (!cible) return;
    const nom = cible.getAttribute('data-trace') ?? cible.getAttribute('aria-label') ?? cible.textContent ?? '';
    const genre = cible.tagName === 'A' ? 'lien' : 'clic';
    noterAction(`${genre} « ${nom.replace(/\s+/g, ' ').trim().slice(0, 60)} »`);
  }, { capture: true });
}

/** Navigateur et système, en version exacte (pour reproduire), à partir de ce que le navigateur annonce. */
function navigateur() {
  const ua = navigator.userAgent;
  const nav = /Firefox\/([\d.]+)/.exec(ua) ? `Firefox ${/Firefox\/([\d.]+)/.exec(ua)![1]}`
    : /Edg\/([\d.]+)/.exec(ua) ? `Edge ${/Edg\/([\d.]+)/.exec(ua)![1]}`
    : /Chrome\/([\d.]+)/.exec(ua) ? `Chrome ${/Chrome\/([\d.]+)/.exec(ua)![1]}`
    : /Version\/([\d.]+).*Safari/.exec(ua) ? `Safari ${/Version\/([\d.]+)/.exec(ua)![1]}`
    : 'inconnu';
  const os = /Android ([\d.]+)/.exec(ua) ? `Android ${/Android ([\d.]+)/.exec(ua)![1]}`
    : /iPhone OS ([\d_]+)/.exec(ua) ? `iOS ${/iPhone OS ([\d_]+)/.exec(ua)![1]!.replace(/_/g, '.')}`
    : /Windows NT ([\d.]+)/.exec(ua) ? `Windows NT ${/Windows NT ([\d.]+)/.exec(ua)![1]}`
    : /Mac OS X ([\d_.]+)/.exec(ua) ? `macOS ${/Mac OS X ([\d_.]+)/.exec(ua)![1]!.replace(/_/g, '.')}`
    : /Linux/.test(ua) ? (/Ubuntu/.test(ua) ? 'Linux (Ubuntu)' : 'Linux') : 'inconnu';
  return { navigateur: nav, systeme: os };
}

export interface Etat { connecte: boolean; roles: string[]; doubleAuthentification: string[] }

/** Tout ce qui partirait avec un rapport, pris maintenant. */
export function prendre(etat: Etat) {
  const theme = document.documentElement.dataset.theme === 'sombre' ? 'sombre' : 'clair';
  return {
    version: __ARGOS_VERSION__,
    prisLe: maintenant(),
    page: pageCourante,
    ...navigateur(),
    langue: navigator.language,
    theme,
    fenetre: `${window.innerWidth}×${window.innerHeight}`,
    zoom: Math.round(window.devicePixelRatio * 100) / 100,
    ecranTactile: navigator.maxTouchPoints > 0,
    enLigne: navigator.onLine,
    etat,
    capacites: {
      clesDeSecurite: typeof window.PublicKeyCredential !== 'undefined',
      chiffrement: typeof crypto?.subtle !== 'undefined',
      lectureVideo: typeof MediaSource !== 'undefined',
      captureEcran: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
    },
    actions: [...actions],
    appels: [...appels],
    erreurs: [...erreurs],
  };
}
export type Telemetrie = ReturnType<typeof prendre>;
