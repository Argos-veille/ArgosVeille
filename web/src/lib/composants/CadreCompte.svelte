<script lang="ts" module>
  export const SECTIONS_COMPTE = [
    { cle: 'profil', titre: 'Profil' }, { cle: 'securite', titre: 'Sécurité' }, { cle: 'appareils', titre: 'Appareils connectés' },
    { cle: 'relecture', titre: 'Relecture' }, { cle: 'mails', titre: 'Mails' }, { cle: 'fermer', titre: 'Fermer mon compte' },
  ] as const;
  export type SectionCompte = (typeof SECTIONS_COMPTE)[number]['cle'];
</script>

<script lang="ts">
  // Cadre de « Mon compte » : titre, menu des sections (à gauche ; en onglets en haut sur téléphone), largeur des
  // blocs (46rem, la même que « Mes vidéos » et « Messages », pages à part). Sur « Mon compte » (`ici`), le menu change de section par
  // l'ancre de l'adresse (/compte#securite) ; ailleurs, il y renvoie.
  import type { Snippet } from 'svelte';
  import { session } from '#lib/session.svelte.ts';

  let { actif, ici = false, titre, avant, children }: {
    actif: SectionCompte;
    ici?: boolean;
    titre?: string;
    avant?: Snippet;      // messages affichés au-dessus du menu et du contenu
    children: Snippet;
  } = $props();
</script>

<div class="conteneur">
  <span class="surtitre">Mon compte</span>
  <h1>{titre ?? session.moi?.pseudo ?? 'Mon compte'}</h1>
  {@render avant?.()}
  <div class="mise-en-page">
    <nav class="menu" aria-label="Mon compte">
      {#each SECTIONS_COMPTE as s (s.cle)}
        {#if s.cle !== 'fermer' || !session.moi?.superAdmin}
          <a href="{ici ? '' : '/compte'}#{s.cle}" class:actif={actif === s.cle} class:danger={s.cle === 'fermer'}
             aria-current={actif === s.cle ? 'page' : undefined}>{s.titre}</a>
        {/if}
      {/each}
    </nav>
    <div class="contenu">{@render children()}</div>
  </div>
</div>

<style>
  .mise-en-page { display: grid; grid-template-columns: 13rem minmax(0, 1fr); gap: 2rem; align-items: start; margin-top: 1rem; }
  .menu { position: sticky; top: 1rem; display: flex; flex-direction: column; gap: 0.125rem; }
  .menu a { padding: 0.5rem 0.75rem; border-radius: var(--rayon); color: var(--texte); text-decoration: none; }
  .menu a:hover { background: var(--surface-2); }
  .menu a.actif { background: var(--accent-doux); color: var(--texte); font-weight: 600; box-shadow: inset 3px 0 0 var(--accent); }
  .menu a.danger { color: var(--danger); }
  /* Même largeur des blocs sur les trois pages. */
  .contenu { display: grid; gap: 1.25rem; max-width: 46rem; }
  .contenu :global(> .carte), .contenu :global(> section), .contenu :global(> form) { margin: 0; }
  @media (max-width: 48rem) {
    .mise-en-page { grid-template-columns: minmax(0, 1fr); gap: 1rem; }
    .menu { position: static; flex-direction: row; overflow-x: auto; gap: 0.25rem; padding-bottom: 0.25rem; scrollbar-width: thin; }
    .menu a { white-space: nowrap; }
    .menu a.actif { box-shadow: inset 0 -3px 0 var(--accent); }
  }
</style>
