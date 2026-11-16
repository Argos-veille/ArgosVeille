// Boîte de confirmation du site (à la place de confirm() du navigateur) : `await confirmer({...})` renvoie
// vrai si la personne confirme. Affichée par Confirmation.svelte, montée une fois dans la mise en page.

export interface DemandeConfirmation {
  titre: string;
  texte?: string;
  oui?: string;                          // libellé du bouton de confirmation
  non?: string;                          // libellé du bouton d'annulation
  ton?: 'valider' | 'danger' | 'neutre';  // couleur du bouton de confirmation
}

export const confirmation = $state<{ demande: (DemandeConfirmation & { repondre: (ok: boolean) => void }) | null }>({ demande: null });

export function confirmer(d: DemandeConfirmation): Promise<boolean> {
  confirmation.demande?.repondre(false);   // une seule à la fois
  return new Promise((repondre) => {
    confirmation.demande = { ...d, repondre: (ok) => { confirmation.demande = null; repondre(ok); } };
  });
}
