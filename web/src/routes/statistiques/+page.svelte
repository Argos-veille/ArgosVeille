<script lang="ts">
  // Statistiques publiques : comptes des vidéos publiées (sans les doublons), calculés par le serveur
  // et gardés 5 minutes. Mêmes données que GET /api/v1/statistiques.
  import { onMount } from 'svelte';
  import Info from '#lib/composants/Info.svelte';
  import { get } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';
  import { CATEGORIES, FORCES, SITUATIONS, SOUS_CATEGORIES } from '#lib/libelles.ts';

  interface Stats {
    publiees: number; enDebat: number; publieesCes30Jours: number; calculeLe: string;
    parMois: { mois: string; videos: number }[];
    categories: Record<string, number>; sousCategories: Record<string, number>;
    forces: Record<string, number>; situations: Record<string, number>;
  }
  const PERIODES = { '7j': '7 derniers jours', '30j': '30 derniers jours', '1an': '12 derniers mois', tout: 'Depuis le début' };
  const VIOLENCES = ['strikes', 'disproportionate_force', 'weapons', 'chokehold', 'other_violence'];

  let periode = $state<keyof typeof PERIODES>('tout');
  let s = $state<Stats | null>(null);
  let erreur = $state('');

  async function charger() {
    erreur = '';
    try { s = await get<Stats>(`/public/statistiques?periode=${periode}`); } catch (x) { erreur = message(x); }
  }
  onMount(charger);

  /** Lignes triées de la plus grande à la plus petite, avec leur libellé. */
  const lignes = (n: Record<string, number>, noms: Record<string, string>, garder?: (c: string) => boolean) =>
    Object.entries(n).filter(([c]) => !garder || garder(c)).sort((a, b) => b[1] - a[1]).map(([c, v]) => ({ code: c, nom: noms[c] ?? c, n: v }));
  const nomMois = (m: string) => new Date(`${m}-01T12:00`).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });
  const maxMois = $derived(Math.max(1, ...(s?.parMois.map((m) => m.videos) ?? [])));
  const nombre = (n: number) => n.toLocaleString('fr-FR');
</script>

{#snippet barres(titre: string, liste: { code: string; nom: string; n: number }[], aide?: string)}
  {@const max = Math.max(1, ...liste.map((l) => l.n))}
  <div class="bloc">
    <h3>{titre}{#if aide}<Info>{aide}</Info>{/if}</h3>
    {#if liste.length}
      <ul class="barres">
        {#each liste as l (l.code)}
          <li>
            <span class="nom">{l.nom}</span>
            <span class="piste" aria-hidden="true"><span class="barre" style:width="{(l.n / max) * 100}%"></span></span>
            <span class="n">{nombre(l.n)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="petit second">Aucune vidéo.</p>
    {/if}
  </div>
{/snippet}

<svelte:head><title>Statistiques — Argos Veille</title></svelte:head>

<div class="conteneur">
  <span class="surtitre">Données</span>
  <h1>Statistiques</h1>
  <p class="second">Les vidéos publiées, sans les doublons. Faits allégués, non jugés : ces chiffres reflètent les vidéos reçues,
    pas l’ensemble des faits.</p>

  <div class="filtres">
    <label>Période (date des faits)
      <select bind:value={periode} onchange={charger}>
        {#each Object.entries(PERIODES) as [code, nom] (code)}<option value={code}>{nom}</option>{/each}
      </select>
    </label>
  </div>

  {#if erreur}
    <div class="message erreur" role="alert">{erreur}</div>
  {:else if !s}
    <p class="second">Chargement…</p>
  {:else}
    <div class="chiffres">
      <div class="chiffre"><span class="valeur">{nombre(s.publiees)}</span><span class="second">vidéos publiées</span></div>
      <div class="chiffre"><span class="valeur">{nombre(s.publieesCes30Jours)}</span><span class="second">publiées ces 30 derniers jours</span></div>
      <div class="chiffre"><a href="/en-debat" class="valeur">{nombre(s.enDebat)}</a><span class="second">en débat</span></div>
    </div>

    <section class="carte">
      <h2>Par mois</h2>
      {#if s.parMois.length}
        <div class="mois" role="img" aria-label="Vidéos publiées par mois des faits (détail dans le tableau ci-dessous)">
          {#each s.parMois as m (m.mois)}
            <div class="colonne">
              <span class="bulle">{nomMois(m.mois)} : {nombre(m.videos)}</span>
              <span class="haut" style:height="{(m.videos / maxMois) * 100}%"></span>
            </div>
          {/each}
        </div>
        <div class="axe petit second">
          <span>{nomMois(s.parMois[0]!.mois)}</span>
          {#if s.parMois.length > 1}<span>{nomMois(s.parMois.at(-1)!.mois)}</span>{/if}
        </div>
        <details>
          <summary class="petit">Voir le tableau</summary>
          <table class="petit">
            <thead><tr><th>Mois</th><th>Vidéos</th></tr></thead>
            <tbody>{#each s.parMois as m (m.mois)}<tr><td>{nomMois(m.mois)}</td><td>{nombre(m.videos)}</td></tr>{/each}</tbody>
          </table>
        </details>
      {:else}
        <p class="petit second">Aucune vidéo sur cette période.</p>
      {/if}
    </section>

    <section class="carte">
      <h2>Nature des faits</h2>
      <div class="grille">
        {@render barres('Catégorie', lignes(s.categories, CATEGORIES))}
        {@render barres('Violences physiques', lignes(s.sousCategories, SOUS_CATEGORIES, (c) => VIOLENCES.includes(c)),
                        'Une vidéo peut entrer dans plusieurs cas : le total peut dépasser le nombre de vidéos.')}
        {@render barres('Abus non violents', lignes(s.sousCategories, SOUS_CATEGORIES, (c) => !VIOLENCES.includes(c)),
                        'Une vidéo peut entrer dans plusieurs cas : le total peut dépasser le nombre de vidéos.')}
      </div>
    </section>

    <section class="carte">
      <h2>Contexte</h2>
      <div class="grille">
        {@render barres('Forces', lignes(s.forces, FORCES))}
        {@render barres('Situation', lignes(s.situations, SITUATIONS),
                        'Une vidéo peut montrer plusieurs situations : le total peut dépasser le nombre de vidéos.')}
      </div>
    </section>

    <p class="petit second note">Mis à jour toutes les 5 minutes. Réutilisables sous licence CC BY 4.0 :
      <a href="/donnees">données ouvertes et API</a>.</p>
  {/if}
</div>

<style>
  .filtres { margin: 1.25rem 0; }
  .note { margin-top: 1rem; }
  .filtres label { display: inline-flex; flex-direction: column; gap: 0.25rem; font-weight: 600; font-size: 0.875rem; }
  .chiffres { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 1rem; margin-bottom: 1rem; }
  .chiffre { display: flex; flex-direction: column; gap: 0.125rem; padding: 1rem 1.25rem; background: var(--surface);
             border: 1px solid var(--trait); border-radius: var(--rayon-grand); }
  .chiffre .valeur { font-size: 2rem; font-weight: 700; line-height: 1.1; color: var(--texte); font-variant-numeric: tabular-nums; }
  a.valeur { text-decoration: none; }
  a.valeur:hover { color: var(--accent-texte); }

  .mois { display: flex; align-items: flex-end; gap: 2px; height: 10rem; border-bottom: 1px solid var(--trait-fort); margin-top: 1rem; }
  .colonne { position: relative; flex: 1; height: 100%; display: flex; align-items: flex-end; }
  .haut { width: 100%; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 0; }
  .colonne:hover .haut { filter: brightness(0.9); }
  .bulle { display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); white-space: nowrap; z-index: 1;
           padding: 0.25rem 0.5rem; background: var(--primaire); color: var(--sur-primaire); border-radius: var(--rayon); font-size: 0.75rem; }
  .colonne:hover .bulle { display: block; }
  .axe { display: flex; justify-content: space-between; margin-top: 0.25rem; }
  details { margin-top: 0.75rem; }
  table { margin-top: 0.5rem; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.125rem 1.5rem 0.125rem 0; font-variant-numeric: tabular-nums; }

  .grille { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1.5rem; }
  h3 { font-size: 0.9375rem; margin: 0 0 0.5rem; }
  .barres { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
  .barres li { display: grid; grid-template-columns: 1fr auto; gap: 0.125rem 0.75rem; align-items: center; }
  .nom { font-size: 0.875rem; }
  .n { grid-row: 1 / 3; grid-column: 2; font-weight: 600; font-variant-numeric: tabular-nums; }
  .piste { grid-column: 1; height: 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden; }
  .barre { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
</style>
