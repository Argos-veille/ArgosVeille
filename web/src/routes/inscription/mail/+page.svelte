<script lang="ts">
  // Lien de confirmation du mail : le jeton est après le « # » (jamais envoyé au serveur du site,
  // ni gardé dans l'historique : il est retiré de l'adresse dès la lecture).
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { post } from '#lib/api.ts';
  import CodesSecours from '#lib/composants/CodesSecours.svelte';
  import { message } from '#lib/erreurs.ts';

  let etat = $state<'verification' | 'attente_sms' | 'codes' | 'erreur'>('verification');
  let codes = $state<string[]>([]);
  let erreur = $state('');
  let certificationEnAttente = $state(false);

  onMount(async () => {
    const jeton = location.hash.slice(1);
    // Jeton retiré de l'adresse (et de l'historique) par le routeur, sans recharger la page.
    if (jeton) void goto(location.pathname, { replace: true, shallow: true, state: {} });
    if (!/^[A-Za-z0-9_-]{43}$/.test(jeton)) {
      erreur = 'Ce lien a déjà servi, ou il est incomplet. Si votre compte est déjà créé, connectez-vous ; sinon, copiez le lien en entier depuis le mail.';
      etat = 'erreur';
      return;
    }
    try {
      const r = await post<{ etape?: string; codesSecours?: string[]; certificationEnAttente?: boolean }>('/inscription/mail', { jeton });
      certificationEnAttente = !!r.certificationEnAttente;
      if (r.codesSecours) {
        codes = r.codesSecours;
        etat = 'codes';
      } else {
        etat = 'attente_sms';
      }
    } catch (x) {
      erreur = message(x);
      etat = 'erreur';
    }
  });
</script>

<svelte:head><title>Confirmation du mail — Argos Veille</title></svelte:head>

<div class="conteneur etroit">
  <span class="surtitre">Rejoindre Argos Veille</span>
  <h1>Confirmation du mail</h1>
  {#if etat === 'verification'}
    <p class="second">Vérification du lien…</p>
  {:else if etat === 'attente_sms'}
    <div class="message succes">Adresse confirmée.</div>
    <p>Revenez à l’onglet de l’inscription et saisissez le code reçu par SMS : vos codes de secours s’y afficheront.</p>
  {:else if etat === 'codes'}
    <div class="carte">
      <h2>Votre compte est créé</h2>
      {#if certificationEnAttente}<p class="message info">Votre code de statut n’a pas encore servi : un statut vérifié demande une double authentification. Activez-la dans « Mon compte », puis saisissez-y votre code.</p>{/if}
      <CodesSecours {codes} suite={() => goto('/connexion?bienvenue=1')} />
    </div>
  {:else}
    <div class="message erreur" role="alert">{erreur}</div>
    <div class="boutons"><a class="bouton principal" href="/connexion">Se connecter</a><a class="bouton" href="/inscription">Recommencer l’inscription</a></div>
  {/if}
</div>
