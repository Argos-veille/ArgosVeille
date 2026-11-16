<script lang="ts">
  // Journal public : chaque décision, retrait et changement de règle, enchaînés par leurs empreintes
  // (on ne peut ni modifier ni effacer une entrée sans que la vérification le révèle).
  import Info from '#lib/composants/Info.svelte';
  import { onMount } from 'svelte';
  import { message } from '#lib/erreurs.ts';
  import { chargerAncrages, chargerJournal, ficheDe, resume, TYPES, verifierDansLeNavigateur, verifierJournal,
           type Ancrage, type Entree, type Verification } from '#lib/journal.ts';

  let entrees = $state<Entree[]>([]);
  let suite = $state<number | null>(null);
  let type = $state('');
  let verification = $state<Verification | null>(null);
  let erreur = $state('');
  let ouverte = $state<number | null>(null);
  let ancrages = $state<Ancrage[]>([]);
  let local = $state<Awaited<ReturnType<typeof verifierDansLeNavigateur>> | null>(null);
  let enCours = $state(false);

  async function verifierLocalement() {
    enCours = true;
    try { local = await verifierDansLeNavigateur(ancrages); } catch (x) { erreur = message(x); } finally { enCours = false; }
  }
  const ETATS_ANCRAGE = { simule: 'Simulé (développement : rien n’est envoyé)', en_attente: 'En attente de confirmation dans Bitcoin', confirme: 'Confirmé' };

  const quand = (d: string) => new Date(d).toLocaleString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  async function charger(plus = false) {
    erreur = '';
    try {
      const q = new URLSearchParams({ ...(type ? { type } : {}), ...(plus && suite ? { avant: String(suite) } : {}) });
      const r = await chargerJournal(q.toString());
      entrees = plus ? [...entrees, ...r.entrees] : r.entrees;
      suite = r.suite;
    } catch (x) { erreur = message(x); }
  }
  onMount(async () => {
    void charger();
    try { verification = await verifierJournal(); } catch { /* affichée sans vérification */ }
    try { ancrages = (await chargerAncrages()).ancrages; } catch { /* section vide */ }
  });
</script>

<svelte:head><title>Journal public — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">Transparence</span>
  <h1>Journal public</h1>
  <p class="second">Décisions, retraits, règles, actions de l’administration : tout est inscrit ici.<Info>Chaque entrée
    contient l’empreinte de la précédente : modifier ou effacer une entrée casserait la chaîne, et la vérification le
    révélerait. Un nom de personne inscrit avant le 14 novembre 2026 est masqué : l’entrée et son empreinte restent.
    Les actions de l’administration et des sources sont inscrites dans les 24 heures, à une heure tirée
    au hasard : le journal ne permet pas de les dater.</Info></p>
  <!-- Un seul bandeau : le résultat du serveur, remplacé par celui du navigateur une fois la vérification
       faite (le navigateur n'a pas à nous croire). Désaccord entre les deux : avertissement explicite. -->
  {#if local}
    {@const ancresOk = local.ancres.filter((a) => a.correspond).length}
    {@const intactLocal = local.rupture === null && ancresOk === local.ancres.length}
    {#if verification && verification.intact !== (local.rupture === null)}
      <div class="message erreur" role="alert">
        <strong>Désaccord :</strong> notre serveur annonce une chaîne {verification.intact ? 'intacte' : 'rompue'}, mais votre
        navigateur la trouve {local.rupture === null ? 'intacte' : `rompue à l’entrée n° ${local.rupture}`}. Fiez-vous à votre
        navigateur : un tel écart signifie que le serveur est en panne ou a été modifié.
      </div>
    {:else}
      <div class="message {intactLocal ? 'succes' : 'erreur'}" role="status">
        Vérifié par votre navigateur : {local.nombre} entrées{local.rupture === null ? ' intactes' : `, chaîne rompue à l’entrée n° ${local.rupture}`}{#if local.masquees}
          (dont {local.masquees} au contenu masqué, donnée personnelle){/if}{#if local.ancres.length},
          {ancresOk} ancrage{local.ancres.length > 1 ? 's' : ''} Bitcoin sur {local.ancres.length}
          correspond{ancresOk > 1 ? 'ent' : ''}{/if}.
      </div>
    {/if}
  {:else if verification}
    <div class="message {verification.intact ? 'succes' : 'erreur'}">
      {#if verification.intact}Vérification par notre serveur : les {verification.entrees} entrées sont intactes.
        Vous pouvez le vérifier vous-même ci-dessous.
      {:else}Attention : la chaîne est rompue à partir de l’entrée n° {verification.premiereEntreeInvalide}.{/if}
    </div>
  {/if}
  <section class="carte ancrages">
    <h2>Ancrages dans Bitcoin</h2>
    <p class="petit second">Chaque jour, l’état du journal est inscrit dans Bitcoin : personne, pas même nous, ne peut le
      réécrire après coup.<Info>Via OpenTimestamps. Seule l’empreinte de la dernière entrée, qui engage toutes les
      précédentes, quitte notre serveur.</Info></p>
    <button class="bouton" onclick={verifierLocalement} disabled={enCours}>
      {enCours ? 'Vérification…' : 'Vérifier toute la chaîne dans mon navigateur'}
    </button>
    <ul class="liste-ancrages">
      {#each ancrages as a (a.jour)}
        <li>
          <div><strong>{new Date(`${a.jour}T12:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>
            <span class="petit discret"> · jusqu’à l’entrée n° {a.derniereEntree}</span></div>
          <div class="petit">{a.etat === 'confirme' ? `Confirmé dans le bloc Bitcoin n° ${a.blocBitcoin?.toLocaleString('fr-FR')}` : ETATS_ANCRAGE[a.etat]}
            {#if local}{' · '}{local.ancres.find((x) => x.jour === a.jour)?.correspond ? '✓ correspond' : '✗ ne correspond pas'}{/if}</div>
          <div class="petit mono empreinte">{a.empreinte}</div>
          {#if a.preuve}<a class="petit" href="/api/public/journal/ancrages/{a.jour}/preuve.ots" download>Télécharger la preuve (.ots)</a>{/if}
        </li>
      {:else}
        <li class="discret petit">Aucun ancrage pour l’instant : le premier a lieu dans la journée.</li>
      {/each}
    </ul>
    <details class="petit">
      <summary>Vérifier une preuve soi-même, sans nous faire confiance</summary>
      <ol>
        <li>Téléchargez la preuve <code>.ots</code> d’un jour.</li>
        <li>Recalculez la chaîne : le bouton ci-dessus le fait dans votre navigateur, à partir de
          l’<a href="/api/public/journal/export" download="argos-veille-journal.json">export complet du journal</a> (formule
          incluse). L’empreinte de l’entrée indiquée doit être celle de l’ancrage.</li>
        <li>Déposez la preuve sur <a href="https://opentimestamps.org" target="_blank" rel="noopener noreferrer">opentimestamps.org</a>,
          ou utilisez l’outil libre <code>ots verify</code> : il confirme que cette empreinte existait à la date du bloc Bitcoin.</li>
      </ol>
    </details>
  </section>
  <label class="filtre">Afficher
    <select bind:value={type} onchange={() => charger()}>
      <option value="">Toutes les entrées</option>
      {#each Object.entries(TYPES) as [cle, texte] (cle)}<option value={cle}>{texte}</option>{/each}
    </select>
  </label>
  {#if erreur}<div class="message erreur">{erreur}</div>{/if}
  <ol class="journal">
    {#each entrees as e (e.numero)}
      <li>
        <div class="tete">
          <span class="mono petit discret">n° {e.numero}</span>
          <span class="pastille">{TYPES[e.type] ?? e.type}</span>
          <span class="petit discret">{quand(e.le)}</span>
        </div>
        <p>{resume(e)}{#if ficheDe(e)}{' · '}<a href={ficheDe(e)}>voir la fiche</a>{/if}</p>
        {#if typeof e.contenu['reason'] === 'string'}<p class="petit second">Motif : {e.contenu['reason']}</p>{/if}
        <button class="bouton lien petit" onclick={() => (ouverte = ouverte === e.numero ? null : e.numero)}>
          {ouverte === e.numero ? 'Masquer le détail' : 'Détail et empreintes'}
        </button>
        {#if ouverte === e.numero}
          <pre>{JSON.stringify(e.contenu, null, 2)}</pre>
          <p class="petit mono empreinte">empreinte {e.empreinte}<br />précédente {e.precedente}</p>
        {/if}
      </li>
    {:else}
      {#if !erreur}<li class="discret">Aucune entrée.</li>{/if}
    {/each}
  </ol>
  {#if suite}<button class="bouton" onclick={() => charger(true)}>Entrées plus anciennes</button>{/if}
</div>

<style>
  .ancrages { margin-bottom: 1.5rem; }
  .liste-ancrages { list-style: none; padding: 0; margin: 1rem 0; display: grid; gap: 0.75rem; }
  .liste-ancrages li { border-top: 1px solid var(--trait); padding-top: 0.75rem; display: grid; gap: 0.125rem; }
  .filtre { display: inline-flex; gap: 0.5rem; align-items: center; font-weight: 600; font-size: 0.875rem; margin-bottom: 1rem; }
  .filtre select { width: auto; }
  .journal { list-style: none; padding: 0; margin: 0 0 1rem; }
  .journal li { padding: 0.875rem 0; border-bottom: 1px solid var(--trait); }
  .journal p { margin: 0.25rem 0; }
  .tete { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  pre { background: var(--surface-2); border-radius: var(--rayon); padding: 0.75rem; font-size: 0.75rem; overflow: auto; }
  .empreinte { word-break: break-all; color: var(--texte-3); }
</style>
