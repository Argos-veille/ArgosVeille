<script lang="ts">
  // Règles de relecture : chaque enregistrement ajoute une version (clé physique + motif), inscrite au journal public.
  import Manque from '#lib/composants/Manque.svelte';
  import { ErreurApi } from '#lib/api.ts';
  import { changerRegles, regles, type BorneRegle, type VersionRegles } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  const GROUPES: [string, [string, string][]][] = [
    ['Relecture', [
      ['sample_size', 'Places par vidéo'], ['summons_per_seat', 'Convocations par place'],
      ['max_review_days', 'Durée max de la relecture (jours)'], ['summons_days', 'Validité d’une convocation (jours)'],
      ['reviews_per_day', 'Relectures max par jour et par relecteur'], ['min_total_weight', 'Poids minimal des votes'],
      ['publish_threshold', 'Seuil de publication'], ['reject_threshold', 'Seuil de rejet'],
      ['enlargement_size', 'Places ajoutées par élargissement'], ['max_enlargements', 'Élargissements max'],
    ]],
    ['Score des relecteurs', [
      ['score_initial', 'Score de départ'], ['score_min', 'Score minimum'], ['score_max', 'Score maximum'],
      ['novice_days', 'Période novice (jours)'], ['novice_factor', 'Poids d’un novice'],
      ['consensus_threshold', 'Seuil de consensus'], ['gain', 'Gain'], ['loss', 'Perte'],
      ['inactivity_days', 'Inactivité avant baisse (jours)'], ['decay', 'Baisse par jour d’inactivité'],
    ]],
    ['Vidéos de contrôle', [
      ['control_rate', 'Part des convocations'], ['control_loss', 'Perte sur erreur'], ['control_min_pool', 'Vidéos actives pour démarrer'],
    ]],
    ['Jury', [
      ['jury_size', 'Taille'], ['jury_majority', 'Majorité'], ['jury_min_votes', 'Votes minimum'],
      ['jury_pool_share', 'Part des relecteurs éligibles'], ['jury_min_age_days', 'Ancienneté du compte (jours)'],
      ['jury_max_per_week', 'Jurys max par semaine'], ['jury_days', 'Durée (jours)'], ['jury_publish_floor', 'Plancher de publication'],
    ]],
    ['Notes des analystes', [
      ['note_min_per_side', 'Évaluations min de chaque côté'], ['note_featured_share', 'Part « utile » pour la mise en avant'],
      ['note_unhelpful_share', 'Part « utile » sous laquelle la note est écartée'],
    ]],
    ['Divers', [['collusion_threshold', 'Seuil de collusion'], ['vote_unlink_months', 'Détachement des votes (mois)']]],
  ];
  const LIBELLES = Object.fromEntries(GROUPES.flatMap(([, l]) => l));

  let version = $state(0);
  let actuelles = $state<Record<string, number>>({});
  let bornes = $state<Record<string, BorneRegle>>({});
  let historique = $state<VersionRegles[]>([]);
  let saisie = $state<Record<string, number | null>>({});
  let motif = $state('');
  let erreur = $state('');
  let info = $state('');
  let enCours = $state(false);

  const changements = $derived(Object.fromEntries(Object.entries(saisie)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]) && e[1] !== actuelles[e[0]])));
  const nbChangements = $derived(Object.keys(changements).length);

  async function charger() {
    try {
      const r = await regles();
      version = r.version; actuelles = r.valeurs; bornes = r.bornes; historique = r.historique;
      saisie = { ...r.valeurs };
      erreur = '';
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    }
  }
  $effect(() => { charger(); });

  async function enregistrer(e: SubmitEvent) {
    e.preventDefault();
    enCours = true; erreur = ''; info = '';
    try {
      const r = await changerRegles(changements, motif.trim());
      motif = '';
      await charger();
      info = `Version ${r.version} en vigueur.`;
    } catch (x) {
      if (x instanceof ErreurApi && x.code === 'regles_invalides' && typeof x.corps['detail'] === 'string') erreur = x.corps['detail'];
      else if (!sessionExpiree(x)) erreur = message(x);
    } finally {
      enCours = false;
    }
  }
  const nombre = (v: number | null) => (v === null ? '—' : String(v));
  const date = (d: string) => new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
</script>

<div class="carte memo">
  <strong>Période de grâce (lancement, peu de relecteurs)</strong>
  <ul class="petit">
    <li>Places par vidéo : 7 au lieu de 15</li>
    <li>Poids minimal des votes plus bas</li>
    <li>Recours admin quand il n’y a pas assez de votes (à faire)</li>
  </ul>
</div>

{#if erreur}<div class="message erreur">{erreur}</div>{/if}
{#if info}<div class="message succes">{info}</div>{/if}

{#if version}
  <form onsubmit={enregistrer}>
    <p class="petit discret">Version {version}</p>
    {#each GROUPES as [titre, liste] (titre)}
      <section class="carte">
        <h2>{titre}</h2>
        {#each liste as [cle, libelle] (cle)}
          {#if bornes[cle] && saisie[cle] !== undefined}
            <label class="ligne" class:change={changements[cle] !== undefined}>
              <span>{libelle} <span class="discret petit">{cle}</span></span>
              <input type="number" inputmode="decimal" min={bornes[cle].min} max={bornes[cle].max}
                     step={bornes[cle].entier ? 1 : 'any'} bind:value={saisie[cle]} />
            </label>
          {/if}
        {/each}
      </section>
    {/each}
    {#if nbChangements}
      <section class="carte">
        <p class="petit">{#each Object.entries(changements) as [k, v] (k)}<span class="pastille">{LIBELLES[k] ?? k} : {nombre(actuelles[k] ?? null)} → {v}</span> {/each}</p>
        <label for="motif-regles">Motif</label>
        <textarea id="motif-regles" placeholder="Public : aucun nom ni détail identifiant" rows="2" maxlength="2000" bind:value={motif}></textarea>
        <p class="boutons"><Manque raisons={[motif.trim().length < 10 && 'motif (10 car.)']}><button class="bouton principal" disabled={enCours || motif.trim().length < 10}>Enregistrer avec la clé</button></Manque></p>
      </section>
    {/if}
  </form>

  <section class="carte">
    <h2>Historique</h2>
    {#each historique as h (h.version)}
      <div class="version">
        <p class="petit"><strong>Version {h.version}</strong> · {date(h.le)}{#if h.motif} · {h.motif}{/if}</p>
        {#if h.changements.length}
          <p class="petit discret">{h.changements.map((c) => `${LIBELLES[c.cle] ?? c.cle} : ${nombre(c.avant)} → ${c.apres}`).join(' · ')}</p>
        {/if}
      </div>
    {/each}
  </section>
{/if}

<style>
  .memo ul { margin: 0.25rem 0 0; padding-left: 1.25rem; }
  .ligne { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.4rem 0; border-bottom: 1px solid var(--trait); }
  .ligne:last-child { border-bottom: 0; }
  .ligne input { width: 8rem; flex: none; }
  .ligne.change span:first-child { font-weight: 700; }
  .version { padding: 0.5rem 0; border-bottom: 1px solid var(--trait); }
  .version:last-child { border-bottom: 0; }
  .pastille { margin-right: 0.25rem; }
</style>
