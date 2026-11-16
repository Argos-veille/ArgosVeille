<script lang="ts">
  // Mes vidéos : celles envoyées avec ce compte. Les vidéos envoyées anonymement n'y sont pas (elles se
  // suivent avec leur code de 12 mots).
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { ErreurApi, get } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';

  interface Video { video: string; pseudonyme: string; etat: string; libelle: string; envoyeeLe: string; decideeLe?: string }
  let videos = $state<Video[] | null>(null);
  let erreur = $state('');
  const date = (d: string) => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

  // Du plus urgent au moins urgent ; sert à la couleur des statuts et aux tris.
  const GROUPES = [
    { ton: 'accent', etats: ['a_verifier'] },
    { ton: 'info', etats: ['envoi_en_cours', 'floutage_en_cours', 'en_relecture', 'devant_le_jury', 'en_attente_analyse'] },
    { ton: 'succes', etats: ['publiee'] },
    { ton: 'danger', etats: ['echec', 'rejetee', 'masquee', 'retiree_motif_legal'] },
    { ton: 'neutre', etats: ['en_debat', 'sans_decision', 'retiree'] },
  ];
  const ORDRE = GROUPES.flatMap((g) => g.etats);
  const ton = (etat: string) => GROUPES.find((g) => g.etats.includes(etat))?.ton ?? 'neutre';
  const rang = (etat: string, liste: string[]) => (liste.includes(etat) ? liste.indexOf(etat) : liste.length);

  const TRIS = { recentes: 'Plus récentes d’abord', anciennes: 'Plus anciennes d’abord', a_traiter: 'À traiter d’abord', statut: 'Par statut' };
  type Tri = keyof typeof TRIS;
  const CLE_TRI = 'argos-mes-videos-tri';
  let tri = $state<Tri>('recentes');

  function choisirTri() {
    try { localStorage.setItem(CLE_TRI, tri); } catch { /* préférence non gardée : sans conséquence */ }
  }

  const plusRecente = (a: Video, b: Video) => b.envoyeeLe.localeCompare(a.envoyeeLe);
  const urgence = (v: Video) => (GROUPES[0]!.etats.includes(v.etat) ? 0 : GROUPES[1]!.etats.includes(v.etat) ? 1 : 2);
  const COMPARER: Record<Tri, (a: Video, b: Video) => number> = {
    recentes: plusRecente,
    anciennes: (a, b) => plusRecente(b, a),
    a_traiter: (a, b) => urgence(a) - urgence(b) || plusRecente(a, b),
    statut: (a, b) => rang(a.etat, ORDRE) - rang(b.etat, ORDRE) || plusRecente(a, b),
  };
  const triees = $derived(videos ? [...videos].sort(COMPARER[tri]) : []);

  onMount(async () => {
    try {
      const garde = localStorage.getItem(CLE_TRI);
      if (garde && garde in TRIS) tri = garde as Tri;
    } catch { /* stockage indisponible : tri par défaut */ }
    try {
      videos = (await get<{ videos: Video[] }>('/compte/videos')).videos;
    } catch (x) {
      if (x instanceof ErreurApi && x.statut === 401) return goto('/connexion');
      erreur = message(x);
    }
  });
</script>

<svelte:head><title>Mes vidéos — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">Suivi de mes envois</span>
  <h1>Mes vidéos</h1>
  <div class="blocs">
  <p class="second intro">Les vidéos envoyées avec votre compte. Vous recevez un mail à chaque étape importante
    (pensez à regarder vos courriers indésirables).</p>
  {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}

  {#if videos === null && !erreur}
    <p class="discret">Chargement…</p>
  {:else if videos?.length === 0}
    <div class="carte">
      <p class="second">Aucune vidéo envoyée avec ce compte pour l’instant.</p>
      <a class="bouton principal" href="/envoyer">Envoyer une vidéo</a>
    </div>
  {:else if videos}
    {#if videos.length > 1}
      <div class="champ tri">
        <label for="tri">Trier</label>
        <select id="tri" bind:value={tri} onchange={choisirTri}>
          {#each Object.entries(TRIS) as [cle, texte] (cle)}<option value={cle}>{texte}</option>{/each}
        </select>
      </div>
    {/if}
    <ul class="liste-videos">
      {#each triees as v (v.video)}
        <li>
          <a class="carte ligne" href="/compte/videos/{v.video}">
            <span>
              <strong>{v.pseudonyme}</strong>
              <span class="petit discret">Envoyée le {date(v.envoyeeLe)}{#if v.decideeLe}{' · '}décision le {date(v.decideeLe)}{/if}</span>
            </span>
            <span class="pastille {ton(v.etat)}">{v.libelle}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="petit discret">Une vidéo envoyée anonymement ? <a href="/suivi">Suivez-la avec son code de 12 mots</a>.</p>
  </div>
</div>

<style>
  /* Même largeur de blocs que « Mon compte ». */
  .blocs { display: grid; gap: 1.25rem; }
  .liste-videos { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.75rem; }
  .intro { margin: 0; }
  .ligne { display: flex; justify-content: space-between; align-items: center; gap: 1rem; text-decoration: none; color: inherit; }
  .ligne > span:first-child { display: grid; gap: 0.25rem; }
  .ligne:hover { border-color: var(--accent); }
  .tri { margin: 0; max-width: 16rem; }
  .pastille { white-space: nowrap; }
</style>
