// Laissez-passer anti-robot de l'envoi (revue de sécurité B11). Le test de Cloudflare (script extérieur) n'est jamais
// chargé dans la page où le code de 12 mots est créé et affiché : la page d'envoi obtient d'abord un laissez-passer,
// puis se recharge sans ce script. Le laissez-passer (valable 1 h, pour un seul envoi) est gardé le temps de l'onglet.
import { ErreurApi, post } from './api.ts';
import { jetonTurnstile } from './turnstile.ts';

const CLE = 'argos-passe-envoi';

/** Laissez-passer encore valable (au moins 5 minutes devant lui), ou null. */
export function lirePasse(): string | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(CLE) ?? 'null') as { passe: string; expire: number } | null;
    return p && p.expire > Date.now() + 5 * 60_000 ? p.passe : null;
  } catch { return null; }
}

/** Passe le test anti-robot, garde le laissez-passer, puis recharge la page (sans le script de Cloudflare). */
export async function obtenirPasseEtRecharger(): Promise<void> {
  const r = await post<{ passe: string; expireDans: number }>('/envois/laissez-passer', { turnstile: await jetonTurnstile() });
  try { sessionStorage.setItem(CLE, JSON.stringify({ passe: r.passe, expire: Date.now() + r.expireDans * 1000 })); } catch { /* sans stockage */ }
  location.reload();
}

/** Pour l'envoi : le laissez-passer, ou une erreur claire s'il a expiré. */
export function passeOuErreur(): string {
  const p = lirePasse();
  if (!p) throw new ErreurApi(400, 'passe_expire', {});
  return p;
}

export function oublierPasse(): void {
  try { sessionStorage.removeItem(CLE); } catch { /* sans stockage */ }
}
