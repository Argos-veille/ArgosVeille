<script lang="ts">
  // Mon compte, en sections (menu à gauche, onglets en haut sur téléphone ; la section ouverte est dans l'adresse,
  // ex. /compte#securite) : profil et code spécial, sécurité (mot de passe, double authentification, codes de
  // secours), appareils connectés, relecture, mails, fermeture. Chaque opération sensible redemande le mot de passe.
  import Manque from '#lib/composants/Manque.svelte';
  import { goto } from '$app/navigation';
  import { secretDuCompte, verifierNouveau } from '#lib/motdepasse.ts';
  import { page } from '$app/state';
  import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
  import QRCode from 'qrcode';
  import { empreinteLongue, rechiffrerCleCompte, type CleCompte } from 'argos-navigateur';
  import { publiqueOuverte } from '#lib/messagerie.ts';
  import { onMount } from 'svelte';
  import { get, post } from '#lib/api.ts';
  import CadreCompte, { SECTIONS_COMPTE, type SectionCompte } from '#lib/composants/CadreCompte.svelte';
  import ChampMotDePasse from '#lib/composants/ChampMotDePasse.svelte';
  import Info from '#lib/composants/Info.svelte';
  import CodesSecours from '#lib/composants/CodesSecours.svelte';
  import { message } from '#lib/erreurs.ts';
  import { rafraichir, session } from '#lib/session.svelte.ts';

  interface Methode { id: string; type: 'totp' | 'webauthn'; nom: string | null; ajouteeLe: string; derniereUtilisation: string | null }

  let methodes = $state<Methode[]>([]);
  let mailConvocations = $state(true);
  // Mails d'avancement des vidéos envoyées avec le compte (« floutage prêt » toujours envoyé).
  type PrefVideo = 'relecture' | 'decision' | 'motifLegal' | 'messageVideo' | 'reponseSource';
  let prefs = $state<Record<PrefVideo, boolean>>({ relecture: true, decision: true, motifLegal: true, messageVideo: true, reponseSource: true });
  const PREFS_VIDEOS: { cle: PrefVideo; titre: string }[] = [
    { cle: 'relecture', titre: 'Ma vidéo est en relecture' },
    { cle: 'decision', titre: 'Décision sur ma vidéo (publiée, refusée, en débat)' },
    { cle: 'motifLegal', titre: 'Ma vidéo est masquée ou retirée pour motif légal' },
    { cle: 'messageVideo', titre: 'Un message m’attend au sujet de ma vidéo' },
  ];
  let info = $state('');
  let erreur = $state('');
  let occupe = $state(false);

  // Ajout d'une méthode
  let ajout = $state<null | 'totp' | 'webauthn'>(null);
  let mdpAjout = $state('');
  let totp = $state<{ secret: string; qr: string } | null>(null);
  let codeTotp = $state('');
  let nomMethode = $state('');
  // Retrait
  let retrait = $state<Methode | null>(null);
  let mdpRetrait = $state('');
  let codeRetrait = $state('');
  // Mot de passe et codes
  let ancien = $state('');
  let nouveau = $state('');
  let confirmation = $state('');
  let mdpCodes = $state('');
  let nouveauxCodes = $state<string[]>([]);
  // Fermeture du compte
  let fermeture = $state(false);
  let mdpFermeture = $state('');
  let codeFermeture = $state('');
  let confirmeFermeture = $state(false);
  let parCode = $state(false);   // clé seulement : code de secours à la place
  let fermeLe = $state('');
  if (page.url.searchParams.has('fermetureAnnulee')) info = 'Bon retour : la fermeture de votre compte est annulée.';

  type Section = SectionCompte;
  const SECTIONS = SECTIONS_COMPTE;
  // Anciennes ancres (liens déjà envoyés) vers leur section.
  const ALIAS: Record<string, Section> = { 'double-authentification': 'securite' };
  const lireSection = (): Section => {
    const h = location.hash.slice(1);
    return ALIAS[h] ?? (SECTIONS.some((x) => x.cle === h) ? (h as Section) : 'profil');
  };
  let section = $state<Section>('profil');

  interface SessionOuverte { id: string; appareil: string; connecteLe: string; derniereActivite: string; actuelle: boolean }
  let sessions = $state<SessionOuverte[]>([]);
  let erreurSessions = $state(false);
  let methodesChargees = $state(false);   // pas d'avertissement « protégez votre compte » avant de savoir
  const quand = (d: string) => {
    const min = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
    return min < 15 ? 'à l’instant' : min < 60 ? `il y a ${min} min` : new Date(d).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  };

  const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

  async function charger() {
    const moi = await rafraichir();
    if (!moi) return goto('/connexion');
    // Les appareils à part : s'ils ne se chargent pas, le reste (double authentification…) s'affiche quand même.
    get<{ sessions: SessionOuverte[] }>('/compte/sessions').then((s) => (sessions = s.sessions))
      .catch(() => (erreurSessions = true));
    const [m, n] = await Promise.all([get<{ methodes: Methode[] }>('/2fa'),
                                      get<Record<PrefVideo | 'convocations', boolean>>('/compte/notifications')]);
    methodes = m.methodes;
    methodesChargees = true;
    mailConvocations = n.convocations;
    prefs = { relecture: n.relecture, decision: n.decision, motifLegal: n.motifLegal, messageVideo: n.messageVideo, reponseSource: n.reponseSource };
  }
  // Comptes vérifiés (journaliste, avocat, association) : empreinte de sécurité de leur messagerie, à publier ailleurs pour
  // que les sources puissent la comparer avec celle que le site leur montre.
  let empreinte = $state('');
  $effect(() => {
    const s = session.moi?.messagerieSources;
    if (!s || s.statut === 'admin') return;
    // Empreinte de la clé OUVERTE par le mot de passe seulement : celle du serveur pourrait être substituée (N1).
    void Promise.resolve(publiqueOuverte()).then(async (p) => { if (p) empreinte = (await empreinteLongue(p)).toUpperCase().match(/.{4}/g)!.join(' '); })
      .catch(() => {});
  });

  onMount(() => {
    section = lireSection();
    const changer = () => { section = lireSection(); erreur = ''; info = info && page.url.searchParams.has('fermetureAnnulee') ? info : ''; };
    addEventListener('hashchange', changer);
    charger().catch((x) => (erreur = message(x)));
    return () => removeEventListener('hashchange', changer);
  });

  const fermerSession = (id: string) => faire(async () => {
    await post(`/compte/sessions/${id}/fermer`);
    sessions = (await get<{ sessions: SessionOuverte[] }>('/compte/sessions')).sessions;
    info = 'Session fermée : cet appareil est déconnecté.';
  });

  async function faire(action: () => Promise<void>) {
    erreur = '';
    info = '';
    occupe = true;
    try {
      await action();
    } catch (x) {
      erreur = message(x);
    } finally {
      occupe = false;
    }
  }

  function annulerAjout() {
    ajout = null; mdpAjout = ''; totp = null; codeTotp = ''; nomMethode = '';
  }

  const commencerTotp = () => faire(async () => {
    const r = await post<{ secret: string; lien: string }>('/2fa/totp/debut', { motDePasse: await secretDuCompte(mdpAjout) });
    totp = { secret: r.secret, qr: await QRCode.toString(r.lien, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
    mdpAjout = '';
  });

  const confirmerTotp = () => faire(async () => {
    await post('/2fa/totp/confirmer', { code: codeTotp.replace(/\s/g, ''), ...(nomMethode.trim() ? { nom: nomMethode.trim() } : {}) });
    annulerAjout();
    info = 'Application d’authentification activée. Elle vous sera demandée à chaque connexion.';
    await charger();
  });

  const ajouterCle = () => faire(async () => {
    const { options } = await post<{ options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/2fa/cle/debut', { motDePasse: await secretDuCompte(mdpAjout) });
    mdpAjout = '';
    const reponse = await startRegistration({ optionsJSON: options });
    await post('/2fa/cle/confirmer', { reponse, ...(nomMethode.trim() ? { nom: nomMethode.trim() } : {}) });
    annulerAjout();
    info = 'Clé de sécurité enregistrée.';
    await charger();
  });

  const retirer = (avecCle: boolean) => faire(async () => {
    let preuve: { code?: string; cle?: unknown };
    if (avecCle) {
      const { options } = await post<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/2fa/cle/defi');
      preuve = { cle: await startAuthentication({ optionsJSON: options }) };
    } else {
      preuve = { code: codeRetrait.replace(/\s/g, '') };
    }
    await post('/2fa/retirer', { methode: retrait!.id, motDePasse: await secretDuCompte(mdpRetrait), ...preuve });
    retrait = null; mdpRetrait = ''; codeRetrait = '';
    info = 'Méthode retirée.';
    await charger();
  });

  const fermer = (avecCle: boolean) => faire(async () => {
    let preuve: { code?: string; cle?: unknown } = {};
    if (methodes.length) {
      if (avecCle) {
        const { options } = await post<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/2fa/cle/defi');
        preuve = { cle: await startAuthentication({ optionsJSON: options }) };
      } else {
        preuve = { code: codeFermeture.replace(/\s/g, '') };
      }
    }
    const r = await post<{ effaceLe: string }>('/compte/fermer', { motDePasse: await secretDuCompte(mdpFermeture), ...preuve });
    fermeLe = date(r.effaceLe);
    session.moi = null;
  });

  const changerMotDePasse = () => faire(async () => {
    if (nouveau !== confirmation) throw new Error('confirmation');
    await verifierNouveau(nouveau, session.moi?.pseudo ?? '');
    // Clé de messagerie : rechiffrée ici avec le nouveau mot de passe (le serveur ne peut pas le faire).
    const { cle } = await get<{ cle: CleCompte | null }>('/messagerie/cle');
    const cleMessagerie = cle ? await rechiffrerCleCompte(cle, ancien, nouveau).catch(() => undefined) : undefined;
    await post('/mot-de-passe', { ancien: await secretDuCompte(ancien), nouveau: await secretDuCompte(nouveau),
                                  ...(cleMessagerie ? { cleMessagerie } : {}) });
    ancien = nouveau = confirmation = '';
    session.moi = null;
    await goto('/connexion');
  });

  const regenererCodes = () => faire(async () => {
    const r = await post<{ codesSecours: string[] }>('/codes-secours', { motDePasse: await secretDuCompte(mdpCodes) });
    mdpCodes = '';
    nouveauxCodes = r.codesSecours;
  });

  let codeSpecial = $state('');
  const saisirCode = () => faire(async () => {
    await post('/compte/code-special', { code: codeSpecial.trim() });
    codeSpecial = '';
    await rafraichir();
    info = 'Code accepté : votre compte est certifié.';
  });

  const changerConvocations = () => faire(async () => {
    await post('/compte/relecture', { convoquer: !session.moi!.convocations });
    await rafraichir();
    info = session.moi!.convocations ? 'Vous serez de nouveau convoqué pour relire.' : 'Vous ne serez plus convoqué pour relire.';
  });

  const changerPref = (cle: PrefVideo) => faire(async () => {
    const r = await post<Record<PrefVideo, boolean>>('/compte/notifications', { [cle]: !prefs[cle] });
    prefs = { relecture: r.relecture, decision: r.decision, motifLegal: r.motifLegal, messageVideo: r.messageVideo, reponseSource: r.reponseSource };
  });

  const changerMails = () => faire(async () => {
    const r = await post<{ mailConvocations: boolean }>('/compte/notifications', { convocations: !mailConvocations });
    mailConvocations = r.mailConvocations;
  });

  const sortirPartout = () => faire(async () => {
    await post('/deconnexion/partout');
    session.moi = null;
    await goto('/connexion');
  });
</script>

<svelte:head><title>Mon compte — Argos Veille</title></svelte:head>

{#if fermeLe || !session.moi}
  <div class="conteneur texte-long">
    <span class="surtitre">Mon compte</span>
    <h1>Mon compte</h1>
    {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
    {#if fermeLe}
    <div class="carte">
      <h2>Votre compte est fermé</h2>
      <p>Il sera effacé définitivement le <strong>{fermeLe}</strong>. Un mail vous le confirme.</p>
      <p class="second">Vous avez changé d’avis ? <a href="/connexion">Reconnectez-vous</a> avant cette date : la fermeture
        sera annulée.</p>
    </div>
    {/if}
  </div>
{:else}
  <CadreCompte actif={section} ici>
    {#snippet avant()}
      {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
      {#if info}<div class="message succes" role="status">{info}</div>{/if}
    {#if methodesChargees && !methodes.length}
      <div class="message attention">
        Protégez votre compte avec une <a href="#securite">double authentification</a>. Elle sera obligatoire pour siéger au
        jury ou devenir analyste.
      </div>
    {/if}
    {#if session.moi?.messagesNonLus}
      <div class="message info"><a href="/compte/messages">L’administration vous a écrit
        ({session.moi.messagesNonLus} message{session.moi.messagesNonLus > 1 ? 's' : ''} non lu{session.moi.messagesNonLus > 1 ? 's' : ''}) →</a></div>
    {/if}

    {/snippet}
        {#if section === 'profil'}
          <section class="carte">
            <h2>Profil</h2>
            <dl class="profil">
              <dt>Pseudo</dt><dd>{session.moi.pseudo}</dd>
              <dt>Inscrit le</dt><dd>{date(session.moi.inscritLe)}</dd>
              {#if session.moi.analysteOsint || session.moi.certification}
                <dt>Statut</dt>
                <dd>
                  {#if session.moi.analysteOsint}<span class="pastille accent">Analyste OSINT vérifié</span>{/if}
                  {#if session.moi.certification}<span class="pastille accent">{({ journalist: 'Journaliste', lawyer: 'Avocat', association: 'Association', trusted: 'Compte de confiance' })[session.moi.certification]} — compte certifié</span>{/if}
                </dd>
              {/if}
              {#if empreinte}
                <dt>Empreinte de sécurité</dt>
                <dd><code>{empreinte}</code><Info>Publiez-la sur votre site ou vos réseaux : une source peut ainsi vérifier que ses
                  messages vous sont bien destinés. Elle change si vous créez une nouvelle clé de messagerie.</Info></dd>
              {:else if session.moi.messagerieSources && session.moi.messagerieSources.statut !== 'admin'}
                <dt>Empreinte de sécurité</dt>
                <dd class="petit second">Visible une fois la messagerie déverrouillée (page Messages).</dd>
              {/if}
            </dl>
          </section>
        {#if !session.moi.superAdmin}
        <section class="carte">
          <h2>Code de compte spécial</h2>
          {#if session.moi.certification}
            <p class="second">Votre compte est certifié ({({ journalist: 'journaliste', lawyer: 'avocat', association: 'association', trusted: 'compte de confiance' })[session.moi.certification]}).
              Un autre code peut ajouter une catégorie.</p>
          {:else}
            <p class="second">Journaliste, avocat, association ou analyste OSINT&nbsp;? <a href="/contact?motif=certification">Demandez un code</a> pour certifier votre compte, puis saisissez-le ici.</p>
          {/if}
          <form class="ligne-code" onsubmit={(e) => { e.preventDefault(); void saisirCode(); }}>
            <input bind:value={codeSpecial} aria-label="Code de compte spécial" placeholder="XXXX-XXXX-XXXX" maxlength="20"
                   autocomplete="off" autocapitalize="characters" spellcheck="false" />
            <Manque raisons={[!codeSpecial.trim() && 'le code']}><button class="bouton" type="submit" disabled={occupe || !codeSpecial.trim()}>Valider le code</button></Manque>
          </form>
        </section>
        {/if}
        {:else if section === 'securite'}
        <section class="carte">
          <h2>Mot de passe<Info>Toutes vos sessions seront fermées, et vous recevrez un mail de confirmation.</Info></h2>
          <form onsubmit={(e) => { e.preventDefault(); void changerMotDePasse(); }}>
            <ChampMotDePasse id="ancien" libelle="Mot de passe actuel" bind:valeur={ancien} />
            <ChampMotDePasse id="nouveau" libelle="Nouveau mot de passe" bind:valeur={nouveau} nouveau />
            <ChampMotDePasse id="confirmation" libelle="Nouveau mot de passe, encore une fois" bind:valeur={confirmation} aide=" " nouveau />
            {#if confirmation && nouveau !== confirmation}<p class="aide erreur-texte">Les deux mots de passe ne sont pas identiques.</p>{/if}
            <Manque raisons={[!ancien && 'le mot de passe actuel', nouveau.length < 12 && 'un nouveau mot de passe de 12 caractères', nouveau.length >= 12 && nouveau !== confirmation && 'la même confirmation']}><button class="bouton" type="submit" disabled={occupe || !ancien || nouveau.length < 12 || nouveau !== confirmation}>Changer le mot de passe</button></Manque>
          </form>
        </section>
        <section class="carte" id="double-authentification">
          <h2>Double authentification</h2>
          {#if methodes.length}
            <ul class="methodes">
              {#each methodes as m (m.id)}
                <li>
                  <div>
                    <strong>{m.nom ?? (m.type === 'totp' ? 'Application d’authentification' : 'Clé de sécurité')}</strong>
                    <span class="pastille">{m.type === 'totp' ? 'Application' : 'Clé ou passkey'}</span>
                    <div class="petit discret">Ajoutée le {date(m.ajouteeLe)} · dernière utilisation : {date(m.derniereUtilisation)}</div>
                  </div>
                  <button class="bouton danger" onclick={() => { retrait = m; mdpRetrait = ''; codeRetrait = ''; }}>Retirer</button>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="second">{methodesChargees ? 'Aucune méthode active.' : 'Chargement…'}</p>
          {/if}

          {#if retrait}
            <form class="sous-carte" onsubmit={(e) => { e.preventDefault(); void retirer(false); }}>
              <h3>Retirer « {retrait.nom ?? (retrait.type === 'totp' ? 'Application' : 'Clé de sécurité')} »</h3>
              <ChampMotDePasse id="mdp-retrait" libelle="Mot de passe" bind:valeur={mdpRetrait} />
              <div class="champ">
                <label for="code-retrait">Code de l’application, ou un code de secours</label>
                <input id="code-retrait" class="mono" bind:value={codeRetrait} maxlength="20" autocomplete="one-time-code" />
              </div>
              <div class="boutons">
                <Manque raisons={[!mdpRetrait && 'votre mot de passe', !codeRetrait && 'le code']}><button class="bouton danger" type="submit" disabled={occupe || !mdpRetrait || !codeRetrait}>Retirer avec ce code</button></Manque>
                {#if methodes.some((m) => m.type === 'webauthn')}
                  <Manque raisons={[!mdpRetrait && 'votre mot de passe']}><button class="bouton" type="button" disabled={occupe || !mdpRetrait} onclick={() => retirer(true)}>Prouver avec une clé</button></Manque>
                {/if}
                <button class="bouton lien" type="button" onclick={() => (retrait = null)}>Annuler</button>
              </div>
            </form>
          {/if}

          {#if !ajout}
            <div class="boutons">
              {#if !methodes.some((m) => m.type === 'totp')}
                <button class="bouton" onclick={() => (ajout = 'totp')}>Ajouter une application d’authentification</button>
              {/if}
              <button class="bouton" onclick={() => (ajout = 'webauthn')}>Ajouter une clé de sécurité ou une passkey</button>
            </div>
          {:else if ajout === 'totp'}
            <div class="sous-carte">
              <h3>Application d’authentification</h3>
              {#if !totp}
                <p class="second petit">Par exemple Aegis, 2FAS, Proton Authenticator ou Google Authenticator.</p>
                <form onsubmit={(e) => { e.preventDefault(); void commencerTotp(); }}>
                  <ChampMotDePasse id="mdp-totp" libelle="Votre mot de passe, pour commencer" bind:valeur={mdpAjout} />
                  <div class="boutons">
                    <Manque raisons={[!mdpAjout && 'votre mot de passe']}><button class="bouton principal" type="submit" disabled={occupe || !mdpAjout}>Continuer</button></Manque>
                    <button class="bouton lien" type="button" onclick={annulerAjout}>Annuler</button>
                  </div>
                </form>
              {:else}
                <div class="qr">
                  <!-- QR code généré sur place à partir du lien otpauth:// (rien n'est chargé ailleurs) -->
                  <div class="qr-image" aria-label="QR code à scanner avec votre application" role="img">{@html totp.qr}</div>
                  <div>
                    <p class="second petit">Scannez ce code avec votre application, ou saisissez cette clé à la main :</p>
                    <code class="secret">{totp.secret.match(/.{1,4}/g)?.join(' ')}</code>
                  </div>
                </div>
                <form onsubmit={(e) => { e.preventDefault(); void confirmerTotp(); }}>
                  <div class="champ">
                    <label for="code-totp">Code affiché par l’application</label>
                    <input id="code-totp" class="code-saisie" bind:value={codeTotp} inputmode="numeric" maxlength="7" required autocomplete="one-time-code" />
                  </div>
                  <div class="champ">
                    <label for="nom-totp">Nom (facultatif)</label>
                    <input id="nom-totp" bind:value={nomMethode} maxlength="40" placeholder="Téléphone perso" />
                  </div>
                  <div class="boutons">
                    <Manque raisons={[codeTotp.replace(/\s/g, '').length !== 6 && 'le code à 6 chiffres']}><button class="bouton principal" type="submit" disabled={occupe || codeTotp.replace(/\s/g, '').length !== 6}>Activer</button></Manque>
                    <button class="bouton lien" type="button" onclick={annulerAjout}>Annuler</button>
                  </div>
                </form>
              {/if}
            </div>
          {:else}
            <form class="sous-carte" onsubmit={(e) => { e.preventDefault(); void ajouterCle(); }}>
              <h3>Clé de sécurité ou passkey</h3>
              <p class="second petit">Une clé physique (YubiKey, SoloKey…) ou une passkey de votre téléphone ou ordinateur.</p>
              <ChampMotDePasse id="mdp-cle" libelle="Votre mot de passe" bind:valeur={mdpAjout} />
              <div class="champ">
                <label for="nom-cle">Nom (facultatif)</label>
                <input id="nom-cle" bind:value={nomMethode} maxlength="40" placeholder="YubiKey bleue" />
              </div>
              <div class="boutons">
                <Manque raisons={[!mdpAjout && 'votre mot de passe']}><button class="bouton principal" type="submit" disabled={occupe || !mdpAjout}>Enregistrer la clé</button></Manque>
                <button class="bouton lien" type="button" onclick={annulerAjout}>Annuler</button>
              </div>
            </form>
          {/if}
        </section>
        <section class="carte">
          <h2>Codes de secours</h2>
          {#if nouveauxCodes.length}
            <CodesSecours codes={nouveauxCodes} pseudo={session.moi.pseudo} suite={async () => { nouveauxCodes = []; await rafraichir(); }} />
          {:else}
            <p class="second">Il vous reste <strong>{session.moi.codesSecoursRestants}</strong> code{session.moi.codesSecoursRestants > 1 ? 's' : ''} sur 10.
              En créer de nouveaux annule les anciens.</p>
            <form onsubmit={(e) => { e.preventDefault(); void regenererCodes(); }}>
              <ChampMotDePasse id="mdp-codes" libelle="Mot de passe" bind:valeur={mdpCodes} />
              <Manque raisons={[!mdpCodes && 'votre mot de passe']}><button class="bouton" type="submit" disabled={occupe || !mdpCodes}>Créer 10 nouveaux codes</button></Manque>
            </form>
          {/if}
        </section>
        {:else if section === 'appareils'}
          <section class="carte">
            <h2>Appareils connectés<Info>Les appareils où votre compte est ouvert. Une session inactive pendant 7 jours se ferme toute seule.</Info></h2>
            {#if erreurSessions}<p class="message erreur petit">La liste des appareils n’a pas pu être chargée. Rechargez la page.</p>{/if}
            <ul class="methodes">
              {#each sessions as s (s.id)}
                <li>
                  <div>
                    <strong>{s.appareil}</strong>
                    {#if s.actuelle}<span class="pastille accent">Cet appareil</span>{/if}
                    <div class="petit discret">Connecté le {date(s.connecteLe)} · dernière activité : {quand(s.derniereActivite)}</div>
                  </div>
                  {#if !s.actuelle}<button class="bouton danger" onclick={() => fermerSession(s.id)} disabled={occupe}>Fermer</button>{/if}
                </li>
              {/each}
            </ul>
          <div class="ligne">
            <div>
              <strong>Se déconnecter partout</strong><Info>Ferme toutes vos sessions, sur tous vos appareils.</Info>
            </div>
            <button class="bouton danger" onclick={sortirPartout} disabled={occupe}>Tout fermer</button>
          </div>
          </section>
        {:else if section === 'relecture'}
        <section class="carte">
          <h2>Relecture</h2>
          <div class="ligne">
            <div>
              <strong>Être convoqué pour relire</strong>
              <span class="statut" class:actif={session.moi.convocations}>{session.moi.convocations ? 'Oui' : 'Non'}</span>
              <Info>Vous voulez seulement envoyer des vidéos ? Coupez : vous ne serez plus convoqué, ni pour relire, ni au jury.
                Les convocations en attente sont annulées.</Info>
            </div>
            <button class="bouton" onclick={changerConvocations} disabled={occupe}>
              {session.moi.convocations ? 'Ne plus me convoquer' : 'Me convoquer à nouveau'}
            </button>
          </div>
        </section>
        {:else if section === 'mails'}
        <section class="carte">
          <h2>Mails<Info>Vidéos envoyées avec votre compte : le mail « floutage prêt à vérifier » est toujours envoyé. Aucun mail
            ne dit de quelle vidéo il s’agit.</Info></h2>
          <div class="ligne">
            <div>
              <strong>Mail de convocation</strong>
              <span class="statut" class:actif={mailConvocations}>{mailConvocations ? 'Activé' : 'Coupé'}</span>
              <Info>Au plus un par jour, sans rien dire de la vidéo.</Info>
            </div>
            <button class="bouton" onclick={changerMails} disabled={occupe}>
              {mailConvocations ? 'Couper' : 'Activer'}
            </button>
          </div>
          <hr />
          {#each PREFS_VIDEOS as p (p.cle)}
            <div class="ligne">
              <div>
                <strong>{p.titre}</strong>
                <span class="statut" class:actif={prefs[p.cle]}>{prefs[p.cle] ? 'Activé' : 'Coupé'}</span>
              </div>
              <button class="bouton" onclick={() => changerPref(p.cle)} disabled={occupe}>{prefs[p.cle] ? 'Couper' : 'Activer'}</button>
            </div>
          {/each}
          {#if session.moi.messagerieSources && session.moi.messagerieSources.statut !== 'admin'}
            <hr />
            <div class="ligne">
              <div>
                <strong>Une source m’a répondu</strong><Info>Au plus un mail par jour, sans rien dire de la vidéo.</Info>
                <span class="statut" class:actif={prefs.reponseSource}>{prefs.reponseSource ? 'Activé' : 'Coupé'}</span>
              </div>
              <button class="bouton" onclick={() => changerPref('reponseSource')} disabled={occupe}>{prefs.reponseSource ? 'Couper' : 'Activer'}</button>
            </div>
          {/if}
        </section>
        {:else if section === 'fermer' && !session.moi.superAdmin}
      <section class="carte" id="fermer">
        <h2>Fermer mon compte</h2>
        {#if !fermeture}
          <p class="second">Accès coupés tout de suite, tout effacé après 30 jours. Se reconnecter d’ici là annule.</p>
          <button class="bouton danger" onclick={() => (fermeture = true)}>Fermer mon compte…</button>
        {:else}
          <p class="second">Restent, sans lien avec vous : vos votes et, pour un analyste, ses notes (« compte supprimé »).
            <Info>Les votes comptent toujours, sinon des décisions déjà prises changeraient : retirez d’abord les notes que vous ne
            voulez pas laisser. Les journaux de connexion exigés par la loi sont gardés un an, comme pour tout le monde.</Info></p>
          <ChampMotDePasse id="mdp-fermeture" libelle="Mot de passe" bind:valeur={mdpFermeture} />
          {#if methodes.length && (methodes.some((m) => m.type === 'totp') || parCode)}
            <div class="champ">
              <label for="code-fermeture">{methodes.some((m) => m.type === 'totp') ? 'Code de votre application, ou un code de secours' : 'Un code de secours'}</label>
              <input id="code-fermeture" class="mono" bind:value={codeFermeture} maxlength="20" autocomplete="one-time-code" />
            </div>
          {/if}
          <label class="case"><input type="checkbox" bind:checked={confirmeFermeture} /> Je veux fermer mon compte.</label>
          <div class="boutons">
            {#if !methodes.length || codeFermeture.trim()}
              <button class="bouton danger" onclick={() => fermer(false)} disabled={occupe || !mdpFermeture || !confirmeFermeture}>
                Fermer mon compte</button>
            {:else if methodes.some((m) => m.type === 'webauthn')}
              <button class="bouton danger" onclick={() => fermer(true)} disabled={occupe || !mdpFermeture || !confirmeFermeture}>
                Fermer avec ma clé de sécurité</button>
            {/if}
            <button class="bouton" onclick={() => { fermeture = false; mdpFermeture = ''; codeFermeture = ''; confirmeFermeture = false; parCode = false; }}>
              Annuler</button>
          </div>
          {#if methodes.length && !methodes.some((m) => m.type === 'totp') && !parCode}
            <p class="aide">Pas de clé sous la main ? <button class="bouton lien" onclick={() => (parCode = true)}>Utiliser un code de secours</button></p>
          {/if}
        {/if}
      </section>
        {/if}
  </CadreCompte>
{/if}

<style>
  .profil { display: grid; grid-template-columns: max-content 1fr; gap: 0.5rem 1.25rem; margin: 0; }
  .profil dt { color: var(--texte-2); }
  .profil dd { margin: 0; display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .methodes { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; gap: 0.75rem; }
  .methodes li, .ligne { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
  /* Le texte passe sur plusieurs lignes plutôt que de pousser le bouton dessous ; sur téléphone, le bouton passe à la ligne. */
  .ligne { flex-wrap: nowrap; }
  .ligne > div:first-child { flex: 1 1 auto; min-width: 0; }
  .ligne > .bouton { flex: 0 0 auto; }
  .ligne + .ligne { margin-top: 0.875rem; }
  .ligne-code { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .ligne-code input { flex: 1 1 12rem; max-width: 18rem; text-transform: uppercase; }
  @media (max-width: 30rem) { .ligne { flex-wrap: wrap; } }
  .methodes li { padding: 0.75rem 0; border-bottom: 1px solid var(--trait); }
  .methodes .pastille { margin-left: 0.5rem; }
  .sous-carte { margin-top: 1rem; padding: 1.25rem; background: var(--surface-2); border-radius: var(--rayon); }
  .qr { display: flex; gap: 1.25rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
  .qr-image { width: 11rem; background: #fff; padding: 0.5rem; border-radius: var(--rayon); }
  .qr-image :global(svg) { display: block; width: 100%; height: auto; }
  .secret { display: inline-block; font-size: 1rem; letter-spacing: 0.06em; background: var(--surface); padding: 0.375rem 0.625rem; border-radius: var(--rayon); word-break: break-all; }
  h2 { font-size: 1.1875rem; }
  .erreur-texte { color: var(--danger); margin-top: -0.5rem; }
  .statut { display: inline-block; margin-left: 0.5rem; font-size: 0.75rem; font-weight: 700; padding: 0.125rem 0.5rem;
            border-radius: 999px; color: var(--danger); background: var(--danger-doux);
            border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent); }
  .statut.actif { color: var(--succes); background: var(--succes-doux); border-color: color-mix(in srgb, var(--succes) 35%, transparent); }
</style>
