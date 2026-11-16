// Données de l'espace analyste (GET /osint/videos).
import { get, post } from './api.ts';
import type { Contexte } from './composants/ContexteVideo.svelte';

export interface VideoOsint extends Contexte { video: string; etape: 'relecture' | 'jury' | 'analyse'; notes: number; mesNotes: number }
export const chargerVideos = () => get<{ plafondNotesParVideo: number; videos: VideoOsint[] }>('/osint/videos');

export interface PropositionOsint { id: string; origine: string; justification: string | null; le: string;
                                    video: { id: string; pseudonyme: string | null }; fiche: { id: string; pseudonyme: string | null } }
export const chargerPropositions = () => get<{ propositions: PropositionOsint[] }>('/osint/evenements');
export const proposerEvenement = (video: string, fiche: string, justification: string) =>
  post<{ proposition: string }>('/osint/evenements', { video, fiche, justification });
export const avisEvenement = (id: string, accord: boolean) => post<{ ok: true; etat: string }>(`/osint/evenements/${id}`, { accord });
