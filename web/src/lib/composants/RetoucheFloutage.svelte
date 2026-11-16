<script lang="ts">
  // Retouche du floutage par la source : retirer le flou d'un visage détecté à tort (ou déjà public),
  // ajouter une zone à flouter (visage oublié, plaque, tatouage, écran…). Les cadres affichés suivent
  // les visages floutés ; une zone ajoutée suit un chemin de points de passage, posés image par image, pour coller aux
  // mouvements irréguliers de la caméra. Le serveur refait ensuite le rendu (10 retouches au plus).
  import Manque from '#lib/composants/Manque.svelte';
  import { untrack } from 'svelte';
  import { aplatir, interpoler, poser, regrouper, type Point } from '#lib/chemins.ts';
  import { message } from '#lib/erreurs.ts';
  import { garderSon, son } from '#lib/son.svelte.ts';

  export interface Piste { id: number; instants: number[]; zones: number[][] }
  export interface Zone { debut: number; fin: number; de: number[]; a: number[] }

  // `libelle` : texte du bouton d'envoi (re-floutage par l'administration : pas de compte de retouches).
  let { obtenirLien, pistes, retouche, retouchesRestantes, appliquer, libelle }: {
    obtenirLien: () => Promise<string>;
    pistes: Piste[];
    retouche: { retirees: number[]; zones: Zone[] };
    retouchesRestantes: number;
    libelle?: string;
    appliquer: (retirees: number[], zones: Zone[]) => Promise<void>;
  } = $props();

  const IMAGE = 1 / 30;
  const MARGE = 0.3;   // secondes : un cadre reste affiché un peu avant et après ses vues (comme le flou)
  let video: HTMLVideoElement | undefined = $state();
  let calque: SVGSVGElement | undefined = $state();
  let source = $state('');
  let temps = $state(0);
  let duree = $state(0);
  let ratio = $state(16 / 9);
  // État de la retouche, parti de la dernière retouche appliquée.
  let retirees = $state<number[]>(untrack(() => [...retouche.retirees]));
  let chemins = $state<Point[][]>(untrack(() => regrouper(retouche.zones)));
  // Zone en cours : ses points de passage, le rectangle qu'on est en train de tracer ou de déplacer.
  let trace = $state<null | { index: number | null; points: Point[]; rect: number[] | null }>(null);
  let prise: null | { deplace: boolean; depart: [number, number]; base: number[] } = null;
  const SEGMENTS_MAX = 500;
  const segments = $derived(aplatir(chemins).length);
  // Cadre affiché pendant le tracé : celui qu'on bouge, sinon la position calculée à cet instant.
  const courant = $derived(trace ? trace.rect ?? interpoler(trace.points, temps, true) : null);
  let erreur = $state('');
  let envoi = $state(false);

  $effect(() => { if (video) { video.volume = son.volume; video.muted = son.muet; } });
  // Visages présents sur l'image affichée ; la liste complète seulement sur demande.
  let tousLesVisages = $state(false);
  const presents = $derived(pistes.filter((p) => cadre(p, temps) !== null));
  const listes = $derived(tousLesVisages ? pistes : presents);
  const retiresAilleurs = $derived(pistes.filter((p) => retirees.includes(p.id) && !listes.includes(p)));
  const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  const ajoutees = $derived(retirees.length > 0);

  async function charger() {
    erreur = '';
    try { source = `/api${await obtenirLien()}`; } catch (x) { erreur = message(x); }
  }
  charger();

  /** Cadre d'une piste à l'instant t (interpolé entre deux vues), ou null hors de sa présence. */
  function cadre(p: Piste, t: number): number[] | null {
    const n = p.instants.length;
    if (!n || t < p.instants[0]! - MARGE || t > p.instants[n - 1]! + MARGE) return null;
    if (n === 1 || t <= p.instants[0]!) return p.zones[0]!;
    if (t >= p.instants[n - 1]!) return p.zones[n - 1]!;
    let i = 0;
    while (i < n - 2 && p.instants[i + 1]! < t) i++;
    const f = (t - p.instants[i]!) / (p.instants[i + 1]! - p.instants[i]! || 1);
    return p.zones[i]!.map((v, k) => v + (p.zones[i + 1]![k]! - v) * f);
  }

  function aller(t: number) {
    if (!video) return;
    video.pause();
    video.currentTime = Math.max(0, Math.min(t, duree || t));
  }
  function basculer(id: number) {
    retirees = retirees.includes(id) ? retirees.filter((x) => x !== id) : [...retirees, id];
  }

  // --- Tracé d'un rectangle sur l'image (souris ou doigt) ------------------------------------------
  function point(e: PointerEvent): [number, number] {
    const r = calque!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  }
  function appui(e: PointerEvent) {
    if (!trace) return;
    video?.pause();
    calque!.setPointerCapture(e.pointerId);
    const p = point(e);
    const c = courant;
    const dedans = !!c && p[0] >= c[0]! && p[0] <= c[0]! + c[2]! && p[1] >= c[1]! && p[1] <= c[1]! + c[3]!;
    prise = { deplace: dedans, depart: p, base: dedans ? [...c!] : [p[0], p[1], 0, 0] };
    trace.rect = prise.base;
  }
  function glisse(e: PointerEvent) {
    if (!trace || !prise) return;
    const [x, y] = point(e);
    const { deplace, depart, base } = prise;
    trace.rect = deplace
      ? [Math.min(1 - base[2]!, Math.max(0, base[0]! + x - depart[0])), Math.min(1 - base[3]!, Math.max(0, base[1]! + y - depart[1])), base[2]!, base[3]!]
      : [Math.min(x, depart[0]), Math.min(y, depart[1]), Math.abs(x - depart[0]), Math.abs(y - depart[1])];
  }
  // Lâcher le cadre pose un point de passage à cette image.
  function relache() {
    prise = null;
    if (!trace?.rect) return;
    if (trace.rect[2]! >= 0.01 && trace.rect[3]! >= 0.01) trace.points = poser(trace.points, temps, trace.rect);
    trace.rect = null;
  }

  function commencerZone(index: number | null = null) {
    erreur = '';
    trace = { index, points: index === null ? [] : chemins[index]!.map((p) => ({ t: p.t, rect: [...p.rect] })), rect: null };
    if (index !== null) aller(chemins[index]![0]!.t);
  }
  function terminerZone() {
    if (!trace || trace.points.length < 2) { erreur = 'Placez au moins deux points de passage, à deux moments différents.'; return; }
    const pts = trace.points;
    const i = trace.index;
    if (aplatir(i === null ? [...chemins, pts] : chemins.map((c, j) => (j === i ? pts : c))).length > SEGMENTS_MAX) { erreur = 'Trop de points de passage.'; return; }
    chemins = i === null ? [...chemins, pts] : chemins.map((c, j) => (j === i ? pts : c));
    trace = null;
    erreur = '';
  }

  async function envoyer() {
    erreur = '';
    envoi = true;
    try {
      await appliquer(retirees, aplatir(chemins));
    } catch (x) {
      erreur = message(x);
    } finally {
      envoi = false;
    }
  }
</script>

<div class="retouche">
  {#if !source}
    <!-- Ouvert directement depuis « Retoucher le floutage » : chargement de la vidéo sans étape intermédiaire. -->
    {#if erreur}<div class="message erreur" role="alert">{erreur}</div><button class="bouton" onclick={charger}>Réessayer</button>{:else}<p class="petit discret">Chargement de l’outil…</p>{/if}
  {:else}
    <!-- Largeur bornée pour tenir dans la fenêtre : le cadre garde les proportions exactes, les zones restent alignées. -->
    <div class="ecran" style:aspect-ratio={ratio} style:width={`min(100%, calc(85dvh * ${ratio}))`}>
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} src={source} preload="auto" playsinline controls={!trace} bind:currentTime={temps} bind:duration={duree}
             onloadedmetadata={() => { if (video?.videoWidth) ratio = video.videoWidth / video.videoHeight; }}
             onvolumechange={() => { if (video) { son.volume = video.volume; son.muet = video.muted; garderSon(); } }}></video>
      <svg bind:this={calque} class="calque" class:trace={!!trace} viewBox="0 0 1 1" preserveAspectRatio="none"
           onpointerdown={appui} onpointermove={glisse} onpointerup={relache} role="presentation">
        {#each pistes as p (p.id)}
          {@const c = cadre(p, temps)}
          {#if c}
            <rect x={c[0]} y={c[1]} width={c[2]} height={c[3]} class="piste" class:retire={retirees.includes(p.id)} vector-effect="non-scaling-stroke" />
          {/if}
        {/each}
        {#each chemins as z, i (i)}
          {@const c = trace?.index === i ? null : interpoler(z, temps)}
          {#if c}<rect x={c[0]} y={c[1]} width={c[2]} height={c[3]} class="zone" vector-effect="non-scaling-stroke" />{/if}
        {/each}
        {#if courant}
          <rect x={courant[0]} y={courant[1]} width={courant[2]} height={courant[3]} class="encours" vector-effect="non-scaling-stroke" />
        {/if}
      </svg>
      {#if !trace}
        <!-- Nom de chaque visage au-dessus de son cadre ; un clic retire ou remet son flou. -->
        <div class="etiquettes">
          {#each presents as p (p.id)}
            {@const c = cadre(p, temps)!}
            <button class="etiquette" class:retire={retirees.includes(p.id)} style:left="{(c[0] ?? 0) * 100}%" style:top="{(c[1] ?? 0) * 100}%"
                    onclick={() => basculer(p.id)} title={retirees.includes(p.id) ? 'Remettre le flou' : 'Retirer le flou'}>
              Visage {p.id + 1}{retirees.includes(p.id) ? ' · sans flou' : ''}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="commandes">
      <button class="bouton" onclick={() => aller(temps - IMAGE)} aria-label="Image précédente">⟨</button>
      <button class="bouton" onclick={() => (video?.paused ? video.play() : video?.pause())}>Lecture / pause</button>
      <button class="bouton" onclick={() => aller(temps + IMAGE)} aria-label="Image suivante">⟩</button>
      <input type="range" min="0" max={duree || 0} step={IMAGE} bind:value={temps} oninput={(e) => aller(Number(e.currentTarget.value))}
             aria-label="Position dans la vidéo" />
      <span class="mono petit">{fmt(temps)} / {fmt(duree || 0)}</span>
    </div>

    {#if trace}
      <div class="message attention" role="status">
        <strong>Points de passage.</strong> Mettez la vidéo en pause au bon moment, tracez un cadre sur l’image ou faites glisser celui qui est affiché : un point est posé. Avancez ou reculez, et recommencez à chaque changement de direction.
        {#if trace.points.length}
          <ol class="points">
            {#each trace.points as p, i (p.t)}
              <li><button class="bouton lien petit" onclick={() => aller(p.t)}>{fmt(p.t)}</button>
                <button class="bouton lien petit" aria-label="Retirer ce point" onclick={() => { if (trace) trace.points = trace.points.filter((_, j) => j !== i); }}>×</button></li>
            {/each}
          </ol>
        {/if}
        <div class="boutons">
          <Manque raisons={[trace.points.length < 2 && 'deux points au moins']}><button class="bouton principal" onclick={terminerZone} disabled={trace.points.length < 2}>Terminer la zone</button></Manque>
          <button class="bouton lien" onclick={() => (trace = null)}>Annuler</button>
        </div>
      </div>
    {/if}
    {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}

    <div class="listes">
      <section>
        <h3>{tousLesVisages ? `Tous les visages floutés (${pistes.length})` : `Visages sur cette image (${presents.length})`}</h3>
        {#each listes as p (p.id)}
          <div class="ligne">
            <label class="case">
              <input type="checkbox" checked={!retirees.includes(p.id)} onchange={() => basculer(p.id)} />
              <span>Visage {p.id + 1} — flou {retirees.includes(p.id) ? 'retiré' : 'gardé'}</span>
            </label>
            <button class="bouton lien petit" onclick={() => aller(p.instants[0]!)}>{fmt(p.instants[0]!)} → {fmt(p.instants.at(-1)!)}</button>
          </div>
        {:else}
          <p class="petit discret">{pistes.length ? 'Aucun visage flouté sur cette image.' : 'Aucun visage détecté.'}</p>
        {/each}
        {#if retiresAilleurs.length}
          <p class="petit">Flous retirés ailleurs dans la vidéo :
            {#each retiresAilleurs as p, i (p.id)}{i ? ', ' : ' '}<button class="bouton lien petit" onclick={() => aller(p.instants[0]!)}>Visage {p.id + 1}</button>{/each}
          </p>
        {/if}
        {#if pistes.length > presents.length || tousLesVisages}
          <button class="bouton lien petit" onclick={() => (tousLesVisages = !tousLesVisages)}>
            {tousLesVisages ? 'Ne montrer que les visages de cette image' : `Voir tous les visages (${pistes.length})`}
          </button>
        {/if}
        {#if ajoutees}
          <div class="message attention">Les visages dont vous retirez le flou seront visibles des relecteurs, puis du
            public si la vidéo est publiée. Ne retirez le flou que d’un visage qui ne risque rien à être montré.</div>
        {/if}
      </section>
      <section>
        <h3>Zones ajoutées ({chemins.length})</h3>
        {#each chemins as z, i (i)}
          <div class="ligne">
            <button class="bouton lien petit" onclick={() => aller(z[0]!.t)}>Zone {i + 1} : {fmt(z[0]!.t)} → {fmt(z.at(-1)!.t)} · {z.length} points</button>
            <span>
              <Manque raisons={[!!trace && 'terminer la zone en cours']}><button class="bouton lien petit" disabled={!!trace} onclick={() => commencerZone(i)}>Modifier</button></Manque>
              <Manque raisons={[!!trace && 'terminer la zone en cours']}><button class="bouton lien petit" disabled={!!trace} onclick={() => (chemins = chemins.filter((_, j) => j !== i))}>Supprimer</button></Manque>
            </span>
          </div>
        {/each}
        {#if !trace && segments < SEGMENTS_MAX}
          <button class="bouton" onclick={() => commencerZone()}>+ Ajouter une zone à flouter</button>
        {/if}
      </section>
    </div>

    <div class="boutons">
      <Manque raisons={[!!trace && 'terminer la zone en cours', retouchesRestantes < 1 && 'une retouche restante']}><button class="bouton principal" onclick={envoyer} disabled={envoi || !!trace || retouchesRestantes < 1}>
        {envoi ? 'Envoi…' : libelle ?? `Appliquer la retouche (${retouchesRestantes} restante${retouchesRestantes > 1 ? 's' : ''})`}
      </button></Manque>
    </div>
    <p class="aide">La vidéo sera floutée à nouveau à partir de l’original : comptez quelques minutes, puis vérifiez le résultat.</p>
  {/if}
</div>

<style>
  .ecran { position: relative; margin-inline: auto; background: #000; border-radius: var(--rayon); overflow: hidden; }
  .ecran video { position: absolute; inset: 0; width: 100%; height: 100%; }
  .calque { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .calque.trace { pointer-events: auto; cursor: crosshair; touch-action: none; }
  rect { fill: none; stroke-width: 2.5px; }
  .piste { stroke: #E8A33D; stroke-dasharray: 6 4; }
  .piste.retire { stroke: #f97066; stroke-dasharray: 2 4; }
  .zone { stroke: #7cacf8; fill: rgb(124 172 248 / 0.15); }
  .points { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; list-style: none; padding: 0; margin: 0.5rem 0; }
  .encours { stroke: #fff; fill: rgb(255 255 255 / 0.15); }
  .etiquettes { position: absolute; inset: 0; pointer-events: none; }
  .etiquette { position: absolute; transform: translateY(calc(-100% - 3px)); pointer-events: auto; cursor: pointer;
               font: 600 0.75rem/1.2 var(--police); padding: 0.125rem 0.375rem; border: 0; border-radius: 4px;
               background: #E8A33D; color: #1F2328; white-space: nowrap; }
  .etiquette.retire { background: #f97066; color: #fff; }
  .etiquette:focus-visible { outline: 2px solid #fff; }
  .commandes { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; margin: 0.75rem 0; }
  .commandes input[type='range'] { flex: 1; min-width: 8rem; accent-color: var(--accent); }
  .listes { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-top: 1rem; }
  @media (max-width: 40rem) { .listes { grid-template-columns: 1fr; } }
  .ligne { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; border-bottom: 1px solid var(--trait); }
  h3 { font-size: 1rem; }
</style>
