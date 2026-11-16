<script lang="ts">
  // Lecteur intégré sur d'autres sites (iframe). Rien ne se lance tout seul : avertissement, puis lecture
  // sur clic. Pas de cookie, pas de traceur. Une vidéo masquée ou retirée disparaît d'ici aussi.
  import { page } from '$app/state';
  import { onMount, tick } from 'svelte';
  import { ErreurApi, get, post } from '#lib/api.ts';
  import { CATEGORIES, FORCES, SOUS_CATEGORIES, libellesChoix } from '#lib/libelles.ts';
  import { son } from '#lib/son.svelte.ts';

  interface Fiche { id: string; etat: 'publiee' | 'en_debat'; categorie: string; sousCategorie: string; sousCategories: string[]; forces: string;
                    date: string; heureConnue: boolean }
  let fiche = $state<Fiche | null>(null);
  let absente = $state<'masquee' | 'retiree' | 'introuvable' | null>(null);
  let source = $state('');
  let chargement = $state(false);
  let video: HTMLVideoElement | undefined = $state();
  const id = page.params['id']!;
  const lienFiche = `/videos/${id}`;
  const quand = (f: Fiche) => f.heureConnue
    ? new Date(f.date).toLocaleString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : new Date(`${f.date}T12:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  onMount(async () => {
    try {
      fiche = await get<Fiche>(`/public/videos/${id}`);
    } catch (x) {
      absente = x instanceof ErreurApi && x.statut === 410 ? (x.code === 'video_masquee' ? 'masquee' : 'retiree') : 'introuvable';
    }
  });

  async function lire() {
    chargement = true;
    try {
      source = `/api${(await post<{ lien: string }>(`/public/videos/${id}/video`)).lien}`;
      await tick();
      if (video) { video.volume = son.volume; video.muted = son.muet; void video.play().catch(() => {}); }
    } finally {
      chargement = false;
    }
  }
</script>

<svelte:head><title>Vidéo — Argos Veille</title><meta name="robots" content="noindex" /></svelte:head>

<div class="cadre">
  {#if absente}
    <div class="ecran">
      <p>{absente === 'masquee' ? 'Cette vidéo est en cours d’examen.' : absente === 'retiree' ? 'Cette vidéo a été retirée pour motif légal.' : 'Vidéo introuvable.'}</p>
      <a href="/journal" target="_blank" rel="noopener">Journal public d’Argos Veille ↗</a>
    </div>
  {:else if fiche}
    {#if source}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} src={source} controls playsinline preload="auto"></video>
    {:else}
      <div class="ecran">
        <p class="alerte">Vidéo de violences ou d’abus policiers : elle peut contenir des images choquantes.</p>
        <button onclick={lire} disabled={chargement}>{chargement ? 'Chargement…' : '▶ Lire la vidéo'}</button>
        <p class="petit">Visages floutés · lecture depuis argos-veille.fr, sans cookie ni traceur</p>
      </div>
    {/if}
    <div class="legende">
      <div>
        <strong>{CATEGORIES[fiche.categorie]} · {libellesChoix(fiche.sousCategories, SOUS_CATEGORIES)}</strong>
        <span>{quand(fiche)} · {FORCES[fiche.forces]}{fiche.etat === 'en_debat' ? ' · en débat' : ''}</span>
        <em>Faits allégués, non jugés.</em>
      </div>
      <a href={lienFiche} target="_blank" rel="noopener">Argos Veille ↗</a>
    </div>
  {/if}
</div>

<style>
  :global(body) { margin: 0; background: #121417; }
  .cadre { display: flex; flex-direction: column; height: 100vh; color: #f3f1ec; font: 14px/1.4 var(--police, system-ui, sans-serif); }
  video, .ecran { flex: 1; min-height: 0; width: 100%; background: #000; }
  video { object-fit: contain; }
  .ecran { display: grid; place-content: center; justify-items: center; gap: 0.75rem; padding: 1rem; text-align: center; }
  .alerte { max-width: 28rem; margin: 0; }
  button { font: inherit; font-weight: 700; padding: 0.625rem 1.25rem; border: 0; border-radius: 999px; background: #e8a33d; color: #121417; cursor: pointer; }
  .petit { font-size: 12px; opacity: 0.7; margin: 0; }
  .legende { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.625rem 0.875rem; background: #1c1f24; }
  .legende div { display: grid; }
  .legende span, .legende em { font-size: 12px; opacity: 0.8; }
  a { color: #e8a33d; white-space: nowrap; }
</style>
