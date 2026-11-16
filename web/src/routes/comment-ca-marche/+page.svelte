<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from '#lib/api.ts';
  import SchemaVerification from '#lib/composants/SchemaVerification.svelte';

  // Chiffres des règles en vigueur (modifiables par l'administration, chaque changement est au journal).
  let r = $state<Record<string, number>>({
    sample_size: 15, enlargement_size: 15, reviews_per_day: 5, max_review_days: 30, publish_threshold: 0.65,
    reject_threshold: 0.35, novice_days: 30, novice_factor: 0.5, jury_size: 11, jury_majority: 8, jury_days: 5,
  });
  onMount(() => { get<{ regles: Record<string, number> }>('/public/regles').then((x) => { r = { ...r, ...x.regles }; }).catch(() => {}); });
  const pc = (x: number | undefined) => `${Math.round((x ?? 0) * 100)} %`;
  const jours = (x: number | undefined) => `${x} jour${(x ?? 0) >= 2 ? 's' : ''}`;
</script>

<svelte:head><title>Comment ça marche — Argos Veille</title></svelte:head>

<article class="conteneur texte-long">
  <span class="surtitre">Comment ça marche</span>
  <h1>De la vidéo à la carte, sans exposer personne</h1>
  <p class="chapo">Les réseaux suppriment ou cachent des vidéos d’abus policiers. Argos Veille les fait vérifier et les garde
    en ligne.</p>

  <h2>1. Envoyer</h2>
  <p>Un fichier ou un lien (une vidéo de 5 minutes au plus), sans compte, ni téléphone, ni mail. Un code de 12 mots permet ensuite de suivre la vidéo. Avec un
    compte, vous la suivez dans « Mes vidéos », sans code à noter.</p>

  <details class="plus">
    <summary>En savoir plus</summary>
    <ul>
      <li><strong>Sans compte</strong> : ni téléphone, ni mail, ni nom. Le code de 12 mots n’est connu que de vous. Tor et VPN
        sont bienvenus.</li>
      <li><strong>Avec un compte</strong> : la vidéo reste liée au compte tant qu’il existe, sauf si vous la retirez.</li>
      <li><strong>L’original est protégé</strong> : chiffré, Argos Veille ne peut pas le lire. Envoyé par lien, il n’est vu que
        le temps d’être chiffré et flouté.</li>
      <li><strong>Le lieu n’est jamais publié plus précisément que vous ne l’avez choisi.</strong> Personne ne peut ensuite le
        rendre plus précis, et l’heure précise n’est jamais publiée.</li>
      <li><strong>Vous gardez la main</strong> : vous pouvez retirer la vidéo à tout moment, sauf demande de la justice ou d’une autorité en cours. Vous n’êtes jamais convoqué pour
        relire votre propre vidéo.</li>
    </ul>
    <p>Ce que la loi impose : pour chaque envoi, retouche ou retrait, l’adresse IP, l’heure et l’identifiant de la vidéo sont gardés un an, à part et chiffrés, pour répondre à la justice.
      Le détail est sur la page <a href="/confidentialite">Confidentialité</a>.</p>
  </details>

  <h2>2. Flouter les visages</h2>
  <p>Les visages sont floutés automatiquement, sauf si vous le refusez. Avant la relecture, vous vérifiez le résultat et pouvez
    corriger les zones, même quand la caméra bouge. Les relecteurs ne voient que la version traitée, jamais l’original.</p>

  <details class="plus">
    <summary>En savoir plus</summary>
    <ul>
      <li><strong>Le floutage est sous votre contrôle</strong> : personne ne voit la vidéo avant votre vérification. Vous
        choisissez de garder le son ou non. Sans réponse de votre part sous 7 jours, la vidéo part en relecture avec le
        floutage automatique.</li>
      <li><strong>Respect des personnes filmées</strong> : la vie privée de chacun est protégée, agents compris. Seul le
        matricule (RIO), que les agents doivent porter, reste visible. Un passage de la description qui identifie quelqu’un
        peut être retiré par l’administration ; chaque correction est inscrite au journal public.</li>
    </ul>
  </details>

  <h2>3. Relire et décider</h2>
  <p>Des relecteurs tirés au sort regardent la vidéo floutée et répondent : montre-t-elle ce qui est annoncé ? Oui, en partie
    ou non. À {pc(r['publish_threshold'])} de oui, elle est publiée ; à {pc(r['reject_threshold'])} ou moins, elle est rejetée.
    Quand c’est serré, d’autres relecteurs puis un jury tranchent.</p>
  <details class="plus">
    <summary>En savoir plus</summary>
    <SchemaVerification />
    <ul>
      <li><strong>Personne ne choisit ce qu’il relit</strong> : {r['sample_size']} relecteurs par vidéo, tirés au hasard parmi
        les comptes actifs, jamais sur leur propre vidéo. {r['reviews_per_day']} relectures par jour au plus ; on peut passer
        son tour sans pénalité. La relecture dure au plus {jours(r['max_review_days'])} : sans assez de votes, la vidéo reste
        « sans décision » et n’est pas publiée.</li>
      <li><strong>Les relecteurs ne voient que la version floutée</strong>, jamais l’original ni la source.</li>
      <li><strong>Un relecteur fiable compte davantage</strong> : « en partie » compte pour un demi-oui ; la fiabilité monte
        quand on vote comme une décision nette et baisse plus vite quand on vote contre. Un nouveau compte compte pour
        {pc(r['novice_factor'])} pendant {jours(r['novice_days'])}. Des vidéos déjà tranchées, glissées parmi les autres,
        vérifient l’attention.</li>
      <li><strong>Les votes serrés</strong> : entre {pc(r['reject_threshold'])} et {pc(r['publish_threshold'])},
        {r['enlargement_size']} relecteurs de plus sont tirés au sort. Si c’est encore serré, un jury de {r['jury_size']}
        comptes anciens et fiables répond par oui ou non en {jours(r['jury_days'])} : {r['jury_majority']} voix pour décider.
        Sinon, la vidéo est publiée « en débat » : visible, mais hors de la carte.</li>
      <li><strong>Les règles sont publiques.</strong> L’administration peut trancher elle-même dans des cas exceptionnels.
        Chaque décision de ce type, et chaque changement de règle, est inscrit au <a href="/journal">journal</a>, avec son
        motif.</li>
    </ul>
  </details>

  <h2>4. Les analystes</h2>
  <p>Des analystes vérifiés ajoutent des notes et peuvent corriger la date ou le lieu, sources à l’appui. Une note éclaire, elle
    ne décide pas.</p>

  <details class="plus">
    <summary>En savoir plus</summary>
    <p>Les relecteurs jugent les notes. Une note est mise en avant quand elle est jugée utile aussi bien par ceux qui ont voté
      oui que par ceux qui ont voté non. Les valeurs données par la source restent visibles.</p>
    <p>Un analyste ne peut jamais rendre le lieu plus précis que ce que la source a choisi. Seule exception : si la source ne
      connaît pas le lieu (vidéo trouvée sur les réseaux), un analyste peut l’établir précisément.</p>
  </details>

  <h2>5. Copies et même événement</h2>
  <p>Une copie d’une vidéo déjà publiée devient une version de sa fiche. Les vidéos d’une même scène, filmée sous plusieurs
    angles, sont reliées entre elles.</p>

  <h2>6. Être contacté</h2>
  <p>Si vous l’acceptez, des journalistes, avocats et associations vérifiés peuvent vous écrire. Argos Veille ne peut pas lire
    ces messages. Vous pouvez aussi leur transmettre l’original, et retirer votre accord tant qu’il n’a pas été téléchargé.</p>

  <details class="plus">
    <summary>En savoir plus</summary>
    <p>Ils doivent d’abord être vérifiés par l’administration. Avec votre accord, que vous pouvez retirer tant que l’original n’a pas été téléchargé, ils peuvent recevoir
      l’original non flouté, par exemple pour défendre une victime.</p>
  </details>

  <h2>7. Un journal public</h2>
  <p>Chaque décision et chaque retrait y sont inscrits. Une entrée modifiée se verrait, et chacun peut le vérifier.
    <a href="/journal">Voir le journal</a>.</p>

  <details class="plus">
    <summary>En savoir plus</summary>
    <p>Chaque décision, chaque retrait et chaque changement de règle est inscrit au journal public, avec son motif.
      L’administration ne peut rien effacer sans que cela se voie. Chaque trimestre, un
      <a href="/transparence">rapport de transparence</a> fait le bilan.</p>
    <p>L’état du journal est ancré chaque jour dans la blockchain Bitcoin, et vérifiable depuis votre navigateur.</p>
  </details>

  <h2>8. Une archive durable</h2>
  <p>Une vidéo publiée reste en ligne, même si elle disparaît de tous les réseaux. Elle ne quitte la carte que si sa source la
    retire, pour un motif légal, ou par une décision motivée de l’administration, inscrite au journal public. Elle est aussi <a href="/donnees">réutilisable librement</a>, pour que d’autres la conservent à leur tour.</p>

  <details class="plus">
    <summary>En savoir plus</summary>
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
      <li>L’original est gardé intact. Il n’est transmis à un tiers vérifié qu’avec l’accord de la source.</li>
      <li>Une vidéo refusée ou restée sans décision n’est pas archivée : elle est effacée 30 jours après la décision, sauf demande de la justice ou d’une autorité en cours.</li>
      <li>Les sauvegardes sont chiffrées et stockées en Suisse.</li>
    </ul>
  </details>

  <p class="livre-blanc">Pour comprendre le projet en détail : <a href="/livre-blanc">le livre blanc</a>.</p>
</article>

<style>
  .chapo { font-size: 1.1875rem; color: var(--texte-2); }
  h2 { margin-top: 2.25rem; padding-top: 1rem; border-top: 1px solid var(--trait); }
  p { color: var(--texte-2); }
  .plus { margin: 0.75rem 0 0; padding: 0.5rem 0.875rem; border: 1px solid var(--trait); border-radius: 8px; }
  .plus summary { cursor: pointer; font-weight: 600; color: var(--accent-texte); }
  .plus[open] summary { margin-bottom: 0.5rem; }
  .plus li, .plus p { color: var(--texte-2); }
  .plus li + li { margin-top: 0.375rem; }
  .plus strong { color: var(--texte); }
  .defile { overflow-x: auto; margin: 0.75rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9375rem; }
  th, td { text-align: left; vertical-align: top; padding: 0.5rem 1rem 0.5rem 0; border-bottom: 1px solid var(--trait); }
  thead th { color: var(--texte-2); font-weight: 600; border-bottom: 1px solid var(--trait-fort); }
  tbody th { color: var(--texte); font-weight: 600; white-space: nowrap; }
  .livre-blanc { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--trait); }
</style>
