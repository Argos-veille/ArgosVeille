<script lang="ts">
  // Lien de réinitialisation reçu par mail : le jeton est après le « # », retiré de l'adresse dès la lecture.
  import { goto } from '$app/navigation';
  import { secretDeConnexion, verifierNouveau } from '#lib/motdepasse.ts';
  import { onMount } from 'svelte';
  import { post } from '#lib/api.ts';
  import ChampMotDePasse from '#lib/composants/ChampMotDePasse.svelte';
  import { message } from '#lib/erreurs.ts';

  let jeton = $state('');
  let motDePasse = $state('');
  let erreur = $state('');
  let fait = $state(false);
  let occupe = $state(false);

  onMount(() => {
    jeton = location.hash.slice(1);
    // Jeton retiré de l'adresse (et de l'historique) par le routeur, sans recharger la page.
    if (jeton) void goto(location.pathname, { replace: true, shallow: true, state: {} });
    if (!/^[A-Za-z0-9_-]{43}$/.test(jeton)) erreur = 'Ce lien a déjà servi, ou il est incomplet. Copiez-le en entier depuis le mail, ou faites une nouvelle demande.';
  });

  async function changer(e: SubmitEvent) {
    e.preventDefault();
    erreur = '';
    occupe = true;
    try {
      const { pseudo } = await post<{ pseudo: string }>('/recuperation/pseudo', { jeton });
      await verifierNouveau(motDePasse, pseudo);
      await post('/recuperation/nouveau-mot-de-passe', { jeton, motDePasse: await secretDeConnexion(pseudo, motDePasse) });
      fait = true;
    } catch (x) {
      erreur = message(x);
    } finally {
      occupe = false;
    }
  }
</script>

<svelte:head><title>Nouveau mot de passe — Argos Veille</title></svelte:head>

<div class="conteneur etroit">
  <span class="surtitre">Mon compte</span>
  <h1>Nouveau mot de passe</h1>
  {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
  {#if fait}
    <div class="message succes">Mot de passe changé. Toutes vos sessions ont été fermées.</div>
    <button class="bouton principal" onclick={() => goto('/connexion')}>Se connecter</button>
  {:else if jeton}
    <form class="carte" onsubmit={changer}>
      <ChampMotDePasse id="mdp" libelle="Nouveau mot de passe" bind:valeur={motDePasse} nouveau />
      <button class="bouton principal pleine-largeur" type="submit" disabled={occupe}>Enregistrer</button>
    </form>
  {/if}
</div>
