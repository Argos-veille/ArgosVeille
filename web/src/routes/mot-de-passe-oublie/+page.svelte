<script lang="ts">
  // Récupération du compte : par un lien envoyé au mail du compte, ou avec un code de secours.
  import { goto } from '$app/navigation';
  import { secretDeConnexion, verifierNouveau } from '#lib/motdepasse.ts';
  import { post } from '#lib/api.ts';
  import ChampMotDePasse from '#lib/composants/ChampMotDePasse.svelte';
  import { message } from '#lib/erreurs.ts';
  import { jetonTurnstile } from '#lib/turnstile.ts';

  let voie = $state<'mail' | 'code'>('mail');
  let mail = $state('');
  let pseudo = $state('');
  let code = $state('');
  let motDePasse = $state('');
  let envoye = $state('');
  let erreur = $state('');
  let occupe = $state(false);

  async function parMail(e: SubmitEvent) {
    e.preventDefault();
    erreur = '';
    occupe = true;
    try {
      const r = await post<{ message: string }>('/recuperation/demande', { mail, turnstile: await jetonTurnstile() });
      envoye = r.message;
    } catch (x) {
      erreur = message(x);
    } finally {
      occupe = false;
    }
  }

  async function parCode(e: SubmitEvent) {
    e.preventDefault();
    erreur = '';
    occupe = true;
    try {
      await verifierNouveau(motDePasse, pseudo);
      await post('/recuperation/code', { pseudo, code: code.replace(/\s/g, ''), motDePasse: await secretDeConnexion(pseudo, motDePasse) });
      await goto('/connexion');
    } catch (x) {
      erreur = message(x);
    } finally {
      occupe = false;
    }
  }
</script>

<svelte:head><title>Récupérer mon compte — Argos Veille</title></svelte:head>

<div class="conteneur etroit">
  <span class="surtitre">Mon compte</span>
  <h1>Récupérer mon compte</h1>
  <div class="onglets" role="tablist">
    <button role="tab" aria-selected={voie === 'mail'} class:actif={voie === 'mail'} onclick={() => (voie = 'mail')}>Par mail</button>
    <button role="tab" aria-selected={voie === 'code'} class:actif={voie === 'code'} onclick={() => (voie = 'code')}>Avec un code de secours</button>
  </div>
  {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}

  {#if voie === 'mail'}
    {#if envoye}
      <div class="message succes">{envoye}</div>
      <p class="petit discret">Pas reçu ? Regardez dans vos courriers indésirables (spams) et, s’il y est, marquez-le comme « courrier légitime ».</p>
      <p class="second">Le lien est valable 30 minutes et ne sert qu’une fois. Il rappelle aussi votre pseudo.</p>
    {:else}
      <form class="carte" onsubmit={parMail}>
        <p class="second">Indiquez l’adresse mail de votre compte : vous recevrez un lien pour choisir un nouveau mot de passe.</p>
        <div class="champ">
          <label for="mail">Adresse mail</label>
          <input id="mail" type="email" bind:value={mail} required autocomplete="email" maxlength="254" />
        </div>
        <button class="bouton principal pleine-largeur" type="submit" disabled={occupe}>Recevoir le lien</button>
      </form>
    {/if}
  {:else}
    <form class="carte" onsubmit={parCode}>
      <p class="second">Si vous n’avez plus accès à votre mail ou à votre second facteur, un code de secours permet de
        choisir un nouveau mot de passe. Toutes vos sessions seront fermées.</p>
      <div class="champ">
        <label for="pseudo">Pseudo</label>
        <input id="pseudo" bind:value={pseudo} required autocomplete="username" maxlength="60" />
      </div>
      <div class="champ">
        <label for="code">Code de secours</label>
        <input id="code" class="mono" bind:value={code} required autocomplete="off" maxlength="20" />
      </div>
      <ChampMotDePasse id="mdp" libelle="Nouveau mot de passe" bind:valeur={motDePasse} nouveau />
      <button class="bouton principal pleine-largeur" type="submit" disabled={occupe}>Changer le mot de passe</button>
    </form>
  {/if}
</div>

<style>
  .onglets { display: flex; gap: 0; border-bottom: 1px solid var(--trait); margin-bottom: 1.25rem; }
  .onglets button { font: inherit; font-weight: 600; background: none; border: 0; border-bottom: 3px solid transparent;
                    padding: 0.625rem 1rem; color: var(--texte-3); cursor: pointer; margin-bottom: -1px; }
  .onglets button.actif { color: var(--texte); border-bottom-color: var(--accent); }
</style>
