<script lang="ts">
  // Signaler une faille : règles pour les chercheurs (16 novembre 2026). Reprise dans /.well-known/security.txt.
  import { CODE_SOURCE, CONTACT } from '#lib/legal.ts';
</script>

<svelte:head><title>Sécurité — Argos Veille</title></svelte:head>

<article class="conteneur texte-long">
  <span class="surtitre">Sécurité</span>
  <h1>Signaler une faille</h1>
  <p class="chapo">Vous avez trouvé une faille ? Merci de nous la signaler en privé : nous la corrigeons vite.</p>

  <h2>Le code est public</h2>
  <p>Tout le code du site est <a href={CODE_SOURCE} target="_blank" rel="noopener noreferrer">en ligne</a>, sous licence
    AGPL. Installez votre propre copie et testez-la librement.</p>

  <h2>Sur le site en ligne</h2>
  <p>Utilisation normale seulement, avec vos propres comptes. Sont interdits :</p>
  <ul>
    <li>accéder aux données d’une autre personne ;</li>
    <li>ralentir ou saturer le site, créer des comptes en masse, scanner les serveurs ;</li>
    <li>envoyer des vidéos de test ;</li>
    <li>tromper l’équipe, les relecteurs ou les sources.</li>
  </ul>

  <h2>Comment signaler</h2>
  <p>Par le bouton « Signaler un bug » en bas de page, ou à <strong>{CONTACT.mail}</strong>. Décrivez la faille et comment
    la reproduire. Ne la rendez pas publique avant sa correction, ni plus de 90 jours après votre signalement.</p>
  <p>Si vous le souhaitez, votre aide sera remerciée publiquement.</p>
</article>
