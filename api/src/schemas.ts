// Briques de schéma JSON communes à tous les appels de l'API.

/**
 * Texte saisi : longueur bornée et aucun caractère de contrôle (octet nul, retour chariot,
 * tabulation, échappement…). PostgreSQL refuse l'octet nul, et ces caractères n'ont rien à faire
 * dans une saisie : ils servent surtout à piéger les journaux ou les en-têtes.
 */
export const texte = (max: number) => ({
  type: 'string', minLength: 1, maxLength: max, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]*$',
});

/** Texte sur plusieurs lignes : comme `texte`, mais le saut de ligne (\n) est permis. */
export const texteLong = (max: number) => ({
  type: 'string', minLength: 1, maxLength: max, pattern: '^[^\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f]*$',
});

/** Code stable d'une erreur levée par la base (« argos:… »), ou undefined. */
/** Choix principal suivi des autres choix (« Plus précisément », « Situation »). */
export const listeChoix = (principal: string | null, autres: string[]): string[] => (principal ? [principal, ...autres] : []);

export const codeArgos = (e: unknown): string | undefined => /argos:([a-z_]+)/.exec(String((e as Error)?.message))?.[1];
