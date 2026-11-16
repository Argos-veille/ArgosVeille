<script lang="ts">
  // Lecteur de la version floutée, pensé pour vérifier : image par image, vitesse réduite, temps
  // affiché au centième. Le lien de visionnage expire au bout de 10 minutes : s'il a expiré, on en
  // redemande un en gardant la position.
  import { onMount } from 'svelte';
  import { message } from '#lib/erreurs.ts';
  import { garderSon, son } from '#lib/son.svelte.ts';
  import { ajouterPassage, dureeVue, type Passage } from '#lib/visionnage.ts';

  // Premier visionnage : on compte la part de la vidéo réellement vue (lecture normale ou accélérée),
  // c'est-à-dire l'union des passages regardés : revoir le même passage en boucle ne compte qu'une fois,
  // et un saut en avant ne compte pas. À 90 % de la durée, `vue` est appelé une fois.
  // `direct` : vidéo chargée tout de suite, sans bouton « Voir la vidéo » (suivi : la source connaît sa vidéo).
  let { obtenirLien, ouverte = () => {}, vue = () => {}, progression = () => {}, direct = false }: {
    obtenirLien: (qualite: 'apercu' | 'complete') => Promise<string>;
    direct?: boolean;
    ouverte?: () => void;
    vue?: () => void;
    progression?: (part: number) => void;
  } = $props();
  const SEUIL_VU = 0.9;
  /** Passages vus, en secondes, triés et sans chevauchement. */
  let passages: Passage[] = [];
  let dernier: number | null = null;
  let vueSignalee = false;
  function compter() {
    if (!video) return;
    const t = video.currentTime;
    if (!video.paused && dernier !== null && t > dernier && t - dernier <= 2) passages = ajouterPassage(passages, dernier, t);
    dernier = t;
    const d = video.duration;
    if (!d || !Number.isFinite(d)) return;
    const part = Math.min(1, dureeVue(passages) / d);
    progression(part);
    if (!vueSignalee && part >= SEUIL_VU) { vueSignalee = true; vue(); }
  }

  const IMAGE = 1 / 30;
  let video: HTMLVideoElement | undefined = $state();
  let source = $state('');
  let qualite = $state<'complete' | 'apercu'>('complete');
  let enCours = $state(false);
  let erreur = $state('');
  let temps = $state(0);
  let duree = $state(0);
  let lecture = $state(false);
  let vitesse = $state(1);
  let reprise = 0;

  async function charger() {
    erreur = '';
    enCours = true;
    try {
      reprise = video?.currentTime ?? 0;
      source = `/api${await obtenirLien(qualite)}`;
      ouverte();
    } catch (x) {
      erreur = message(x);
    } finally {
      enCours = false;
    }
  }
  onMount(() => { if (direct) charger(); });

  function pas(n: number) {
    if (!video) return;
    video.pause();
    video.currentTime = Math.min(Math.max(0, video.currentTime + n * IMAGE), duree || video.duration);
  }
  function basculer() {
    if (!video) return;
    if (video.paused) void video.play(); else video.pause();
  }
  // Plein écran : tout le lecteur (vidéo ET commandes image par image), pas seulement la vidéo.
  let cadre = $state<HTMLDivElement | null>(null);
  let pleinEcran = $state(false);
  type DocWebkit = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
  const enPleinEcran = () => (document.fullscreenElement ?? (document as DocWebkit).webkitFullscreenElement ?? null);
  function basculerPleinEcran() {
    // Sortir seulement si c'est CE lecteur qui est en plein écran (deux lecteurs possibles sur une page).
    if (enPleinEcran() === cadre) {
      if (document.exitFullscreen) void document.exitFullscreen(); else (document as DocWebkit).webkitExitFullscreen?.();
      return;
    }
    const el = cadre as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    if (el?.requestFullscreen && document.fullscreenEnabled) { void el.requestFullscreen().catch(() => {}); return; }
    if (el?.webkitRequestFullscreen) { el.webkitRequestFullscreen(); return; }   // iPad (anciennes versions)
    // iPhone (Safari iOS) : pas de plein écran pour un bloc ; celui de la vidéo (sans les commandes image par image).
    (video as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)?.webkitEnterFullscreen?.();
  }
  $effect(() => {
    const suivre = () => { pleinEcran = enPleinEcran() === cadre; };
    document.addEventListener('fullscreenchange', suivre);
    document.addEventListener('webkitfullscreenchange', suivre);
    return () => { document.removeEventListener('fullscreenchange', suivre); document.removeEventListener('webkitfullscreenchange', suivre); };
  });
  const format = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;

  function clavier(e: KeyboardEvent) {
    if (!source || e.ctrlKey || e.metaKey || e.altKey) return;   // Ctrl+F, Cmd+F… restent au navigateur
    if (e.key === ',' || e.key === 'ArrowLeft') { e.preventDefault(); pas(e.key === ',' ? -1 : -15); }
    if (e.key === '.' || e.key === 'ArrowRight') { e.preventDefault(); pas(e.key === '.' ? 1 : 15); }
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); basculer(); }
    if (e.key.toLowerCase() === 'f') { e.preventDefault(); basculerPleinEcran(); }
  }
  $effect(() => { if (video) video.playbackRate = vitesse; });
  $effect(() => { if (video) { video.volume = son.volume; video.muted = son.muet; } });
</script>

<div class="lecteur" class:plein={pleinEcran} role="region" aria-label="Lecteur vidéo" bind:this={cadre}>
  {#if !source}
    <div class="avant">
      <p>La vidéo n’est montrée qu’en version floutée, par un lien personnel valable 10 minutes.</p>
      <div class="boutons">
        <button class="bouton principal" onclick={charger} disabled={enCours}>{enCours ? 'Chargement…' : 'Voir la vidéo'}</button>
        <label class="petit"><input type="checkbox" checked={qualite === 'apercu'}
               onchange={(e) => (qualite = e.currentTarget.checked ? 'apercu' : 'complete')} /> Version légère (connexion lente)</label>
      </div>
      {#if erreur}<div class="message erreur">{erreur}</div>{/if}
    </div>
  {:else}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video bind:this={video} src={source} preload="metadata" playsinline tabindex="0" onkeydown={clavier}
           bind:currentTime={temps} bind:duration={duree}
           onplay={() => { lecture = true; dernier = video?.currentTime ?? null; }} onpause={() => (lecture = false)}
           ontimeupdate={compter} onseeking={() => (dernier = null)} onseeked={() => (dernier = video?.currentTime ?? null)}
           onended={compter}
           onloadedmetadata={() => { if (video && reprise) video.currentTime = reprise; }}
           onerror={() => { erreur = 'La vidéo n’a pas pu être lue (le lien a peut-être expiré).'; }}></video>
    <div class="commandes">
      <button class="bouton" onclick={() => pas(-1)} aria-label="Image précédente" title="Image précédente (,)">⟨ 1 image</button>
      <button class="bouton principal" onclick={basculer}>{lecture ? 'Pause' : 'Lecture'}</button>
      <button class="bouton" onclick={() => pas(1)} aria-label="Image suivante" title="Image suivante (.)">1 image ⟩</button>
      <label class="vitesse">Vitesse
        <select bind:value={vitesse}>
          <option value={0.25}>× 0,25</option><option value={0.5}>× 0,5</option><option value={1}>× 1</option><option value={1.5}>× 1,5</option>
        </select>
      </label>
      <span class="volume">
        <button class="bouton" onclick={() => { son.muet = !son.muet; garderSon(); }}
                aria-label={son.muet ? 'Remettre le son' : 'Couper le son'} title={son.muet ? 'Remettre le son' : 'Couper le son'}>
          {#if son.muet || son.volume === 0}
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          {/if}
        </button>
        <input type="range" min="0" max="1" step="0.05" value={son.muet ? 0 : son.volume} aria-label="Volume"
               oninput={(e) => { son.volume = Number(e.currentTarget.value); son.muet = son.volume === 0; garderSon(); }} />
      </span>
      <span class="temps mono">{format(temps)} / {format(duree || 0)}</span>
      <button class="bouton" onclick={basculerPleinEcran} title="Plein écran (f)">{pleinEcran ? 'Quitter le plein écran' : 'Plein écran'}</button>
    </div>
    <input class="frise" type="range" min="0" max={duree || 0} step={IMAGE} bind:value={temps}
           oninput={(e) => { if (video) video.currentTime = Number(e.currentTarget.value); }} aria-label="Position dans la vidéo" />
    <p class="aide">Raccourcis (vidéo sélectionnée) : espace = lecture/pause, « , » et « . » = image par image, flèches = ± ½ seconde, « f » = plein écran.</p>
    {#if erreur}<div class="message erreur">{erreur} <button class="bouton lien" onclick={charger}>Recharger</button></div>{/if}
  {/if}
</div>

<style>
  .lecteur { background: var(--surface); border: 1px solid var(--trait); border-radius: var(--rayon-grand); overflow: hidden; }
  .avant { padding: 2rem 1.5rem; aspect-ratio: 16 / 9; display: grid; place-content: center; text-align: center;
           background: repeating-linear-gradient(135deg, var(--surface-2) 0 12px, var(--surface) 12px 24px); }
  .avant .boutons { justify-content: center; }
  video { display: block; width: 100%; aspect-ratio: 16 / 9; background: #000; }
  .commandes { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; padding: 0.75rem 1rem 0.25rem; }
  .vitesse { display: inline-flex; gap: 0.4rem; align-items: center; font-size: 0.875rem; color: var(--texte-2); }
  .vitesse select { width: auto; min-height: 2.5rem; padding: 0.25rem 0.5rem; }
  .temps { margin-left: auto; color: var(--texte-2); }
  .volume { display: inline-flex; align-items: center; gap: 0.375rem; }
  .volume .bouton { padding: 0.5rem; width: 2.5rem; }
  .volume input { width: 6rem; accent-color: var(--accent); }
  .frise { width: calc(100% - 2rem); margin: 0.5rem 1rem 0; accent-color: var(--accent); }
  .aide { padding: 0 1rem 0.75rem; margin: 0; }
  .message { margin: 0 1rem 1rem; }
  /* Plein écran : la vidéo prend toute la hauteur restante au-dessus des commandes. */
  .lecteur.plein { display: flex; flex-direction: column; border-radius: 0; border: 0; height: 100vh; height: 100dvh; }
  .lecteur.plein video { flex: 1; min-height: 0; aspect-ratio: auto; width: 100%; object-fit: contain; }
</style>
