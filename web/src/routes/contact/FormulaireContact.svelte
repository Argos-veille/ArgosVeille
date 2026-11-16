<script lang="ts">
  import Manque from '#lib/composants/Manque.svelte';
  import { page } from '$app/state';
  import { post } from '#lib/api.ts';
  import { message as texteErreur } from '#lib/erreurs.ts';
  import { jetonTurnstile } from '#lib/turnstile.ts';

  const MOTIFS: Record<string, string> = {
    contenu: 'Signaler un contenu', droit_de_reponse: 'Droit de réponse', donnees: 'Mes données personnelles',
    autorite: 'Demande d’une autorité', presse: 'Presse, association, avocat', certification: 'Certifier mon compte', autre: 'Autre',
  };
  const AVEC_MAIL = ['droit_de_reponse', 'donnees', 'certification'];

  // Arrivée depuis un lien « Demandez un code » : /contact?motif=certification.
  const motifDemande = page.url.searchParams.get('motif') ?? '';
  let motif = $state(motifDemande in MOTIFS ? motifDemande : 'contenu');
  let mail = $state('');
  let contenu = $state('');
  let erreur = $state('');
  let occupe = $state(false);
  let envoye = $state(false);
  const mailRequis = $derived(AVEC_MAIL.includes(motif));

  async function envoyer(e: SubmitEvent) {
    e.preventDefault();
    erreur = '';
    occupe = true;
    try {
      await post('/contact', { motif, message: contenu, ...(mail.trim() ? { mail: mail.trim() } : {}), turnstile: await jetonTurnstile() });
      envoye = true;
    } catch (x) {
      erreur = texteErreur(x);
    } finally {
      occupe = false;
    }
  }
</script>

{#if envoye}
  <div class="message succes" role="status">Message envoyé. Merci.</div>
{:else}
  <form class="carte" onsubmit={envoyer}>
    <div class="champ">
      <label for="motif">Objet</label>
      <select id="motif" bind:value={motif}>
        {#each Object.entries(MOTIFS) as [cle, texte] (cle)}<option value={cle}>{texte}</option>{/each}
      </select>
    </div>
    <div class="champ">
      <label for="contenu">Message</label>
      <textarea id="contenu" rows="6" maxlength="5000" required bind:value={contenu}></textarea>
      {#if motif === 'certification'}<span class="aide">Indiquez votre rôle (journaliste, avocat, association, analyste OSINT) et comment le vérifier.</span>{/if}
    </div>
    <div class="champ">
      <label for="mail">Votre adresse mail{mailRequis ? '' : ' (facultatif, pour recevoir une réponse)'}</label>
      <input id="mail" type="email" maxlength="254" autocomplete="email" required={mailRequis} bind:value={mail} />
    </div>
    {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
    <Manque raisons={[contenu.trim().length < 10 && 'un message de 10 caractères au moins', mailRequis && !mail.trim() && 'votre adresse mail']}><button class="bouton principal" type="submit" disabled={occupe || contenu.trim().length < 10 || (mailRequis && !mail.trim())}>
      {occupe ? 'Envoi…' : 'Envoyer'}</button></Manque>
  </form>
{/if}
