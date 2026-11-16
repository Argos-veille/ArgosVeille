// Données de la page Relecture (GET /relecture), partagées par la liste et la page d'une convocation.
import { get } from './api.ts';
import type { Contexte } from './composants/ContexteVideo.svelte';

export type Raison = { cle: string; libelle: string; contraires?: string[] };
export interface Convocation extends Contexte {
  convocation: string; secondExamen: boolean; verdicts: string[]; raisonsObligatoires: boolean;
  expireLe: string; notesAnalystes: number;
  ressemblance: { video: string; pseudonyme: string | null } | null;
  evenements: { video: string; pseudonyme: string | null }[];
}
export interface Relecture {
  relecturesAujourdhui: number; plafondParJour: number; mailConvocations: boolean;
  raisons: { oui: Raison[]; non: Raison[] };
  convocations: Convocation[];
  notesAJuger: { convocation: string; notes: number; dejaJugees: number }[];
}
export const chargerRelecture = () => get<Relecture>('/relecture');
