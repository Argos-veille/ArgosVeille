// Clé publique de messagerie de l'Administration, ÉPINGLÉE dans le code du site (second audit, N2) : la source ne
// chiffre pour « Administration » que vers cette clé, jamais vers une clé que renverrait le serveur (base ou API
// compromise). null tant qu'elle n'est pas renseignée : la source voit alors l'empreinte, comme pour un journaliste.
// À remplir avec la valeur affichée par 08-redeployer.sh (ligne « clé de messagerie admin »), puis redéployer.
export const CLE_MESSAGERIE_ADMIN: string | null = 'BE1jsYWw4nbX0O9/cpyjbeVGeXY5ZI/VQZhivfuqdGGK1yO1fkDAiKeE3AMwtTz0F3m7hNyv4y0Dg24TsNFOqkQ=';
