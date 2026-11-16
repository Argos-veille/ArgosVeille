// Statistiques publiques : comptes des vidéos publiées (sans les doublons d'une vidéo déjà publiée), par mois, nature
// des faits, forces et situation. Seulement ce que montrent déjà les fiches publiques. Calcul en base, gardé 5 minutes
// dans Redis (même résultat pour tous). Servi par GET /public/statistiques (le site) et GET /v1/statistiques (API).
// Une vidéo avec plusieurs sous-catégories ou situations compte dans chacune : ces totaux dépassent le nombre de vidéos.
import type { Dependances } from './app.ts';

export const PERIODES_STATS: Record<string, number | null> = { '7j': 7, '30j': 30, '1an': 365, tout: null };
const DUREE_CACHE = 300;

export interface Statistiques {
  periode: string; du: string | null; au: string | null; calculeLe: string;
  publiees: number; enDebat: number; publieesCes30Jours: number;
  parMois: { mois: string; videos: number }[];
  categories: Record<string, number>; sousCategories: Record<string, number>;
  forces: Record<string, number>; situations: Record<string, number>;
}

const objet = (rows: { code: string; n: string }[]) => Object.fromEntries(rows.map((r) => [r.code, Number(r.n)]));

/** Mois manquants remplis à zéro, du premier au dernier mois présent. */
function moisContinus(rows: { mois: string; n: string }[]): { mois: string; videos: number }[] {
  if (!rows.length) return [];
  const n = new Map(rows.map((r) => [r.mois, Number(r.n)]));
  const sortie: { mois: string; videos: number }[] = [];
  let [a, m] = rows[0]!.mois.split('-').map(Number) as [number, number];
  const fin = rows.at(-1)!.mois;
  for (let i = 0; i < 1200; i++) {
    const cle = `${a}-${String(m).padStart(2, '0')}`;
    sortie.push({ mois: cle, videos: n.get(cle) ?? 0 });
    if (cle === fin) break;
    if (++m > 12) { m = 1; a++; }
  }
  return sortie;
}

export async function statistiques(deps: Dependances, q: { periode?: string; du?: string; au?: string }): Promise<Statistiques> {
  const periode = q.periode ?? 'tout';
  const cle = `stats:${periode}:${q.du ?? ''}:${q.au ?? ''}`;
  const enCache = await deps.redis.get(cle);
  if (enCache) return JSON.parse(enCache) as Statistiques;

  const jours = PERIODES_STATS[periode] ?? null;
  // Filtre sur la date des faits (heure de Paris), commun à toutes les requêtes.
  const DATE = `($1::int IS NULL OR v.occurred_at >= now() - make_interval(days => $1))
            AND ($2::date IS NULL OR (v.occurred_at AT TIME ZONE 'Europe/Paris')::date >= $2)
            AND ($3::date IS NULL OR (v.occurred_at AT TIME ZONE 'Europe/Paris')::date <= $3)`;
  const PUBLIEES = `SELECT v.occurred_at, v.decided_at, v.category, v.subcategory, v.extra_subcategories, v.forces, v.situation,
                           v.extra_situations FROM core.videos v
                     WHERE v.status = 'published' AND NOT v.is_control AND ${DATE}
                       AND NOT EXISTS (SELECT 1 FROM core.videos m WHERE m.id = v.duplicate_of AND m.status = 'published')`;
  const p = [jours, q.du ?? null, q.au ?? null];
  const db = deps.bases.app;
  const [totaux, mois, categories, sous, forces, situations] = await Promise.all([
    db.query<{ publiees: string; en_debat: string; recentes: string }>(
      `SELECT (SELECT count(*) FROM (${PUBLIEES}) v) AS publiees,
              (SELECT count(*) FROM core.videos v WHERE v.status = 'under_debate' AND NOT v.is_control AND ${DATE}) AS en_debat,
              (SELECT count(*) FROM (${PUBLIEES}) v WHERE v.decided_at >= now() - interval '30 days') AS recentes`, p),
    db.query<{ mois: string; n: string }>(
      `SELECT to_char(v.occurred_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM') AS mois, count(*) AS n
         FROM (${PUBLIEES}) v WHERE v.occurred_at IS NOT NULL GROUP BY 1 ORDER BY 1`, p),
    db.query<{ code: string; n: string }>(
      `SELECT v.category AS code, count(*) AS n FROM (${PUBLIEES}) v WHERE v.category IS NOT NULL GROUP BY 1`, p),
    db.query<{ code: string; n: string }>(
      `SELECT c AS code, count(*) AS n FROM (${PUBLIEES}) v, unnest(array[v.subcategory] || v.extra_subcategories) c
        WHERE c IS NOT NULL GROUP BY 1`, p),
    db.query<{ code: string; n: string }>(
      `SELECT coalesce(v.forces, 'unknown') AS code, count(*) AS n FROM (${PUBLIEES}) v GROUP BY 1`, p),
    db.query<{ code: string; n: string }>(
      `SELECT c AS code, count(*) AS n FROM (${PUBLIEES}) v, unnest(array[v.situation] || v.extra_situations) c
        WHERE c IS NOT NULL GROUP BY 1`, p),
  ]);
  const t = totaux.rows[0]!;
  const s: Statistiques = {
    periode, du: q.du ?? null, au: q.au ?? null, calculeLe: new Date().toISOString(),
    publiees: Number(t.publiees), enDebat: Number(t.en_debat), publieesCes30Jours: Number(t.recentes),
    parMois: moisContinus(mois.rows),
    categories: objet(categories.rows), sousCategories: objet(sous.rows), forces: objet(forces.rows), situations: objet(situations.rows),
  };
  await deps.redis.set(cle, JSON.stringify(s), 'EX', DUREE_CACHE);
  return s;
}
