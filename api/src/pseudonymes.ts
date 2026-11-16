// Pseudonymes des vidéos, générés par le site (jamais choisis par la source, qui pourrait y glisser
// un indice sur elle-même) : « Héron-Ambre-4821 ». 64 animaux × 32 couleurs × 9 000 nombres ≈ 18 millions.
import { randomInt } from 'node:crypto';

const ANIMAUX = [
  'Héron', 'Loup', 'Renard', 'Lynx', 'Chouette', 'Faucon', 'Castor', 'Blaireau', 'Hermine', 'Loutre', 'Cerf', 'Chamois',
  'Bouquetin', 'Marmotte', 'Écureuil', 'Hérisson', 'Lièvre', 'Martinet', 'Hirondelle', 'Mésange', 'Rouge-gorge', 'Pinson',
  'Corbeau', 'Pie', 'Geai', 'Milan', 'Busard', 'Vautour', 'Aigle', 'Grue', 'Cigogne', 'Martin', 'Goéland', 'Cormoran',
  'Macareux', 'Dauphin', 'Phoque', 'Baleine', 'Thon', 'Saumon', 'Truite', 'Brochet', 'Tortue', 'Lézard', 'Salamandre',
  'Grenouille', 'Crapaud', 'Abeille', 'Bourdon', 'Libellule', 'Papillon', 'Coccinelle', 'Grillon', 'Cigale', 'Fourmi',
  'Ours', 'Bison', 'Chevreuil', 'Sanglier', 'Genette', 'Fouine', 'Belette', 'Putois', 'Mouflon',
] as const;
const COULEURS = [
  'Ambre', 'Azur', 'Corail', 'Ivoire', 'Jade', 'Lilas', 'Ocre', 'Opale', 'Perle', 'Pourpre', 'Rubis', 'Saphir', 'Sépia',
  'Turquoise', 'Vermeil', 'Émeraude', 'Indigo', 'Cuivre', 'Bronze', 'Argent', 'Cendre', 'Cobalt', 'Grenat', 'Garance',
  'Safran', 'Sauge', 'Prune', 'Olive', 'Ardoise', 'Carmin', 'Céladon', 'Topaze',
] as const;

export function pseudonymeAleatoire(): string {
  return `${ANIMAUX[randomInt(ANIMAUX.length)]}-${COULEURS[randomInt(COULEURS.length)]}-${randomInt(1000, 10000)}`;
}

export const TAILLE_ESPACE_PSEUDONYMES = ANIMAUX.length * COULEURS.length * 9000;
