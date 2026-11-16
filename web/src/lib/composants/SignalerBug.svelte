<script lang="ts">
  // Formulaire « Signaler un bug ». La télémétrie est prise à l'ouverture (et reprise juste avant
  // l'envoi), montrée en entier, et ne part que si la personne clique sur « Envoyer ».
  // Pages des sources (envoi, suivi) : ni pseudo, ni capture d'écran, ni thèmes liés aux comptes.
  import Manque from '#lib/composants/Manque.svelte';
  import { page } from '$app/state';
  import { get, post } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';
  import { session } from '#lib/session.svelte.ts';
  import { prendre, type Telemetrie } from '#lib/telemetrie.ts';

  interface Theme { cle: string; libelle: string; pourLesSources: boolean; urgent: boolean; precis: { cle: string; libelle: string }[] }

  let dialogue: HTMLDialogElement | undefined = $state();
  let themes = $state<Theme[]>([]);
  let theme = $state('autre');
  let precis = $state('autre');
  let description = $state('');
  let joindreTelemetrie = $state(true);
  let joindrePseudo = $state(true);
  let capture = $state<string | null>(null);
  let masque = $state(false);           // dialogue caché le temps de la capture
  let telemetrie = $state<Telemetrie | null>(null);
  let erreur = $state('');
  let envoye = $state<string | null>(null);
  let envoi = $state(false);

  const routeId = $derived(page.route.id ?? 'inconnue');
  const pageSource = $derived(/^\/(envoyer|suivi)(\/|$)/.test(routeId));
  const proposes = $derived(themes.filter((t) => !pageSource || t.pourLesSources));
  const themeChoisi = $derived(themes.find((t) => t.cle === theme));

  /** Thème proposé selon la page d'où l'on signale. */
  function preremplir() {
    const r = routeId;
    const [t, p] = r.startsWith('/inscription') ? ['compte', 'inscription']
      : r.startsWith('/connexion') ? ['compte', 'connexion']
      : r.startsWith('/mot-de-passe') || r.startsWith('/recuperation') ? ['compte', 'mot_de_passe']
      : r.startsWith('/compte') ? ['compte', 'autre']
      : r.startsWith('/relecture') ? ['relecture', 'autre']
      : r.startsWith('/envoyer') ? ['envoi', 'autre']
      : r.startsWith('/suivi') ? ['suivi', 'autre']
      : r.startsWith('/carte') ? ['public', 'carte']
      : ['autre', 'autre'];
    theme = t!;
    precis = p!;
  }

  function etat() {
    const moi = session.moi;
    return {
      connecte: !!moi,
      roles: moi ? ['relecteur', ...(moi.analysteOsint ? ['analyste_osint'] : [])] : [],
      doubleAuthentification: moi?.doubleAuthentification ?? [],
    };
  }

  export async function ouvrir() {
    erreur = '';
    envoye = null;
    description = '';
    capture = null;
    joindreTelemetrie = true;
    joindrePseudo = !!session.moi && !pageSource;
    preremplir();
    telemetrie = pageSource ? null : prendre(etat());
    dialogue?.showModal();
    if (!themes.length) {
      try {
        themes = (await get<{ themes: Theme[] }>('/bugs/themes')).themes;
      } catch (e) {
        erreur = message(e);
      }
    }
  }

  function changerTheme() {
    precis = themeChoisi?.precis[0]?.cle ?? 'autre';
  }

  /** Capture de l'onglet, avec l'accord du navigateur ; le formulaire est caché le temps de la prise. */
  async function capturer() {
    erreur = '';
    let flux: MediaStream | null = null;
    try {
      masque = true;
      flux = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false,
                                                            preferCurrentTab: true } as DisplayMediaStreamOptions);
      const video = document.createElement('video');
      video.srcObject = flux;
      video.muted = true;
      await video.play();
      await new Promise((ok) => setTimeout(ok, 300));
      const echelle = Math.min(1, 1600 / video.videoWidth);
      const toile = document.createElement('canvas');
      toile.width = Math.round(video.videoWidth * echelle);
      toile.height = Math.round(video.videoHeight * echelle);
      toile.getContext('2d')!.drawImage(video, 0, 0, toile.width, toile.height);
      capture = toile.toDataURL('image/jpeg', 0.8);
    } catch (e) {
      erreur = (e as Error).name === 'NotAllowedError' ? 'Capture annulée.' : 'La capture d’écran n’a pas pu être prise.';
    } finally {
      flux?.getTracks().forEach((t) => t.stop());
      masque = false;
    }
  }

  async function envoyer(e: SubmitEvent) {
    e.preventDefault();
    erreur = '';
    envoi = true;
    try {
      const r = await post<{ requete: string }>('/bugs', {
        theme, sousTheme: precis, description, page: routeId, pageSource,
        joindrePseudo: joindrePseudo && !pageSource,
        // Depuis une page de source : ni état du compte, ni description du navigateur (qui le rendrait reconnaissable).
        ...(joindreTelemetrie && !pageSource ? { telemetrie: prendre(etat()) } : {}),
        ...(capture && !pageSource ? { capture } : {}),
      });
      envoye = r.requete;
    } catch (x) {
      erreur = message(x);
    } finally {
      envoi = false;
    }
  }

  const videoAffichee = () => typeof document !== 'undefined' && !!document.querySelector('main video');
</script>

<dialog bind:this={dialogue} class:masque aria-labelledby="titre-bug" onclose={() => (capture = null)}>
  <div class="tete">
    <h2 id="titre-bug">Signaler un bug</h2>
    <button class="bouton lien" onclick={() => dialogue?.close()} aria-label="Fermer">Fermer</button>
  </div>

  {#if envoye}
    <div class="message succes">
      Merci, le rapport est bien arrivé. Sa référence : <code>{envoye.slice(0, 8)}</code>.
    </div>
    <div class="boutons"><button class="bouton principal" onclick={() => dialogue?.close()}>Fermer</button></div>
  {:else}
    <form onsubmit={envoyer}>
      {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}

      <div class="deux">
        <div class="champ">
          <label for="bug-theme">Sujet</label>
          <select id="bug-theme" bind:value={theme} onchange={changerTheme}>
            {#each proposes as t (t.cle)}<option value={t.cle}>{t.libelle}</option>{/each}
          </select>
        </div>
        <div class="champ">
          <label for="bug-precis">Plus précisément</label>
          <select id="bug-precis" bind:value={precis}>
            {#each themeChoisi?.precis ?? [] as p (p.cle)}<option value={p.cle}>{p.libelle}</option>{/each}
          </select>
        </div>
      </div>

      {#if themeChoisi?.urgent}
        <div class="message attention">
          Ce rapport sera traité en priorité. Ne décrivez jamais une faille ailleurs qu’ici (réseaux sociaux, forums) :
          cela la rendrait utilisable par d’autres avant qu’elle soit corrigée.
        </div>
      {/if}

      <div class="champ">
        <label for="bug-description">Que s’est-il passé ?</label>
        <textarea id="bug-description" bind:value={description} maxlength="5000" required
                  placeholder="Ce que vous faisiez, ce que vous attendiez, ce qui s’est produit."></textarea>
        {#if pageSource}
          <span class="aide">N’écrivez ici ni votre code de suivi, ni rien qui permette de vous reconnaître.</span>
        {/if}
      </div>

      <label class="case">
        <input type="checkbox" bind:checked={joindreTelemetrie} />
        <span>Joindre les informations techniques (fortement conseillé : elles permettent de retrouver le bug).</span>
      </label>
      {#if joindreTelemetrie && telemetrie}
        <details class="apercu">
          <summary>Voir exactement ce qui sera joint</summary>
          <p class="aide">
            Version du site, navigateur et système, taille de la fenêtre, vos 30 dernières actions (pages et boutons,
            jamais ce que vous tapez), les derniers échanges avec le serveur (sans leur contenu) et les erreurs.
            Ni adresse IP, ni cookie, ni adresse complète des pages.
          </p>
          <pre>{JSON.stringify(telemetrie, null, 2)}</pre>
        </details>
      {/if}

      {#if session.moi && !pageSource}
        <label class="case">
          <input type="checkbox" bind:checked={joindrePseudo} />
          <span>Joindre mon pseudo (<strong>{session.moi.pseudo}</strong>) pour qu’on puisse vérifier mon compte.</span>
        </label>
      {/if}

      {#if !pageSource && !videoAffichee() && typeof navigator.mediaDevices?.getDisplayMedia === 'function'}
        <div class="capture">
          {#if capture}
            <img src={capture} alt="Capture d’écran jointe au rapport" />
            <button type="button" class="bouton lien" onclick={() => (capture = null)}>Retirer la capture</button>
          {:else}
            <button type="button" class="bouton" onclick={capturer}>Ajouter une capture d’écran</button>
            <span class="aide">Facultatif. Votre navigateur vous demandera quoi capturer ; vous verrez l’image avant l’envoi.</span>
          {/if}
        </div>
      {/if}

      <div class="boutons">
        <Manque raisons={[!description.trim() && 'une description']}><button class="bouton principal" type="submit" disabled={envoi || !description.trim()}>
          {envoi ? 'Envoi…' : 'Envoyer le rapport'}
        </button></Manque>
        <button class="bouton" type="button" onclick={() => dialogue?.close()}>Annuler</button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  dialog {
    width: min(40rem, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); overflow: auto;
    border: 1px solid var(--trait); border-radius: var(--rayon-grand); padding: 1.5rem;
    background: var(--surface); color: var(--texte); box-shadow: var(--ombre);
  }
  dialog::backdrop { background: rgb(18 20 23 / 0.55); }
  /* Pendant la capture : le formulaire ET le fondu disparaissent (sinon le fondu reste sur l’image). */
  dialog.masque { opacity: 0; }
  dialog.masque::backdrop { background: transparent; }
  .tete { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
  .deux { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  @media (max-width: 34rem) { .deux { grid-template-columns: 1fr; } }
  .apercu { margin: 0 0 1rem 1.75rem; }
  .apercu summary { cursor: pointer; color: var(--accent-texte); font-size: 0.875rem; }
  pre { background: var(--surface-2); border: 1px solid var(--trait); border-radius: var(--rayon); padding: 0.75rem;
        font-size: 0.75rem; max-height: 16rem; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .capture { display: grid; gap: 0.5rem; justify-items: start; margin-top: 0.75rem; }
  .capture img { max-width: 100%; max-height: 12rem; border: 1px solid var(--trait); border-radius: var(--rayon); }
</style>
