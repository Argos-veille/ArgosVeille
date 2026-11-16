import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { execSync } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

// Version du site jointe aux rapports de bug : le commit en cours.
let version = 'inconnue';
try {
  version = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch { /* hors dépôt git */ }

// Clé de site Turnstile (publique). Vide en développement : jeton factice, aucun script chargé.
// Pour essayer le vrai widget en dev : ARGOS_TURNSTILE_CLE_SITE=1x00000000000000000000AA (clé de test
// de Cloudflare qui accepte toujours), avec la clé secrète de test côté API.
// « vite dev » : pas de construction ; la politique stricte des styles ne vaut que pour le site construit.
const enDev = !process.argv.includes('build');

const cleTurnstile = process.env['ARGOS_TURNSTILE_CLE_SITE'] ?? '';

// Tuiles de la carte (5,9 Go) : jamais copiées dans le site construit. En production, adresse donnée par
// ARGOS_TUILES (servies à part) ; en développement, servies par ce greffon depuis ../cartes/france.pmtiles,
// avec les requêtes partielles (Range) dont pmtiles a besoin.
const tuiles = process.env['ARGOS_TUILES'] ?? '';
const tuilesDev = (): Plugin => ({
  name: 'argos-tuiles-dev',
  configureServer(serveur) {
    serveur.middlewares.use('/carte/france.pmtiles', (req, res) => {
      const fichier = resolve('../cartes/france.pmtiles');
      let taille: number;
      try { taille = statSync(fichier).size; } catch { res.statusCode = 404; res.end(); return; }
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-type', 'application/octet-stream');
      if (!m) { res.setHeader('content-length', taille); createReadStream(fichier).pipe(res); return; }
      const debut = Number(m[1]);
      const fin = Math.min(m[2] ? Number(m[2]) : taille - 1, taille - 1);
      if (debut > fin) { res.statusCode = 416; res.setHeader('content-range', `bytes */${taille}`); res.end(); return; }
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${debut}-${fin}/${taille}`);
      res.setHeader('content-length', fin - debut + 1);
      createReadStream(fichier, { start: debut, end: fin }).pipe(res);
    });
  },
});

export default defineConfig({
  plugins: [
    tuilesDev(),
    sveltekit({
      adapter: adapter(),
      // Protection contre les formulaires envoyés depuis d'autres sites : l'adaptateur Node (v6) ne lit plus
      // ORIGIN et reconstruit l'adresse du site à partir de la requête, ce qui peut différer derrière le
      // tunnel ou Caddy. On déclare donc les deux adresses officielles (le formulaire du code bêta en dépend).
      csrf: { trustedOrigins: ['https://argos-veille.fr', 'https://admin.argos-veille.fr'] },
      // Politique de sécurité du contenu : rien d'extérieur. Scripts et styles du site seulement
      // (SvelteKit ajoute l'empreinte de ses propres scripts), images du site ou générées sur place.
      csp: {
        mode: 'hash',
        directives: {
          'default-src': ['self'],
          // Exception assumée (décision du 5 novembre 2026) : le test anti-robot Turnstile de Cloudflare,
          // seul script extérieur, chargé uniquement quand une page en a besoin (inscription, connexion
          // après des échecs, mot de passe oublié, envoi de vidéo). Cloudflare voit déjà tout le trafic.
          'script-src': ['self', 'https://challenges.cloudflare.com'],
          'frame-src': ['https://challenges.cloudflare.com'],
          // Styles : fichiers du site seulement. Restent permis les attributs style="…" que Svelte pose pour les
          // largeurs, hauteurs et positions calculées (style-src-attr) : ils ne peuvent ni charger ni exécuter quoi
          // que ce soit. En développement, Vite injecte ses styles dans la page : tout reste permis.
          'style-src': enDev ? ['self', 'unsafe-inline'] : ['self'],
          'style-src-elem': enDev ? ['self', 'unsafe-inline'] : ['self'],
          'style-src-attr': ['unsafe-inline'],
          'img-src': ['self', 'data:', 'blob:'],
          // Vidéos floutées lues directement sur Cloudflare R2, par des liens signés de 10 minutes.
          'media-src': ['self', 'blob:', 'https://*.r2.cloudflarestorage.com'],
          'font-src': ['self'],
          'connect-src': ['self'],
          'worker-src': ['self', 'blob:'],   // la carte dessine dans des « workers » créés sur place
          'frame-ancestors': ['none'],
          'base-uri': ['none'],
          'form-action': ['self'],
          'object-src': ['none'],
        },
      },
      version: { name: version },
    }),
  ],
  // Code partagé avec les tests : phrase secrète, chiffrement de l'original, métadonnées (alias de Vite ;
  // celui de SvelteKit est obsolète). Pour TypeScript : « paths » dans tsconfig.json.
  resolve: { alias: { 'argos-navigateur': new URL('../navigateur/src/index.ts', import.meta.url).pathname } },
  // La bibliothèque de carte (MapLibre) dépasse à elle seule 1 Mo : avertissement relevé en conséquence.
  build: { chunkSizeWarningLimit: 1500 },
  define: { __ARGOS_VERSION__: JSON.stringify(version), __ARGOS_TURNSTILE__: JSON.stringify(cleTurnstile),
            __ARGOS_TUILES__: JSON.stringify(tuiles) },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: { allow: ['.', '../navigateur'] },
    // L'API est servie sous /api, à la même adresse que le site : le cookie de session et la
    // vérification d'origine fonctionnent comme en production. L'origine du navigateur est gardée.
    proxy: {
      '/api': {
        target: process.env['ARGOS_API_INTERNE'] ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
        rewrite: (chemin) => chemin.replace(/^\/api/, ''),
      },
    },
  },
});
