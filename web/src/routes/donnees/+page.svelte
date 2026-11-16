<script lang="ts">
  // Données ouvertes : API publique v1, exports, intégration, licence.
  import Info from '#lib/composants/Info.svelte';
  const site = typeof location === 'undefined' ? 'https://argos-veille.fr' : location.origin;
</script>

<svelte:head><title>Données ouvertes et API — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">Données ouvertes</span>
  <h1>Réutiliser les données</h1>
  <p class="second">Les vidéos publiées sont libres de réutilisation : API, export complet ou lecteur à intégrer. Sans compte,
    sans clé.</p>

  <section class="carte">
    <h2>Licence CC BY 4.0</h2>
    <p>Trois conditions : citer <strong>Argos Veille</strong>, faire un lien vers la fiche de chaque vidéo, et garder la mention
      <strong>« faits allégués, non jugés »</strong>.
      <a href="https://creativecommons.org/licenses/by/4.0/deed.fr" target="_blank" rel="noopener noreferrer">Texte de la licence ↗</a></p>
  </section>

  <section class="carte">
    <h2>Ce qu’elles contiennent</h2>
    <p>Ce que montre la fiche publique. Jamais rien qui relie une vidéo à sa source ou à un relecteur.<Info>Nature des faits,
      forces, situation, date (à l’heure près, ou le jour seul), lieu arrondi, décision. Une vidéo masquée ou retirée disparaît
      de l’API dès la décision.</Info></p>
  </section>

  <section class="carte">
    <h2>API<Info>Lecture seule, en JSON, ouverte à tous les sites. 600 requêtes par heure et par connexion, 30 pour les exports.
      <code>sousCategorie</code> et <code>situation</code> donnent le choix principal ; <code>sousCategories</code> et
      <code>situations</code>, tous les choix.</Info></h2>
    <dl>
      <dt><code>GET /api/v1/videos</code></dt>
      <dd>100 par page. Filtres : <code>etat=en_debat</code>, <code>categorie</code>, <code>forces</code>, <code>du</code>,
        <code>au</code>. Page suivante : <code>apres=</code> la valeur de <code>suivante</code>.</dd>
      <dt><code>GET /api/v1/videos/&#123;id&#125;</code></dt>
      <dd>Une fiche complète, avec le code d’intégration.</dd>
      <dt><code>GET /api/v1/export.json</code> · <code>GET /api/v1/export.csv</code></dt>
      <dd>Toutes les vidéos publiées et en débat.</dd>
      <dt><code>GET /api/v1/statistiques</code></dt>
      <dd>Les chiffres de la page <a href="/statistiques">Statistiques</a>. Filtres : <code>periode</code> (<code>7j</code>,
        <code>30j</code>, <code>1an</code>, <code>tout</code>), <code>du</code>, <code>au</code>.</dd>
      <dt><code>GET /api/v1/transparence</code></dt>
      <dd>Le <a href="/transparence">rapport de transparence</a> d’un trimestre terminé : <code>trimestre=2027-T1</code>
        (le plus récent par défaut). Les nombres de 1 à 4 valent <code>"&lt;5"</code>.</dd>
      <dt><code>GET /api/v1/oembed?url=…</code></dt>
      <dd>Intégration automatique à partir du lien d’une fiche.</dd>
    </dl>
    <p class="petit">Exemple : <a href="/api/v1/videos?categorie=violence">{site}/api/v1/videos?categorie=violence</a></p>
  </section>

  <section class="carte">
    <h2>Intégrer une vidéo</h2>
    <p>Sur la fiche, « Intégrer cette vidéo » donne le code à copier. Si la vidéo est retirée, elle disparaît aussi de votre
      page.<Info>Le lecteur affiche d’abord un avertissement, ne lance rien tout seul et ne dépose aucun cookie.</Info></p>
  </section>

  <section class="carte">
    <h2>Le journal public</h2>
    <p>Toutes les décisions : <a href="/journal">journal public</a> et
      <a href="/api/public/journal/export" download="argos-veille-journal.json">export complet</a>.</p>
  </section>
</div>

<style>
  dl { display: grid; gap: 0.25rem; }
  dt { margin-top: 0.75rem; font-weight: 600; }
  dd { margin: 0; color: var(--texte-2); }
  code { font-family: var(--police-mono); font-size: 0.875em; }
</style>
