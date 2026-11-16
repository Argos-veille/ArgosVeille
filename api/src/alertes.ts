// Alerte par mail au super-administrateur quand l'API enchaîne des erreurs : au plus une par heure, sans donnée de requête.
import type { Dependances } from './app.ts';
import { ecrire } from './compte.ts';

const FENETRE_MINUTES = 15;
const SEUIL = 5;

export async function alerterErreurs(deps: Dependances): Promise<boolean> {
  const { bases, redis } = deps;
  const r = (await bases.app.query<{ total: number; route: string; occurrences: number }>('SELECT * FROM core.recent_error_summary($1)', [FENETRE_MINUTES])).rows[0];
  if (!r || r.total < SEUIL) return false;
  if ((await redis.set('alerte-erreurs', '1', 'EX', 3600, 'NX')) !== 'OK') return false;
  const admin = (await bases.app.query<{ id: string }>('SELECT id FROM core.accounts WHERE is_superadmin LIMIT 1')).rows[0];
  if (!admin) return false;
  return ecrire(deps, admin.id, 'erreurs du serveur',
    `${r.total} erreurs du serveur en ${FENETRE_MINUTES} minutes, dont ${r.occurrences} sur ${r.route}.\n\nLe détail est dans l’administration, page « Erreurs du serveur ».`);
}
