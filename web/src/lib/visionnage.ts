// Premier visionnage en relecture : part de la vidéo réellement vue = union des passages regardés.
// Revoir le même passage en boucle ne compte qu'une fois.

export type Passage = [number, number];   // [début, fin] en secondes

/** Ajoute un passage et fusionne avec ceux qu'il touche ; la liste rendue est triée, sans chevauchement. */
export function ajouterPassage(liste: Passage[], debut: number, fin: number): Passage[] {
  const tous = [...liste.map((p) => [...p] as Passage), [debut, fin] as Passage].sort((a, b) => a[0] - b[0]);
  const r: Passage[] = [];
  for (const [a, b] of tous) {
    const precedent = r[r.length - 1];
    if (precedent && a <= precedent[1]) precedent[1] = Math.max(precedent[1], b);
    else r.push([a, b]);
  }
  return r;
}

/** Durée totale couverte par les passages, en secondes. */
export const dureeVue = (liste: Passage[]) => liste.reduce((total, [a, b]) => total + (b - a), 0);
