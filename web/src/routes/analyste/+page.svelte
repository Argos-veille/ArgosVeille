<script lang="ts">
  // Espace analyste OSINT : toutes les vidéos en relecture ou devant le jury, sans convocation.
  import Manque from '#lib/composants/Manque.svelte';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { ErreurApi } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';
  import { CATEGORIES, dateFaits, SOUS_CATEGORIES, libellesChoix } from '#lib/libelles.ts';
  import { avisEvenement, chargerPropositions, chargerVideos, proposerEvenement, type PropositionOsint, type VideoOsint } from '#lib/osint.ts';

  let videos = $state<VideoOsint[] | null>(null);
  let erreur = $state('');
  let propositions = $state<PropositionOsint[]>([]);
  let videoEv = $state('');
  let ficheEv = $state('');
  let justification = $state('');
  let occupe = $state(false);
  let info = $state('');

  const recharger = async () => { propositions = (await chargerPropositions().catch(() => ({ propositions: [] }))).propositions; };

  async function faire(f: () => Promise<unknown>, succes: string) {
    occupe = true; erreur = ''; info = '';
    try { await f(); info = succes; await recharger(); return true; }
    catch (x) { erreur = message(x); return false; }
    finally { occupe = false; }
  }
  async function proposer(e: SubmitEvent) {
    e.preventDefault();
    if (await faire(() => proposerEvenement(videoEv.trim(), ficheEv.trim(), justification.trim()), 'Proposition envoyée.')) { videoEv = ''; ficheEv = ''; justification = ''; }
  }

  onMount(async () => {
    try {
      videos = (await chargerVideos()).videos;
      await recharger();
    } catch (x) {
      if (x instanceof ErreurApi && x.statut === 401) return goto('/connexion');
      erreur = message(x);
    }
  });
</script>

<svelte:head><title>Espace analyste — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">Analyste OSINT</span>
  <h1>Vidéos en relecture</h1>
  <p class="second">Vos notes éclairent les relecteurs, sans décider. Trois au plus par vidéo.</p>
  {#if erreur}<div class="message erreur">{erreur}</div>{/if}

  {#if videos}
    {#each videos as v (v.video)}
      <a class="ligne" href="/analyste/{v.video}">
        <div>
          <span class="pastille {v.etape === 'relecture' ? '' : 'accent'}">{{ jury: 'Devant le jury', analyse: 'Lieu ou date à établir', relecture: 'En relecture' }[v.etape]}</span>
          <strong>{v.categorie ? CATEGORIES[v.categorie] : 'Nature non précisée'}{#if v.sousCategorie}{' · '}{libellesChoix(v.sousCategories, SOUS_CATEGORIES)}{/if}</strong>
          <div class="petit second">{v.description ?? ''}</div>
          <div class="petit discret">{dateFaits(v.date, v.heureConnue ?? true)}</div>
        </div>
        <div class="compte petit">
          <span>{v.notes} note{v.notes > 1 ? 's' : ''}</span>
          {#if v.mesNotes}<span class="discret">dont {v.mesNotes} de vous</span>{/if}
        </div>
      </a>
    {:else}
      <div class="carte"><p class="second">Aucune vidéo en relecture pour l’instant.</p></div>
    {/each}
  {/if}

  <h2>Même événement</h2>
  {#if info}<div class="message succes">{info}</div>{/if}
  {#each propositions as p (p.id)}
    <div class="carte">
      <p><a href="/videos/{p.video.id}" target="_blank" rel="noopener">{p.video.pseudonyme ?? 'Vidéo'}</a> ↔
         <a href="/videos/{p.fiche.id}" target="_blank" rel="noopener">{p.fiche.pseudonyme ?? 'Vidéo'}</a></p>
      {#if p.justification}<p class="petit second">{p.justification}</p>{/if}
      <div class="boutons">
        <button class="bouton" disabled={occupe} onclick={() => faire(() => avisEvenement(p.id, true), 'Avis enregistré.')}>Même événement</button>
        <button class="bouton" disabled={occupe} onclick={() => faire(() => avisEvenement(p.id, false), 'Avis enregistré.')}>Autre événement</button>
      </div>
    </div>
  {/each}
  <form class="carte" onsubmit={proposer}>
    <div class="champ"><label for="ev-video">Vidéo (nom ou lien)</label><input id="ev-video" type="text" maxlength="300" bind:value={videoEv} /></div>
    <div class="champ"><label for="ev-fiche">Fiche publiée du même événement (nom ou lien)</label><input id="ev-fiche" type="text" maxlength="300" bind:value={ficheEv} /></div>
    <div class="champ"><label for="ev-justif">Justification</label><textarea id="ev-justif" rows="3" maxlength="2000" bind:value={justification}></textarea></div>
    <Manque raisons={[!videoEv.trim() && 'la vidéo', !ficheEv.trim() && 'la fiche à relier', justification.trim().length < 10 && 'une justification de 10 caractères']}><button class="bouton principal" type="submit" disabled={occupe || !videoEv.trim() || !ficheEv.trim() || justification.trim().length < 10}>Proposer</button></Manque>
  </form>
</div>

<style>
  .ligne { display: flex; justify-content: space-between; gap: 1rem; padding: 1rem 1.25rem; background: var(--surface);
           border: 1px solid var(--trait); border-radius: var(--rayon-grand); text-decoration: none; color: var(--texte); margin-bottom: 0.75rem; }
  .ligne:hover { border-color: var(--trait-fort); box-shadow: var(--ombre); }
  .ligne strong { margin-left: 0.5rem; }
  .compte { display: grid; text-align: right; align-content: start; white-space: nowrap; }
</style>
