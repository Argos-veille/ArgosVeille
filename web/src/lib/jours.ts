/** Jours restants avant la date AAAA-MM-JJ (négatif : dépassée), comptés au jour près. */
export function joursRestants(date: string, maintenant = new Date()): number {
  const fin = new Date(`${date}T00:00:00`);
  const jour = new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate());
  return Math.round((fin.getTime() - jour.getTime()) / 86_400_000);
}
