<script lang="ts">
  // Signaler une vidéo publique (compte connecté). L'administration l'examine et vous répond par mail ;
  // qui a signalé n'est jamais affiché.
  import Manque from '#lib/composants/Manque.svelte';
  import Info from '#lib/composants/Info.svelte';
  import { post } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';
  import { session } from '#lib/session.svelte.ts';

  let { video }: { video: string } = $props();

  const MOTIFS = [
    ['visible_identity', 'Une personne reste reconnaissable (visage mal flouté…)'],
    ['identifying_text', 'Le texte identifie quelqu’un (nom, adresse…)'],
    ['illegal_content', 'Contenu illégal'],
    ['defamation', 'Diffamation, accusation sans fondement'],
    ['wrong_context', 'Date, lieu ou contexte faux'],
    ['other', 'Autre raison'],
  ] as const;

  let ouvert = $state(false);
  let motif = $state<(typeof MOTIFS)[number][0]>('visible_identity');
  let details = $state('');
  let enCours = $state(false);
  let erreur = $state('');
  let fait = $state(false);

  async function envoyer() {
    erreur = ''; enCours = true;
    try {
      await post(`/videos/${video}/signaler`, { motif, ...(details.trim() ? { details: details.trim() } : {}) });
      fait = true;
    } catch (x) {
      erreur = message(x);
    } finally {
      enCours = false;
    }
  }
</script>

<section class="carte">
  <h2>Un problème avec cette vidéo ?<Info>Votre pseudo n’est jamais affiché. Vous recevrez la réponse de l’administration par mail.</Info></h2>
  {#if fait}
    <div class="message succes" role="status">Merci. L’administration va l’examiner et vous répondra par mail.</div>
  {:else if !session.moi}
    <p class="petit second">Pour signaler une vidéo, <a href="/connexion">connectez-vous</a>
      ou <a href="/inscription">créez un compte</a>.</p>
  {:else if !ouvert}
    <button class="bouton" onclick={() => (ouvert = true)}>Signaler</button>
  {:else}
    <fieldset class="champ">
      <legend class="etiquette">Motif</legend>
      {#each MOTIFS as [cle, texte] (cle)}
        <label class="case"><input type="radio" bind:group={motif} value={cle} /> {texte}</label>
      {/each}
    </fieldset>
    <div class="champ">
      <label for="details-signalement">Précisions {motif === 'other' ? '(obligatoires)' : '(facultatives)'}</label>
      <textarea id="details-signalement" rows="3" maxlength="2000" bind:value={details}
                placeholder="Par exemple : le visage du passant à gauche est visible à 0:03."></textarea>
    </div>
    {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
    <div class="boutons">
      <Manque raisons={[motif === 'other' && details.trim().length < 10 && 'des précisions (10 caractères au moins)']}><button class="bouton principal" disabled={enCours || (motif === 'other' && details.trim().length < 10)} onclick={envoyer}>
        {enCours ? 'Envoi…' : 'Envoyer le signalement'}</button></Manque>
      <button class="bouton" onclick={() => (ouvert = false)}>Annuler</button>
    </div>
  {/if}
</section>

<style>
  fieldset { border: 0; padding: 0; margin: 0 0 1rem; display: grid; gap: 0.375rem; }
</style>
