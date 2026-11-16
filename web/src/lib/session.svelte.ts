// Compte connecté (GET /moi), partagé par toutes les pages.
import { ErreurApi, get, post } from './api.ts';

export interface Moi {
  pseudo: string;
  inscritLe: string;
  codesSecoursRestants: number;
  doubleAuthentification: ('totp' | 'webauthn')[];
  analysteOsint: boolean;
  superAdmin?: true;
  messagesNonLus: number;
  conditionsAAccepter?: string;
  convocations: boolean;
  certification?: 'journalist' | 'lawyer' | 'association' | 'trusted';   // compte certifié par un code
  // Messagerie avec les sources : comptes vérifiés (journaliste, avocat, association) et super-admin.
  messagerieSources?: { statut: 'journalist' | 'lawyer' | 'association' | 'admin'; nonLus: number };
  messagesVideosNonLus?: number;   // messages reçus au sujet des vidéos envoyées avec ce compte
}

export const session = $state<{ moi: Moi | null; chargee: boolean }>({ moi: null, chargee: false });

export async function rafraichir(): Promise<Moi | null> {
  try {
    session.moi = await get<Moi>('/moi');
  } catch (e) {
    if (!(e instanceof ErreurApi && e.statut === 401)) throw e;
    session.moi = null;
  } finally {
    session.chargee = true;
  }
  return session.moi;
}

export async function deconnecter() {
  await post('/deconnexion').catch(() => {});
  session.moi = null;
  cleMessagerie.ouverte = null;   // la clé de messagerie ouverte ne survit pas à la déconnexion
}

/** Clé de messagerie du compte, ouverte (en mémoire seulement, jamais enregistrée dans le navigateur). */
export const cleMessagerie = $state<{ ouverte: import('argos-navigateur').CleOuverte | null }>({ ouverte: null });
