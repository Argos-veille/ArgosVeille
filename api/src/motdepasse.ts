// Règle du mot de passe : 12 caractères minimum, sans obligation de majuscules ou de symboles,
// mais refus des mots de passe courants et des mots de passe trop répétitifs. Aucun service extérieur.

export type ResultatMotDePasse = { ok: true } | { ok: false; erreur: 'mdp_trop_court' | 'mdp_trop_long' | 'mdp_courant' | 'mdp_repetitif' | 'mdp_contient_pseudo' };

export function validerMotDePasse(mdp: string, pseudo: string, courants: ReadonlySet<string>): ResultatMotDePasse {
  const caracteres = [...mdp];
  if (caracteres.length < 12) return { ok: false, erreur: 'mdp_trop_court' };
  if (caracteres.length > 128) return { ok: false, erreur: 'mdp_trop_long' };
  const bas = mdp.toLowerCase();
  if (courants.has(bas)) return { ok: false, erreur: 'mdp_courant' };
  if (new Set(caracteres).size < 5) return { ok: false, erreur: 'mdp_repetitif' };  // « aaaaaaaaaaaa », « abababababab »
  if (pseudo.length >= 3 && bas.includes(pseudo.toLowerCase())) return { ok: false, erreur: 'mdp_contient_pseudo' };
  return { ok: true };
}
