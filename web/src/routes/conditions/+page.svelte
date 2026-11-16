<script lang="ts">
  // Conditions d'utilisation (validées par l’administrateur le 7 novembre 2026 ; texte à faire relire par l'avocat,
  // question 28). Changer le texte = changer la version dans #lib/conditions.ts et api/src/conditions.ts.
  import { CONDITIONS_DATE } from '#lib/conditions.ts';
</script>

<svelte:head><title>Conditions d’utilisation — Argos Veille</title></svelte:head>

<article class="conteneur texte-long">
  <span class="surtitre">Conditions d’utilisation</span>
  <h1>Les règles d’Argos Veille</h1>
  <p class="chapo">Argos Veille recense et archive des vidéos d’interventions des forces de l’ordre pour les faire
    vérifier par une communauté et les rendre consultables durablement, y compris quand elles ont été supprimées ou
    rendues moins visibles sur d’autres plateformes. Ces règles s’appliquent à toute personne qui envoie une vidéo, avec ou sans
    compte, et à tous les relecteurs.</p>
  <p class="petit discret">Version du {CONDITIONS_DATE}. Elle est acceptée à chaque envoi et à l’inscription ; si elle
    change, la nouvelle version vous sera redemandée.</p>

  <h2>1. Ce que vous garantissez en envoyant une vidéo</h2>
  <ul>
    <li><strong>Elle est authentique</strong> : elle n’a pas été truquée, générée ni montée pour tromper (couper le début
      ou la fin est permis, pas changer le sens de ce qu’on voit).</li>
    <li><strong>Vous avez le droit de la partager</strong> : vous l’avez filmée vous-même, ou la personne qui l’a filmée
      est d’accord, ou elle a déjà été rendue publique.</li>
    <li><strong>Elle est en rapport avec le site</strong> : elle montre une intervention de la police nationale, de la
      gendarmerie, d’une police municipale ou de la douane, en France.</li>
    <li><strong>Ce que vous déclarez est sincère</strong> : la date, le lieu, la nature des faits et la description
      correspondent à ce que vous savez.</li>
  </ul>

  <h2>2. Ce qui est interdit</h2>
  <ul>
    <li>Tout contenu à caractère sexuel ou pornographique.</li>
    <li>Des images de mineurs sans lien avec les faits filmés.</li>
    <li>Des violences sans rapport avec une intervention des forces de l’ordre, ou des images choquantes gratuites.</li>
    <li>Les propos ou symboles haineux, les appels à la violence ou à la vengeance contre quiconque, agents compris.</li>
    <li>Révéler la vie privée d’une personne, y compris d’un agent : nom, adresse, famille, comptes personnels…
      Le numéro de matricule (RIO), que les agents doivent porter, n’est pas concerné : il reste visible.</li>
    <li>Les fausses vidéos, les envois en série, la publicité et tout usage étranger au but du site.</li>
  </ul>

  <h2>3. Ce que fait Argos Veille de votre vidéo</h2>
  <ul>
    <li>Les visages sont floutés ; vous vérifiez le résultat avant toute relecture. Vous choisissez de garder ou non
      le son, et la précision du lieu affiché.</li>
    <li>La vidéo floutée est relue par des relecteurs tirés au sort. Elle n’est publiée que si la relecture le décide :
      l’envoi ne garantit pas la publication.</li>
    <li>Les faits présentés sont des <strong>faits allégués</strong> : Argos Veille ne les qualifie pas juridiquement
      et ne se prononce pas sur la culpabilité de quiconque.</li>
    <li>Une vidéo publiée (version floutée et contexte) est diffusée sous licence
      <a href="https://creativecommons.org/licenses/by/4.0/deed.fr" target="_blank" rel="noopener noreferrer">CC BY 4.0</a> :
      chacun peut la reprendre en citant Argos Veille et en renvoyant à sa fiche.</li>
    <li>Une vidéo publiée est conservée et reste consultable tant que vous ne la retirez pas, qu’aucun motif légal ne
      l’impose, et même si elle a disparu d’autres plateformes. Une vidéo refusée ou restée sans décision n’est pas archivée : elle est effacée 30 jours après la décision, sauf demande de la justice ou d’une autorité en cours.</li>
    <li>Vous pouvez retirer votre vidéo à tout moment avec votre code de suivi, sauf si elle fait l’objet d’une
      procédure légale en cours.</li>
  </ul>

  <h2>4. Les relecteurs</h2>
  <p>Les relecteurs s’engagent à relire avec honnêteté, à ne jamais chercher à identifier une personne filmée ni la
    source d’une vidéo, et à ne rien diffuser de ce qu’ils voient en relecture. Les vidéos peuvent montrer des violences
    réelles et choquer.</p>

  <h2>5. En cas de manquement</h2>
  <ul>
    <li>Une vidéo contraire à ces règles est refusée ou retirée, même après sa publication.</li>
    <li>Un passage de la description qui identifie quelqu’un, ou contraire à ces règles, peut être retiré par
      l’administration ; la correction est inscrite au <a href="/journal">journal public</a>.</li>
    <li>Un compte qui ne les respecte pas peut être suspendu ou exclu ; la décision est motivée et inscrite au
      <a href="/journal">journal public</a>, sans le pseudo.</li>
    <li>Les contenus manifestement illégaux, en particulier toute image d’abus sexuel sur mineur, sont signalés aux
      autorités (plateforme PHAROS), comme la loi l’impose.</li>
    <li>Vous restez responsable de ce que vous envoyez et de ce que vous déclarez.</li>
  </ul>

  <h2>6. Vos données</h2>
  <p>Envoyer une vidéo ne demande ni compte, ni téléphone, ni mail. Si vous choisissez de l’envoyer avec votre compte,
    elle reste liée à ce compte tant qu’il existe, sauf si vous la retirez : sur demande de la justice, ce lien pourrait révéler que vous l’avez
    envoyée. Le site ne garde que ce qui est nécessaire à son
    fonctionnement et aux obligations légales ; le détail est expliqué sur la page
    <a href="/confidentialite">Confidentialité</a>.</p>
</article>
