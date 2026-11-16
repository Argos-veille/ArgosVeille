// Le site est rendu dans le navigateur : les pages appellent l'API directement (même adresse), sans
// que le serveur du site ne voie jamais le cookie de session. La partie publique (carte, fiches)
// pourra passer en rendu serveur à l'étape I-4.
export const ssr = false;
export const prerender = false;
