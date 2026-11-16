// Listes chargées une fois au démarrage : mots de passe courants et mots interdits dans les pseudos.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function lignes(nom: string): string[] {
  const f = fileURLToPath(new URL(`../data/${nom}`, import.meta.url));
  return readFileSync(f, 'utf8').split('\n').filter((l) => l !== '' && !l.startsWith('# '));
}

export interface Listes {
  motsDePasseCourants: ReadonlySet<string>;  // en minuscules
  pseudosInterdits: readonly string[];       // déjà « aplatis » (minuscules, sans accents)
}

export function chargerListes(): Listes {
  return {
    motsDePasseCourants: new Set(lignes('mots-de-passe-courants.txt')),
    pseudosInterdits: lignes('pseudos-interdits.txt').map((l) => l.trim()).filter(Boolean),
  };
}
