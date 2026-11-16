<script lang="ts">
  // Connexion : pseudo + mot de passe, puis le second facteur s'il y en a un (application, clé de
  // sécurité ou code de secours). Vérification anti-robot seulement après plusieurs échecs.
  import Manque from '#lib/composants/Manque.svelte';
  import { goto } from '$app/navigation';
  import { secretDeConnexion } from '#lib/motdepasse.ts';
  import { page } from '$app/state';
  import { startAuthentication } from '@simplewebauthn/browser';
  import { ErreurApi, post } from '#lib/api.ts';
  import ChampMotDePasse from '#lib/composants/ChampMotDePasse.svelte';
  import { message } from '#lib/erreurs.ts';
  import { preparerALaConnexion } from '#lib/messagerie.ts';
  import { rafraichir } from '#lib/session.svelte.ts';
  import { jetonTurnstile } from '#lib/turnstile.ts';

  // « Se souvenir de mon pseudo » : gardé seulement dans ce navigateur (jamais le mot de passe).
  const CLE_PSEUDO = 'argos:pseudo';
  const pseudoGarde = (() => { try { return localStorage.getItem(CLE_PSEUDO) ?? ''; } catch { return ''; } })();
  let pseudo = $state(pseudoGarde);
  let souvenirPseudo = $state(!!pseudoGarde);
  // « Ne pas me redemander pendant 30 jours » : la double authentification, sur cet appareil.
  let seSouvenir = $state(false);
  // Gardé jusqu'à la fin de la connexion (double authentification comprise) pour ouvrir la clé de messagerie.
  let mdpMessagerie = '';
  let motDePasse = $state('');
  let turnstileRequis = $state(false);
  let attente = $state('');
  let methodes = $state<string[]>([]);
  // Faux pour les comptes à double authentification obligatoire (journaliste, avocat, association, analyste, admin).
  let confiancePossible = $state(true);
  let mode = $state<'totp' | 'code_secours'>('totp');
  let code = $state('');
  let erreur = $state('');
  let occupe = $state(false);
  const bienvenue = page.url.searchParams.has('bienvenue');

  // Retour après connexion (ex. depuis « Envoyer une vidéo ») : seulement une page de ce site.
  const retourDemande = page.url.searchParams.get('retour') ?? '';
  const retour = /^\/(?!\/)[\w\-/?=&]*$/.test(retourDemande) ? retourDemande : null;

  /** Session ouverte. `fermetureAnnulee` : le compte était en cours de fermeture, la reconnexion l'a annulée. */
  async function reussite(r: { fermetureAnnulee?: boolean } = {}) {
    try { if (souvenirPseudo) localStorage.setItem(CLE_PSEUDO, pseudo.trim()); else localStorage.removeItem(CLE_PSEUDO); }
    catch { /* stockage indisponible : rien à retenir */ }
    await rafraichir();
    preparerALaConnexion(mdpMessagerie);
    mdpMessagerie = '';
    await goto(r.fermetureAnnulee ? '/compte?fermetureAnnulee' : (retour ?? '/compte'));
  }

  async function connecter(e: SubmitEvent) {
    e.preventDefault();
    erreur = '';
    occupe = true;
    try {
      // Le mot de passe ne part pas : seulement le secret de connexion qui en est tiré (revue de sécurité A5).
      type Reponse = { etape?: string; methodes?: string[]; attente?: string; fermetureAnnulee?: boolean; confiancePossible?: boolean };
      const secret = await secretDeConnexion(pseudo, motDePasse);
      const turnstile = turnstileRequis ? { turnstile: await jetonTurnstile() } : {};
      let r: Reponse;
      try {
        r = await post<Reponse>('/connexion', { pseudo, motDePasse: secret, ...turnstile });
      } catch (x) {
        if (!(x instanceof ErreurApi && x.code === 'mot_de_passe_a_convertir')) throw x;
        // Audit M8 : passé cette date (fixée ici, dans le navigateur), le mot de passe n'est plus jamais renvoyé, même si le
        // serveur ou un intermédiaire le demande : le compte passe par « Mot de passe oublié ».
        if (Date.now() > FIN_CONVERSION) {
          throw new Error('Votre compte doit choisir un nouveau mot de passe : utilisez « Mot de passe oublié ».');
        }
        // Compte d'avant ce changement : le mot de passe part une dernière fois, avec le secret qui le remplace.
        // (nouveau jeton anti-robot si besoin : un jeton ne sert qu'une fois)
        r = await post<Reponse>('/connexion', { pseudo, motDePasse, nouveauSecret: secret,
                                                ...(turnstileRequis ? { turnstile: await jetonTurnstile() } : {}) });
      }
      mdpMessagerie = motDePasse;
      if (r.etape === 'double_authentification') {
        attente = r.attente!;
        methodes = r.methodes!;
        confiancePossible = r.confiancePossible !== false;
        if (!confiancePossible) seSouvenir = false;
        mode = methodes.includes('totp') ? 'totp' : 'code_secours';
        motDePasse = '';
      } else {
        await reussite(r);
      }
    } catch (x) {
      if (x instanceof ErreurApi && x.code === 'turnstile_requis') turnstileRequis = true;
      erreur = message(x);
    } finally {
      occupe = false;
    }
  }

  async function secondFacteur(corps: { code?: string; cle?: unknown }) {
    erreur = '';
    occupe = true;
    try {
      await reussite(await post<{ fermetureAnnulee?: boolean }>('/connexion/2fa', { attente, ...corps, ...(seSouvenir ? { seSouvenir } : {}) }));
    } catch (x) {
      erreur = message(x);
      if (x instanceof ErreurApi && ['attente_expiree', 'trop_d_essais'].includes(x.code)) attente = '';
    } finally {
      occupe = false;
    }
  }

  async function avecCle() {
    erreur = '';
    try {
      const { options } = await post<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/connexion/2fa/cle', { attente });
      const cle = await startAuthentication({ optionsJSON: options });
      await secondFacteur({ cle });
    } catch (x) {
      erreur = message(x);
    }
  }
  // Dernier jour où un compte d'avant le secret de connexion (0101) peut encore envoyer son mot de passe (audit M8).
  const FIN_CONVERSION = Date.parse('2026-11-15T00:00:00+01:00');   // un seul compte, déjà converti : plus aucun renvoi
</script>

<svelte:head><title>Connexion — Argos Veille</title></svelte:head>

<div class="conteneur etroit">
  <span class="surtitre">Mon compte</span>
  <h1>Connexion</h1>
  {#if bienvenue && !attente}<div class="message succes">Votre compte est prêt. Connectez-vous avec votre pseudo et votre mot de passe.</div>{/if}
  {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}

  {#if !attente}
    <form class="carte" onsubmit={connecter}>
      <div class="champ">
        <label for="pseudo">Pseudo</label>
        <input id="pseudo" bind:value={pseudo} required autocomplete="username" maxlength="60" />
      </div>
      <ChampMotDePasse id="mdp" libelle="Mot de passe" bind:valeur={motDePasse} />
      <label class="case"><input type="checkbox" bind:checked={souvenirPseudo} /> <span>Se souvenir de mon pseudo sur cet appareil <span class="discret">(déconseillé s’il est partagé)</span></span></label>
      {#if turnstileRequis}
        <p class="aide">Après plusieurs échecs, une vérification anti-robot accompagne la connexion.</p>
      {/if}
      <div class="boutons">
        <button class="bouton principal pleine-largeur" type="submit" disabled={occupe}>{occupe ? 'Connexion…' : 'Se connecter'}</button>
      </div>
    </form>
    <p class="petit"><a href="/mot-de-passe-oublie">Mot de passe oublié, ou plus d’accès à votre second facteur ?</a></p>
    <p class="petit discret">Pas encore de compte ? <a href="/inscription">Créer un compte</a></p>
  {:else}
    <div class="carte">
      <h2>Double authentification</h2>
      {#if confiancePossible}
      <label class="case confiance"><input type="checkbox" bind:checked={seSouvenir} />
        <span>Ne pas me redemander pendant 30 jours sur cet appareil
          <span class="petit discret">(à éviter sur un appareil partagé)</span></span></label>
      {/if}
      {#if methodes.includes('webauthn')}
        <p class="second">Utilisez votre clé de sécurité ou votre passkey.</p>
        <button class="bouton principal" onclick={avecCle} disabled={occupe}>Utiliser ma clé de sécurité</button>
        <hr />
      {/if}
      <form onsubmit={(e) => { e.preventDefault(); void secondFacteur({ code: code.replace(/\s/g, '') }); }}>
        <div class="champ">
          <label for="code">{mode === 'totp' ? 'Code de votre application d’authentification' : 'Un de vos codes de secours'}</label>
          {#if mode === 'totp'}
            <input id="code" class="code-saisie" bind:value={code} required inputmode="numeric" autocomplete="one-time-code"
                   pattern={'[0-9 ]{6,7}'} maxlength="7" />
          {:else}
            <input id="code" class="mono" bind:value={code} required autocomplete="off" maxlength="20" />
          {/if}
        </div>
        <div class="boutons">
          <Manque raisons={[!code && 'le code']}><button class="bouton principal" type="submit" disabled={occupe || !code}>Valider</button></Manque>
          {#if methodes.includes('totp')}
            <button type="button" class="bouton lien" onclick={() => { mode = mode === 'totp' ? 'code_secours' : 'totp'; code = ''; }}>
              {mode === 'totp' ? 'Utiliser un code de secours' : 'Utiliser l’application'}
            </button>
          {/if}
        </div>
      </form>
    </div>
    <p class="petit"><button class="bouton lien" onclick={() => { attente = ''; code = ''; }}>← Revenir</button></p>
  {/if}
</div>

<style>
  .confiance { margin-bottom: 1rem; }
</style>
