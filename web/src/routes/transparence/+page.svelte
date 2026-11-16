<script lang="ts">
  // Rapport de transparence : ce que la plateforme a fait pendant un trimestre terminé.
  // Petits nombres masqués côté serveur (« <5 »). Mêmes données que GET /api/v1/transparence.
  import { onMount } from 'svelte';
  import { get } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';

  type Compte = number | '<5';
  type Repartition = Record<string, Compte>;
  interface Rapport {
    trimestre: string;
    envois: { recues: Compte; echecs: Compte; retireesParLaSource: Compte };
    decisions: { parResultat: Repartition; parQui: Repartition; delaiMedianJours: number | null };
    signalements: { parMotif: Repartition; parSuite: Repartition };
    retraits: Repartition; corrections: Compte; changementsDeRegles: Compte; sanctions: Repartition;
    originaux: { parAdministration: Repartition; parLaSource: Repartition; ouverturesParAdministration: Compte };
    autorites: { parAuteur: Repartition; parObjet: Repartition; parSuite: Repartition };
  }
  interface Reponse { trimestres: string[]; prochain: string; rapport: Rapport | null }

  const RESULTATS = { published: 'Publiées', rejected: 'Rejetées', under_debate: 'En débat', no_decision: 'Sans décision' };
  const QUI = { communaute: 'Relecteurs', jury: 'Jury', administration: 'Administration' };
  const MOTIFS = { visible_identity: 'Identité visible', identifying_text: 'Texte identifiant', illegal_content: 'Contenu illégal', defamation: 'Diffamation',
                   wrong_context: 'Contexte faux', other: 'Autre' };
  const SUITES = { open: 'En cours', handled: 'Suivis d’une action', dismissed: 'Écartés' };
  const RETRAITS = { hidden: 'Masquées', removed: 'Retirées' };
  const SANCTIONS = { suspend: 'Suspensions', ban: 'Exclusions' };
  const AUTEURS = { police: 'Police ou gendarmerie', judicial: 'Parquet ou juge', administration: 'Administration', other: 'Autre' };
  const OBJETS = { removal: 'Retrait d’une vidéo', identification: 'Identification d’une personne', preservation: 'Conservation',
                   other: 'Autre' };
  const SUITES_AUTORITES = { pending: 'En cours', complied: 'Satisfaites', partial: 'En partie', refused: 'Refusées ou contestées' };
  const DESTINATAIRES = { lawyer: 'Avocat', journalist: 'Journaliste', association: 'Association', other: 'Autre' };

  let r = $state<Reponse | null>(null);
  let choisi = $state('');
  let erreur = $state('');

  async function charger(t?: string) {
    erreur = '';
    try {
      r = await get<Reponse>(`/public/transparence${t ? `?trimestre=${t}` : ''}`);
      choisi = r.rapport?.trimestre ?? '';
    } catch (x) { erreur = message(x); }
  }
  onMount(() => charger());

  const nomTrimestre = (t: string) => `${['1er', '2e', '3e', '4e'][Number(t.slice(6)) - 1]} trimestre ${t.slice(0, 4)}`;
  const n = (c: Compte | undefined) => (c === undefined ? '0' : c === '<5' ? 'moins de 5' : c.toLocaleString('fr-FR'));
  const lignes = (rep: Repartition, noms: Record<string, string>) => Object.entries(noms).map(([code, nom]) => ({ nom, n: n(rep[code]) }));
  const jourLong = (d: string) => new Date(`${d}T12:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
</script>

{#snippet tableau(titre: string, liste: { nom: string; n: string }[])}
  <div class="bloc">
    <h3>{titre}</h3>
    <dl>{#each liste as l (l.nom)}<dt>{l.nom}</dt><dd>{l.n}</dd>{/each}</dl>
  </div>
{/snippet}

<svelte:head><title>Rapport de transparence — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">Transparence</span>
  <h1>Rapport de transparence</h1>
  <p class="second">Ce que la plateforme a fait chaque trimestre. Les nombres de 1 à 4 sont affichés « moins de 5 » :
    aucun chiffre ne permet de remonter à une personne.</p>

  {#if erreur}
    <div class="message erreur" role="alert">{erreur}</div>
  {:else if !r}
    <p class="second">Chargement…</p>
  {:else if !r.rapport}
    <section class="carte"><p>Le premier rapport paraîtra le {jourLong(r.prochain)}, à la fin du trimestre en cours.</p></section>
  {:else}
    {@const p = r.rapport}
    <div class="filtres">
      <label>Trimestre
        <select bind:value={choisi} onchange={() => charger(choisi)}>
          {#each r.trimestres as t (t)}<option value={t}>{nomTrimestre(t)}</option>{/each}
        </select>
      </label>
    </div>

    <section class="carte">
      <h2>Envois</h2>
      {@render tableau('', [{ nom: 'Vidéos reçues', n: n(p.envois.recues) }, { nom: 'Échecs de traitement', n: n(p.envois.echecs) },
                            { nom: 'Retirées par leur source', n: n(p.envois.retireesParLaSource) }])}
    </section>

    <section class="carte">
      <h2>Décisions</h2>
      <div class="grille">
        {@render tableau('Résultat', lignes(p.decisions.parResultat, RESULTATS))}
        {@render tableau('Prises par', lignes(p.decisions.parQui, QUI))}
      </div>
      <p class="petit second">Délai médian entre la réception et la décision :
        {p.decisions.delaiMedianJours === null ? 'trop peu de décisions pour le calculer' :
         p.decisions.delaiMedianJours < 1 ? 'moins d’un jour' : `${p.decisions.delaiMedianJours} jour${p.decisions.delaiMedianJours > 1 ? 's' : ''}`}.</p>
    </section>

    <section class="carte">
      <h2>Signalements et retraits</h2>
      <div class="grille">
        {@render tableau('Signalements reçus', lignes(p.signalements.parMotif, MOTIFS))}
        {@render tableau('Suite donnée', lignes(p.signalements.parSuite, SUITES))}
        {@render tableau('Vidéos retirées par l’administration', lignes(p.retraits, RETRAITS))}
      </div>
    </section>

    <section class="carte">
      <h2>Demandes des autorités</h2>
      <div class="grille">
        {@render tableau('De', lignes(p.autorites.parAuteur, AUTEURS))}
        {@render tableau('Objet', lignes(p.autorites.parObjet, OBJETS))}
        {@render tableau('Suite donnée', lignes(p.autorites.parSuite, SUITES_AUTORITES))}
      </div>
    </section>

    <section class="carte">
      <h2>Originaux non floutés</h2>
      <div class="grille">
        {@render tableau('Transmis par l’administration', lignes(p.originaux.parAdministration, DESTINATAIRES))}
        {@render tableau('Transmis par la source', lignes(p.originaux.parLaSource, DESTINATAIRES))}
      </div>
      <p class="petit second">Ouverts par l’administration : {n(p.originaux.ouverturesParAdministration)}.</p>
    </section>

    <section class="carte">
      <h2>Comptes et règles</h2>
      <div class="grille">
        {@render tableau('Comptes sanctionnés', lignes(p.sanctions, SANCTIONS))}
        {@render tableau('Autres', [{ nom: 'Lieux ou dates corrigés par un analyste', n: n(p.corrections) },
                                    { nom: 'Changements de règles', n: n(p.changementsDeRegles) }])}
      </div>
    </section>

    <p class="petit second note">Le détail de chaque décision est dans le <a href="/journal">journal public</a>. Réutilisable
      sous licence CC BY 4.0 : <a href="/donnees">données ouvertes et API</a>.</p>
  {/if}
</div>

<style>
  .filtres { margin: 1.25rem 0; }
  .filtres label { display: inline-flex; flex-direction: column; gap: 0.25rem; font-weight: 600; font-size: 0.875rem; }
  .grille { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1.25rem; }
  h3 { font-size: 0.9375rem; margin: 0 0 0.375rem; }
  h3:empty { display: none; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 0.25rem 1rem; margin: 0; }
  dt { color: var(--texte-2); }
  dd { margin: 0; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
  .carte p.petit { margin: 0.75rem 0 0; }
  .note { margin-top: 1rem; }
</style>
