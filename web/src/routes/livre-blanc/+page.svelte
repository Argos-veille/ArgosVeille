<!--
  Livre blanc public d’Argos Veille (rédigé le 2026-11-14).
  Garanties seulement, jamais le « comment ». Aucun chiffre de règle (ils changent via la page Règles).
  Dépend du correctif 0092 (précision du lieu plafonnée au choix de la source) : sections 3 et 4.
-->
<script lang="ts">
  import SchemaVerification from '#lib/composants/SchemaVerification.svelte';
  import { CODE_SOURCE } from '#lib/legal.ts';
</script>

<svelte:head><title>Livre blanc — Argos Veille</title></svelte:head>

<article class="conteneur texte-long">
  <span class="surtitre">Livre blanc</span>
  <h1>Ce que les réseaux effacent, Argos le garde</h1>
  <p class="chapo">Ce qu’est Argos Veille, ce qu’il garantit aux personnes qui filment, et ce qu’il offre à la presse, aux
    associations et aux chercheurs.</p>

  <h2>1. Pourquoi Argos Veille</h2>
  <p>Les vidéos d’interventions policières filmées par des témoins peuvent disparaître : supprimées, masquées ou rendues invisibles
    par les réseaux sociaux. Avec elles disparaît une trace des faits.</p>
  <p>Ces vidéos peuvent aussi servir à la défense des victimes de violences policières. Avec l’accord de la source, un
    avocat, une association ou un journaliste vérifié peut recevoir l’original non flouté.</p>
  <p>Celles et ceux qui filment prennent aussi un risque. Publier sous son nom expose à des pressions, et rien ne garantit que
    la vidéo restera en ligne.</p>
  <p>Argos Veille est une veille citoyenne : ce n’est ni une administration, ni un média, ni un parti qui décide, mais des
    citoyens. Chacun peut envoyer une vidéo, et des relecteurs tirés au sort la vérifient. Elle répond ainsi à ces deux
    problèmes : garder les vidéos, et protéger les personnes qui les envoient.</p>

  <h2>2. Ce que fait Argos Veille</h2>
  <p>Argos Veille recense, vérifie, cartographie et archive les vidéos d’abus et de violences policières en France. Il couvre la
    police nationale, la gendarmerie, les polices municipales et la douane.</p>
  <ol>
    <li><strong>Recueillir</strong> : chacun peut envoyer une vidéo, avec ou sans compte.</li>
    <li><strong>Flouter</strong> : les visages reconnaissables sont floutés avant que quiconque voie la vidéo.</li>
    <li><strong>Vérifier</strong> : une communauté de relecteurs tirés au sort juge si la vidéo montre ce qui est annoncé.</li>
    <li><strong>Publier</strong> : la vidéo rejoint une <a href="/carte">carte publique</a>, avec un lieu arrondi.</li>
    <li><strong>Garder</strong> : elle reste en ligne, même si elle disparaît ailleurs.</li>
  </ol>
  <p>Les faits sont présentés comme des faits allégués. Argos Veille ne les qualifie pas juridiquement et ne se prononce sur la
    culpabilité de personne.</p>

  <h2>3. Pour les personnes qui filment</h2>
  <p>La protection de la source passe avant tout : ce que le site n’a jamais collecté ne peut ni fuiter ni être saisi.</p>
  <ul>
    <li><strong>Sans compte</strong> : ni téléphone, ni mail, ni nom. Un code de 12 mots, connu de vous seul, permet de suivre
      la vidéo. Tor et VPN sont bienvenus.</li>
    <li><strong>Avec un compte</strong> : la vidéo se suit dans « Mes vidéos », sans code à noter. Elle reste liée au compte
      tant qu’il existe, sauf si vous la retirez.</li>
    <li><strong>L’original est protégé</strong> : chiffré, Argos Veille ne peut pas le lire. Envoyé par lien, il n’est vu que le temps d’être chiffré et flouté. Seule la version floutée est montrée.</li>
    <li><strong>Le floutage est sous votre contrôle</strong> : vous vérifiez et corrigez les visages floutés avant que quiconque
      voie la vidéo. Vous choisissez de garder le son ou non.</li>
    <li><strong>Le lieu n’est jamais publié plus précisément que vous ne l’avez choisi.</strong> Personne ne peut ensuite le
      rendre plus précis, et l’heure précise n’est jamais publiée.</li>
    <li><strong>Vous gardez la main</strong> : vous pouvez retirer la vidéo à tout moment, sauf demande de la justice ou d’une autorité en cours.</li>
    <li><strong>Être contacté, seulement si vous le voulez</strong> : des journalistes, avocats et associations vérifiés
      peuvent alors vous écrire. Argos Veille ne peut pas lire ces messages. Chaque compte vérifié a une empreinte, publiée
      aussi hors du site : la comparer garantit que vous écrivez bien à la bonne personne.</li>
  </ul>
  <p>Ce que la loi impose : pour chaque envoi, retouche ou retrait, l’adresse IP, l’heure et l’identifiant de la vidéo sont gardés un an, à part et chiffrés, pour répondre à la justice. Le
    détail est sur la page <a href="/confidentialite">Confidentialité</a>.</p>

  <h2>4. La vérification</h2>
  <p>Une vidéo n’est publiée que si une communauté de relecteurs le décide. L’envoi ne garantit pas la publication.</p>

  <SchemaVerification />

  <p>Les relecteurs répondent à une seule question : la vidéo montre-t-elle ce qui est annoncé ? Quand le vote est serré,
    d’autres relecteurs puis un jury tranchent.</p>
  <ul>
    <li><strong>Personne ne choisit ce qu’il relit</strong> : les relecteurs sont tirés au sort, et jamais sur leur propre
      vidéo.</li>
    <li><strong>Les relecteurs ne voient que la version floutée</strong>, jamais l’original ni la source.</li>
    <li><strong>L’attention est contrôlée</strong>, et les relecteurs fiables pèsent davantage.</li>
    <li><strong>Des analystes vérifiés</strong> ajoutent des notes et corrigent la date ou le lieu, sources à l’appui. Une
      note éclaire, elle ne décide pas. Un analyste ne peut jamais rendre le lieu plus précis que ce que la source a choisi.
      Seule exception : si la source ne connaît pas le lieu (vidéo trouvée sur les réseaux), un analyste peut l’établir
      précisément.</li>
    <li><strong>Les règles sont publiques.</strong> Chaque changement de règle et chaque décision exceptionnelle de
      l’administration est inscrit au <a href="/journal">journal</a>, avec son motif.</li>
    <li><strong>Une copie d’une vidéo déjà publiée</strong> rejoint sa fiche. Les vidéos d’une même scène, sous plusieurs
      angles, sont reliées.</li>
  </ul>
  <p>Le détail des règles en vigueur est sur la page <a href="/comment-ca-marche">Comment ça marche</a>.</p>

  <h2>5. La conservation</h2>
  <p>Une vidéo publiée reste en ligne, même si elle disparaît de tous les réseaux. Elle ne quitte la carte que si sa source la
    retire, pour un motif légal, ou par une décision motivée de l’administration, inscrite au journal public.</p>
  <div class="defile">
    <table>
      <thead><tr><th></th><th>Public</th><th>Non public</th></tr></thead>
      <tbody>
        <tr><th scope="row">Vidéo</th><td>Version floutée</td><td>Original, que le site ne peut pas lire</td></tr>
        <tr><th scope="row">Lieu</th><td>Arrondi, selon le choix de la source</td><td>Position exacte</td></tr>
        <tr><th scope="row">Date</th><td>Le jour, ou l’heure arrondie</td><td>L’heure à la seconde</td></tr>
        <tr><th scope="row">Source</th><td>Rien</td><td>Ni nom, ni lien avec un relecteur</td></tr>
      </tbody>
    </table>
  </div>
  <ul>
    <li>L’original est gardé intact. Il n’est transmis à un tiers vérifié qu’avec l’accord de la source. Cet accord se retire à
      tout moment ; un original déjà transmis ne peut pas être repris.</li>
    <li>Une vidéo refusée ou restée sans décision n’est pas archivée : elle est effacée 30 jours après la décision, sauf demande de la justice ou d’une autorité en cours.</li>
    <li>Les sauvegardes sont chiffrées et stockées en Suisse.</li>
    <li>Une vidéo publiée est <a href="/donnees">réutilisable librement</a>, pour que d’autres la conservent à leur tour.</li>
  </ul>

  <h2>6. Pour la presse, les associations et les chercheurs</h2>
  <p>Toutes les données publiées sont ouvertes, sous licence CC BY 4.0, sans inscription ni clé.</p>
  <div class="defile">
    <table>
      <thead><tr><th>Outil</th><th>Ce qu’il donne</th></tr></thead>
      <tbody>
        <tr><th scope="row"><a href="/carte">Carte</a></th><td>Chaque vidéo vérifiée, là où elle a été filmée, avec recherche et filtres</td></tr>
        <tr><th scope="row">Fiche d’une vidéo</th><td>Nature des faits, forces, situation, date, lieu arrondi, décision, notes d’analystes</td></tr>
        <tr><th scope="row"><a href="/donnees">API et exports</a></th><td>Toutes les vidéos publiées, en JSON ou CSV</td></tr>
        <tr><th scope="row"><a href="/statistiques">Statistiques</a></th><td>Vidéos publiées par mois, par catégorie, par force, par situation</td></tr>
        <tr><th scope="row"><a href="/transparence">Rapport de transparence</a></th><td>Chaque trimestre : envois, décisions, signalements, retraits, demandes des autorités, originaux transmis</td></tr>
        <tr><th scope="row"><a href="/journal">Journal public</a></th><td>Chaque décision et chaque retrait, impossible à réécrire sans que cela se voie</td></tr>
        <tr><th scope="row">Intégration</th><td>Un lecteur à placer sur votre site, sans cookie ni lecture automatique</td></tr>
        <tr><th scope="row"><a href={CODE_SOURCE} target="_blank" rel="noopener noreferrer">Code source</a></th><td>Tout le code du site, libre (licence AGPL), pour vérifier ce qu’il fait</td></tr>
      </tbody>
    </table>
  </div>
  <p><strong>Citer une vidéo</strong> : mentionner Argos Veille, renvoyer à sa fiche, et présenter les faits comme allégués.</p>
  <p><strong>Aller plus loin</strong> : les journalistes, avocats et associations vérifiés peuvent écrire aux sources qui
    l’acceptent. Avec l’accord de la source, ils peuvent recevoir l’original non flouté.</p>

  <h2>7. Les principes</h2>
  <ul>
    <li><strong>Indépendance</strong> : Argos Veille vit de <a href="/soutenir">dons</a>. Il ne vend rien, n’affiche aucune
      publicité, ne revend aucune donnée et ne pose aucun traceur. Un don ne donne aucun avantage.</li>
    <li><strong>Neutralité</strong> : les faits sont allégués, jamais jugés. La communauté vérifie ce que montre une vidéo, pas
      la culpabilité de quiconque.</li>
    <li><strong>Respect des personnes filmées</strong> : les visages reconnaissables sont floutés. La vie privée de chacun est protégée, agents
      compris. Seul le matricule (RIO), que les agents doivent porter, reste visible. Un passage de la description qui
      identifie quelqu’un peut être retiré par l’administration ; chaque correction est inscrite au journal public.</li>
    <li><strong>Aucun appel à la haine</strong> : les propos haineux et les appels à la violence ou à la vengeance, contre
      quiconque, sont interdits.</li>
    <li><strong>Transparence</strong> : chaque décision, chaque retrait et chaque changement de règle est inscrit au journal
      public, avec son motif. L’administration ne peut rien effacer sans que cela se voie.</li>
  </ul>

  <h2>8. Feuille de route</h2>
  <div class="defile">
    <table>
      <thead><tr><th>Étape</th><th>Quand</th><th>Ce qui change</th></tr></thead>
      <tbody>
        <tr><th scope="row">Bêta fermée</th><td>Du 7 au 14 novembre 2026</td><td>Le site est en ligne, accessible sur invitation</td></tr>
        <tr><th scope="row">Ouverture publique</th><td>15 novembre 2026</td><td>Envoi, inscription et carte ouverts à tous</td></tr>
        <tr><th scope="row">Premier rapport de transparence</th><td>1er janvier 2027</td><td>Bilan du dernier trimestre 2026, puis un rapport par trimestre</td></tr>
      </tbody>
    </table>
  </div>
  <p>Pour <a href="/envoyer">envoyer une vidéo</a>, <a href="/inscription">devenir relecteur</a> ou
    <a href="/soutenir">soutenir le projet</a>.</p>
</article>

<style>
  .chapo { font-size: 1.1875rem; color: var(--texte-2); }
  h2 { margin-top: 2.25rem; padding-top: 1rem; border-top: 1px solid var(--trait); }
  p, li { color: var(--texte-2); }
  li + li { margin-top: 0.375rem; }
  li strong, p strong { color: var(--texte); }

  .defile { overflow-x: auto; margin: 1rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9375rem; }
  th, td { text-align: left; vertical-align: top; padding: 0.5rem 1rem 0.5rem 0; border-bottom: 1px solid var(--trait); }
  thead th { color: var(--texte-2); font-weight: 600; border-bottom: 1px solid var(--trait-fort); }
  tbody th { color: var(--texte); font-weight: 600; white-space: nowrap; }
  td { color: var(--texte-2); }
</style>
