// Zones de flou ajoutées à la main : un chemin de points de passage (instant + rectangle), envoyé au serveur en segments
// « de tel rectangle à tel autre ». Permet de suivre un mouvement irrégulier de la caméra.
export interface Point { t: number; rect: number[] }
export interface Segment { debut: number; fin: number; de: number[]; a: number[] }

const memes = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Regroupe les segments qui se suivent en chemins de points. */
export function regrouper(segments: Segment[]): Point[][] {
  const chemins: Point[][] = [];
  for (const s of [...segments].sort((a, b) => a.debut - b.debut)) {
    const c = chemins.find((p) => p.at(-1)!.t === s.debut && memes(p.at(-1)!.rect, s.de));
    if (c) c.push({ t: s.fin, rect: [...s.a] });
    else chemins.push([{ t: s.debut, rect: [...s.de] }, { t: s.fin, rect: [...s.a] }]);
  }
  return chemins;
}

export function aplatir(chemins: Point[][]): Segment[] {
  return chemins.flatMap((p) => p.slice(1).map((b, i) => ({ debut: p[i]!.t, fin: b.t, de: p[i]!.rect, a: b.rect })));
}

/** Rectangle à l'instant t, ou null hors du chemin (`borne` : garde alors le premier ou le dernier point). */
export function interpoler(points: Point[], t: number, borne = false): number[] | null {
  const n = points.length;
  if (!n) return null;
  if (t < points[0]!.t) return borne ? points[0]!.rect : null;
  if (t > points[n - 1]!.t) return borne ? points[n - 1]!.rect : null;
  let i = 0;
  while (i < n - 2 && points[i + 1]!.t < t) i++;
  if (n === 1) return points[0]!.rect;
  const a = points[i]!, b = points[i + 1]!;
  const f = (t - a.t) / (b.t - a.t || 1);
  return a.rect.map((v, k) => v + (b.rect[k]! - v) * f);
}

/** Ajoute un point à sa place dans le temps ; à la même image, il remplace le point existant. */
export function poser(points: Point[], t: number, rect: number[], tolerance = 1 / 60): Point[] {
  const arrondi = Math.round(t * 1000) / 1000;
  return [...points.filter((p) => Math.abs(p.t - arrondi) > tolerance), { t: arrondi, rect }].sort((a, b) => a.t - b.t);
}
