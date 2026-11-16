<script lang="ts">
  // Politique de confidentialité (RGPD). Chaque donnée et chaque durée correspondent au code et à la base
  // (vérifié le 7 novembre 2026) : la modifier en même temps que le traitement qu'elle décrit.
  // Bases légales et exception journalistique (art. 85 RGPD) : à valider par l'avocat.
  import { CONTACT, EDITEUR, PRESTATAIRES } from '#lib/legal.ts';
</script>

<svelte:head><title>Confidentialité — Argos Veille</title></svelte:head>

<article class="conteneur texte-long">
  <span class="surtitre">Confidentialité</span>
  <h1>Vos données sur Argos Veille</h1>
  <p class="chapo">Le principe : ce que le site n’a jamais collecté ne peut ni fuiter ni être saisi. Pas de traceur, pas de
    publicité, aucune ressource chargée depuis un autre site en dehors de la protection anti-robot.</p>
  <p class="petit second">Responsable du traitement : {EDITEUR.anonyme ? 'l’éditeur du site (voir les mentions légales)' : EDITEUR.nom}
    — contact : {CONTACT.mail}.</p>

  <h2>1. Si vous envoyez une vidéo sans compte</h2>
  <ul>
    <li><strong>L’original</strong> est chiffré dans votre navigateur avant de partir, avec une clé tirée de votre code de
      12 mots. Argos Veille ne connaît pas ce code et ne peut pas lire l’original. Il est gardé tant que la vidéo n’est pas
      retirée.</li>
    <li><strong>Si vous donnez un lien</strong> plutôt qu’un fichier, notre serveur récupère la vidéo et la voit en clair le temps de la chiffrer et de la flouter. Le lien n’est pas conservé.</li>
    <li><strong>La copie de travail</strong> sert à flouter les visages : notre serveur la voit en clair le temps du floutage
      (24 h au plus). Elle est ensuite gardée chiffrée, puis effacée dès la fin de la vérification du floutage (7 jours au
      plus).</li>
    <li><strong>La version floutée</strong> et le <strong>contexte</strong> que vous indiquez (date, lieu arrondi selon votre
      choix, nature des faits, description) : gardés tant que la vidéo n’est pas retirée ; publiés si la relecture le décide.</li>
    <li><strong>Les sauvegardes</strong> sont chiffrées et stockées en Suisse. Une vidéo retirée en disparaît au bout de 8 jours
      environ ; les autres données, au bout de 6 mois au plus.</li>
    <li><strong>Les métadonnées</strong> de la vidéo (position GPS exacte, heure à la seconde) sont lues dans votre navigateur
      pour préremplir le formulaire. Elles sont retirées de la copie envoyée pour le floutage : dans votre navigateur pour
      un MP4 ou un MOV, sinon par le serveur au traitement. Seul l’original, chiffré, les garde.</li>
    <li><strong>Le code de suivi</strong> : le site ne le conserve pas et ne peut pas le retrouver.</li>
    <li><strong>Journal légal</strong> : la loi (décret n° 2021-1362) impose de conserver <strong>un an</strong>, pour chaque
      envoi, retouche ou retrait d’une vidéo, l’adresse IP, l’heure exacte, l’identifiant de la vidéo et, si vous utilisez un
      compte, ce compte. Ce journal est chiffré et tenu à part : ni le site ni son serveur ne peuvent le lire. Il n’est
      ouvert que pour répondre à une réquisition judiciaire. Il est effacé au bout d’un an, et de ses sauvegardes quelques jours plus tard.</li>
    <li>Si vous l’autorisez, l’administration (et elle seule) peut ouvrir l’original pour le transmettre à une
      association, un avocat ou un journaliste. Vous pouvez retirer cette autorisation à tout moment ; un original déjà transmis ne peut pas être repris.</li>
  </ul>

  <h2>2. Si vous envoyez une vidéo avec votre compte</h2>
  <p>En plus de ce qui précède, la vidéo est liée à votre compte tant qu’il existe, pour que vous la suiviez dans « Mes
    vidéos » et receviez des mails d’avancement (qui ne disent jamais de quelle vidéo il s’agit). Sur demande de la
    justice, ce lien pourrait révéler que vous l’avez envoyée. Il est effacé avec votre compte, ou dès que vous retirez la
    vidéo (sauf demande de la justice ou d’une autorité en cours, où tout est gardé). Seul le journal légal le garde un an, comme la loi l’impose.</p>

  <h2>3. Si vous créez un compte (relecteur)</h2>
  <ul>
    <li><strong>Pseudo</strong> (visible) et <strong>mot de passe</strong> (jamais conservé en clair).</li>
    <li><strong>Numéro de téléphone</strong> : vérifié par SMS, pour empêcher qu’une même personne ouvre plusieurs
      comptes. Le numéro lui-même n’est pas conservé.</li>
    <li><strong>Adresse mail</strong> : gardée chiffrée, pour vous écrire (confirmation, convocations, sécurité). Elle
      n’est jamais affichée, y compris à l’administration.</li>
    <li><strong>Double authentification</strong>, <strong>codes de secours</strong> et <strong>appareils connus</strong>
      (pour vous prévenir d’une connexion depuis un nouvel appareil), sans que le site garde de quoi les reconstituer.</li>
    <li><strong>Sessions</strong> : un cookie de connexion, valable 30 jours au plus (7 jours sans activité).</li>
    <li><strong>Votes et score</strong> : le lien entre un vote et votre compte est coupé au bout de <strong>6 mois</strong>
      (le vote reste, sans auteur). Le score de fiabilité n’est jamais affiché.</li>
    <li><strong>Journal légal des connexions</strong> (adresse IP, heure) : un an, comme pour les envois.</li>
    <li><strong>Fermer son compte</strong> : vos accès sont coupés tout de suite, puis tout est effacé au bout de 30 jours
      (pseudo, mot de passe, mail, téléphone, messages, lien avec vos vidéos). Restent, sans lien avec vous :
      vos votes et, si vous êtes analyste, vos notes signées « compte supprimé ».</li>
  </ul>

  <h2>4. Rapports de bug</h2>
  <p>Quand vous signalez un bug, le rapport contient ce que vous voyez avant de l’envoyer : navigateur et système, taille de
    la fenêtre, les dernières actions sur le site (pages et boutons, jamais ce que vous avez tapé), les erreurs, et une
    capture d’écran si vous la cochez. Jamais votre adresse IP, vos cookies ni le texte saisi. Les erreurs du serveur
    liées à une requête sont gardées <strong>14 jours</strong>, sans adresse IP.</p>

  <h2>5. Cookies et stockage dans le navigateur</h2>
  <ul>
    <li><strong>Connexion</strong> (si vous avez un compte) et <strong>accès à la bêta</strong> (pendant la bêta) : nécessaires
      au fonctionnement, sans consentement à donner.</li>
    <li>Dans votre navigateur seulement : votre thème (clair ou sombre), l’avertissement de la carte déjà vu, le rappel de
      double authentification fermé, le tri de « Mes vidéos » et, si vous cochez « Se souvenir de mon pseudo », votre pseudo
      (visible de quiconque utilise cet appareil ; décochez la case pour l’effacer).</li>
    <li>Aucun cookie de mesure d’audience ni de publicité.</li>
  </ul>

  <h2>6. Qui voit vos données</h2>
  <p>Personne ne les achète ni ne les reçoit à des fins commerciales. Les relecteurs ne voient que la version floutée et le
    contexte, jamais qui a envoyé la vidéo. Des prestataires techniques traitent certaines données pour notre compte :</p>
  <ul>
    {#each PRESTATAIRES as p (p.nom)}<li><strong>{p.nom}</strong> — {p.role} ({p.lieu}).</li>{/each}
  </ul>
  <p>Cloudflare assure la connexion entre votre navigateur et notre serveur : comme tout intermédiaire de ce type, il voit
    passer votre adresse IP et les échanges. L’original de votre vidéo, chiffré dans votre navigateur, lui reste illisible.
    Cloudflare étant une société américaine, ces transferts reposent sur le cadre de protection des données UE–États-Unis.
    Les calendriers OpenTimestamps, qui datent le journal public, ne reçoivent qu’une empreinte, jamais une donnée.</p>
  <p>Sur réquisition judiciaire, Argos Veille est tenu de remettre ce qu’il détient ; c’est pourquoi il détient le moins de
    choses possible.</p>

  <p>La recherche d’adresse sur les cartes passe par notre serveur vers le service public d’adresses (Géoplateforme, IGN) : il ne voit pas votre adresse IP, et ce que vous cherchez n’est pas conservé.</p>

  <h2>7. Les personnes filmées</h2>
  <p>Les visages reconnaissables sont floutés avant toute relecture. Si vous apparaissez dans une vidéo et pensez être reconnaissable,
    ou si vous souhaitez vous opposer à la publication, écrivez-nous (page <a href="/contact">Contact</a>) en indiquant
    l’adresse de la fiche : nous examinons chaque demande.</p>

  <h2>8. Formulaire de contact</h2>
  <p>Votre message et votre adresse mail, si vous la donnez, sont chiffrés et effacés au bout d’un an. Votre adresse IP sert seulement à limiter les envois et n’est pas conservée avec le message.</p>

  <h2>9. Vos droits</h2>
  <p>Vous pouvez demander l’accès à vos données, leur rectification, leur effacement, la limitation de leur traitement,
    vous y opposer, et en recevoir une copie : à l’adresse {CONTACT.mail}. Avec un compte, vous pouvez aussi tout effacer
    vous-même en fermant votre compte. Pour une vidéo envoyée sans compte, le code de 12 mots est la seule preuve qu’elle
    est la vôtre : sans lui, nous ne pouvons pas savoir qui l’a envoyée.</p>
  <p>Si vous estimez que vos droits ne sont pas respectés, vous pouvez saisir la
    <a href="https://www.cnil.fr/fr/plaintes" target="_blank" rel="noopener noreferrer">CNIL</a>.</p>
</article>
