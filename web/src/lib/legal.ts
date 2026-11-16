// Informations légales du site, regroupées ici (mentions légales, confidentialité, contact).
// Choix de l’administrateur (7 novembre 2026), en attendant l'association : éditeur ANONYME, personne physique non
// professionnelle (LCEN art. 1-1, II) — ses coordonnées sont chez l'hébergeur, le site ne publie que celles de
// l'hébergeur. À faire confirmer par l'avocat (question 33). Quand l'association existera : anonyme = false
// et remplir nom, forme, RNA, siège, directeur de la publication.
// Coordonnées des prestataires relevées le 7 novembre 2026 : à revérifier avant l'ouverture.

export const A_COMPLETER = '[À COMPLÉTER]';

export const EDITEUR = {
  anonyme: true,
  nom: A_COMPLETER,               // ex. « Association Argos Veille » (loi 1901)
  forme: A_COMPLETER,             // ex. « association déclarée (loi du 1er juillet 1901) »
  rna: A_COMPLETER,               // numéro RNA (W…), une fois l'association déclarée
  siege: A_COMPLETER,             // adresse du siège (une domiciliation est possible)
  directeurPublication: A_COMPLETER,
};

/** Dépôt public du code (licence AGPL), mis à jour à chaque version publiée. */
export const CODE_SOURCE = 'https://github.com/Argos-veille/ArgosVeille';

export const CONTACT = {
  mail: 'contact@argos-veille.fr',   // boîte Infomaniak (l'ancienne noreply@, renommée), sert aussi d'expéditeur des mails
};

export const PRESTATAIRES = [
  { role: 'Hébergement du serveur', nom: 'Hostinger International Ltd', adresse: '61 Lordou Vironos, 6023 Larnaca, Chypre',
    lieu: 'serveur situé en France' },
  { role: 'Connexion sécurisée, protection anti-robot (Turnstile) et stockage des fichiers vidéo (R2)', nom: 'Cloudflare, Inc.',
    adresse: '101 Townsend Street, San Francisco, CA 94107, États-Unis', lieu: 'réseau mondial' },
  { role: 'Envoi des mails', nom: 'Infomaniak Network SA', adresse: 'Rue Eugène-Marziano 25, 1227 Les Acacias (Genève), Suisse',
    lieu: 'Suisse' },
  { role: 'Envoi des SMS de vérification', nom: 'OVH SAS (OVHcloud)', adresse: '2 rue Kellermann, 59100 Roubaix, France',
    lieu: 'France' },
] as const;
