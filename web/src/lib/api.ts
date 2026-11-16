// Appels à l'API (servie sous /api, à la même adresse que le site).
// Chaque appel est noté pour la télémétrie : route générique, statut, code d'erreur, durée et numéro
// de requête (en-tête x-argos-requete) — jamais le contenu envoyé ou reçu.
import { noterAppel, routeGenerique } from './telemetrie.ts';

export class ErreurApi extends Error {
  constructor(public statut: number, public code: string, public corps: Record<string, unknown>) {
    super(code);
  }
}

export async function api<T = Record<string, unknown>>(methode: 'GET' | 'POST' | 'PUT', chemin: string, corps?: unknown): Promise<T> {
  const debut = performance.now();
  let reponse: Response;
  try {
    reponse = await fetch(`/api${chemin}`, {
      method: methode,
      credentials: 'same-origin',
      headers: corps === undefined ? {} : { 'content-type': 'application/json' },
      body: corps === undefined ? undefined : JSON.stringify(corps),
    });
  } catch {
    noterAppel({ route: `${methode} ${routeGenerique(chemin)}`, statut: 0, erreur: 'reseau', duree: Math.round(performance.now() - debut) });
    throw new ErreurApi(0, 'reseau', {});
  }
  const json = (await reponse.json().catch(() => ({}))) as Record<string, unknown>;
  const erreur = typeof json['erreur'] === 'string' ? json['erreur'] : undefined;
  noterAppel({
    route: `${methode} ${routeGenerique(chemin)}`, statut: reponse.status, duree: Math.round(performance.now() - debut),
    ...(erreur ? { erreur } : {}), ...(reponse.headers.get('x-argos-requete') ? { requete: reponse.headers.get('x-argos-requete')! } : {}),
  });
  // Accès bêta révoqué ou expiré pendant la visite : on recharge, le site affiche la page d'attente.
  if (reponse.status === 403 && erreur === 'acces_beta'
      && !['/connexion', '/inscription/mail', '/recuperation', '/mot-de-passe-oublie'].includes(location.pathname)) location.reload();
  if (!reponse.ok) throw new ErreurApi(reponse.status, erreur ?? 'erreur_inconnue', json);
  return json as T;
}

export const get = <T = Record<string, unknown>>(chemin: string) => api<T>('GET', chemin);
export const post = <T = Record<string, unknown>>(chemin: string, corps: unknown = {}) => api<T>('POST', chemin, corps);
