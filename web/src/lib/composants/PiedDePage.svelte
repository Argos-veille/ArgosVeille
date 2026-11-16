<script lang="ts">
  // Pied de page allégé (15 novembre 2026) : la devise, puis les liens « à propos ». Le reste est dans le menu (EnTete).
  import { dev } from '$app/env';
  import { CODE_SOURCE } from '#lib/legal.ts';
  let { signaler }: { signaler: () => void } = $props();
</script>

<footer class="pied">
  <div class="conteneur grille">
    <div class="marque">
      <p class="devise">Ce que les réseaux effacent, Argos le garde.</p>
      <p class="discret petit">
        Argos Veille permet de recenser, vérifier et cartographier les vidéos de violences policières et d’abus, envoyées anonymement
        ou avec un compte, et relues par la communauté.
      </p>
      <a class="x" href="https://x.com/Argosveille" target="_blank" rel="noopener noreferrer">Suivre @Argosveille sur X ↗</a>
    </div>
    <nav aria-label="À propos">
      <h2>À propos</h2>
      <ul>
        <li><a href="/contact">Contact</a></li>
        <li><a href="/conditions">Conditions d’utilisation</a></li>
        <li><a href="/confidentialite">Confidentialité</a></li>
        <li><a href="/mentions-legales">Mentions légales</a></li>
        <li><a href="/securite">Sécurité</a></li>
        <li><a href={CODE_SOURCE} target="_blank" rel="noopener noreferrer">Code source ↗</a></li>
        <li><button class="bouton lien" onclick={signaler} data-trace="ouvrir signaler un bug">Signaler un bug</button></li>
      </ul>
    </nav>
  </div>
  <div class="conteneur bas discret petit">
    <span>Aucun traceur, aucune publicité. Seule la protection anti-robot est chargée depuis un autre site.</span>
    {#if dev}<a href="/dev/boite">Boîte de développement (SMS et mails de test)</a>{/if}
  </div>
</footer>

<style>
  .pied { border-top: 1px solid var(--trait); background: var(--surface); margin-top: 4rem; padding: 2.5rem 0 1.5rem; }
  .grille { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 2rem; }
  .marque { display: grid; gap: 0.5rem; align-content: start; }
  .marque p { margin: 0; }
  .devise { font-weight: 700; font-size: 1.0625rem; }
  .x { color: var(--texte-2); font-size: 0.875rem; }
  h2 { margin: 0 0 0.75rem; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--texte); }
  ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.5rem; font-size: 0.9375rem; }
  ul a, .bouton.lien { color: var(--texte-2); text-decoration: none; }
  ul a:hover, .bouton.lien:hover, .x:hover { color: var(--texte); text-decoration: underline; text-underline-offset: 0.18em; }
  .bouton.lien { padding: 0; font-size: 0.9375rem; font-weight: 400; }
  .bas { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--trait); display: flex; flex-wrap: wrap;
         justify-content: space-between; gap: 0.5rem 1.5rem; }
  .bas a { color: inherit; }
  @media (max-width: 40rem) { .grille { grid-template-columns: minmax(0, 1fr); } }
</style>
