// Volume des vidéos, commun à tous les lecteurs du site : bas par défaut (30 %), gardé dans ce navigateur.
const CLE = 'argos-son';
function lire(): { volume: number; muet: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(CLE) ?? 'null') as { volume?: unknown; muet?: unknown } | null;
    if (v && typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1) return { volume: v.volume, muet: v.muet === true };
  } catch { /* stockage indisponible ou valeur abîmée */ }
  return { volume: 0.3, muet: false };
}
export const son = $state(typeof localStorage === 'undefined' ? { volume: 0.3, muet: false } : lire());
export function garderSon() {
  try { localStorage.setItem(CLE, JSON.stringify({ volume: son.volume, muet: son.muet })); } catch { /* réglage pour cette page */ }
}
