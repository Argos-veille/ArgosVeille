<script lang="ts">
  // Fiche publique d'une vidéo publiée ou « en débat ». Rien ne se lance tout seul ; faits allégués,
  // non jugés ; lieu arrondi, heure à l'heure près ; empreintes pour vérifier l'authenticité.
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import { ErreurApi, get, post } from '#lib/api.ts';
  import LieuApercu from '#lib/composants/LieuApercu.svelte';
  import LecteurVideo from '#lib/composants/LecteurVideo.svelte';
  import IntegrerVideo from '#lib/composants/IntegrerVideo.svelte';
  import SignalerVideo from '#lib/composants/SignalerVideo.svelte';
  import ContacterSource from '#lib/composants/ContacterSource.svelte';
  import { message } from '#lib/erreurs.ts';
  import type { Correction } from '#lib/composants/ContexteVideo.svelte';
  import { CATEGORIES, dateFaits, FORCES, PRECISIONS, SITUATIONS, SOUS_CATEGORIES, libellesChoix } from '#lib/libelles.ts';

  interface Fiche {
    id: string; etat: 'publiee' | 'en_debat'; pseudonyme: string | null; categorie: string; sousCategorie: string; sousCategories: string[];
    forces: string; situation: string; situations: string[]; date: string; heureConnue: boolean; lieu: { lat: number; lon: number; precision: string } | null;
    description: string | null; envoyeeLe: string; decision: { par: string | null; le: string } | null;
    empreintes: { floutee: string | null; horodatage: boolean };
    correction: Correction | null;
    origine: { publiePar: string; lien: string | null } | null;
    versionDe: { id: string; pseudonyme: string | null } | null;
    autresVersions: { id: string; pseudonyme: string | null; le: string | null }[];
    memeEvenement: { id: string; pseudonyme: string | null }[];
    notes: { note: string; auteur: string | null; statutAuteur: string; ecriteLe: string; version: number;
             constat: string; explication: string; liens: string[]; miseEnAvant: boolean }[];
  }
  const PAR: Record<string, string> = { communaute: 'par la communauté des relecteurs', jury: 'par un jury de relecteurs', administration: 'par l’administration' };

  let fiche = $state<Fiche | null>(null);
  let introuvable = $state(false);
  let retrait = $state<'video_masquee' | 'video_retiree' | null>(null);
  let erreur = $state('');
  const longue = (d: string) => new Date(d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const heure = (d: string) => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const domaine = (l: string) => { try { return new URL(l).hostname; } catch { return l; } };

  onMount(async () => {
    try {
      fiche = await get<Fiche>(`/public/videos/${page.params.id}`);
    } catch (x) {
      if (x instanceof ErreurApi && x.statut === 404) introuvable = true;
      else if (x instanceof ErreurApi && x.statut === 410) retrait = x.code as 'video_masquee' | 'video_retiree';
      else erreur = message(x);
    }
  });
  const lien = async () => (await post<{ lien: string }>(`/public/videos/${page.params.id}/video`)).lien;
</script>

<svelte:head>
  <title>{fiche ? `${SOUS_CATEGORIES[fiche.sousCategorie] ?? 'Vidéo'} — Argos Veille` : 'Vidéo — Argos Veille'}</title>
</svelte:head>

<div class="conteneur">
  <p class="petit"><a href="/carte">← La carte</a></p>
  {#if retrait === 'video_masquee'}
    <h1>Vidéo en cours d’examen</h1>
    <p class="second">Masquée le temps d’examiner un signalement (motif au <a href="/journal">journal public</a>).</p>
  {:else if retrait === 'video_retiree'}
    <h1>Vidéo retirée pour motif légal</h1>
    <p class="second">Le motif du retrait est inscrit au <a href="/journal">journal public</a>.</p>
  {:else if introuvable}
    <h1>Cette vidéo n’est pas publique</h1>
    <p class="second">Elle n’existe pas, n’a pas été publiée, ou a été retirée. Le <a href="/journal">journal public</a> garde
      la trace de chaque décision et de chaque retrait.</p>
  {:else if erreur}
    <div class="message erreur">{erreur}</div>
  {:else if fiche}
    <span class="surtitre">{fiche.etat === 'publiee' ? 'Vidéo publiée' : 'Vidéo en débat'}</span>
    <h1>{CATEGORIES[fiche.categorie]} · {libellesChoix(fiche.sousCategories, SOUS_CATEGORIES)}</h1>
    <p class="second">{fiche.heureConnue ? `${longue(fiche.date)} vers ${heure(fiche.date)}` : `${longue(`${fiche.date}T12:00`)} (heure inconnue)`}
      · {FORCES[fiche.forces]} · {libellesChoix(fiche.situations, SITUATIONS)}</p>
    {#if fiche.origine}
      <p class="petit">Publiée à l’origine par {#if fiche.origine.lien}<a href={fiche.origine.lien} target="_blank" rel="noopener noreferrer nofollow ugc">{fiche.origine.publiePar} ↗</a>{:else}{fiche.origine.publiePar}{/if}.</p>
    {/if}
    {#if fiche.versionDe}
      <div class="message">Autre version de <a href="/videos/{fiche.versionDe.id}" data-sveltekit-reload>{fiche.versionDe.pseudonyme ?? 'la fiche d’origine'}</a>.</div>
    {/if}
    {#if fiche.autresVersions.length}
      <div class="carte">
        <h2>Autres versions</h2>
        <ul class="liens">{#each fiche.autresVersions as x (x.id)}<li><a href="/videos/{x.id}" data-sveltekit-reload>{x.pseudonyme ?? 'Voir la vidéo'}</a></li>{/each}</ul>
      </div>
    {/if}
    {#if fiche.memeEvenement.length}
      <div class="carte">
        <h2>Autres vidéos de cet événement</h2>
        <ul class="liens">{#each fiche.memeEvenement as x (x.id)}<li><a href="/videos/{x.id}" data-sveltekit-reload>{x.pseudonyme ?? 'Voir la vidéo'}</a></li>{/each}</ul>
      </div>
    {/if}
    {#if fiche.etat === 'publiee' && !fiche.versionDe}
      <p class="petit"><a href="/envoyer?evenement={fiche.id}">Vous avez filmé la même scène ? Envoyer votre vidéo</a></p>
    {/if}
    {#if fiche.correction}
      <div class="message info">
        Date, heure ou lieu corrigés par {fiche.correction.par ?? 'un compte supprimé'}, analyste OSINT, d’après ses recherches.
        La source avait déclaré : {dateFaits(fiche.correction.declare.date, fiche.correction.declare.heureConnue)},
        {PRECISIONS[fiche.correction.declare.lieu.precision] ?? ''} autour de {fiche.correction.declare.lieu.lat.toFixed(3)},
        {fiche.correction.declare.lieu.lon.toFixed(3)}.
        <details class="petit"><summary>Justification</summary><p class="explication">{fiche.correction.justification}</p>
          <ul class="liens">{#each fiche.correction.liens as l (l)}<li><a href={l} target="_blank" rel="noopener noreferrer nofollow ugc">{domaine(l)} ↗</a></li>{/each}</ul>
        </details>
      </div>
    {/if}
    {#if fiche.etat === 'en_debat'}
      <div class="message attention">Les relecteurs ne sont pas parvenus à trancher : cette vidéo n’est pas sur la carte.
        Ce qui suit n’est ni confirmé, ni démenti.</div>
    {/if}

    <div class="grille">
      <div class="colonne">
        <LecteurVideo obtenirLien={lien} />
        {#if fiche.description}
          <section class="carte">
            <h2>Ce que décrit la source</h2>
            <blockquote>{fiche.description}</blockquote>
            <p class="petit discret">Faits allégués, non jugés{#if fiche.pseudonyme}{' · '}vidéo « {fiche.pseudonyme} »{/if}.</p>
          </section>
        {/if}
        {#if fiche.notes.length}
          <section>
            <h2>Notes d’analystes</h2>
            <p class="petit second">Par des analystes vérifiés. Elles éclairent, sans décider.</p>
            {#each fiche.notes as n (n.note)}
              <article class="carte note" class:avant={n.miseEnAvant}>
                <div class="petit discret"><strong>{n.auteur ?? 'compte supprimé'}</strong>
                  {n.statutAuteur === 'analyste_osint_verifie' ? '· analyste OSINT vérifié' : '· analyste retiré'}
                  {#if n.miseEnAvant}{' · '}<span class="pastille accent">Mise en avant</span>{/if}</div>
                <h3>{n.constat}</h3>
                <p class="explication">{n.explication}</p>
                <ul class="liens">{#each n.liens as l (l)}<li><a href={l} target="_blank" rel="noopener noreferrer nofollow ugc">{domaine(l)} ↗</a></li>{/each}</ul>
              </article>
            {/each}
          </section>
        {/if}
      </div>
      <aside class="colonne">
        {#if fiche.lieu}
          <LieuApercu lieu={fiche.lieu} />
          <p class="petit discret">Lieu arrondi ({PRECISIONS[fiche.lieu.precision] ?? fiche.lieu.precision}).</p>
        {/if}
        <section class="carte">
          <h2>Vérification</h2>
          <dl>
            {#if fiche.decision}
              <dt>Décision</dt>
              <dd>{fiche.etat === 'publiee' ? 'Publiée' : 'Mise en débat'} {fiche.decision.par ? PAR[fiche.decision.par] : ''}, le {longue(fiche.decision.le)}</dd>
            {/if}
            <dt>Reçue le</dt><dd>{longue(fiche.envoyeeLe)}</dd>
            {#if fiche.empreintes.floutee}
              <dt>Empreinte de la version floutée</dt><dd class="empreinte mono">{fiche.empreintes.floutee}</dd>
            {/if}
          </dl>
          <p class="petit discret">L’empreinte (SHA-256) de la version floutée permet de vérifier que la vidéo publiée n’a pas été
            modifiée. Chaque décision est inscrite au <a href="/journal">journal public</a>.</p>
        </section>
        <IntegrerVideo video={fiche.id} />
        <ContacterSource video={fiche.id} />
        <SignalerVideo video={fiche.id} />
      </aside>
    </div>
  {:else}
    <p class="second">Chargement…</p>
  {/if}
</div>

<style>
  .grille { display: grid; grid-template-columns: minmax(0, 1fr) 20rem; gap: 1.5rem; margin-top: 1.5rem; align-items: start; }
  @media (max-width: 60rem) { .grille { grid-template-columns: 1fr; } }
  .colonne { display: grid; gap: 1rem; }
  .colonne :global(.carte + .carte) { margin-top: 0; }
  blockquote { margin: 0 0 0.5rem; padding: 0.75rem 1rem; border-left: 3px solid var(--accent); background: var(--surface-2); }
  dl { margin: 0 0 0.75rem; display: grid; gap: 0.25rem; }
  dt { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--texte-3); margin-top: 0.5rem; }
  dd { margin: 0; }
  .empreinte { word-break: break-all; font-size: 0.75rem; }
  .note.avant { box-shadow: inset 3px 0 0 var(--accent); }
  .explication { white-space: pre-wrap; color: var(--texte-2); }
  .liens { list-style: none; padding: 0; margin: 0; display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.875rem; }
  h2 { font-size: 1.125rem; }
</style>
