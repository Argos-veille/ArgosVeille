// Libellés affichés pour les codes de l'API. Neutres : ce sont des faits allégués, non jugés.
export const CATEGORIES: Record<string, string> = { violence: 'Violence physique', abuse: 'Abus non violent' };
export const SOUS_CATEGORIES: Record<string, string> = {
  strikes: 'Coups', disproportionate_force: 'Usage disproportionné de la force', weapons: 'Armes (LBD, grenades, taser)',
  chokehold: 'Clé d’étranglement, plaquage ventral', other_violence: 'Autre violence',
  contested_arrest: 'Interpellation contestée', discriminatory_stop: 'Contrôle signalé comme discriminatoire ou répété',
  insults: 'Propos insultants ou discriminatoires', intimidation: 'Intimidation, menaces',
  filming_obstruction: 'Entrave au droit de filmer', property_destruction: 'Destruction de téléphone ou de biens',
  complaint_refused: 'Refus de prendre une plainte', other_abuse: 'Autre abus',
};
export const FORCES: Record<string, string> = {
  national_police: 'Police nationale', gendarmerie: 'Gendarmerie', municipal_police: 'Police municipale', customs: 'Douane', unknown: 'Non identifiées',
};
export const SITUATIONS: Record<string, string> = {
  demonstration: 'Manifestation', stop: 'Contrôle', arrest: 'Interpellation', other: 'Autre situation',
};
/** Plusieurs choix en toutes lettres : « Coups, Armes (LBD, grenades, taser) ». */
export const libellesChoix = (codes: string[], noms: Record<string, string>): string => codes.map((c) => noms[c] ?? c).join(', ');
export const PRECISIONS: Record<string, string> = {
  exact: 'lieu précis', approx_100m: 'à 100 m près', municipality: 'commune seulement',
};
export const METADONNEES: Record<string, { texte: string; ton: 'succes' | 'attention' | 'info' }> = {
  coherent: { texte: 'Les métadonnées de la vidéo sont cohérentes avec la date et le lieu annoncés.', ton: 'succes' },
  incoherent: { texte: 'Les métadonnées de la vidéo ne correspondent pas à la date ou au lieu annoncés.', ton: 'attention' },
  absent: { texte: 'La vidéo n’a pas de métadonnées exploitables (fréquent après un partage : ce n’est pas suspect en soi).', ton: 'info' },
};

export function dateLongue(iso: string | null): string {
  if (!iso) return 'date inconnue';
  return new Date(iso).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Date des faits : avec l'heure si elle est connue, sinon la date seule et « heure inconnue ». */
export function dateFaits(iso: string | null, heureConnue = true): string {
  if (!iso) return 'date inconnue';
  if (heureConnue) return dateLongue(iso);
  return `${new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} (heure inconnue)`;
}

export function dansCombienDeTemps(iso: string): string {
  const h = Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000);
  return h < 1 ? 'moins d’une heure' : h < 48 ? `${h} h` : `${Math.round(h / 24)} jours`;
}
