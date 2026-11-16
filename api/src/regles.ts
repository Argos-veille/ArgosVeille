// Règles de relecture modifiables depuis l'administration : bornes de chaque réglage et contrôles
// de cohérence. La base n'accepte que des nombres ; ce fichier dit lesquels ont un sens.

export interface Borne { min: number; max: number; entier?: boolean; defaut?: number }

export const BORNES: Record<string, Borne> = {
  // Relecture
  sample_size: { min: 3, max: 100, entier: true },
  enlargement_size: { min: 0, max: 100, entier: true },
  max_enlargements: { min: 0, max: 5, entier: true },
  max_review_days: { min: 0.001, max: 365 },
  summons_per_seat: { min: 1, max: 20, entier: true },
  summons_days: { min: 0.001, max: 365 },
  reviews_per_day: { min: 1, max: 100, entier: true },
  publish_threshold: { min: 0.5, max: 1 },
  reject_threshold: { min: 0, max: 0.5 },
  min_total_weight: { min: 0, max: 1000 },
  // Score des relecteurs
  score_initial: { min: 0, max: 100 },
  score_min: { min: 0, max: 100 },
  score_max: { min: 0, max: 100 },
  novice_days: { min: 0, max: 365 },
  novice_factor: { min: 0, max: 1 },
  consensus_threshold: { min: 0.5, max: 1 },
  gain: { min: 0, max: 10 },
  loss: { min: 0, max: 10 },
  inactivity_days: { min: 0.001, max: 365 },
  decay: { min: 0, max: 1 },
  // Vidéos de contrôle
  control_rate: { min: 0, max: 1 },
  control_loss: { min: 0, max: 10 },
  control_min_pool: { min: 0, max: 1000, entier: true, defaut: 30 },
  // Jury
  jury_size: { min: 3, max: 100, entier: true },
  jury_majority: { min: 2, max: 100, entier: true },
  jury_min_votes: { min: 1, max: 100, entier: true },
  jury_pool_share: { min: 0.01, max: 1 },
  jury_min_age_days: { min: 0, max: 3650 },
  jury_max_per_week: { min: 1, max: 50, entier: true },
  jury_days: { min: 0.001, max: 60 },
  jury_publish_floor: { min: 0, max: 1 },
  // Notes des analystes
  note_min_per_side: { min: 1, max: 100, entier: true, defaut: 3 },
  note_featured_share: { min: 0.5, max: 1, defaut: 0.6667 },
  note_unhelpful_share: { min: 0, max: 0.5, defaut: 0.3333 },
  // Divers
  collusion_threshold: { min: 1, max: 100, entier: true },
  vote_unlink_months: { min: 1, max: 120, entier: true },
};

/** Valeurs en vigueur, réglages absents remplacés par leur valeur par défaut. */
export function valeurs(params: Record<string, unknown>): Record<string, number> {
  const r: Record<string, number> = {};
  for (const [cle, b] of Object.entries(BORNES)) {
    const v = params[cle];
    if (typeof v === 'number') r[cle] = v;
    else if (b.defaut !== undefined) r[cle] = b.defaut;
  }
  return r;
}

/** Erreur lisible si les changements sortent des bornes ou rendent les règles incohérentes, sinon null. */
export function verifier(actuelles: Record<string, number>, changements: Record<string, number>): string | null {
  for (const [cle, v] of Object.entries(changements)) {
    const b = BORNES[cle];
    if (!b) return `réglage inconnu : ${cle}`;
    if (!Number.isFinite(v) || v < b.min || v > b.max) return `${cle} : entre ${b.min} et ${b.max}`;
    if (b.entier && !Number.isInteger(v)) return `${cle} : nombre entier`;
  }
  const n = { ...actuelles, ...changements };
  const ok = (a: string, b: string) => n[a] === undefined || n[b] === undefined || n[a]! <= n[b]!;
  if (!ok('reject_threshold', 'publish_threshold')) return 'le seuil de rejet doit rester sous le seuil de publication';
  if (!ok('score_min', 'score_initial') || !ok('score_initial', 'score_max')) return 'score : minimum ≤ initial ≤ maximum';
  if (!ok('jury_majority', 'jury_size') || !ok('jury_min_votes', 'jury_size')) return 'jury : majorité et votes minimum ≤ taille du jury';
  if (!ok('jury_majority', 'jury_min_votes')) return 'jury : majorité ≤ votes minimum';
  return null;
}
