// Administration (super-administrateur) : session ouverte par la clé physique, tableau de bord,
// alertes et rapports de bug. Les actions sensibles redemandent la clé à chaque fois (avecCle).
import { startAuthentication } from '@simplewebauthn/browser';
import { get, post } from './api.ts';
import type { Contexte } from './composants/ContexteVideo.svelte';
import type { Note } from './composants/NoteAnalyste.svelte';

type OptionsCle = Parameters<typeof startAuthentication>[0]['optionsJSON'];

/** Demande un défi au serveur et le fait signer par la clé physique. */
export async function preuveCle() {
  const { options } = await post<{ options: OptionsCle }>('/admin/decision/defi');
  return startAuthentication({ optionsJSON: options });
}

export interface EtatSession { superAdmin: boolean; ouverte: boolean; expireDans: number }
export const etatSession = () => get<EtatSession>('/admin/session');
export const ouvrirSession = async () => post<{ ok: true; expireDans: number }>('/admin/session', { cle: await preuveCle() });
export const fermerSession = () => post('/admin/session/fin');

export interface TableauDeBord {
  aTraiter: { juresManquants: number; signalements: number; signalementsGraves: number; bugs: number; bugsUrgents: number; messages?: number; doublons?: number; contacts?: number };
  videos: { aVerifier: number; enTraitement: number; enFile: number; enRelecture: number; auJury: number; enDebat: number;
            publiees: number; publiees7j: number; echecs: number };
  communaute: { comptes: number; relecteursActifs30j: number; inscriptions7j: number; analystes: number; avecDoubleAuth: number };
  sante: { journalIntact: boolean; entreesJournal: number; dernierAncrage: { jour: string; simule: boolean; bloc: number | null } | null;
           derniereConvocation: string | null; dernierVote: string | null; erreursServeur24h: number };
  relecture: { disponibles: number; vivierJury: number; jurySize: number;
               convocations30j: { votees: number; passees: number; expirees: number; enAttente: number };
               dureeMoyenneHeures: number | null; plusAncienne: { depuis: string; fin: string } | null;
               decisions30j: { publiees: number; rejetees: number; enDebat: number; sansDecision: number } };
  recours: { sansDecision: number; plusAncienne: string | null };
  statutsARenouveler: { nombre: number; prochains: { compte: string; pseudo: string; statut: string; expire: string }[] };   // pas assez de votes : à trancher par l'administration
  analyse: { enAttente: number; plusAncienne: string | null; arrivees30j: number };   // lieu ou date à établir
  envois: { recues24h: number; recues7j: number; avecCompte7j: number; echecs7j: number; traitementMoyenMinutes: number | null; doublons7j: number };
}
export const tableauDeBord = () => get<TableauDeBord>('/admin/tableau-de-bord');

export interface AlerteJury { video: string; depuis: string; vivier: number | null; categorie: string | null;
                              sousCategorie: string | null; date: string | null }
export const alertes = () => get<{ juresManquants: AlerteJury[] }>('/admin/alertes');

export type Decision = 'publier' | 'rejeter' | 'debat' | 'relecture';
export const trancher = async (video: string, decision: Decision, motif: string) =>
  post<{ ok: true; statut: string }>(`/admin/videos/${video}/decision`, { decision, motif, cle: await preuveCle() });

export type StatutBug = 'open' | 'handled' | 'dismissed';
export const STATUTS_BUG: Record<StatutBug, string> = { open: 'À traiter', handled: 'Traités', dismissed: 'Écartés' };

export interface RapportBug { id: string; le: string; theme: string; precis: string; urgent: boolean; extrait: string; page: string;
                              pageSource: boolean; pseudo: string | null; capture: boolean; statut: StatutBug }
export interface ErreurServeur { request_id: string; created_at: string; method: string; route: string; error_name: string;
                                 message: string; stack: string }
export interface DetailBug extends Omit<RapportBug, 'extrait' | 'capture'> {
  description: string; telemetrie: Record<string, unknown> | null; capture: string | null; erreursServeur: ErreurServeur[];
}
export const rapportsBug = (statut: StatutBug) => get<{ rapports: RapportBug[] }>(`/admin/bugs?statut=${statut}`);
export const rapportBug = (id: string) => get<DetailBug>(`/admin/bugs/${id}`);
export const changerStatutBug = (id: string, statut: StatutBug) => post(`/admin/bugs/${id}/statut`, { statut });

export interface ThemeBug { cle: string; libelle: string; precis: { cle: string; libelle: string }[] }
export const themesBug = () => get<{ themes: ThemeBug[] }>('/bugs/themes');

// Vidéos (A2) : liste, fiche d'administration, lecture de la version floutée.
export const STATUTS_VIDEO: Record<string, string> = {
  processing: 'En traitement', failed: 'Échec du traitement', awaiting_author: 'Vérification par la source',
  in_review: 'En relecture', jury: 'Devant le jury', awaiting_osint: 'En attente d’analyse', published: 'Publiée', rejected: 'Rejetée', under_debate: 'En débat',
  no_decision: 'Sans décision', hidden: 'Masquée', removed: 'Retirée (motif légal)', withdrawn: 'Retirée par la source',
};
/** Couleur de la pastille d'un statut, la même que dans « Mes vidéos ». */
const TONS_STATUT: Record<string, string> = {
  awaiting_author: 'accent', uploading: 'info', processing: 'info', in_review: 'info', jury: 'info', awaiting_osint: 'accent', published: 'succes',
  failed: 'danger', rejected: 'danger', hidden: 'danger', removed: 'danger',
};
export const tonStatut = (statut: string): string => TONS_STATUT[statut] ?? '';
/** Statuts où le super-administrateur peut publier ou rejeter (core.admin_decide). */
export const DECIDABLES = ['in_review', 'jury', 'awaiting_osint', 'published', 'rejected', 'under_debate', 'no_decision'];

export interface VideoListe { id: string; statut: string; envoyeeLe: string; decideeLe: string | null; categorie: string | null;
                              sousCategorie: string | null; sousCategories: string[]; date: string | null; extrait: string | null; pseudonyme: string | null;
                              signalements: number; gelLegal: boolean; forces: string | null }
/** `filtres` : chaîne de requête déjà construite (statut, categorie, sousCategorie, forces, du, au, signalees, gel, texte). */
export const videosAdmin = (filtres: string) => get<{ videos: VideoListe[] }>(`/admin/videos${filtres ? `?${filtres}` : ''}`);

interface Tour { nombre: number; oui: number; enPartie: number; non: number; poids: number; partOui: number | null; visageSignale: number }
interface Convocs { envoyees: number; repondues: number; enAttente: number; expirees: number }
export interface Signalement { id: string; gravite: 'serious' | 'normal'; motif: string; details: string | null; le: string;
                               statut: 'open' | 'handled' | 'dismissed'; traiteLe: string | null }
export interface FicheAdmin extends Contexte {
  versionDe: { id: string; pseudonyme: string | null } | null;
  origine: { publiePar: string | null; lien: string | null; precisions: string | null; publique: boolean } | null;
  memeEvenement: VideoDoublon[];
  video: string; statut: string; envoyeeLe: string; relectureDepuis: string | null; juryDepuis: string | null; decideeLe: string | null;
  decideePar: 'review' | 'jury' | 'legal' | null; retireeLe: string | null; gelLegal: boolean; elargissements: number;
  premierTour: number | null; duree: number | null; echec: string | null; retouches: number;
  votes: Partial<Record<'review' | 'jury', Tour>>; convocations: Partial<Record<'review' | 'jury', Convocs>>;
  signalements: Signalement[]; notesMasquees: number; notes: Note[];
  journal: { numero: number; type: string; le: string; contenu: Record<string, unknown> }[];
  transmission: { autorisee: boolean; autoriseeLe: string | null; transmissions: { le: string; destinataire: string }[] };
  refloutage?: EtatRefloutage;
}
export const videoAdmin = (id: string) => get<FicheAdmin>(`/admin/videos/${id}`);
export const lienVideoAdmin = async (id: string) => (await post<{ lien: string }>(`/admin/videos/${id}/video`)).lien;
// Transmission de l'original (étape 3) : original CHIFFRÉ + enveloppe, à ouvrir sur le PC avec la YubiKey.
export type Destinataire = 'association' | 'avocat' | 'journaliste' | 'autre';
export const originalChiffre = async (video: string, motif: string) =>
  post<{ lien: string; sha256Original: string; enveloppe: unknown }>(`/admin/videos/${video}/original`, { motif, cle: await preuveCle() });
export const noterTransmission = async (video: string, destinataire: Destinataire, motif: string) =>
  post(`/admin/videos/${video}/transmission`, { destinataire, motif, cle: await preuveCle() });
export const masquerNote = async (note: string, motif: string) =>
  post(`/admin/notes/${note}/masquer`, { motif, cle: await preuveCle() });
export const demasquerNote = async (note: string, motif: string) =>
  post(`/admin/notes/${note}/demasquer`, { motif, cle: await preuveCle() });

export const MOTIFS_SIGNALEMENT: Record<string, string> = {
  visible_identity: 'Personne identifiable', identifying_text: 'Texte identifiant', illegal_content: 'Contenu illégal', defamation: 'Diffamation',
  wrong_context: 'Contexte faux', other: 'Autre',
};

// Signalements et modération (A2-2).
export type ActionModeration = 'masquer' | 'retablir' | 'retirer' | 'geler' | 'degeler';
export interface EtatRefloutage { enCours: boolean; etape: 'preparation' | 'attente' | 'rendu' | null; avancement: number | null;
                                 derniere: { le: string; echec: boolean; faite: boolean } | null }
export const etatRefloutage = (video: string) => get<EtatRefloutage>(`/admin/videos/${video}/refloutage`);
export const refluter = async (video: string, zones: { debut: number; fin: number; de: number[]; a: number[] }[], motif: string) =>
  post(`/admin/videos/${video}/refloutage`, { zones, motif, cle: await preuveCle() });

export const rattacherDoublon = async (id: string, video: string, motif: string) =>
  post<{ ok: true; fiche: string }>(`/admin/doublons/${id}/rattacher`, { video, motif, cle: await preuveCle() });
export interface PropositionEvenement { id: string; origine: 'source' | 'reviewer' | 'analyst' | 'admin'; justification: string | null; le: string;
                                        oui: number; non: number; video: VideoDoublon; fiche: { id: string; pseudonyme: string | null } }
export const propositionsEvenement = () => get<{ propositions: PropositionEvenement[] }>('/admin/evenements');
export const deciderEvenement = async (id: string, accepter: boolean, motif: string) =>
  post(`/admin/evenements/${id}`, { accepter, motif, cle: await preuveCle() });
export const relierEvenement = async (video: string, fiche: string, motif: string) =>
  post(`/admin/videos/${video}/evenement`, { fiche, motif, cle: await preuveCle() });
export const retirerEvenement = async (video: string, motif: string) =>
  post(`/admin/videos/${video}/evenement/retirer`, { motif, cle: await preuveCle() });
export interface MessageContact { id: string; le: string; motif: string; traiteLe: string | null; mail: string | null; message: string }
export const messagesContact = (traites: boolean) => get<{ messages: MessageContact[] }>(`/admin/contact?traites=${traites ? 'oui' : 'non'}`);
export const traiterContact = (id: string, traite: boolean) => post<{ ok: true }>(`/admin/contact/${id}`, { traite });
export interface Controle { video: string; pseudonyme: string | null; nomAffiche: string; reponse: boolean; active: boolean; retiree: boolean;
                            votes: number; corrects: number }
export const controles = () => get<{ controles: Controle[] }>('/admin/controles');
export const activerControle = (video: string, active: boolean) => post<{ ok: true }>(`/admin/controles/${video}`, { active });
export interface ErreurRecente { requete: string; le: string; route: string; statut: number; nom: string | null; message: string | null; trace: string | null }
export const erreursServeur = (heures: number) => get<{ erreurs: ErreurRecente[] }>(`/admin/erreurs?heures=${heures}`);
export const supprimerEchec = async (video: string, motif: string) =>
  post(`/admin/videos/${video}/supprimer-echec`, { motif, cle: await preuveCle() });
export interface OrigineSaisie { publiePar?: string; lien?: string; precisions?: string; publique: boolean }
export const modifierOrigine = async (video: string, origine: OrigineSaisie, motif: string) =>
  post(`/admin/videos/${video}/origine`, { ...origine, motif, cle: await preuveCle() });
export const annulerVersion = async (video: string, motif: string) =>
  post(`/admin/videos/${video}/version/annuler`, { motif, cle: await preuveCle() });

export const moderer = async (video: string, action: ActionModeration, motif: string) =>
  post(`/admin/videos/${video}/moderation`, { action, motif, cle: await preuveCle() });

export interface SignalementAdmin extends Signalement { video: string; pseudonyme: string | null; statutVideo: string;
                                                       note: string | null; origine: 'compte' | 'relecture' }
export const signalements = (statut: StatutBug) => get<{ signalements: SignalementAdmin[] }>(`/admin/signalements?statut=${statut}`);
export interface VideoDoublon { id: string; pseudonyme: string | null; statut: string }
export interface Doublon { id: string; niveau: 'exact' | 'strong' | 'possible'; le: string;
                           scores: { visuel: number | null; son: number | null; camera: number | null };
                           video: VideoDoublon; autre: VideoDoublon }
export const doublons = (ecartes: boolean) => get<{ doublons: Doublon[] }>(`/admin/doublons?ecartes=${ecartes ? 'oui' : 'non'}`);
export const ecarterDoublon = (id: string, ecarter: boolean) => post<{ ok: true }>(`/admin/doublons/${id}`, { ecarter });
export const classerSignalement = (id: string, statut: 'handled' | 'dismissed', note: string) =>
  post<{ ok: true; prevenu: boolean }>(`/admin/signalements/${id}`, { statut, note });

// Comptes (A3).
export interface CompteListe { id: string; pseudo: string; inscritLe: string; statut: 'active' | 'suspended' | 'banned';
                               suspenduJusqua: string | null; score: number; votes: number; dernierVote: string | null;
                               derniereActivite: string | null; doubleAuth: boolean; analyste: boolean; suspect: boolean;
                               superAdmin: boolean; messagesNonLus: number }
export const STATUTS_COMPTE: Record<string, string> = { active: 'Actif', suspended: 'Suspendu', banned: 'Exclu' };
export const comptesAdmin = (filtres: string) => get<{ comptes: CompteListe[] }>(`/admin/comptes${filtres ? `?${filtres}` : ''}`);

export interface MessageAdmin { id: string; deLAdmin: boolean; texte: string; le: string; luLe: string | null }
export interface FicheCompte {
  id: string; pseudo: string; inscritLe: string; statut: 'active' | 'suspended' | 'banned'; suspenduJusqua: string | null;
  score: number; suspect: boolean; superAdmin: boolean; analyste: boolean; doubleAuth: ('totp' | 'webauthn')[];
  sessionsOuvertes: number; derniereActivite: string | null;
  activite: { votes: number; votesJury: number; dernierVote: string | null; convocations30j: number; notes: number;
              notesMasquees: number; corrections: number; signalements: number };
  sanctions: { type: 'logout' | 'suspend' | 'ban'; le: string; fin: string | null; motif: string | null; leveeLe: string | null }[];
  messages: MessageAdmin[];
  statuts: StatutCompte[];   // statuts actifs
  echeances: Partial<Record<StatutCompte, string>>;   // échéance des statuts annuels (renouvelables 30 jours avant)
}
export const compteAdmin = (id: string) => get<FicheCompte>(`/admin/comptes/${id}`);
export type ActionCompte = 'deconnecter' | 'suspendre' | 'lever' | 'bannir';
export const sanctionner = async (id: string, action: ActionCompte, motif: string, jours?: number) =>
  post<{ ok: true; prevenu: boolean }>(`/admin/comptes/${id}/sanction`, { action, motif, ...(jours ? { jours } : {}), cle: await preuveCle() });
// Statuts d'un compte : tous gérés depuis la fiche (clé physique).
export type StatutCompte = 'journaliste' | 'avocat' | 'association' | 'analyste' | 'confiance';
export const STATUTS_SPECIAUX: Record<StatutCompte, string> = {
  journaliste: 'Journaliste', avocat: 'Avocat', association: 'Association', analyste: 'Analyste OSINT', confiance: 'Compte de confiance',
};
export const changerStatut = async (pseudo: string, statut: StatutCompte, accorder: boolean) =>
  post(`/admin/comptes/${encodeURIComponent(pseudo)}/statut`, { statut, accorder, cle: await preuveCle() });
export const ecrireAuCompte = (id: string, texte: string) => post<{ ok: true; prevenu: boolean }>(`/admin/comptes/${id}/messages`, { texte });

export interface BorneRegle { min: number; max: number; entier?: boolean; defaut?: number }
export interface VersionRegles { version: number; le: string; motif: string | null; changements: { cle: string; avant: number | null; apres: number }[] }
export const regles = () => get<{ version: number; valeurs: Record<string, number>; bornes: Record<string, BorneRegle>; historique: VersionRegles[] }>('/admin/regles');
export const changerRegles = async (changements: Record<string, number>, motif: string) =>
  post<{ ok: true; version: number }>('/admin/regles', { changements, motif, cle: await preuveCle() });

// Notes de l'administration : pense-bêtes privés, date facultative.
export interface NoteAdmin { id: string; titre: string; date: string | null; detail: string | null }
export const notesAdmin = () => get<{ notes: NoteAdmin[] }>('/admin/notes');
export const enregistrerNoteAdmin = (n: { id?: string; titre: string; date: string | null; detail: string | null }) =>
  post<{ id: string }>('/admin/notes', n);
export const supprimerNoteAdmin = (id: string) => post(`/admin/notes/${id}/supprimer`);

// Description : correction ou masquage d'un passage par l'administration seule, sans copie du texte remplacé (0113, 0114).
export interface CorrectionDescription { id: string; le: string; justification: string }
export const correctionsDescription = (video: string) => get<{ corrections: CorrectionDescription[] }>(`/admin/videos/${video}/description`);
export const corrigerDescription = async (video: string, description: string, justification: string) =>
  post<{ correction: string }>(`/admin/videos/${video}/description`, { description, justification, cle: await preuveCle() });
