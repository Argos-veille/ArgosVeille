<script lang="ts">
  import { doublons, ecarterDoublon, rattacherDoublon, STATUTS_VIDEO, type Doublon, type VideoDoublon } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  const NIVEAUX: Record<Doublon['niveau'], string> = { exact: 'Copie exacte', strong: 'Forte ressemblance', possible: 'Ressemblance possible' };
  const pc = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)} %`);

  let ecartes = $state(false);
  let liste = $state<Doublon[] | null>(null);
  let erreur = $state('');
  let enCours = $state(false);

  const RATTACHABLES = ['awaiting_author', 'in_review', 'jury', 'under_debate', 'no_decision', 'published'];
  const peutEtreOrigine = (o: VideoDoublon, v: VideoDoublon) => o.statut === 'published' && RATTACHABLES.includes(v.statut);
  const origines = (d: Doublon) => [...(peutEtreOrigine(d.autre, d.video) ? [d.autre] : []), ...(peutEtreOrigine(d.video, d.autre) ? [d.video] : [])];

  let ouvert = $state<string | null>(null);
  let origine = $state('');
  let motif = $state('');

  function ouvrir(d: Doublon) {
    ouvert = ouvert === d.id ? null : d.id;
    origine = origines(d)[0]?.id ?? '';
    motif = '';
  }

  async function rattacher(d: Doublon) {
    enCours = true;
    erreur = '';
    try {
      await rattacherDoublon(d.id, origine === d.video.id ? d.autre.id : d.video.id, motif.trim());
      ouvert = null;
      await charger();
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    } finally {
      enCours = false;
    }
  }

  async function charger() {
    try {
      liste = (await doublons(ecartes)).doublons;
      erreur = '';
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    }
  }
  $effect(() => { void ecartes; charger(); });

  async function basculer(d: Doublon) {
    enCours = true;
    try {
      await ecarterDoublon(d.id, !ecartes);
      await charger();
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    } finally {
      enCours = false;
    }
  }
</script>

<div class="onglets" role="tablist">
  <button role="tab" class="bouton" aria-selected={!ecartes} onclick={() => (ecartes = false)}>À voir</button>
  <button role="tab" class="bouton" aria-selected={ecartes} onclick={() => (ecartes = true)}>Écartés</button>
</div>
{#if erreur}<div class="message erreur">{erreur}</div>{/if}
{#if liste}
  <div class="carte">
    {#each liste as d (d.id)}
      <div class="ligne">
        <div>
          <span class="pastille {d.niveau === 'possible' ? '' : 'accent'}">{NIVEAUX[d.niveau]}</span>
          <span class="petit discret">{new Date(d.le).toLocaleString('fr-FR')}</span>
          <div class="petit">
            <a href="/admin/videos/{d.video.id}">{d.video.pseudonyme ?? 'Vidéo'}</a> <span class="discret">({STATUTS_VIDEO[d.video.statut] ?? d.video.statut})</span>
            ↔
            <a href="/admin/videos/{d.autre.id}">{d.autre.pseudonyme ?? 'Vidéo'}</a> <span class="discret">({STATUTS_VIDEO[d.autre.statut] ?? d.autre.statut})</span>
          </div>
          <div class="petit discret">Image {pc(d.scores.visuel)} · Son {pc(d.scores.son)} · Caméra {pc(d.scores.camera)}</div>
        </div>
        <div class="actions">
          {#if !ecartes && origines(d).length}
            <button class="bouton" aria-pressed={ouvert === d.id} onclick={() => ouvrir(d)}>Rattacher</button>
          {/if}
          <button class="bouton" disabled={enCours} onclick={() => basculer(d)}>{ecartes ? 'Rétablir' : 'Écarter'}</button>
        </div>
        {#if ouvert === d.id}
          <div class="panneau">
            {#if origines(d).length > 1}
              <fieldset>
                <legend class="etiquette">Fiche d’origine</legend>
                {#each origines(d) as o (o.id)}
                  <label class="case"><input type="radio" name="origine-{d.id}" value={o.id} bind:group={origine} /> <span>{o.pseudonyme ?? 'Vidéo'}</span></label>
                {/each}
              </fieldset>
            {:else}
              <p class="petit">Fiche d’origine : {origines(d)[0]?.pseudonyme ?? 'Vidéo'}</p>
            {/if}
            <div class="champ">
              <label for="motif-{d.id}">Motif (public, inscrit au journal)</label>
              <textarea id="motif-{d.id}" placeholder="Public : aucun nom ni détail identifiant" rows="2" maxlength="2000" bind:value={motif}></textarea>
            </div>
            <button class="bouton principal" onclick={() => rattacher(d)} disabled={enCours || motif.trim().length < 10}>
              {enCours ? 'Touchez votre clé…' : 'Confirmer'}</button>
          </div>
        {/if}
      </div>
    {:else}
      <p class="second">Aucun doublon.</p>
    {/each}
  </div>
{/if}

<style>
  .onglets { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .onglets [aria-selected='true'] { border-color: var(--accent); background: var(--accent-doux); }
  .ligne { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.75rem 0; border-bottom: 1px solid var(--trait); flex-wrap: wrap; }
  .ligne:last-child { border-bottom: 0; }
  .actions { display: flex; gap: 0.5rem; }
  .panneau { flex-basis: 100%; }
</style>
