<script lang="ts">
  // Mentions légales (LCEN, art. 1-1 depuis la loi SREN du 21 mai 2024). Les informations sur l'éditeur viennent de #lib/legal.ts.
  import { CONTACT, EDITEUR, PRESTATAIRES } from '#lib/legal.ts';
</script>

<svelte:head><title>Mentions légales — Argos Veille</title></svelte:head>

<article class="conteneur texte-long">
  <span class="surtitre">Mentions légales</span>
  <h1>Qui édite Argos Veille</h1>

  <h2>Éditeur</h2>
  {#if EDITEUR.anonyme}
    <p>Argos Veille est édité par une personne physique agissant à titre non professionnel, qui a choisi de garder
      l’anonymat, comme le permet l’article 1-1, II de la loi n° 2004-575 du 21 juin 2004 pour la confiance dans
      l’économie numérique. Ses coordonnées ont été communiquées à l’hébergeur du site :</p>
    <p><strong>Hostinger International Ltd</strong>, 61 Lordou Vironos, 6023 Larnaca, Chypre.</p>
    <p>Contact : {CONTACT.mail} — voir aussi la page <a href="/contact">Contact</a>. Une association est en cours de
      création pour reprendre l’édition du site.</p>
  {:else}
    <dl>
      <dt>Nom</dt><dd>{EDITEUR.nom}</dd>
      <dt>Forme</dt><dd>{EDITEUR.forme}</dd>
      <dt>Numéro RNA</dt><dd>{EDITEUR.rna}</dd>
      <dt>Siège</dt><dd>{EDITEUR.siege}</dd>
      <dt>Directeur de la publication</dt><dd>{EDITEUR.directeurPublication}</dd>
      <dt>Contact</dt><dd>{CONTACT.mail} — voir aussi la page <a href="/contact">Contact</a></dd>
    </dl>
  {/if}

  <h2>Hébergement et prestataires techniques</h2>
  <ul class="prestataires">
    {#each PRESTATAIRES as p (p.nom)}
      <li><strong>{p.nom}</strong>, {p.adresse}<br /><span class="second">{p.role} ({p.lieu}).</span></li>
    {/each}
  </ul>

  <h2>Rôle d’Argos Veille</h2>
  <p>Les vidéos sont envoyées par leurs auteurs et vérifiées par une communauté de relecteurs tirés au sort, selon des
    règles publiques. Argos Veille les héberge et les présente comme des <strong>faits allégués</strong>, sans les qualifier
    juridiquement. Pour signaler un contenu, exercer un droit de réponse ou demander un retrait, voir la page
    <a href="/contact">Contact</a>.</p>

  <h2>Propriété intellectuelle et réutilisation</h2>
  <p>Les vidéos publiées (versions floutées) et leur contexte sont diffusés sous licence
    <a href="https://creativecommons.org/licenses/by/4.0/deed.fr" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>
    (voir <a href="/donnees">Données ouvertes et API</a>). Le nom, le logo et les textes du site restent la propriété de leur
    éditeur. Fonds de carte : © les contributeurs d’OpenStreetMap, rendu Protomaps.</p>

  <h2>Données personnelles</h2>
  <p>Voir la page <a href="/confidentialite">Confidentialité</a>.</p>
</article>

<style>
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.375rem 1.25rem; }
  dt { color: var(--texte-2); }
  dd { margin: 0; }
  @media (max-width: 34rem) { dl { grid-template-columns: 1fr; } dd { margin-bottom: 0.5rem; } }
  .prestataires { display: grid; gap: 0.75rem; }
</style>
