<script lang="ts">
  // Une convocation : regarder la version floutée, lire ce qui est annoncé, voter (oui / en partie /
  // non avec des raisons ; le jury répond oui ou non). Les notes des analystes restent repliées tant
  // que la vidéo n'a pas été ouverte. Après le vote : juger ces notes.
  import Manque from '#lib/composants/Manque.svelte';
  import { confirmer } from '#lib/confirmer.svelte.ts';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { ErreurApi, get, post } from '#lib/api.ts';
  import ContexteVideo from '#lib/composants/ContexteVideo.svelte';
  import LecteurVideo from '#lib/composants/LecteurVideo.svelte';
  import NoteAnalyste, { type Note } from '#lib/composants/NoteAnalyste.svelte';
  import { message } from '#lib/erreurs.ts';
  import { chargerRelecture, type Convocation, type Raison } from '#lib/relecture.ts';

  const id = $derived(page.params.convocation!);
  let mode = $state<'chargement' | 'vote' | 'apres' | 'terminee'>('chargement');
  let c = $state<Convocation | null>(null);
  let raisonsVote = $state<{ oui: Raison[]; non: Raison[] }>({ oui: [], non: [] });
  let notes = $state<Note[]>([]);
  let rappel = $state('');
  let raisonsNotes = $state<{ oui: Raison[]; non: Raison[] }>({ oui: [], non: [] });
  let videoOuverte = $state(false);
  let vueComplete = $state(false);   // premier visionnage terminé (90 % regardés)
  let progression = $state(0);
  let verdict = $state('');
  let raisons = $state<string[]>([]);
  let visage = $state(false);
  let dejaPresente = $state(false);
  let fiche = $state('');
  let reponsesEvenement = $state<Record<string, '' | 'oui' | 'non'>>({});
  let autreEvenement = $state(false);
  let ficheEvenement = $state('');
  let erreur = $state('');
  let occupe = $state(false);
  let vientDeVoter = $state(false);

  const VERDICTS: Record<string, { texte: string; aide: string }> = {
    oui: { texte: 'Oui', aide: 'La vidéo montre bien ce qui est annoncé.' },
    en_partie: { texte: 'En partie', aide: 'Une partie seulement, ou avec un doute sur un point.' },
    non: { texte: 'Non', aide: 'Elle ne montre pas ce qui est annoncé, ou elle est trompeuse.' },
  };
  const proposees = $derived(verdict === 'oui' ? raisonsVote.oui : verdict === 'non' ? raisonsVote.non
    : verdict === 'en_partie' ? [...raisonsVote.oui, ...raisonsVote.non] : []);

  async function chargerNotes() {
    const r = await get<{ rappel: string; notes: Note[]; raisons?: { oui: Raison[]; non: Raison[] } }>(`/relecture/${id}/notes`);
    notes = r.notes;
    rappel = r.rappel;
    if (r.raisons) raisonsNotes = r.raisons;
  }

  onMount(async () => {
    try {
      const r = await chargerRelecture();
      raisonsVote = r.raisons;
      c = r.convocations.find((x) => x.convocation === id) ?? null;
      if (c) {
        mode = 'vote';
        // Déjà regardée lors d'une visite précédente ? Le serveur le dit en donnant les notes.
        try { await chargerNotes(); vueComplete = true; } catch { /* pas encore */ }
        return;
      }
      await chargerNotes();   // convocation déjà votée : jugement des notes
      mode = 'apres';
    } catch (x) {
      if (x instanceof ErreurApi && x.statut === 401) return goto('/connexion');
      mode = 'terminee';
    }
  });

  async function lien(qualite: 'apercu' | 'complete') {
    return (await post<{ lien: string }>(`/relecture/${id}/video`, { qualite })).lien;
  }
  function ouverte() {
    videoOuverte = true;
  }
  /** Fin du premier visionnage : réponse et notes s'ouvrent (le serveur peut demander d'attendre un peu). */
  async function vue() {
    for (let essai = 0; essai < 5; essai++) {
      try {
        await chargerNotes();
        vueComplete = true;
        return;
      } catch (x) {
        const reste = x instanceof ErreurApi ? Number(x.corps['disponibleDans'] ?? 0) : 0;
        if (!reste) { vueComplete = true; return; }
        await new Promise((ok) => setTimeout(ok, (reste + 1) * 1000));
      }
    }
  }

  function choisirVerdict(v: string) {
    verdict = v;
    const permises = new Set(proposees.map((r) => r.cle));
    raisons = raisons.filter((r) => permises.has(r));
  }

  const evenementsRepondus = $derived(Object.entries(reponsesEvenement).filter(([, r]) => r !== '').map(([f, r]) => ({ fiche: f, oui: r === 'oui' })));

  async function voter(e: SubmitEvent) {
    e.preventDefault();
    erreur = '';
    occupe = true;
    try {
      await post(`/relecture/${id}/vote`, { verdict, raisons, visageIdentifiable: visage,
                                            ...(dejaPresente ? { dejaPresente: fiche.trim() } : {}),
                                            ...(evenementsRepondus.length ? { evenements: evenementsRepondus } : {}),
                                            ...(autreEvenement ? { memeEvenement: ficheEvenement.trim() } : {}) });
      vientDeVoter = true;
      await chargerNotes().catch(() => { notes = []; });
      mode = 'apres';
      scrollTo({ top: 0 });
    } catch (x) {
      erreur = message(x);
    } finally {
      occupe = false;
    }
  }

  async function passer() {
    if (!(await confirmer({ titre: 'Passer votre tour ?', texte: 'La vidéo sera confiée à quelqu’un d’autre, sans pénalité pour vous.',
                            oui: 'Passer mon tour' }))) return;
    try {
      await post(`/relecture/${id}/passer`);
      await goto('/relecture');
    } catch (x) {
      erreur = message(x);
    }
  }
</script>

<svelte:head><title>{c?.secondExamen ? 'Second examen' : 'Relecture'} — Argos Veille</title></svelte:head>

<div class="conteneur">
  <p class="petit"><a href="/relecture">← Mes convocations</a></p>

  {#if mode === 'chargement'}
    <p class="second">Chargement…</p>

  {:else if mode === 'terminee'}
    <h1>Convocation terminée</h1>
    <p class="second">Cette convocation a expiré, a été passée, ou toutes les places ont été prises.</p>

  {:else if mode === 'vote' && c}
    <span class="surtitre">{c.secondExamen ? 'Second examen — jury' : 'Relecture'}</span>
    <h1>La vidéo montre-t-elle ce qui est annoncé ?</h1>
    {#if c.secondExamen}
      <div class="message info">Le premier tour n’a pas permis de trancher : vous faites partie des 11 jurés tirés au
        sort parmi les relecteurs expérimentés. Vous ne verrez aucun chiffre du premier tour : jugez par vous-même.</div>
    {/if}

    <div class="grille">
      <div class="colonne-video">
        <LecteurVideo obtenirLien={lien} {ouverte} {vue} progression={(p) => (progression = p)} />
        <div class="carte"><ContexteVideo {c} /></div>

        {#if c.notesAnalystes}
          <section class="notes" aria-label="Notes d’analystes">
            <h2>Notes d’analystes ({c.notesAnalystes})</h2>
            {#if !vueComplete}
              <div class="message info">Faites-vous d’abord votre propre idée : les notes s’affichent à la fin de votre
                premier visionnage.</div>
            {:else}
              <p class="rappel">{rappel}</p>
              {#each notes as n (n.note)}<NoteAnalyste note={n} />{/each}
            {/if}
          </section>
        {/if}
      </div>

      <form class="carte vote" onsubmit={voter}>
        <h2>Votre réponse</h2>
        {#if !vueComplete}
          <div class="attente" role="status">
            <div class="barre" aria-hidden="true"><span style:width="{Math.round(progression * 100)}%"></span></div>
            <p class="petit"><strong>Visionnage : {Math.round(progression * 100)} %</strong> — la réponse s’ouvre à 90 %.</p>
            <details>
              <summary class="petit">Pourquoi attendre ?</summary>
              <p class="petit second">Pour juger sur la vidéo entière, avant de lire l’avis des autres. Pause, retour et
                accéléré (× 1,5) sont permis ; les passages sautés ne comptent pas. Ce qui est vu reste acquis.</p>
            </details>
          </div>
        {/if}
        <fieldset disabled={!vueComplete} class="tout">
        <fieldset>
          <legend class="visuellement-cache">La vidéo montre-t-elle ce qui est annoncé ?</legend>
          {#each c.verdicts as v (v)}
            <label class="verdict" class:choisi={verdict === v}>
              <input type="radio" name="verdict" value={v} checked={verdict === v} onchange={() => choisirVerdict(v)} />
              <span><strong>{VERDICTS[v]?.texte}</strong><span class="petit second">{VERDICTS[v]?.aide}</span></span>
            </label>
          {/each}
        </fieldset>

        {#if proposees.length}
          <fieldset>
            <legend class="etiquette">Pourquoi ? {c.raisonsObligatoires ? '(au moins une raison)' : '(facultatif)'}</legend>
            {#each proposees as r (r.cle)}
              {@const contraire = proposees.find((x) => r.contraires?.includes(x.cle) && raisons.includes(x.cle))}
              <label class="case" class:bloquee={contraire}>
                <input type="checkbox" value={r.cle} bind:group={raisons} disabled={!!contraire} />
                <span>{r.libelle}{#if contraire}<span class="aide"> — incompatible avec « {contraire.libelle} »</span>{/if}</span>
              </label>
            {/each}
          </fieldset>
        {/if}

        <label class="case visage">
          <input type="checkbox" bind:checked={visage} />
          <span>Un visage reste reconnaissable malgré le floutage (un signalement sera ouvert).</span>
        </label>

        {#if !c.secondExamen}
          {#if c.ressemblance}
            <div class="message petit">Cette vidéo ressemble à une vidéo déjà publiée :
              <a href="/videos/{c.ressemblance.video}" target="_blank" rel="noopener">{c.ressemblance.pseudonyme ?? 'voir la fiche'}</a>.</div>
          {/if}
          <label class="case">
            <input type="checkbox" bind:checked={dejaPresente}
                   onchange={() => { if (dejaPresente && !fiche) fiche = c?.ressemblance?.pseudonyme ?? ''; }} />
            <span>Cette vidéo est déjà présente sur le site.</span>
          </label>
          {#if dejaPresente}
            <div class="champ">
              <label for="fiche">Nom ou lien de la fiche</label>
              <input id="fiche" type="text" maxlength="300" bind:value={fiche} />
            </div>
          {/if}
        {/if}

        {#if !c.secondExamen}
          {#each c.evenements as e (e.video)}
            <fieldset class="evenement">
              <legend class="etiquette">Même événement que <a href="/videos/{e.video}" target="_blank" rel="noopener">{e.pseudonyme ?? 'cette fiche'}</a> ?</legend>
              <label class="case"><input type="radio" name="ev-{e.video}" value="oui" bind:group={reponsesEvenement[e.video]} /> <span>Oui</span></label>
              <label class="case"><input type="radio" name="ev-{e.video}" value="non" bind:group={reponsesEvenement[e.video]} /> <span>Non</span></label>
              <label class="case"><input type="radio" name="ev-{e.video}" value="" bind:group={reponsesEvenement[e.video]} /> <span>Je ne sais pas</span></label>
            </fieldset>
          {/each}
          <label class="case">
            <input type="checkbox" bind:checked={autreEvenement} />
            <span>Une autre fiche montre le même événement, sous un autre angle.</span>
          </label>
          {#if autreEvenement}
            <div class="champ">
              <label for="fiche-evenement">Nom ou lien de la fiche</label>
              <input id="fiche-evenement" type="text" maxlength="300" bind:value={ficheEvenement} />
            </div>
          {/if}
        {/if}

        {#if erreur}
          <div class="message erreur" role="alert">{erreur}
            {#if erreur.includes('double authentification')}<br /><a href="/compte">Aller dans Mon compte</a>{/if}</div>
        {/if}
        <Manque raisons={[!vueComplete && 'regarder la vidéo jusqu’au bout', !verdict && 'votre réponse', c.raisonsObligatoires && !raisons.length && 'au moins une raison', dejaPresente && !fiche.trim() && 'l’adresse de la fiche déjà publiée', autreEvenement && !ficheEvenement.trim() && 'l’adresse de la fiche du même événement']} large><button class="bouton principal pleine-largeur" type="submit"
                disabled={occupe || !vueComplete || !verdict || (c.raisonsObligatoires && !raisons.length) || (dejaPresente && !fiche.trim()) || (autreEvenement && !ficheEvenement.trim())}>
          {occupe ? 'Envoi…' : 'Envoyer ma réponse'}
        </button></Manque>
        </fieldset>
        <button class="bouton lien" type="button" onclick={passer}>Passer mon tour</button>
      </form>
    </div>

  {:else}
    <span class="surtitre">Après votre vote</span>
    <h1>{vientDeVoter ? 'Merci, votre réponse est enregistrée' : 'Notes d’analystes'}</h1>
    {#if notes.length}
      <p class="second">Ces notes vous ont-elles paru pertinentes ? Une note n’est mise en avant que si des relecteurs
        qui ont répondu différemment à la vidéo la jugent tous utile.</p>
      <div class="texte-long">
        {#each notes as n (n.note)}<NoteAnalyste note={n} juger={{ convocation: id, raisons: raisonsNotes }} />{/each}
      </div>
    {:else}
      <p class="second">Aucune note d’analyste sur cette vidéo.</p>
    {/if}
    <div class="boutons"><a class="bouton principal" href="/relecture">Retour à mes convocations</a></div>
  {/if}
</div>

<style>
  .grille { display: grid; grid-template-columns: minmax(0, 1fr) 22rem; gap: 1.5rem; align-items: start; margin-top: 1.5rem; }
  @media (max-width: 60rem) { .grille { grid-template-columns: 1fr; } }
  .colonne-video { display: grid; gap: 1rem; }
  .vote { position: sticky; top: 5rem; }
  @media (max-width: 60rem) { .vote { position: static; } }
  fieldset { border: 0; padding: 0; margin: 0 0 1rem; }
  .verdict { display: flex; gap: 0.75rem; align-items: flex-start; padding: 0.75rem; border: 1px solid var(--trait-fort);
             border-radius: var(--rayon); margin-bottom: 0.5rem; cursor: pointer; }
  .verdict span { display: grid; }
  .verdict input { margin-top: 0.3rem; accent-color: var(--texte); }
  .evenement { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .evenement legend { width: 100%; }
  .verdict.choisi { border-color: var(--accent); background: var(--accent-doux); }
  .bloquee { color: var(--texte-3); }
  .tout:disabled { opacity: 0.5; }
  .attente { background: var(--surface-2); border-radius: var(--rayon); padding: 0.75rem 1rem; margin-bottom: 1rem; }
  .attente .barre { height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; margin-bottom: 0.5rem; }
  .attente .barre span { display: block; height: 100%; background: var(--accent); transition: width 0.3s; }
  .attente p { margin: 0 0 0.25rem; }
  .attente summary { cursor: pointer; color: var(--accent-texte); }
  .visage { padding-top: 0.75rem; border-top: 1px solid var(--trait); }
  .notes h2 { margin-top: 0.5rem; }
  .rappel { font-weight: 600; color: var(--texte-2); }
</style>
