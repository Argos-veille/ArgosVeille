// Côté serveur du site (le reste est rendu dans le navigateur) :
//   - le lecteur intégré (/integrer/…) est le seul contenu que d'autres sites peuvent afficher dans un cadre ;
//     partout ailleurs, « frame-ancestors 'none' » (politique de sécurité de vite.config.ts) ;
//   - les balises d'aperçu de partage (Open Graph, oEmbed) sont insérées dans l'en-tête, pour que X,
//     Mastodon ou une messagerie affichent une carte. Pour une fiche : nature, date, forces, « faits
//     allégués » ; jamais la description de la source (elle pourrait contenir des noms).
import type { Handle } from '@sveltejs/kit/hooks';
import { PAGES_LIBRES } from '#lib/pages-libres.ts';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { CATEGORIES, FORCES, SOUS_CATEGORIES } from '#lib/libelles.ts';

const API = process.env['ARGOS_API_INTERNE'] ?? 'http://127.0.0.1:3000';
// Page d'attente : ARGOS_EN_PREPARATION=oui sur l'instance publique tant que le site n'est pas ouvert.
// Toutes les pages affichent « Bientôt en ligne » (les fichiers statiques, servis avant, restent accessibles),
// SAUF pour qui a saisi un code d'accès à la bêta (cookie vérifié auprès de l'API, ARGOS_BETA=oui côté API).
const EN_PREPARATION = process.env['ARGOS_EN_PREPARATION'] === 'oui';
const COOKIE_BETA = '__Host-argos_beta';
const pageAttente = (erreur = '') => `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Argos Veille — bientôt en ligne</title>
  <meta name="description" content="Ce que les réseaux effacent, Argos le garde. Le site est en préparation.">
  <meta property="og:title" content="Argos Veille"><meta property="og:description" content="Ce que les réseaux effacent, Argos le garde. Bientôt en ligne.">
  <meta property="og:image" content="https://argos-veille.fr/apercu-partage.png"><meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    html, body { margin: 0; height: 100%; background: #1f2328; color: #e9e6df; }
    body { display: grid; place-items: center; font: 1rem/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; text-align: center; }
    main { padding: 2rem 1.25rem; max-width: 40rem; }
    img { width: min(30rem, 88vw); height: auto; }
    p { margin: 1.5rem 0 0; color: #c9c5bc; }
    a { color: #e8a33d; }
    details { margin-top: 2.5rem; color: #c9c5bc; }
    summary { cursor: pointer; color: #e8a33d; }
    form { display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; margin-top: 1rem; }
    input { font: inherit; padding: 0.5rem 0.75rem; border-radius: 6px; border: 1px solid #5b616b; background: #2b3036; color: #e9e6df;
            letter-spacing: 0.08em; text-transform: uppercase; width: 14rem; }
    button { font: inherit; font-weight: 600; padding: 0.5rem 1rem; border-radius: 6px; border: 0; background: #e8a33d; color: #1f2328; cursor: pointer; }
    .erreur { color: #f2a8a0; }
  </style>
</head>
<body>
  <main>
    <img src="/logo-complet-sombre.svg" alt="Argos Veille — Ce que les réseaux effacent, Argos le garde" width="691" height="232">
    <p>Le site est en préparation. Ouverture prochaine.</p>
    <p><a href="https://x.com/Argosveille" rel="noopener noreferrer">Suivre l’ouverture sur X : @Argosveille</a></p>
    <p><a href="/connexion">Vous avez déjà un compte ? Se connecter</a></p>
    <details${erreur ? ' open' : ''}>
      <summary>J’ai un code d’accès</summary>
      <form method="post" action="/acces-beta">
        <input name="code" aria-label="Code d’accès" placeholder="XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" required>
        <button type="submit">Entrer</button>
      </form>
      ${erreur ? `<p class="erreur" role="alert">${erreur}</p>` : ''}
    </details>
  </main>
</body>
</html>`;
const DEVISE = 'Ce que les réseaux effacent, Argos le garde. Recensement, vérification et cartographie des vidéos de violences et d’abus policiers.';
const FICHE = /^\/videos\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/;

const echapper = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Fiche { categorie: string | null; sousCategorie: string | null; forces: string | null; date: string | null; heureConnue: boolean; etat: string }

async function apercu(origine: string, chemin: string): Promise<{ titre: string; resume: string; oembed?: string }> {
  const m = FICHE.exec(chemin);
  if (!m) return { titre: 'Argos Veille', resume: DEVISE };
  try {
    const r = await fetch(`${API}/public/videos/${m[1]}`, { signal: AbortSignal.timeout(2_000) });
    if (!r.ok) return { titre: 'Argos Veille', resume: DEVISE };
    const f = (await r.json()) as Fiche;
    const quand = f.date ? new Date(f.heureConnue ? f.date : `${f.date}T12:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }) : null;
    const nature = [f.categorie && CATEGORIES[f.categorie], f.sousCategorie && SOUS_CATEGORIES[f.sousCategorie]].filter(Boolean).join(' · ');
    const resume = [quand, f.forces && FORCES[f.forces], f.etat === 'en_debat' ? 'vidéo en débat' : null].filter(Boolean).join(' · ');
    return {
      titre: `${nature || 'Vidéo'} — Argos Veille`,
      resume: `${resume ? `${resume}. ` : ''}Faits allégués, non jugés. Visages floutés.`,
      oembed: `${origine}/api/v1/oembed?url=${encodeURIComponent(`${origine}/videos/${m[1]}`)}`,
    };
  } catch {
    return { titre: 'Argos Veille', resume: DEVISE };
  }
}

// En-têtes de sécurité de toutes les pages (comme l'API, app.ts) : HTTPS imposé au navigateur pendant 2 ans, type des
// fichiers jamais deviné, adresse de la page jamais transmise aux autres sites (« same-origin » : voir la page d'attente).
const EN_TETES_SECURITE = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
} as const;

const attente = (erreur = '', statut = 200) => new Response(pageAttente(erreur), { status: statut, headers: {
  ...EN_TETES_SECURITE,
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  // « same-origin » et non « no-referrer » : sinon Firefox envoie le formulaire du code avec une origine
  // « null », que la protection de SvelteKit contre les formulaires d'autres sites refuse. Rien n'est
  // transmis aux autres sites.
  'x-robots-tag': 'noindex', 'referrer-policy': 'same-origin',
} });

// Accès déjà vérifiés auprès de l'API (une minute) : un code révoqué cesse de marcher très vite.
// Accès = un code bêta valable, OU être connecté à son compte (cookie de session).
const COOKIE_SESSION = '__Host-argos_session';
const verifies = new Map<string, number>();
function cookie(entete: string | null, nom: string, forme: RegExp): string | null {
  for (const morceau of (entete ?? '').split(';')) {
    const i = morceau.indexOf('=');
    if (i > 0 && morceau.slice(0, i).trim() === nom) { const v = morceau.slice(i + 1).trim(); return forme.test(v) ? v : null; }
  }
  return null;
}
async function accesBeta(entete: string | null): Promise<boolean> {
  const code = cookie(entete, COOKIE_BETA, /^[0-9A-Z]{12}$/);
  const session = cookie(entete, COOKIE_SESSION, /^[A-Za-z0-9_-]{43}$/);
  if (!code && !session) return false;
  const cle = `${code ?? ''}|${session ?? ''}`;
  if ((verifies.get(cle) ?? 0) > Date.now()) return true;
  try {
    const envoyes = [code ? `${COOKIE_BETA}=${code}` : '', session ? `${COOKIE_SESSION}=${session}` : ''].filter(Boolean).join('; ');
    const r = await fetch(`${API}/beta/etat`, { headers: { cookie: envoyes }, signal: AbortSignal.timeout(2_000) });
    const ok = r.ok && ((await r.json()) as { acces?: boolean }).acces === true;
    if (ok) { if (verifies.size > 10_000) verifies.clear(); verifies.set(cle, Date.now() + 60_000); }
    return ok;
  } catch {
    return false;
  }
}

/** Saisie du code sur la page d'attente (formulaire HTML, sans script) : l'API vérifie et pose le cookie. */
async function entrerBeta(requete: Request): Promise<Response> {
  const code = String((await requete.formData().catch(() => null))?.get('code') ?? '').slice(0, 40);
  const r = await fetch(`${API}/beta/entrer`, {
    method: 'POST', body: JSON.stringify({ code }), signal: AbortSignal.timeout(5_000),
    // L'API limite les essais par adresse : on lui transmet celle du visiteur (cloudflared la met ici).
    headers: { 'content-type': 'application/json', ...(requete.headers.get('x-forwarded-for') ? { 'x-forwarded-for': requete.headers.get('x-forwarded-for')! } : {}) },
  }).catch(() => null);
  if (!r) return attente('Le service ne répond pas. Réessayez dans un moment.', 503);
  if (r.status === 429) return attente('Trop d’essais. Réessayez dans une heure.', 429);
  if (!r.ok) return attente('Ce code n’est pas valable (ou plus valable).', 400);
  return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': r.headers.get('set-cookie') ?? '', 'cache-control': 'no-store' } });
}

// Tuiles de la carte (fichier de plusieurs Go, hors du site construit) : servies par le site lui-même, depuis le
// disque du serveur, avec les lectures partielles (Range) dont la carte a besoin. Publiques, même pendant la bêta.
const TUILES = process.env['ARGOS_FICHIER_TUILES'] ?? '/srv/argos/donnees/cartes/france.pmtiles';
function tuiles(requete: Request): Response {
  let taille: number;
  try { taille = statSync(TUILES).size; } catch { return new Response('Carte indisponible', { status: 404 }); }
  const entetes = { 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=86400' };
  const m = /^bytes=(\d+)-(\d*)$/.exec(requete.headers.get('range') ?? '');
  if (!m) {
    return new Response(Readable.toWeb(createReadStream(TUILES)) as ReadableStream, { headers: { ...entetes, 'content-length': String(taille) } });
  }
  const debut = Number(m[1]);
  const fin = Math.min(m[2] ? Number(m[2]) : taille - 1, taille - 1, debut + 16 * 1024 * 1024 - 1);   // 16 Mio au plus par lecture
  if (debut > fin) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${taille}` } });
  return new Response(Readable.toWeb(createReadStream(TUILES, { start: debut, end: fin })) as ReadableStream, {
    status: 206, headers: { ...entetes, 'content-range': `bytes ${debut}-${fin}/${taille}`, 'content-length': String(fin - debut + 1) },
  });
}

export const handle: Handle = async ({ event, resolve }) => {
  if (event.url.pathname === '/carte/france.pmtiles' && (event.request.method === 'GET' || event.request.method === 'HEAD')) {
    return tuiles(event.request);
  }
  let accesOuvert = true;
  if (EN_PREPARATION) {
    if (event.url.pathname === '/acces-beta' && event.request.method === 'POST') return entrerBeta(event.request);
    accesOuvert = await accesBeta(event.request.headers.get('cookie'));
    if (!PAGES_LIBRES.has(event.url.pathname) && !accesOuvert) {
      // Retour du formulaire traité par l'API (production) : motif du refus dans l'adresse.
      const motif = event.url.searchParams.get('beta');
      return attente(motif === 'invalide' ? 'Ce code n’est pas valable (ou plus valable).'
        : motif === 'trop' ? 'Trop d’essais. Réessayez dans une heure.' : '');
    }
  }
  const origine = event.url.origin;
  const a = event.url.pathname.startsWith('/integrer/') ? null : await apercu(origine, event.url.pathname);
  const balises = a ? [
    `<meta name="description" content="${echapper(a.resume)}">`,
    `<meta property="og:site_name" content="Argos Veille">`,
    `<meta property="og:type" content="${FICHE.test(event.url.pathname) ? 'article' : 'website'}">`,
    `<meta property="og:title" content="${echapper(a.titre)}">`,
    `<meta property="og:description" content="${echapper(a.resume)}">`,
    `<meta property="og:url" content="${echapper(`${origine}${event.url.pathname}`)}">`,
    `<meta property="og:image" content="${origine}/apercu-partage.png">`,
    `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
    `<meta property="og:locale" content="fr_FR">`,
    `<meta name="twitter:card" content="summary_large_image"><meta name="twitter:site" content="@Argosveille">`,
    ...(a.oembed ? [`<link rel="alternate" type="application/json+oembed" href="${echapper(a.oembed)}" title="Argos Veille">`] : []),
  ].join('\n    ') : '';

  const reponse = await resolve(event, {
    // Page libre vue sans accès : marquée, pour que la navigation interne repasse par ce contrôle (voir +layout.svelte).
    transformPageChunk: ({ html }) => {
      const marque = accesOuvert ? html : html.replace('<html', '<html data-sans-acces');
      return balises ? marque.replace('</head>', `    ${balises}\n  </head>`) : marque;
    },
  });
  for (const [nom, valeur] of Object.entries(EN_TETES_SECURITE)) if (!reponse.headers.has(nom)) reponse.headers.set(nom, valeur);
  // Site ouvert : l'ancien code d'accès à la bêta est effacé du navigateur (il ne doit plus accompagner aucun envoi, M13).
  if (!EN_PREPARATION && (event.request.headers.get('cookie') ?? '').includes(`${COOKIE_BETA}=`)) {
    reponse.headers.append('set-cookie', `${COOKIE_BETA}=; Path=/; Secure; SameSite=Lax; Max-Age=0`);
  }
  if (event.url.pathname.startsWith('/integrer/')) {
    const csp = reponse.headers.get('content-security-policy');
    if (csp) reponse.headers.set('content-security-policy', csp.replace("frame-ancestors 'none'", 'frame-ancestors *'));
  }
  return reponse;
};
