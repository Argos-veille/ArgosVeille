// État de la porte de l'administration, partagé entre PorteAdmin et les pages qu'elle protège :
// une page qui reçoit « session_admin_requise » referme la porte.
import { ErreurApi } from './api.ts';

export const porte = $state<{ etat: 'chargement' | 'interdit' | 'fermee' | 'ouverte' }>({ etat: 'chargement' });

/** Vrai (et porte refermée) si l'erreur vient d'une session d'administration expirée. */
export function sessionExpiree(e: unknown): boolean {
  if (e instanceof ErreurApi && e.code === 'session_admin_requise') {
    porte.etat = 'fermee';
    return true;
  }
  return false;
}
