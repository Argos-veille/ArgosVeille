<script lang="ts">
  import { dev } from '$app/env';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { deconnecter, session } from '#lib/session.svelte.ts';
  import { basculer, theme } from '#lib/theme.svelte.ts';
  import Logo from './Logo.svelte';

  // Menu (15 novembre 2026) : la carte en lien direct, trois menus déroulants (Vidéos, Découvrir, Participer),
  // l'administration, et « Envoyer une vidéo » en bouton.
  // Téléphone : le bouton « Menu » montre les mêmes groupes en sections. Clavier : Échap ferme et rend le focus.
  interface Lien { href: string; texte: string }
  let menuOuvert = $state(false);
  let deroule = $state<string | null>(null);
  const actif = (href: string) => page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
  const directs: Lien[] = [{ href: '/carte', texte: 'Carte' }];
  const groupes = $derived<{ nom: string; liens: Lien[] }[]>([
    { nom: 'Vidéos', liens: [
      { href: '/en-debat', texte: 'En débat' },
      // Connecté : ses vidéos envoyées avec le compte (la page renvoie aussi vers le suivi par code).
      session.moi ? { href: '/compte/videos', texte: 'Mes vidéos' } : { href: '/suivi', texte: 'Suivre ma vidéo' },
    ] },
    { nom: 'Découvrir', liens: [
      { href: '/comment-ca-marche', texte: 'Comment ça marche' },
      { href: '/statistiques', texte: 'Statistiques' },
      { href: '/journal', texte: 'Journal public' },
      { href: '/transparence', texte: 'Rapport de transparence' },
      { href: '/donnees', texte: 'Données ouvertes et API' },
    ] },
    { nom: 'Participer', liens: [
      ...(session.moi ? [{ href: '/relecture', texte: 'Relecture' }] : []),
      ...(session.moi?.analysteOsint ? [{ href: '/analyste', texte: 'Analyste' }] : []),
      { href: '/soutenir', texte: 'Soutenir Argos Veille' },
    ] },
  ]);
  // L'administration n'existe que sur admin.argos-veille.fr (joignable par WireGuard) et en développement.
  const administration = $derived(!!session.moi?.superAdmin && (dev || page.url.hostname.startsWith('admin.')));

  function fermer() { menuOuvert = false; deroule = null; }
  function basculerGroupe(nom: string) { deroule = deroule === nom ? null : nom; }
  /** Échap : ferme le menu déroulant ouvert et rend le focus à son bouton. */
  function touche(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !deroule) return;
    const nom = deroule;
    deroule = null;
    document.getElementById(`bouton-${nom}`)?.focus();
  }
  /** Clic ou focus hors d'un menu déroulant : il se ferme. */
  function dehors(e: Event) {
    if (deroule && !(e.target as Element | null)?.closest?.('.groupe')) deroule = null;
  }

  async function sortir() {
    await deconnecter();
    fermer();
    await goto('/');
  }
</script>

<svelte:window onkeydown={touche} onclick={dehors} onfocusin={dehors} />

<header class="entete">
  <div class="conteneur barre">
    <a href="/" class="marque" aria-label="Argos Veille, accueil"><Logo taille={30} /></a>

    <button class="bouton bascule-menu" aria-expanded={menuOuvert} aria-controls="menu-principal"
            onclick={() => (menuOuvert = !menuOuvert)}>
      Menu
    </button>

    <nav id="menu-principal" class:ouvert={menuOuvert} aria-label="Navigation principale">
      <ul class="liens">
        {#each directs as l (l.href)}
          <li><a href={l.href} aria-current={actif(l.href) ? 'page' : undefined} onclick={fermer}>{l.texte}</a></li>
        {/each}
        {#each groupes as g (g.nom)}
          <li class="groupe">
            <button id="bouton-{g.nom}" class="titre-groupe" type="button" aria-expanded={deroule === g.nom} aria-controls="menu-{g.nom}"
                    class:courant={g.liens.some((l) => actif(l.href))} onclick={() => basculerGroupe(g.nom)}>
              {g.nom} <span aria-hidden="true">▾</span>
            </button>
            <span class="section">{g.nom}</span>
            <ul id="menu-{g.nom}" class="sous" class:ouvert={deroule === g.nom}>
              {#each g.liens as l (l.href)}
                <li><a href={l.href} aria-current={actif(l.href) ? 'page' : undefined} onclick={fermer}>{l.texte}</a></li>
              {/each}
            </ul>
          </li>
        {/each}
        {#if administration}
          <li><a href="/admin" aria-current={actif('/admin') ? 'page' : undefined} onclick={fermer}>Administration</a></li>
        {/if}
        <li class="envoyer"><a class="bouton principal" href="/envoyer" aria-current={actif('/envoyer') ? 'page' : undefined} onclick={fermer}>Envoyer une vidéo</a></li>
      </ul>
      <div class="actions">
        <button class="bouton theme" onclick={basculer} data-trace="basculer le thème"
                aria-label={theme.valeur === 'clair' ? 'Passer en mode sombre' : 'Passer en mode clair'}>
          {#if theme.valeur === 'clair'}
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg>
          {/if}
        </button>
        {#if session.moi}
          <!-- Non-lus : administration, et sources pour les comptes vérifiés (ceux de l'admin sont dans l'administration). -->
          {@const sources = session.moi.messagerieSources}
          {@const nonLus = (session.moi.messagesNonLus ?? 0) + (session.moi.messagesVideosNonLus ?? 0)
                           + (sources && sources.statut !== 'admin' ? sources.nonLus : 0)}
          <a class="bouton theme messages" href="/compte/messages" onclick={fermer} data-trace="messages"
             aria-current={page.url.pathname === '/compte/messages' ? 'page' : undefined}
             aria-label={nonLus ? `Messages : ${nonLus} non lu${nonLus > 1 ? 's' : ''}` : 'Messages'} title="Messages">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/></g></svg>
            {#if nonLus}<span class="pastille-message" aria-hidden="true">{nonLus}</span>{/if}
          </a>
          <a class="bouton" href="/compte" onclick={fermer}>
            <span class="pseudo">{session.moi.pseudo}</span>
          </a>
          <button class="bouton lien" onclick={sortir}>Se déconnecter</button>
        {:else if session.chargee}
          <a class="bouton" href="/connexion" onclick={fermer}>Se connecter</a>
          <a class="bouton principal" href="/inscription" onclick={fermer}>Créer un compte</a>
        {/if}
      </div>
    </nav>
  </div>
</header>

<style>
  .entete { background: var(--surface); border-bottom: 1px solid var(--trait); position: sticky; top: 0; z-index: 10; }
  .barre { display: flex; align-items: center; gap: 1.5rem; min-height: 4rem; }
  .marque { text-decoration: none; display: inline-flex; }
  nav { display: flex; align-items: center; gap: 1.5rem; flex: 1; }
  ul { list-style: none; margin: 0; padding: 0; }
  .liens { display: flex; align-items: center; gap: 1.125rem; flex: 1; }
  .liens a, .titre-groupe, .actions > * { white-space: nowrap; }
  .liens > li > a:not(.bouton), .titre-groupe, .sous a { color: var(--texte-2); text-decoration: none; font-weight: 550; font-size: 0.9375rem;
    display: inline-flex; gap: 0.4rem; align-items: center; padding: 0.375rem 0; border-bottom: 2px solid transparent; }
  .titre-groupe { background: none; border-top: 0; border-left: 0; border-right: 0; cursor: pointer; font-family: inherit; }
  .liens > li > a:not(.bouton):hover, .titre-groupe:hover, .sous a:hover { color: var(--texte); }
  .liens > li > a[aria-current='page']:not(.bouton), .titre-groupe.courant, .sous a[aria-current='page'] { color: var(--texte); border-bottom-color: var(--accent); }
  .groupe { position: relative; }
  .section { display: none; }
  .sous { display: none; position: absolute; top: calc(100% + 0.5rem); left: -0.75rem; min-width: 14rem; z-index: 20;
          background: var(--surface); border: 1px solid var(--trait); border-radius: 8px; box-shadow: var(--ombre); padding: 0.375rem 0.75rem; }
  .sous.ouvert { display: block; }
  .sous a { display: flex; padding: 0.4rem 0; }
  .envoyer { margin-left: auto; }
  .actions { display: flex; gap: 0.5rem; align-items: center; }
  .theme { padding: 0.5rem; width: 2.5rem; }
  .messages { position: relative; display: inline-grid; place-items: center; }
  .messages[aria-current='page'] { border-color: var(--accent); }
  .pastille-message { position: absolute; top: -0.45rem; right: -0.45rem; display: inline-grid; place-items: center;
                      min-width: 1.15rem; height: 1.15rem; padding: 0 0.25rem; border-radius: 999px; background: var(--accent);
                      color: var(--sur-accent); font-size: 0.6875rem; font-weight: 700; box-shadow: 0 0 0 2px var(--surface); }
  .pseudo { max-width: 10rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bascule-menu { display: none; margin-left: auto; }

  @media (max-width: 76rem) {
    .bascule-menu { display: inline-flex; }
    nav { display: none; position: absolute; top: 100%; left: 0; right: 0; background: var(--surface);
          border-bottom: 1px solid var(--trait); flex-direction: column; align-items: stretch; padding: 1rem 1.25rem; gap: 1rem; }
    nav.ouvert { display: flex; }
    .liens { flex-direction: column; align-items: stretch; gap: 0.25rem; }
    .titre-groupe { display: none; }
    .section { display: block; margin-top: 0.75rem; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em;
               text-transform: uppercase; color: var(--texte-2); }
    .sous { display: block; position: static; min-width: 0; border: 0; box-shadow: none; padding: 0 0 0 0.25rem; background: none; }
    .envoyer { margin: 0.75rem 0 0; }
    .actions { flex-wrap: wrap; }
  }
</style>
