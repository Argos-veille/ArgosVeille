<script lang="ts">
  // Contact, signalement, droit de réponse (LCEN, art. 1-1, III), exercice des droits RGPD.
  // Texte à faire valider par l'avocat (questions 26 et 28).
  import { CONTACT, EDITEUR } from '#lib/legal.ts';
  import FormulaireContact from './FormulaireContact.svelte';
</script>

<svelte:head><title>Contact — Argos Veille</title></svelte:head>

<article class="conteneur texte-long">
  <span class="surtitre">Contact</span>
  <h1>Nous écrire</h1>
  <p class="chapo">Écrivez-nous ici, ou à <strong>{CONTACT.mail}</strong>. Si cela concerne une vidéo, donnez l’adresse de sa fiche.</p>
  <div class="message info">Ne nous écrivez jamais votre code de 12 mots : personne ne vous le demandera. Pour suivre ou
    retirer une vidéo : <a href="/suivi">Suivre ma vidéo</a>.</div>

  <FormulaireContact />

  <h2>Signaler un contenu</h2>
  <p>Avec un compte : bouton « Signaler » de la fiche de la vidéo. Sans compte : écrivez-nous. Les contenus manifestement
    illicites sont retirés sans délai.</p>

  <h2>Droit de réponse</h2>
  <p>Toute personne nommée ou désignée sur Argos Veille peut demander l’insertion d’une réponse (loi n° 2004-575 du 21 juin
    2004, art. 1-1, III), dans les trois mois suivant la mise en ligne. Écrivez {EDITEUR.anonyme ? 'à l’éditeur' : `au directeur de
    la publication (${EDITEUR.directeurPublication})`} à l’adresse ci-dessus{#if EDITEUR.anonyme} (ou, l’éditeur ayant gardé
    l’anonymat, à l’hébergeur indiqué dans les <a href="/mentions-legales">mentions légales</a>, qui transmet){/if}, en
    indiquant la fiche concernée, les passages contestés et le texte de votre réponse. Si elle est recevable, elle est
    publiée dans les trois jours sur la fiche concernée.</p>

  <h2>Vos données personnelles</h2>
  <p>Accès, rectification, effacement, opposition : écrivez-nous ; détails sur la page
    <a href="/confidentialite">Confidentialité</a>.</p>

  <h2>Autorités</h2>
  <p>Les demandes des autorités (réquisitions, demandes de retrait) sont à adresser à la même adresse. Chaque retrait légal
    est inscrit au <a href="/journal">journal public</a>, avec son motif.</p>

  <h2>Presse, associations, avocats</h2>
  <p>Pour réutiliser les vidéos publiées, voir <a href="/donnees">Données ouvertes et API</a> (licence CC BY 4.0). Pour
    toute autre demande, écrivez-nous.</p>
</article>
