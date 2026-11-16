<script lang="ts">
  // Suivi d'une vidéo par sa source : état, version floutée, vérification et retouche du floutage,
  // retrait. Deux façons d'y accéder : le code de 12 mots (envoi anonyme, page /suivi) ou le compte
  // qui l'a envoyée (« Mes vidéos ») ; dans ce cas le retrait demande le mot de passe (+ second facteur).
  import Manque from '#lib/composants/Manque.svelte';
  import Info from '#lib/composants/Info.svelte';
  import { clesAdmin } from '#lib/cles-admin.ts';
  import { secretDuCompte } from '#lib/motdepasse.ts';
  import { confirmer } from '#lib/confirmer.svelte.ts';
  import MessagerieSource from '#lib/composants/MessagerieSource.svelte';
  import RattacherCompte from '#lib/composants/RattacherCompte.svelte';
  import { startAuthentication } from '@simplewebauthn/browser';
  import { cleOriginalBrute, deriverSecrets, entropieVideo, envelopper, lirePhrase, ouvrirCode, phraseDepuisEntropie, type CleOuverte, type PourCompte } from 'argos-navigateur';
  import DeverrouillerMessagerie from '#lib/composants/DeverrouillerMessagerie.svelte';
  import { cleMessagerie } from '#lib/session.svelte.ts';
  import { get } from '#lib/api.ts';
  import { onDestroy, onMount } from 'svelte';
  import { post } from '#lib/api.ts';
  import ChampMotDePasse from '#lib/composants/ChampMotDePasse.svelte';
  import LecteurVideo from '#lib/composants/LecteurVideo.svelte';
  import RetoucheFloutage, { type Piste, type Zone } from '#lib/composants/RetoucheFloutage.svelte';
  import { appelSource, videosDuCode } from '#lib/envoi.ts';
  import { message } from '#lib/erreurs.ts';
  import { session } from '#lib/session.svelte.ts';

  // Avec le code, `entropie` (la phrase) sert aussi à autoriser la transmission de l'original plus tard.
  type Cible = { jeton: string; cleCopie: string; entropie?: Uint8Array } | { video: string };
  let { cible, introuvable }: { cible: Cible; introuvable?: () => void } = $props();

  interface Suivi {
    pseudonyme: string; etat: string; libelle: string; envoyeeLe: string; decideeLe?: string; retireeLe?: string;
    avancement?: number; fileAttente?: number; raison?: string; echeance?: string; retouchesRestantes?: number;
    ressemblance?: { video: string; pseudonyme: string | null };
    transmission?: { proposee: boolean; autorisee: boolean; autoriseeLe: string | null; empreinte?: string;
                     transmissions: { le: string; destinataire: string }[]; telechargements?: string[] };
  }
  const DESTINATAIRES: Record<string, string> = { association: 'une association', lawyer: 'un avocat', journalist: 'un journaliste', other: 'un autre destinataire' };
  let motsAutorisation = $state('');
  let autoriserOuvert = $state(false);
  let retoucheOuverte = $state(false);   // vérification : outil de retouche à la place du lecteur

  // Avec le code : sans cookie, le jeton dans le corps. Depuis le compte : la session, l'identifiant de la vidéo.
  const parCompte = $derived('video' in cible);
  const ident = $derived('video' in cible ? { video: cible.video } : { jeton: cible.jeton });
  const appel = <T,>(chemin: string, corps: object = {}) =>
    parCompte ? post<T>(chemin, { ...ident, ...corps }) : appelSource<T>(chemin, { ...ident, ...corps });

  let masques = $state<{ retouchable: boolean; pistes: Piste[]; retouche: { retirees: number[]; zones: Zone[] };
                         retouchesRestantes: number } | null>(null);
  let suivi = $state<Suivi | null>(null);
  let erreur = $state('');
  let info = $state('');
  let confirmation = $state('');
  let motDePasse = $state('');
  let code = $state('');
  let parCode = $state(false);
  let retirer = $state(false);
  let occupe = $state(false);
  let minuteur: ReturnType<typeof setInterval> | undefined;
  let verifieLe = $state(0);
  let maintenant = $state(Date.now());
  const horloge = setInterval(() => (maintenant = Date.now()), 1000);
  const facteurs = $derived(session.moi?.doubleAuthentification ?? []);

  const PHRASES: Record<string, string> = {
    envoi_en_cours: 'L’envoi n’est pas terminé.',
    floutage_en_cours: 'Floutage en cours. Cette page se met à jour toute seule.',
    echec: 'Le traitement a échoué.',
    a_verifier: 'Vérifiez le floutage : personne ne la voit avant votre accord.',
    en_relecture: 'Des relecteurs tirés au sort la vérifient.',
    devant_le_jury: 'Vote serré : un jury la réexamine.',
    en_attente_analyse: 'Validée par les relecteurs. Des analystes cherchent le lieu ou la date avant de la publier.',
    publiee: 'Elle est publiée sur la carte.',
    rejetee: 'Pour les relecteurs, elle ne montre pas ce qui est annoncé.',
    en_debat: 'Pas de majorité nette : elle reste « en débat », hors de la carte.',
    sans_decision: 'Pas assez de relecteurs n’ont répondu à temps.',
    retiree: 'Vous l’avez retirée.',
  };
  const date = (d: string) => new Date(d).toLocaleString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  async function charger() {
    suivi = await appel<Suivi>('/suivi');
    verifieLe = Date.now();
    masques = suivi.etat === 'a_verifier' ? await appel<NonNullable<typeof masques>>('/suivi/masques').catch(() => null) : null;
    clearInterval(minuteur);
    if (suivi.etat === 'floutage_en_cours') minuteur = setInterval(() => void charger().catch(() => {}), 10_000);
  }
  onMount(() => {
    charger().catch((x) => {
      if (message(x) === 'Introuvable.' && introuvable) introuvable();
      else erreur = message(x);
    });
  });
  onDestroy(() => { clearInterval(minuteur); clearInterval(horloge); });

  async function lien(qualite: 'apercu' | 'complete') {
    return (await appel<{ lien: string }>('/suivi/apercu', { qualite })).lien;
  }

  async function valider() {
    if (!(await confirmer({ titre: 'Envoyer la vidéo en relecture ?', texte: 'Elle partira telle que floutée : vous ne pourrez plus retoucher le floutage.',
                            oui: 'Oui, envoyer en relecture', ton: 'valider' }))) return;
    erreur = ''; info = '';
    try {
      await appel('/suivi/valider');
      info = 'C’est parti : la vidéo est en relecture.';
      await charger();
    } catch (x) { erreur = message(x); }
  }

  async function retrait(avecCle = false) {
    erreur = ''; info = ''; occupe = true;
    try {
      if (parCompte) {
        let preuve: { code?: string; cle?: unknown } = {};
        if (facteurs.length) {
          if (avecCle) {
            const { options } = await post<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/2fa/cle/defi');
            preuve = { cle: await startAuthentication({ optionsJSON: options }) };
          } else {
            preuve = { code: code.replace(/\s/g, '') };
          }
        }
        await appel('/suivi/retirer', { motDePasse: await secretDuCompte(motDePasse), ...preuve });
      } else {
        await appel('/suivi/retirer', { confirmation });
      }
      // Après un retrait, plus rien ne relie le code ni le compte à la vidéo (B2) : on n'interroge plus le serveur.
      info = 'Vidéo retirée : ses fichiers sont effacés, et ce code ne la désigne plus.';
      retirer = false; motDePasse = ''; code = '';
      if (suivi) suivi = { ...suivi, etat: 'retiree', libelle: 'Retirée par vous' };
    } catch (x) { erreur = message(x); } finally { occupe = false; }
  }

  // Envoi avec un compte : le code, rouvert ici avec la clé du compte.
  let motsDuCompte = $state<string[] | null>(null);
  let codeDemande = $state(false);
  let sansCode = $state(false);
  async function afficherCode(cle: CleOuverte) {
    erreur = '';
    try {
      const { code } = await appel<{ code: PourCompte | null }>('/suivi/code');
      if (!code) { sansCode = true; return; }
      motsDuCompte = await phraseDepuisEntropie(await ouvrirCode(code, cle));
    } catch (x) { erreur = message(x); }
  }
  const demanderCode = () => { codeDemande = true; if (cleMessagerie.ouverte) void afficherCode(cleMessagerie.ouverte); };

  /** Autoriser la transmission de l'original : l'enveloppe est faite ici, à partir de la phrase. */
  async function autoriser() {
    erreur = ''; info = ''; occupe = true;
    try {
      let entropie = 'entropie' in cible ? cible.entropie : undefined;
      let parMots = false;
      if (!entropie) {
        const lu = await lirePhrase(motsAutorisation);
        if (!lu.ok) throw new Error('Code de 12 mots illisible : vérifiez les mots.');
        // Le code peut servir à plusieurs vidéos : on retrouve le secret de celle-ci.
        const videos = await videosDuCode<{ position: number; pseudonyme: string }>(lu.entropie).catch(() => []);
        const v = videos.find((x) => x.pseudonyme === suivi!.pseudonyme);
        if (!v) throw new Error('Ce code n’est pas celui de cette vidéo.');
        entropie = await entropieVideo(lu.entropie, v.position); parMots = true;
      }
      const cles = await clesAdmin();   // épinglées dans le code (A7)
      const enveloppe = await envelopper(await cleOriginalBrute(entropie), cles, suivi!.transmission!.empreinte!);
      if (parMots) {
        // Depuis le compte : le code doit être celui de CETTE vidéo (sinon la clé n'ouvrirait rien).
        const jeton = (await deriverSecrets(entropie)).jetonSuivi;
        const autre = await appelSource<{ pseudonyme: string }>('/suivi', { jeton }).catch(() => null);
        if (autre?.pseudonyme !== suivi!.pseudonyme) throw new Error('Ce code n’est pas celui de cette vidéo.');
        await appelSource('/suivi/autoriser', { jeton, enveloppe });
      } else {
        await appel('/suivi/autoriser', { enveloppe });
      }
      info = 'Autorisation enregistrée : l’administration pourra transmettre l’original si elle le juge utile.';
      autoriserOuvert = false; motsAutorisation = '';
      await charger();
    } catch (x) { erreur = x instanceof Error && !('code' in x) ? x.message : message(x); } finally { occupe = false; }
  }

  async function ouvrirAutorisation() {
    if (!('entropie' in cible && cible.entropie)) { autoriserOuvert = true; return; }
    if (await confirmer({ titre: 'Autoriser la transmission de l’original ?',
                          texte: 'L’original non flouté pourra être transmis à une association, un avocat ou un journaliste, si l’administration le juge utile. Vous pourrez retirer cette autorisation à tout moment.',
                          oui: 'J’autorise la transmission', ton: 'valider' })) await autoriser();
  }

  async function retirerAutorisation() {
    if (!(await confirmer({ titre: 'Retirer votre autorisation ?', texte: 'Les transmissions déjà faites restent ; aucune autre ne sera possible.',
                            oui: 'Retirer mon autorisation', ton: 'danger' }))) return;
    erreur = ''; info = '';
    try {
      await appel('/suivi/autorisation/retirer');
      info = 'Autorisation retirée.';
      await charger();
    } catch (x) { erreur = message(x); }
  }

  async function retoucher(retirees: number[], zones: Zone[]) {
    await appel('/suivi/retoucher', { ...('cleCopie' in cible ? { cleCopie: cible.cleCopie } : {}), retirees, zones });
    retoucheOuverte = false;
    info = 'Retouche envoyée : la vidéo est floutée à nouveau. Cette page se met à jour toute seule.';
    await charger();
  }
</script>

{#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
{#if info}<div class="message succes" role="status">{info}</div>{/if}

{#if suivi}
  <div class="carte">
    <div class="tete">
      <div>
        <span class="petit discret">Vidéo</span>
        <h2>{suivi.pseudonyme}</h2>
      </div>
      <span class="pastille accent">{suivi.libelle}</span>
    </div>
    <p class="second">{PHRASES[suivi.etat] ?? ''}</p>
    {#if suivi.etat === 'floutage_en_cours'}
      <div class="progression en-cours" role="progressbar" aria-valuenow={suivi.avancement ?? 0} aria-valuemin="0" aria-valuemax="100">
        <span style:width="{suivi.fileAttente ? 0 : (suivi.avancement ?? 0)}%"></span>
      </div>
      <p class="petit second"><span class="point-actif" aria-hidden="true"></span>
        {#if suivi.fileAttente}
          En file d’attente : {suivi.fileAttente === 1 ? 'votre vidéo est la prochaine à être traitée'
            : `${suivi.fileAttente - 1} vidéo${suivi.fileAttente > 2 ? 's' : ''} avant la vôtre`}.
        {:else}
          Floutage en cours : {suivi.avancement ?? 0} %
        {/if}
        <span class="discret"> · vérifié il y a {Math.max(0, Math.round((maintenant - verifieLe) / 1000))} s</span>
        <Info>Une minute de vidéo demande environ une minute de traitement. Vous pouvez fermer cette page et revenir plus
          tard{parCompte ? '' : ' avec votre code'}.</Info></p>
    {/if}
    {#if suivi.raison}<div class="message erreur">{suivi.raison} Vous pouvez envoyer la vidéo à nouveau.</div>{/if}
    {#if suivi.ressemblance}
      <div class="message">Cette vidéo ressemble à une vidéo déjà publiée : <a href="/videos/{suivi.ressemblance.video}">{suivi.ressemblance.pseudonyme ?? 'voir la fiche'}</a>.</div>
    {/if}
    <p class="petit discret">Envoyée le {date(suivi.envoyeeLe)}{#if suivi.decideeLe}{' · '}décision le {date(suivi.decideeLe)}{/if}</p>
  </div>

  {#if suivi.etat === 'a_verifier'}
    <!-- Vérification : un seul encart (la vidéo floutée, puis valider ou retoucher). -->
    <section class="carte">
      {#if !retoucheOuverte}<h2>Vérifier le floutage</h2>{/if}
      {#if retoucheOuverte && masques?.retouchable}
        {#key suivi.envoyeeLe + (masques.retouchesRestantes ?? 0)}
          <RetoucheFloutage obtenirLien={() => lien('complete')} pistes={masques.pistes} retouche={masques.retouche}
                            retouchesRestantes={masques.retouchesRestantes} appliquer={retoucher} />
        {/key}
        <div class="boutons"><button class="bouton lien" onclick={() => (retoucheOuverte = false)}>Fermer la retouche</button></div>
      {:else}
        <LecteurVideo obtenirLien={lien} direct />
        <p class="second">Regardez la vidéo jusqu’au bout. Un visage reconnaissable ? Un détail qui vous identifie ?</p>
        {#if suivi.echeance}<p class="petit discret">Sans réponse, la vidéo partira en relecture le {date(suivi.echeance)}.</p>{/if}
        <div class="boutons">
          <button class="bouton valider" onclick={valider}>Le floutage me convient : envoyer en relecture</button>
          {#if masques?.retouchable}
            <button class="bouton" onclick={() => (retoucheOuverte = true)}>Retoucher le floutage</button>
          {/if}
        </div>
        {#if masques && !masques.retouchable}
          <p class="petit discret">La retouche n’est plus possible pour cette vidéo (copie de travail expirée).</p>
        {/if}
      {/if}
    </section>
  {:else if ['en_relecture', 'devant_le_jury', 'en_attente_analyse', 'publiee', 'rejetee', 'en_debat', 'sans_decision'].includes(suivi.etat)}
    <section>
      <h2>La version floutée</h2>
      <LecteurVideo obtenirLien={lien} direct />
    </section>
  {/if}

  <!-- Pas pendant le floutage ni sa vérification : la personne vient d'envoyer (la case existe à l'envoi). -->
  {#if suivi.transmission?.proposee && !['retiree', 'retiree_motif_legal', 'floutage_en_cours', 'a_verifier'].includes(suivi.etat)}
    <div class="carte">
      <h2>Transmission de l’original</h2>
      {#if suivi.transmission.autorisee}
        <p class="second">Transmission autorisée{#if suivi.transmission.autoriseeLe} le {date(suivi.transmission.autoriseeLe)}{/if}.</p>
        <button class="bouton" onclick={retirerAutorisation}>Retirer mon autorisation</button>
      {:else}
        <p class="second">À une association, un avocat ou un journaliste, si l’administration le juge utile.<Info>L’original reste
          chiffré : seule l’administration peut l’ouvrir. Sur décision de justice, Argos Veille pourrait devoir le remettre.</Info></p>
        {#if !autoriserOuvert}
          <!-- Code déjà connu (suivi ouvert avec les 12 mots) : une simple confirmation ; sinon, formulaire pour le retaper. -->
          <Manque raisons={[!suivi.transmission.empreinte && 'la fin du traitement de l’original']}><button class="bouton" onclick={ouvrirAutorisation} disabled={!suivi.transmission.empreinte || occupe}>Autoriser la transmission</button></Manque>
        {:else}
          {#if !('entropie' in cible && cible.entropie)}
            <div class="champ">
              <label for="mots-autorisation">Votre code de 12 mots (la clé de l’original)<Info>Seul ce code peut ouvrir l’original :
                sans lui, l’autorisation est impossible.</Info></label>
              <textarea id="mots-autorisation" bind:value={motsAutorisation} rows="2" autocomplete="off" autocapitalize="none" spellcheck="false"></textarea>
            </div>
          {/if}
          <div class="boutons">
            <button class="bouton principal" onclick={autoriser} disabled={occupe}>J’autorise la transmission</button>
            <button class="bouton lien" onclick={() => (autoriserOuvert = false)}>Annuler</button>
          </div>
        {/if}
      {/if}
      {#if suivi.transmission.telechargements?.length}
        <ul class="transmissions">
          {#each suivi.transmission.telechargements as d (d)}<li>Téléchargé par l’administration le {date(d)}.</li>{/each}
        </ul>
      {/if}
      {#if suivi.transmission.transmissions.length}
        <ul class="transmissions">
          {#each suivi.transmission.transmissions as t (t.le)}<li>Transmis le {date(t.le)} à {DESTINATAIRES[t.destinataire] ?? 'un destinataire'}.</li>{/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if parCompte && !['retiree', 'retiree_motif_legal', 'envoi_en_cours'].includes(suivi.etat)}
    <div class="carte">
      <h2>Mon code</h2>
      {#if motsDuCompte}
        <ol class="mots-code">{#each motsDuCompte as m, i (i)}<li><span class="n">{i + 1}</span> {m}</li>{/each}</ol>
      {:else if sansCode}
        <p class="second">Le code de cette vidéo n’est pas gardé avec votre compte.</p>
      {:else if codeDemande && !cleMessagerie.ouverte}
        <DeverrouillerMessagerie ouverte={afficherCode} />
      {:else}
        <button class="bouton" onclick={demanderCode}>Afficher mon code</button>
      {/if}
    </div>
  {/if}

  {#if !['retiree', 'retiree_motif_legal', 'envoi_en_cours', 'echec'].includes(suivi.etat)}
    <MessagerieSource {appel} {parCompte} entropie={'entropie' in cible ? cible.entropie : undefined}
                      recente={['floutage_en_cours', 'a_verifier'].includes(suivi.etat)} />
  {/if}

  {#if !('video' in cible) && !['retiree', 'retiree_motif_legal', 'envoi_en_cours', 'echec'].includes(suivi.etat)}
    <RattacherCompte jeton={cible.jeton} cleCopie={cible.cleCopie} entropie={cible.entropie} />
  {/if}

  {#if suivi.etat !== 'retiree' && suivi.etat !== 'retiree_motif_legal'}
    <div class="carte">
      <h2>Retirer la vidéo</h2>
      {#if !retirer}
        <p class="second">À tout moment. Définitif : ses fichiers sont effacés.</p>
        <button class="bouton danger" onclick={() => (retirer = true)}>Retirer ma vidéo…</button>
      {:else}
        {#if parCompte}
          <p class="second">C’est définitif : ses fichiers sont effacés. Confirmez avec votre mot de passe{facteurs.length ? ' et votre double authentification' : ''}.</p>
          <ChampMotDePasse id="mdp-retrait" libelle="Mot de passe" bind:valeur={motDePasse} />
          {#if facteurs.includes('totp') || parCode}
            <div class="champ">
              <label for="code-retrait">{facteurs.includes('totp') ? 'Code de votre application, ou un code de secours' : 'Un code de secours'}</label>
              <input id="code-retrait" class="mono" bind:value={code} maxlength="20" autocomplete="one-time-code" />
            </div>
          {/if}
          <div class="boutons">
            {#if !facteurs.length || code.trim()}
              <button class="bouton danger" onclick={() => retrait(false)} disabled={occupe || !motDePasse}>Retirer définitivement</button>
            {:else if facteurs.includes('webauthn')}
              <button class="bouton danger" onclick={() => retrait(true)} disabled={occupe || !motDePasse}>Retirer avec ma clé de sécurité</button>
            {/if}
            <button class="bouton lien" type="button" onclick={() => { retirer = false; motDePasse = ''; code = ''; parCode = false; }}>Annuler</button>
          </div>
          {#if facteurs.length && !facteurs.includes('totp') && !parCode}
            <p class="aide">Pas de clé sous la main ? <button class="bouton lien" onclick={() => (parCode = true)}>Utiliser un code de secours</button></p>
          {/if}
        {:else}
        <form onsubmit={(e) => { e.preventDefault(); void retrait(); }}>
          <div class="champ">
            <label for="confirmation">Pour confirmer, retapez le nom de la vidéo : <strong>{suivi.pseudonyme}</strong></label>
            <input id="confirmation" bind:value={confirmation} autocomplete="off" />
          </div>
          <div class="boutons">
            <Manque raisons={[!confirmation.trim() && 'le nom de la vidéo, retapé']}><button class="bouton danger" type="submit" disabled={!confirmation.trim()}>Retirer définitivement</button></Manque>
            <button class="bouton lien" type="button" onclick={() => (retirer = false)}>Annuler</button>
          </div>
        </form>
        {/if}
      {/if}
    </div>
  {/if}
{/if}

<style>
  .mots-code { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; list-style: none; padding: 1rem; margin: 0;
               background: var(--surface-2); border-radius: var(--rayon); font-family: var(--police-mono); }
  @media (max-width: 34rem) { .mots-code { grid-template-columns: repeat(2, 1fr); } }
  .mots-code .n { color: var(--texte-3); font-size: 0.8125rem; display: inline-block; min-width: 1.5rem; }
  .tete { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
  .tete h2 { margin: 0; }
  section { margin: 1.5rem 0; }
  .progression { margin-top: 0.75rem; }
  .transmissions { margin: 0.75rem 0 0; padding-left: 1.25rem; color: var(--texte-2); }
</style>
