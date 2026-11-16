<script lang="ts">
  // Une vidéo dans l'espace analyste : la regarder, lire les notes, écrire, corriger ou retirer les siennes.
  import Manque from '#lib/composants/Manque.svelte';
  import { confirmer } from '#lib/confirmer.svelte.ts';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { api, ErreurApi, get, post } from '#lib/api.ts';
  import CarteLieu from '#lib/composants/CarteLieu.svelte';
  import ContexteVideo from '#lib/composants/ContexteVideo.svelte';
  import LecteurVideo from '#lib/composants/LecteurVideo.svelte';
  import NoteAnalyste, { type Note } from '#lib/composants/NoteAnalyste.svelte';
  import { message } from '#lib/erreurs.ts';
  import { dateFaits, PRECISIONS } from '#lib/libelles.ts';
  import { chargerVideos, type VideoOsint } from '#lib/osint.ts';

  const id = $derived(page.params.video!);
  let v = $state<VideoOsint | null>(null);
  let plafond = $state(3);
  let notes = $state<Note[]>([]);
  let introuvable = $state(false);
  let erreur = $state('');
  let info = $state('');
  let occupe = $state(false);
  // Formulaire (nouvelle note ou correction)
  let edition = $state<string | null>(null);   // id de la note corrigée, ou null pour une nouvelle
  let constat = $state('');
  let explication = $state('');
  let liens = $state<string[]>(['']);
  let publier = $state(false);

  const miennes = $derived(notes.filter((n) => n.mienne).length);

  // Correction de la date, de l'heure ou du lieu
  interface CorrectionPassee { correction: string; par: string | null; le: string; date: string; heureConnue: boolean;
    lieu: { lat: number; lon: number; precision: string }; justification: string; liens: string[]; annulee: { le: string; motif: string } | null }
  let corrections = $state<CorrectionPassee[]>([]);
  let formCorrection = $state(false);
  let cJour = $state('');
  let cHeure = $state('');
  let cHeureInconnue = $state(false);
  let cLieu = $state<{ lat: number; lon: number } | null>(null);
  let cPrecision = $state<'exact' | 'approx_100m' | 'municipality'>('approx_100m');
  let cJustification = $state('');
  let cLiens = $state<string[]>(['']);
  let cDateEtablie = $state(false);   // vidéo « date à établir » : cette correction établit la date
  let cLieuEtabli = $state(false);    // vidéo « lieu à établir » : cette correction établit le lieu
  const versLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

  async function chargerCorrections() {
    corrections = (await get<{ corrections: CorrectionPassee[] }>(`/osint/videos/${id}/corrections`)).corrections;
  }
  function ouvrirCorrection() {
    if (!v) return;
    const l = v.date ? versLocal(new Date(v.date)) : '';
    cJour = l.slice(0, 10); cHeure = v.heureConnue === false ? '' : l.slice(11, 16); cHeureInconnue = v.heureConnue === false;
    cLieu = v.lieu ? { lat: v.lieu.lat, lon: v.lieu.lon } : null;
    cPrecision = (v.lieu?.precision as typeof cPrecision) ?? 'approx_100m';
    cJustification = ''; cLiens = ['']; cDateEtablie = false; cLieuEtabli = false;
    formCorrection = true;
  }
  async function envoyerCorrection(e: SubmitEvent) {
    e.preventDefault();
    erreur = ''; info = ''; occupe = true;
    try {
      await post(`/osint/videos/${id}/correction`, {
        date: new Date(`${cJour}T${cHeureInconnue ? '12:00' : cHeure}`).toISOString(), heureConnue: !cHeureInconnue,
        lieu: cLieu, precision: cPrecision, justification: cJustification.trim(), liens: cLiens.map((l) => l.trim()).filter(Boolean),
        etablit: { date: cDateEtablie, lieu: cLieuEtabli },
      });
      info = 'Correction appliquée : les relecteurs voient la nouvelle date et le nouveau lieu, à côté de ceux de la source.';
      formCorrection = false;
      v = (await chargerVideos()).videos.find((x) => x.video === id) ?? v;
      await chargerCorrections();
    } catch (x) {
      erreur = message(x);
    } finally {
      occupe = false;
    }
  }

  async function chargerNotes() {
    notes = (await get<{ notes: Note[] }>(`/osint/videos/${id}/notes`)).notes;
  }
  onMount(async () => {
    try {
      const r = await chargerVideos();
      plafond = r.plafondNotesParVideo;
      v = r.videos.find((x) => x.video === id) ?? null;
      if (!v) { introuvable = true; return; }
      await chargerNotes();
      await chargerCorrections();
    } catch (x) {
      if (x instanceof ErreurApi && x.statut === 401) return goto('/connexion');
      erreur = message(x);
    }
  });

  const lien = async (qualite: 'apercu' | 'complete') =>
    (await post<{ lien: string }>(`/osint/videos/${id}/video`, { qualite })).lien;

  function vider() {
    edition = null; constat = ''; explication = ''; liens = ['']; publier = false;
  }
  function corriger(n: Note) {
    edition = n.note; constat = n.constat; explication = n.explication; liens = [...n.liens]; publier = n.publier ?? false;
    document.getElementById('formulaire-note')?.scrollIntoView({ behavior: 'smooth' });
  }

  async function enregistrer(e: SubmitEvent) {
    e.preventDefault();
    erreur = ''; info = ''; occupe = true;
    const corps = { constat: constat.trim(), explication: explication.trim(), liens: liens.map((l) => l.trim()).filter(Boolean), publier };
    try {
      if (edition) {
        await api('PUT', `/osint/notes/${edition}`, corps);
        info = 'Note corrigée : la version précédente reste visible dans l’historique.';
      } else {
        await post(`/osint/videos/${id}/notes`, corps);
        info = 'Note publiée pour les relecteurs.';
      }
      vider();
      await chargerNotes();
    } catch (x) {
      erreur = message(x);
    } finally {
      occupe = false;
    }
  }

  async function retirer(n: Note) {
    if (!(await confirmer({ titre: 'Retirer cette note ?', texte: 'Elle ne sera plus affichée, mais reste dans l’historique d’Argos Veille.',
                            oui: 'Retirer la note', ton: 'danger' }))) return;
    erreur = ''; info = '';
    try {
      await post(`/osint/notes/${n.note}/retrait`);
      if (edition === n.note) vider();
      info = 'Note retirée.';
      await chargerNotes();
    } catch (x) {
      erreur = message(x);
    }
  }
</script>

<svelte:head><title>Espace analyste — Argos Veille</title></svelte:head>

<div class="conteneur">
  <p class="petit"><a href="/analyste">← Vidéos en relecture</a></p>
  {#if introuvable}
    <h1>Vidéo introuvable</h1>
    <p class="second">Elle n’est plus en relecture : la décision a peut-être été prise.</p>
  {:else if v}
    <span class="surtitre">Analyste OSINT · {{ jury: 'devant le jury', analyse: 'lieu ou date à établir', relecture: 'en relecture' }[v.etape]}</span>
    <h1>Analyser la vidéo</h1>
    {#if erreur}<div class="message erreur" role="alert">{erreur}
      {#if erreur.includes('double authentification')}<br /><a href="/compte">Aller dans Mon compte</a>{/if}</div>{/if}
    {#if info}<div class="message succes" role="status">{info}</div>{/if}

    <div class="grille">
      <div class="colonne">
        <LecteurVideo obtenirLien={lien} />
        <div class="carte"><ContexteVideo c={v} /></div>
        <section class="carte">
          <h2>Date, heure et lieu</h2>
          {#if !formCorrection}
            <p class="petit second">Appliquée tout de suite, avec votre justification ; la déclaration de la source reste affichée.</p>
            <button class="bouton" onclick={ouvrirCorrection}>Corriger la date, l’heure ou le lieu</button>
          {:else}
            <form onsubmit={envoyerCorrection}>
              <div class="deux">
                <div class="champ"><label for="c-jour">Date</label><input id="c-jour" type="date" bind:value={cJour} required /></div>
                <div class="champ">
                  <label for="c-heure">Heure</label>
                  <input id="c-heure" type="time" bind:value={cHeure} disabled={cHeureInconnue} required={!cHeureInconnue} />
                  <label class="case petit"><input type="checkbox" bind:checked={cHeureInconnue} /> <span>Heure inconnue</span></label>
                </div>
              </div>
              <div class="champ">
                <span class="etiquette">Lieu</span>
                <CarteLieu bind:lieu={cLieu} precision={cPrecision} />
              </div>
              <div class="champ">
                <label for="c-precision">Précision du lieu</label>
                <select id="c-precision" bind:value={cPrecision}>
                  {#each Object.entries(PRECISIONS) as [cle, texte] (cle)}<option value={cle}>{texte}</option>{/each}
                </select>
                {#if !v?.aEtablir?.lieu}<p class="petit second">Jamais plus précis que le choix de la source : la précision y est
                  ramenée.</p>{/if}
              </div>
              {#if v?.aEtablir?.date || v?.aEtablir?.lieu}
                <fieldset class="champ">
                  <legend class="etiquette">La source ne les connaissait pas</legend>
                  {#if v.aEtablir.date}<label class="case"><input type="checkbox" bind:checked={cDateEtablie} /> <span>J’ai établi la date</span></label>{/if}
                  {#if v.aEtablir.lieu}<label class="case"><input type="checkbox" bind:checked={cLieuEtabli} /> <span>J’ai établi le lieu</span></label>{/if}
                </fieldset>
              {/if}
              <div class="champ">
                <label for="c-justification">Justification</label>
                <textarea id="c-justification" bind:value={cJustification} required minlength="10" maxlength="5000"
                          placeholder="Comment vous avez établi la date, l’heure ou le lieu (éléments visibles, recoupements…). Public : pas d’adresse plus précise que le choix de la source."></textarea>
              </div>
              <fieldset class="champ">
                <legend class="etiquette">Sources (1 à 10 liens https)</legend>
                {#each cLiens as _, i (i)}
                  <input type="url" bind:value={cLiens[i]} placeholder="https://" maxlength="2000" aria-label="Source {i + 1}" required={i === 0} />
                {/each}
                {#if cLiens.length < 10}<button type="button" class="bouton lien" onclick={() => (cLiens = [...cLiens, ''])}>+ Ajouter un lien</button>{/if}
              </fieldset>
              <div class="boutons">
                <Manque raisons={[!cLieu && 'le lieu', cJustification.trim().length < 10 && 'une justification de 10 caractères']}><button class="bouton principal" type="submit" disabled={occupe || !cLieu || cJustification.trim().length < 10}>Appliquer la correction</button></Manque>
                <button class="bouton lien" type="button" onclick={() => (formCorrection = false)}>Annuler</button>
              </div>
            </form>
          {/if}
          {#if corrections.length}
            <details class="petit historique-corrections">
              <summary>Historique des corrections ({corrections.length})</summary>
              <ul>
                {#each corrections as c (c.correction)}
                  <li class:annulee={c.annulee}>
                    {new Date(c.le).toLocaleDateString('fr-FR')} · {c.par ?? 'compte supprimé'} :
                    {dateFaits(c.date, c.heureConnue)}, {c.lieu.lat.toFixed(4)}, {c.lieu.lon.toFixed(4)}
                    {#if c.annulee}<br /><em>annulée : {c.annulee.motif}</em>{/if}
                  </li>
                {/each}
              </ul>
            </details>
          {/if}
        </section>

        <section>
          <h2>Notes ({notes.length})</h2>
          {#each notes as n (n.note)}
            <NoteAnalyste note={n}>
              {#snippet actions()}
                {#if n.mienne}
                  <div class="boutons actions">
                    <span class="petit discret">{n.publier ? 'Proposée pour la fiche publique' : 'Réservée aux relecteurs'}</span>
                    <button class="bouton" onclick={() => corriger(n)}>Corriger</button>
                    <button class="bouton danger" onclick={() => retirer(n)}>Retirer</button>
                  </div>
                {/if}
              {/snippet}
            </NoteAnalyste>
          {:else}
            <p class="second">Aucune note pour l’instant.</p>
          {/each}
        </section>
      </div>

      <form class="carte formulaire" id="formulaire-note" onsubmit={enregistrer}>
        <h2>{edition ? 'Corriger ma note' : 'Nouvelle note'}</h2>
        {#if !edition && miennes >= plafond}
          <div class="message info">Vous avez déjà {plafond} notes sur cette vidéo : corrigez-en une, ou retirez-la.</div>
        {:else}
          <div class="champ">
            <label for="constat">Constat</label>
            <input id="constat" bind:value={constat} maxlength="200" required placeholder="Lieu confirmé : …" />
            <span class="aide">Une phrase vérifiable. {200 - constat.length} caractères restants.</span>
          </div>
          <div class="champ">
            <label for="explication">Explication</label>
            <textarea id="explication" bind:value={explication} maxlength="5000" required rows="7"
                      placeholder="Comment vous êtes arrivé à ce constat, à quel moment de la vidéo, avec quelle méthode."></textarea>
          </div>
          <fieldset class="champ">
            <legend class="etiquette">Sources (1 à 10 liens https)</legend>
            {#each liens as _, i (i)}
              <div class="lien">
                <input type="url" bind:value={liens[i]} placeholder="https://" maxlength="2000" aria-label="Lien {i + 1}" required={i === 0} />
                {#if liens.length > 1}<button type="button" class="bouton" aria-label="Retirer le lien {i + 1}" onclick={() => (liens = liens.filter((__, j) => j !== i))}>✕</button>{/if}
              </div>
            {/each}
            {#if liens.length < 10}<button type="button" class="bouton lien" onclick={() => (liens = [...liens, ''])}>+ Ajouter un lien</button>{/if}
            <span class="aide">Argos Veille n’ouvre jamais ces liens : ils sont affichés tels quels aux relecteurs.</span>
          </fieldset>
          <label class="case">
            <input type="checkbox" bind:checked={publier} />
            <span>Proposer cette note pour la fiche publique (elle n’y paraîtra que si la vidéo est publiée et que les
              relecteurs ne l’ont pas jugée peu utile).</span>
          </label>
          <div class="boutons">
            <button class="bouton principal" type="submit" disabled={occupe}>{edition ? 'Enregistrer la correction' : 'Publier la note'}</button>
            {#if edition}<button class="bouton lien" type="button" onclick={vider}>Annuler</button>{/if}
          </div>
        {/if}
      </form>
    </div>
  {:else if erreur}
    <div class="message erreur">{erreur}</div>
  {/if}
</div>

<style>
  .grille { display: grid; grid-template-columns: minmax(0, 1fr) 24rem; gap: 1.5rem; align-items: start; margin-top: 1.5rem; }
  @media (max-width: 60rem) { .grille { grid-template-columns: 1fr; } }
  .colonne { display: grid; gap: 1rem; }
  .formulaire { position: sticky; top: 5rem; }
  @media (max-width: 60rem) { .formulaire { position: static; } }
  fieldset { border: 0; padding: 0; margin: 0 0 1.125rem; min-width: 0; }
  fieldset legend { padding: 0; margin-bottom: 0.375rem; }
  fieldset .bouton.lien { justify-self: start; margin-top: 0.25rem; }
  .lien { display: flex; gap: 0.5rem; }
  .deux { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  fieldset input + input { margin-top: 0.5rem; }
  .historique-corrections { margin-top: 1rem; }
  .historique-corrections li.annulee { color: var(--texte-3); }
  .actions { margin-top: 0.75rem; }
  .actions span { margin-right: auto; }
</style>
