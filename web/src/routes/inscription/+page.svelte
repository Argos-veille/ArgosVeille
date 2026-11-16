<script lang="ts">
  // Inscription des relecteurs : formulaire → code SMS + lien reçu par mail (dans l'ordre que l'on
  // veut) → codes de secours. Le compte est créé quand le SMS et le mail sont confirmés.
  import Manque from '#lib/composants/Manque.svelte';
  import Info from '#lib/composants/Info.svelte';
  import { secretDeConnexion, verifierNouveau } from '#lib/motdepasse.ts';
  import { goto } from '$app/navigation';
  import { ErreurApi, post } from '#lib/api.ts';
  import ChampMotDePasse from '#lib/composants/ChampMotDePasse.svelte';
  import CodesSecours from '#lib/composants/CodesSecours.svelte';
  import { message } from '#lib/erreurs.ts';
  import { rafraichir } from '#lib/session.svelte.ts';
  import { jetonTurnstile } from '#lib/turnstile.ts';
  import { CONDITIONS_VERSION } from '#lib/conditions.ts';

  let etape = $state<'formulaire' | 'confirmations' | 'codes'>('formulaire');
  let pseudo = $state('');
  let certificationEnAttente = $state(false);
  let motDePasse = $state('');
  let confirmation = $state('');
  let telephone = $state('');
  let mail = $state('');
  let charte = $state(false);
  let conditions = $state(false);
  let codeInvitation = $state('');   // code de compte spécial (facultatif), donné par l'administration
  let inscription = $state('');
  let code = $state('');
  let smsOk = $state(false);
  let attenteMail = $state(false);
  let codes = $state<string[]>([]);
  let erreur = $state('');
  let recuperation = $state(false);
  let occupe = $state(false);

  async function commencer(e: SubmitEvent) {
    e.preventDefault();
    erreur = '';
    recuperation = false;
    if (motDePasse !== confirmation) {
      erreur = 'Les deux mots de passe ne sont pas identiques.';
      return;
    }
    occupe = true;
    try {
      await verifierNouveau(motDePasse, pseudo);
      const r = await post<{ inscription: string }>('/inscription/debut',
        { pseudo, motDePasse: await secretDeConnexion(pseudo, motDePasse), telephone, mail, turnstile: await jetonTurnstile(), conditions: CONDITIONS_VERSION,
          ...(codeInvitation.trim() ? { codeInvitation: codeInvitation.trim() } : {}) });
      inscription = r.inscription;
      motDePasse = confirmation = '';
      etape = 'confirmations';
    } catch (x) {
      erreur = message(x);
      recuperation = x instanceof ErreurApi && x.code === 'deja_inscrit';
    } finally {
      occupe = false;
    }
  }

  async function confirmerSms(e: SubmitEvent) {
    e.preventDefault();
    erreur = '';
    occupe = true;
    try {
      const r = await post<{ etape?: string; codesSecours?: string[]; certificationEnAttente?: boolean }>('/inscription/sms', { inscription, code });
      certificationEnAttente = !!r.certificationEnAttente;
      smsOk = true;
      if (r.codesSecours) {
        codes = r.codesSecours;
        etape = 'codes';
      } else if (r.etape === 'attente_mail') {
        attenteMail = true;
      }
    } catch (x) {
      erreur = message(x);
      if (x instanceof ErreurApi && (x.code === 'inscription_expiree' || x.code === 'trop_d_essais')) etape = 'formulaire';
    } finally {
      occupe = false;
    }
  }

  async function terminer() {
    // Le compte est créé ; la connexion se fait avec le pseudo et le mot de passe.
    await rafraichir();
    await goto('/connexion?bienvenue=1');
  }
</script>

<svelte:head><title>Créer un compte — Argos Veille</title></svelte:head>

<div class="conteneur etroit">
  <span class="surtitre">Rejoindre Argos Veille</span>
  <h1>Créer mon compte</h1>

  <ol class="etapes" aria-label="Étapes">
    <li class:active={etape === 'formulaire'} class:faite={etape !== 'formulaire'}>Mes informations</li>
    <li class:active={etape === 'confirmations'} class:faite={etape === 'codes'}>SMS et mail</li>
    <li class:active={etape === 'codes'}>Codes de secours</li>
  </ol>

  {#if erreur}
    <div class="message erreur" role="alert">
      {erreur}
      {#if recuperation}<br /><a href="/mot-de-passe-oublie">Récupérer mon compte</a>{/if}
    </div>
  {/if}

  {#if etape === 'formulaire'}
    <p class="second">Votre téléphone et votre mail servent seulement à éviter les faux comptes et à récupérer votre
      accès. Ils ne sont jamais affichés, ni conservés en clair.</p>
    <form class="carte" onsubmit={commencer}>
      <div class="champ">
        <label for="pseudo">Pseudo<Info>Visible des autres. 3 à 30 caractères : lettres sans accents, chiffres, . _ -
          Il sert aussi d’identifiant de connexion.</Info></label>
        <input id="pseudo" bind:value={pseudo} required minlength="3" maxlength="30" autocomplete="username"
               pattern="[A-Za-z0-9._\-]+" />
      </div>
      <ChampMotDePasse id="mdp" libelle="Mot de passe" bind:valeur={motDePasse} nouveau />
      <ChampMotDePasse id="mdp2" libelle="Mot de passe, encore une fois" bind:valeur={confirmation} aide=" " nouveau />
      <div class="champ">
        <label for="tel">Téléphone mobile<Info>Numéros français (métropole et outre-mer). Vous recevrez un code par SMS.</Info></label>
        <input id="tel" type="tel" bind:value={telephone} required autocomplete="tel" inputmode="tel" />
      </div>
      <div class="champ">
        <label for="mail">Adresse mail<Info>Vous recevrez un lien de confirmation, puis les convocations à relire (désactivables).
          Pensez à regarder vos courriers indésirables (spams).</Info></label>
        <input id="mail" type="email" bind:value={mail} required autocomplete="email" maxlength="254" />
      </div>
      <div class="champ">
        <label for="code-invitation">Code d’invitation (facultatif)<Info>Seulement si Argos Veille vous en a remis un (journalistes,
          avocats, associations…). Sinon, laissez vide.</Info></label>
        <input id="code-invitation" bind:value={codeInvitation} maxlength="20" autocomplete="off" autocapitalize="characters"
               spellcheck="false" placeholder="XXXX-XXXX-XXXX" />
        <span class="aide">Journaliste, avocat, association ou analyste OSINT&nbsp;? <a href="/contact?motif=certification" target="_blank" rel="noopener">Demandez un code</a>. Le statut demande ensuite une double authentification.</span>
      </div>
      <label class="case">
        <input type="checkbox" bind:checked={charte} required />
        <span>Je m’engage à relire honnêtement, sans chercher à identifier quiconque ni diffuser ce que je vois.
          Je sais que certaines images peuvent choquer.</span>
      </label>
      <label class="case">
        <input type="checkbox" bind:checked={conditions} required />
        <span>J’ai lu et j’accepte les <a href="/conditions" target="_blank">conditions d’utilisation</a>.</span>
      </label>
      <div class="boutons">
        <Manque raisons={[!charte && 'la case de la charte', !conditions && 'la case des conditions']}><button class="bouton principal pleine-largeur" type="submit" disabled={occupe || !charte || !conditions}>
          {occupe ? 'Envoi…' : 'Recevoir mes codes de confirmation'}
        </button></Manque>
      </div>
    </form>
    <p class="petit discret">Déjà inscrit ? <a href="/connexion">Se connecter</a></p>

  {:else if etape === 'confirmations'}
    <div class="carte">
      <h2>1. Le code reçu par SMS</h2>
      {#if smsOk}
        <div class="message succes">Téléphone confirmé.</div>
      {:else}
        <form onsubmit={confirmerSms}>
          <div class="champ">
            <label for="code">Code à 6 chiffres</label>
            <input id="code" class="code-saisie" bind:value={code} required inputmode="numeric" autocomplete="one-time-code"
                   pattern={'[0-9]{6}'} maxlength="6" />
          </div>
          <Manque raisons={[code.length !== 6 && 'le code à 6 chiffres']}><button class="bouton principal" type="submit" disabled={occupe || code.length !== 6}>Valider le code</button></Manque>
        </form>
      {/if}
    </div>
    <div class="carte">
      <h2>2. Le lien reçu par mail</h2>
      <p class="second">Ouvrez le lien « Confirmez votre adresse » reçu à <strong>{mail}</strong> (il s’ouvre dans un nouvel
        onglet).</p>
      {#if attenteMail}<div class="message info">Téléphone confirmé : il ne reste que le lien du mail.</div>{/if}
      <p class="petit discret">Valable 30 minutes. Pas de mail ? Regardez dans les indésirables.</p>
    </div>

  {:else}
    <div class="carte">
      <h2>Votre compte est créé</h2>
      {#if certificationEnAttente}<p class="message info">Votre code de statut n’a pas encore servi : un statut vérifié demande une double authentification. Activez-la dans « Mon compte », puis saisissez-y votre code.</p>{/if}
      <CodesSecours {codes} {pseudo} suite={terminer} />
    </div>
  {/if}
</div>
