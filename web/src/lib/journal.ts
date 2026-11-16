// Journal public : types et textes lisibles des entrées, partagés par l'accueil et la page du journal.
import { get } from './api.ts';

export interface Entree { numero: number; le: string; type: string; contenu: Record<string, unknown>; masque?: boolean; empreinte: string; precedente: string }
export interface Verification { intact: boolean; entrees: number; premiereEntreeInvalide?: number }

export const TYPES: Record<string, string> = {
  decision: 'Décision', removal: 'Retrait pour motif légal', withdrawal: 'Retrait par la source', rule_change: 'Changement de règle',
  authority_request: 'Demande d’une autorité', admin_action: 'Action de l’administration', event_link: 'Rattachement à une fiche',
  video_received: 'Vidéo reçue', correction: 'Correction d’un analyste', original_shared: 'Original transmis par la source',
};
const STATUTS: Record<string, string> = {
  published: 'publiée', awaiting_osint: 'validée, en attente d’analyse', rejected: 'rejetée', under_debate: 'mise en débat', no_decision: 'classée sans décision',
  hidden: 'masquée', removed: 'retirée',
};
const PAR: Record<string, string> = { review: 'par la communauté', jury: 'par un jury', admin: 'par l’administration', legal: 'pour motif légal' };
const ACTIONS: Record<string, string> = {
  decision: 'Décision de l’administration', review_restarted: 'Relecture relancée par l’administration', osint_grant: 'Statut d’analyste OSINT accordé', osint_revoke: 'Statut d’analyste OSINT retiré',
  sanction: 'Sanction d’un compte', reblur: 'Floutage complété', mask_note: 'Note d’analyste masquée', unmask_note: 'Note d’analyste démasquée', verification: 'Vérification d’un compte',
  cancel_correction: 'Correction de date, d’heure ou de lieu annulée',
  description_corrected: 'Description corrigée par l’administration',
  account_code_created: 'Code de compte vérifié créé', account_code_revoked: 'Code de compte vérifié révoqué',
  hide_video: 'Vidéo masquée le temps d’un examen', unhide_video: 'Vidéo rétablie après examen',
  remove_video: 'Vidéo retirée pour motif légal', legal_hold: 'Gel légal posé (la source ne peut plus retirer la vidéo)',
  legal_hold_lifted: 'Gel légal levé',
  original_downloaded: 'Original téléchargé par l’administration (avec l’autorisation de la source)',
  original_released: 'Original transmis (avec l’autorisation de la source)',
  logout_account: 'Un compte déconnecté de force', suspend_account: 'Un compte suspendu', lift_suspension: 'Suspension d’un compte levée',
  ban_account: 'Un compte exclu définitivement',
  attach_version: 'Vidéo rattachée à une fiche existante',
  detach_version: 'Rattachement à une fiche annulé',
  origin_edited: 'Origine d’une vidéo modifiée',
  delete_failed: 'Vidéo en échec de traitement supprimée',
  event_validated: 'Vidéos reliées à un même événement', event_refused: 'Proposition de même événement refusée',
  event_unlinked: 'Vidéo retirée d’un événement',
};

/** Une phrase lisible pour une entrée du journal. */
export function resume(e: Entree): string {
  const r = phrase(e);
  return e.masque ? `${r} (nom masqué : donnée personnelle)` : r;
}

function phrase(e: Entree): string {
  const c = e.contenu;
  if (e.type === 'decision') return `Vidéo ${STATUTS[String(c['status'])] ?? String(c['status'])}${c['stage'] ? ` ${PAR[String(c['stage'])] ?? ''}` : ''}`;
  if (e.type === 'admin_action') {
    const a = ACTIONS[String(c['action'])] ?? String(c['action']);
    if (c['action'] === 'decision') return `${a} : vidéo ${STATUTS[String(c['to'])] ?? c['to']}`;
    if (c['action'] === 'original_released') {
      const qui: Record<string, string> = { association: 'une association', lawyer: 'un avocat', journalist: 'un journaliste', other: 'un autre destinataire' };
      return `${a} à ${qui[String(c['recipient'])] ?? 'un destinataire'}`;
    }
    if (c['action'] === 'sanction') {
      const genre: Record<string, string> = { logout: 'déconnexion forcée', suspension: 'suspension', suspend: 'suspension', ban: 'exclusion' };
      return `${a} (${genre[String(c['kind'])] ?? 'sanction'})`;
    }
    if (c['action'] === 'suspend_account' && c['days']) return `${a} pour ${c['days']} jour${Number(c['days']) > 1 ? 's' : ''}`;
    return a;
  }
  if (e.type === 'event_link' && c['version_of']) return 'Vidéo rattachée comme version d’une fiche existante';
  if (e.type === 'event_link' && c['target']) return 'Vidéos reliées à un même événement';
  if (e.type === 'original_shared') {
    const qui: Record<string, string> = { association: 'une association', lawyer: 'un avocat', journalist: 'un journaliste' };
    return `La source a transmis l’original à ${qui[String(c['recipient'])] ?? 'un compte vérifié'}`;
  }
  if (e.type === 'rule_change' && c['version']) return `Changement de règle (version ${String(c['version'])})${c['reason'] ? ` : ${String(c['reason'])}` : ''}`;
  if (e.type === 'withdrawal') return 'La source a retiré sa vidéo';
  if (e.type === 'correction') return 'Date, heure ou lieu d’une vidéo corrigés par un analyste';
  return TYPES[e.type] ?? e.type;
}

/** Lien vers la fiche, seulement pour une vidéo publique (publiée ou en débat). */
export function ficheDe(e: Entree): string | null {
  const v = e.contenu['video'];
  return e.type === 'decision' && typeof v === 'string' && ['published', 'under_debate'].includes(String(e.contenu['status']))
    ? `/videos/${v}` : null;
}

/** « il y a 2 h », « il y a 3 jours »… */
export function ilYa(d: string): string {
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  const j = Math.round(s / 86400);
  return j < 31 ? `il y a ${j} jour${j > 1 ? 's' : ''}` : new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

export const chargerJournal = (q = '') => get<{ entrees: Entree[]; suite: number | null }>(`/public/journal${q ? `?${q}` : ''}`);
export const verifierJournal = () => get<Verification>('/public/journal/verification');

export interface Ancrage {
  jour: string; derniereEntree: number; empreinte: string; etat: 'simule' | 'en_attente' | 'confirme';
  blocBitcoin: number | null; envoyeLe: string; confirmeLe: string | null; preuve: boolean;
}
export const chargerAncrages = () => get<{ ancrages: Ancrage[] }>('/public/journal/ancrages');

const enHex = (o: Uint8Array) => [...o].map((x) => x.toString(16).padStart(2, '0')).join('');
const deHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/**
 * Vérification indépendante, dans le navigateur : télécharge tout le journal, recalcule chaque empreinte
 * (SHA-256 de l'empreinte précédente suivie de « type|contenu|horodatage »), puis compare la tête de
 * chaîne de chaque jour aux empreintes ancrées dans Bitcoin. Rien n'est demandé au serveur sur le résultat.
 */
export async function verifierDansLeNavigateur(ancrages: Ancrage[]) {
  const { entrees } = await get<{ entrees: { numero: number; type: string; contenu: string | null; masque?: boolean; horodatage: string; empreinte: string; precedente: string }[] }>(
    '/public/journal/export');
  const recalculees = new Map<number, string>();
  let precedente = new Uint8Array([0]);
  let rupture: number | null = null;
  let masquees = 0;
  for (const e of entrees) {
    // Contenu masqué (donnée personnelle) : son empreinte ne se recalcule pas, le lien avec la précédente si.
    if (e.masque) {
      masquees++;
      if (rupture === null && e.precedente !== enHex(precedente)) rupture = e.numero;
      if (rupture === null) recalculees.set(e.numero, e.empreinte);
      precedente = deHex(e.empreinte);
      continue;
    }
    const texte = new TextEncoder().encode(`${e.type}|${e.contenu}|${e.horodatage}`);
    const donnees = new Uint8Array(precedente.length + texte.length);
    donnees.set(precedente);
    donnees.set(texte, precedente.length);
    const attendue = enHex(new Uint8Array(await crypto.subtle.digest('SHA-256', donnees)));
    if (rupture === null && (e.precedente !== enHex(precedente) || e.empreinte !== attendue)) rupture = e.numero;
    if (rupture === null) recalculees.set(e.numero, attendue);
    precedente = deHex(e.empreinte);
  }
  const ancres = ancrages.map((a) => ({ jour: a.jour, correspond: recalculees.get(a.derniereEntree) === a.empreinte }));
  return { nombre: entrees.length, masquees, rupture, ancres };
}
