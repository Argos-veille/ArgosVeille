// Rapport de transparence : ce que la plateforme a fait pendant un trimestre TERMINÉ (jamais en direct : un compteur
// qui bouge juste après une action permettrait de la dater). Règles d'anonymat (l’administrateur, 14 novembre 2026) :
//   - 1 à 4 → « <5 » ; dans une même répartition, si une seule case est masquée, la plus petite autre l'est aussi
//     (sinon on la retrouverait par soustraction) ;
//   - une dimension à la fois, jamais de lieu, de forces, de type de compte, d'heure ni d'administrateur ;
//   - délai médian arrondi au jour, seulement s'il porte sur au moins 5 décisions.
// Servi par GET /public/transparence (le site) et GET /v1/transparence (API, avec la licence).
// Depuis 0110, la base applique elle-même ces règles (trimestre entier terminé, « <5 », masquage secondaire, délai) ;
// le site les réapplique en seconde couche (sans effet sur des valeurs déjà masquées).
import type { Dependances } from './app.ts';

export type Compte = number | '<5';
export const TRIMESTRE = '^[0-9]{4}-T[1-4]$';
const DUREE_CACHE = 3600;

const seuil = (n: Compte): Compte => (typeof n === 'number' && n >= 1 && n <= 4 ? '<5' : n);

/** Une répartition { code: nombre } avec ses petits nombres masqués, et le masquage secondaire. */
export function repartition(r: Record<string, Compte>): Record<string, Compte> {
  const sortie: Record<string, Compte> = Object.fromEntries(Object.entries(r).map(([c, n]) => [c, seuil(n)]));
  const masquees = Object.values(sortie).filter((n) => n === '<5').length;
  if (masquees === 1) {
    const autre = Object.entries(r).filter((e): e is [string, number] => typeof e[1] === 'number' && sortie[e[0]] !== '<5' && e[1] > 0)
      .sort((a, b) => a[1] - b[1])[0];
    if (autre) sortie[autre[0]] = '<5';
  }
  return sortie;
}

type Repartition = Record<string, Compte>;
interface Brut {
  envois: { recues: Compte; echecs: Compte; retireesParLaSource: Compte };
  decisions: { parResultat: Repartition; parQui: Repartition; delaiMedianJours: number | null };
  signalements: { parMotif: Repartition; parSuite: Repartition };
  retraits: Repartition; corrections: Compte; changementsDeRegles: Compte; sanctions: Repartition;
  originaux: { parAdministration: Repartition; parLaSource: Repartition; ouverturesParAdministration: Compte };
}

/** Bornes d'un trimestre « 2026-T4 » : [1er jour, 1er jour du suivant). */
export function bornes(t: string): { du: string; au: string } {
  const [a, q] = [Number(t.slice(0, 4)), Number(t.slice(6))];
  const mois = (q - 1) * 3 + 1;
  const fin = q === 4 ? `${a + 1}-01-01` : `${a}-${String(mois + 3).padStart(2, '0')}-01`;
  return { du: `${a}-${String(mois).padStart(2, '0')}-01`, au: fin };
}

const trimestreDe = (jour: string) => `${jour.slice(0, 4)}-T${Math.floor((Number(jour.slice(5, 7)) - 1) / 3) + 1}`;
const suivant = (t: string) => (t.endsWith('T4') ? `${Number(t.slice(0, 4)) + 1}-T1` : `${t.slice(0, 6)}${Number(t.slice(6)) + 1}`);

/** Trimestres terminés depuis la première entrée du journal (le plus récent d'abord), et la date du prochain rapport. */
export async function trimestres(deps: Dependances, aujourdhui = new Date()): Promise<{ trimestres: string[]; prochain: string }> {
  const r = await deps.bases.app.query<{ jour: string | null }>(
    `SELECT to_char(min(recorded_at) AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour FROM ledger.entries`);
  const jour = aujourdhui.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const encours = trimestreDe(jour);
  const liste: string[] = [];
  if (r.rows[0]?.jour) for (let t = trimestreDe(r.rows[0].jour); t !== encours && liste.length < 400; t = suivant(t)) liste.unshift(t);
  return { trimestres: liste, prochain: bornes(encours).au };
}

export async function rapport(deps: Dependances, t: string) {
  const cle = `transparence:${t}`;
  const enCache = await deps.redis.get(cle);
  if (enCache) return JSON.parse(enCache) as Record<string, unknown>;
  const { du, au } = bornes(t);
  const [b, autorites] = await Promise.all([
    deps.bases.app.query<{ r: Brut }>('SELECT core.transparency_report($1, $2) AS r', [du, au]).then((x) => x.rows[0]!.r),
    deps.bases.app.query<{ r: Record<string, Repartition> }>('SELECT core.transparency_authority($1, $2) AS r', [du, au])
      .then((x) => x.rows[0]!.r),
  ]);
  const sortie = {
    trimestre: t, du, au,
    envois: { recues: seuil(b.envois.recues), echecs: seuil(b.envois.echecs), retireesParLaSource: seuil(b.envois.retireesParLaSource) },
    decisions: {
      parResultat: repartition(b.decisions.parResultat), parQui: repartition(b.decisions.parQui),
      delaiMedianJours: b.decisions.delaiMedianJours,   // la base ne le donne que sur 5 décisions au moins
    },
    signalements: { parMotif: repartition(b.signalements.parMotif), parSuite: repartition(b.signalements.parSuite) },
    retraits: repartition(b.retraits), corrections: seuil(b.corrections), changementsDeRegles: seuil(b.changementsDeRegles),
    sanctions: repartition(b.sanctions),
    autorites: { parAuteur: repartition(autorites['parAuteur']!), parObjet: repartition(autorites['parObjet']!),
                 parSuite: repartition(autorites['parSuite']!) },
    originaux: {
      parAdministration: repartition(b.originaux.parAdministration), parLaSource: repartition(b.originaux.parLaSource),
      ouverturesParAdministration: seuil(b.originaux.ouverturesParAdministration),
    },
  };
  await deps.redis.set(cle, JSON.stringify(sortie), 'EX', DUREE_CACHE);
  return sortie;
}

/** Réponse commune aux deux routes : la liste des trimestres et le rapport demandé (le plus récent par défaut). */
export async function transparence(deps: Dependances, demande?: string):
  Promise<{ trimestres: string[]; prochain: string; rapport: Record<string, unknown> | null } | null> {
  const { trimestres: liste, prochain } = await trimestres(deps);
  const t = demande ?? liste[0];
  if (demande && !liste.includes(demande)) return null;
  return { trimestres: liste, prochain, rapport: t ? await rapport(deps, t) : null };
}
