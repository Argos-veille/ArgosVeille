<script lang="ts">
  // Une note d'analyste OSINT : constat, explication, liens (jamais ouverts par le site : on les suit
  // si on veut), signature, historique des versions. Après son vote, le relecteur peut la juger.
  import Manque from '#lib/composants/Manque.svelte';
  import { untrack } from 'svelte';
  import { post } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';

  export interface Version { version: number; date: string; constat: string; explication: string; liens: string[] }
  export interface Note {
    note: string; auteur: string | null; statutAuteur: 'analyste_osint_verifie' | 'analyste_retire';
    auteurNotesMisesEnAvant: number; etat?: 'mise_en_avant' | 'a_evaluer' | 'peu_utile';
    monJugement?: { avis: string; raisons: string[] } | null; mienne?: boolean; publier?: boolean;
    ecriteLe: string; corrigeeLe: string | null; version: number;
    constat: string; explication: string; liens: string[]; historique: Version[];
    masquee?: { le: string; motif: string };   // administration seulement
  }
  type Raison = { cle: string; libelle: string; contraires?: string[] };

  let { note, juger = null, actions }: {
    note: Note;
    juger?: { convocation: string; raisons: { oui: Raison[]; non: Raison[] } } | null;
    actions?: import('svelte').Snippet;
  } = $props();

  const ETATS = { mise_en_avant: 'Mise en avant', a_evaluer: 'À évaluer', peu_utile: 'Peu utile' } as const;
  const AVIS = { oui: 'Oui', en_partie: 'En partie', non: 'Non' } as const;
  const date = (d: string) => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const domaine = (l: string) => { try { return new URL(l).hostname; } catch { return l; } };

  let avis = $state<keyof typeof AVIS | ''>('');
  let raisons = $state<string[]>([]);
  // État et jugement partent de la note reçue, puis évoluent avec les jugements de ce relecteur.
  let etat = $state(untrack(() => note.etat));
  let jugement = $state(untrack(() => note.monJugement ?? null));
  let modifier = $state(untrack(() => !note.monJugement));
  let erreur = $state('');
  let occupe = $state(false);
  const proposees = $derived(!juger ? [] : avis === 'oui' ? juger.raisons.oui : avis === 'non' ? juger.raisons.non
    : avis === 'en_partie' ? [...juger.raisons.oui, ...juger.raisons.non] : []);

  function choisirAvis(a: keyof typeof AVIS) {
    avis = a;
    const permises = new Set((a === 'oui' ? juger!.raisons.oui : a === 'non' ? juger!.raisons.non : [...juger!.raisons.oui, ...juger!.raisons.non]).map((r) => r.cle));
    raisons = raisons.filter((r) => permises.has(r));
  }

  async function envoyer(e: SubmitEvent) {
    e.preventDefault();
    erreur = '';
    occupe = true;
    try {
      const r = await post<{ etat: Note['etat'] }>(`/relecture/${juger!.convocation}/notes/${note.note}/jugement`, { avis, raisons });
      etat = r.etat;
      jugement = { avis, raisons: [...raisons] };
      modifier = false;
    } catch (x) {
      erreur = message(x);
    } finally {
      occupe = false;
    }
  }
</script>

<article class="note" class:avant={etat === 'mise_en_avant'}>
  <header>
    <div class="signature">
      <strong>{note.auteur ?? 'compte supprimé'}</strong>
      {#if note.statutAuteur === 'analyste_osint_verifie'}<span class="pastille accent">Analyste OSINT vérifié</span>
      {:else}<span class="pastille">Analyste retiré</span>{/if}
      {#if note.auteurNotesMisesEnAvant >= 3}<span class="pastille">Notes souvent mises en avant</span>{/if}
    </div>
    <div class="petit discret">
      {date(note.ecriteLe)}{#if note.corrigeeLe}{' · '}corrigée le {date(note.corrigeeLe)} (version {note.version}){/if}
      {#if etat}{' · '}<span class="etat {etat}">{ETATS[etat]}</span>{/if}
    </div>
  </header>
  <h3>{note.constat}</h3>
  <p class="explication">{note.explication}</p>
  <ul class="liens">
    {#each note.liens as l (l)}
      <li><a href={l} target="_blank" rel="noopener noreferrer nofollow ugc"><span class="domaine">{domaine(l)}</span> <span class="url">{l}</span> ↗</a></li>
    {/each}
  </ul>
  {#if note.historique.length > 1}
    <details class="historique">
      <summary>Voir les {note.historique.length} versions</summary>
      <ol>
        {#each note.historique as v (v.version)}
          <li><span class="petit discret">Version {v.version}, {date(v.date)}</span><br /><strong>{v.constat}</strong>
            <p class="explication petit">{v.explication}</p></li>
        {/each}
      </ol>
    </details>
  {/if}

  {#if actions}{@render actions()}{/if}

  {#if juger}
    <div class="jugement">
      {#if jugement && !modifier}
        <p class="petit">Votre jugement : <strong>{AVIS[jugement.avis as keyof typeof AVIS]}</strong>
          <button class="bouton lien" onclick={() => { modifier = true; avis = jugement!.avis as keyof typeof AVIS; raisons = [...jugement!.raisons]; }}>changer</button></p>
      {:else}
        <form onsubmit={envoyer}>
          <fieldset>
            <legend>Cette note est-elle pertinente ?</legend>
            <div class="choix">
              {#each Object.entries(AVIS) as [cle, texte] (cle)}
                <label class:choisi={avis === cle}><input type="radio" name="avis-{note.note}" value={cle} checked={avis === cle}
                       onchange={() => choisirAvis(cle as keyof typeof AVIS)} /> {texte}</label>
              {/each}
            </div>
          </fieldset>
          {#if proposees.length}
            <fieldset class="raisons">
              <legend class="petit">Pourquoi ? (au moins une raison)</legend>
              {#each proposees as r (r.cle)}
                {@const contraire = proposees.find((x) => r.contraires?.includes(x.cle) && raisons.includes(x.cle))}
                <label class="case" class:bloquee={contraire}>
                  <input type="checkbox" value={r.cle} bind:group={raisons} disabled={!!contraire} />
                  <span>{r.libelle}{#if contraire}<span class="aide"> — incompatible avec « {contraire.libelle} »</span>{/if}</span>
                </label>
              {/each}
            </fieldset>
          {/if}
          {#if erreur}<div class="message erreur">{erreur}</div>{/if}
          <Manque raisons={[!avis && 'votre avis', !raisons.length && 'au moins une raison']}><button class="bouton" type="submit" disabled={occupe || !avis || !raisons.length}>Enregistrer mon jugement</button></Manque>
        </form>
      {/if}
    </div>
  {/if}
</article>

<style>
  .note { border: 1px solid var(--trait); border-radius: var(--rayon-grand); padding: 1.25rem; background: var(--surface); }
  .note + :global(.note) { margin-top: 1rem; }
  .note.avant { border-color: color-mix(in srgb, var(--accent) 60%, transparent); box-shadow: inset 3px 0 0 var(--accent); }
  header { display: flex; justify-content: space-between; gap: 0.5rem 1rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
  .signature { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  h3 { margin: 0.25rem 0 0.5rem; }
  .explication { white-space: pre-wrap; color: var(--texte-2); }
  .liens { list-style: none; padding: 0; margin: 0 0 0.75rem; display: grid; gap: 0.25rem; font-size: 0.875rem; }
  .liens a { word-break: break-all; }
  .domaine { font-weight: 700; }
  .url { color: var(--texte-3); }
  .etat.mise_en_avant { color: var(--accent-texte); font-weight: 700; }
  .etat.peu_utile { color: var(--texte-3); }
  .historique summary { cursor: pointer; font-size: 0.875rem; color: var(--accent-texte); }
  .historique ol { padding-left: 1.25rem; }
  .jugement { border-top: 1px solid var(--trait); margin-top: 1rem; padding-top: 1rem; }
  fieldset { border: 0; padding: 0; margin: 0 0 0.75rem; }
  legend { font-weight: 600; margin-bottom: 0.5rem; }
  .choix { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .choix label { border: 1px solid var(--trait-fort); border-radius: var(--rayon); padding: 0.375rem 0.875rem; cursor: pointer; }
  .choix label.choisi { border-color: var(--accent); background: var(--accent-doux); font-weight: 600; }
  .choix input { accent-color: var(--texte); }
  .bloquee { color: var(--texte-3); }
</style>
