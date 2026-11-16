<script lang="ts">
  // Ce que la source a annoncé : nature des faits, forces, situation, date, lieu arrondi, description,
  // et l'indicateur de cohérence des métadonnées. Faits allégués, non jugés.
  import LieuApercu from './LieuApercu.svelte';
  import { CATEGORIES, dateFaits, FORCES, METADONNEES, PRECISIONS, SITUATIONS, SOUS_CATEGORIES, libellesChoix } from '#lib/libelles.ts';

  export interface Contexte {
    pseudonyme: string | null; categorie: string | null; sousCategorie: string | null; sousCategories: string[]; forces: string | null;
    situation: string | null; situations: string[]; date: string | null; heureConnue?: boolean; lieu: { lat: number; lon: number; precision: string } | null;
    description: string | null; langue: string | null; metadonnees: string | null;
    correction?: Correction | null;
    aEtablir?: { date: boolean; lieu: boolean };   // la source ne les connaissait pas : à établir par un analyste
    origine?: { publiePar: string | null; lien: string | null; precisions: string | null } | null;
  }
  export interface Correction {
    par: string | null; statutAuteur: string; le: string; justification: string; liens: string[];
    declare: { date: string; heureConnue: boolean; lieu: { lat: number; lon: number; precision: string } };
  }
  let { c }: { c: Contexte } = $props();
  const osm = $derived(c.lieu ? `https://www.openstreetmap.org/?mlat=${c.lieu.lat}&mlon=${c.lieu.lon}#map=16/${c.lieu.lat}/${c.lieu.lon}` : '');
  const meta = $derived(c.metadonnees ? METADONNEES[c.metadonnees] : undefined);
</script>

<section class="contexte" aria-label="Ce qui est annoncé">
  <p class="discret petit">{c.correction ? 'Ce que la source annonce, date et lieu corrigés par un analyste' : 'Ce que la source annonce'} — faits allégués, non jugés{#if c.pseudonyme}{' · '}envoyée par <strong>{c.pseudonyme}</strong>{/if}</p>
  <dl>
    <div><dt>Nature</dt><dd>{c.categorie ? CATEGORIES[c.categorie] : '—'}{#if c.sousCategorie}{' · '}{libellesChoix(c.sousCategories, SOUS_CATEGORIES)}{/if}</dd></div>
    <div><dt>Forces</dt><dd>{c.forces ? FORCES[c.forces] : '—'}</dd></div>
    <div><dt>Situation</dt><dd>{c.situation ? libellesChoix(c.situations, SITUATIONS) : '—'}</dd></div>
    <div><dt>Date{#if c.aEtablir?.date} <span class="pastille accent">À établir</span>{/if}</dt><dd>{#if c.aEtablir?.date}Au plus tard le {dateFaits(c.date, false)}{:else}{dateFaits(c.date, c.heureConnue ?? true)}{/if}</dd></div>
    <div><dt>Lieu{#if c.aEtablir?.lieu} <span class="pastille accent">À établir</span>{/if}</dt><dd>
      {#if c.aEtablir?.lieu}<span class="discret petit">Repère approximatif</span><br />{/if}
      {#if c.lieu}
        <LieuApercu lieu={c.lieu} carte={false} />
        <span class="discret petit">{c.lieu.lat.toFixed(4)}, {c.lieu.lon.toFixed(4)} ({PRECISIONS[c.lieu.precision] ?? c.lieu.precision})
        · <a href={osm} target="_blank" rel="noopener noreferrer">OpenStreetMap ↗</a></span>
      {:else}non indiqué{/if}
    </dd></div>
  </dl>
  {#if c.lieu}<div class="carte-lieu"><LieuApercu lieu={c.lieu} adresse={false} /></div>{/if}
  {#if c.correction}
    <div class="correction">
      <p class="petit"><strong>Date, heure ou lieu corrigés</strong> par {c.correction.par ?? 'un compte supprimé'}
        ({c.correction.statutAuteur === 'analyste_osint_verifie' ? 'analyste OSINT vérifié' : 'analyste retiré'}),
        le {new Date(c.correction.le).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}.</p>
      <p class="petit second">Déclaré par la source : {dateFaits(c.correction.declare.date, c.correction.declare.heureConnue)}
        · {c.correction.declare.lieu.lat.toFixed(4)}, {c.correction.declare.lieu.lon.toFixed(4)}
        ({PRECISIONS[c.correction.declare.lieu.precision] ?? c.correction.declare.lieu.precision})</p>
      <details class="petit"><summary>Justification</summary>
        <p class="explication">{c.correction.justification}</p>
        <ul>{#each c.correction.liens as l (l)}<li><a href={l} target="_blank" rel="noopener noreferrer nofollow ugc">{l} ↗</a></li>{/each}</ul>
      </details>
    </div>
  {/if}
  {#if c.origine}
    <div class="petit origine">
      <strong>Origine :</strong>
      {#if c.origine.publiePar}publiée par {c.origine.publiePar}{/if}
      {#if c.origine.lien}<a href={c.origine.lien} target="_blank" rel="noopener noreferrer nofollow ugc">{c.origine.lien} ↗</a>{/if}
      {#if c.origine.precisions}<p class="second" style:white-space="pre-line">{c.origine.precisions}</p>{/if}
    </div>
  {/if}
  {#if c.description}<blockquote>{c.description}</blockquote>{/if}
  {#if meta}<div class="message {meta.ton}">{meta.texte}</div>{/if}
</section>

<style>
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.75rem 1.5rem; margin: 0 0 1rem; }
  dt { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--texte-3); }
  dt .pastille { text-transform: none; letter-spacing: 0; font-weight: 600; margin-left: 0.375rem; vertical-align: middle; }
  dd { margin: 0.125rem 0 0; }
  .carte-lieu { margin: 0 0 1rem; max-width: 36rem; }
  .correction { border-left: 3px solid var(--info); background: var(--info-doux); padding: 0.625rem 0.875rem; margin: 0 0 1rem;
                border-radius: 0 var(--rayon) var(--rayon) 0; }
  .origine { margin: 0 0 1rem; overflow-wrap: anywhere; }
  .origine p { margin: 0.25rem 0 0; white-space: pre-wrap; }
  .correction p { margin: 0 0 0.25rem; }
  .correction .explication { white-space: pre-wrap; }
  .correction ul { padding-left: 1rem; word-break: break-all; }
  blockquote { margin: 0 0 1rem; padding: 0.75rem 1rem; border-left: 3px solid var(--accent); background: var(--surface-2); border-radius: 0 var(--rayon) var(--rayon) 0; }
</style>
