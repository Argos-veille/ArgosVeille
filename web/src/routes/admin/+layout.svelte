<script lang="ts">
  // Menu de l'administration, en haut de chaque page (super-administrateur seulement).
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { session } from '#lib/session.svelte.ts';

  let { children }: { children: Snippet } = $props();

  const LIENS: [string, string][] = [
    ['/admin', 'Tableau de bord'], ['/admin/videos', 'Vidéos'], ['/admin/signalements', 'Signalements'],
    ['/admin/doublons', 'Doublons'], ['/admin/contact', 'Contact'], ['/admin/autorites', 'Autorités'], ['/admin/comptes', 'Comptes'],
    ['/admin/messagerie', 'Messagerie'], ['/admin/codes', 'Codes'], ['/admin/controles', 'Contrôles'],
    ['/admin/regles', 'Règles'], ['/admin/erreurs', 'Erreurs'],
  ];
  const actif = (href: string) => (href === '/admin' ? page.url.pathname === '/admin' : page.url.pathname.startsWith(href));
  const nonLus = $derived(session.moi?.messagerieSources?.nonLus ?? 0);
</script>

{#if session.moi?.superAdmin}
  <nav class="menu-admin" aria-label="Administration">
    <div class="conteneur">
      {#each LIENS as [href, libelle] (href)}
        <a {href} class:actif={actif(href)} aria-current={actif(href) ? 'page' : undefined}>{libelle}{#if href === '/admin/messagerie' && nonLus}<span class="pastille accent">{nonLus}</span>{/if}</a>
      {/each}
    </div>
  </nav>
{/if}
{@render children()}

<style>
  .menu-admin { border-bottom: 1px solid var(--trait); background: var(--surface-2); margin-bottom: 1.5rem; }
  .menu-admin .conteneur { display: flex; flex-wrap: wrap; gap: 0.25rem; padding-top: 0.5rem; padding-bottom: 0.5rem; }
  .menu-admin a { padding: 0.35rem 0.7rem; border-radius: var(--rayon-grand); text-decoration: none; color: var(--texte-2); font-size: 0.9375rem; }
  .menu-admin a:hover { background: var(--surface); color: var(--texte); }
  .menu-admin a.actif { background: var(--surface); color: var(--texte); font-weight: 700; }
  .pastille { margin-left: 0.35rem; }
</style>
