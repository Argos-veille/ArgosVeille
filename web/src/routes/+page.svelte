<script lang="ts">
  import Info from '#lib/composants/Info.svelte';
  import { onMount } from 'svelte';
  import { chargerJournal, ficheDe, ilYa, resume, verifierJournal, type Entree, type Verification } from '#lib/journal.ts';
  import { session } from '#lib/session.svelte.ts';
  import ApercuCarte from '#lib/composants/ApercuCarte.svelte';

  let dernieres = $state<Entree[]>([]);
  let publiees = $state<number | null>(null);   // nombre de vidéos sur la carte
  let verification = $state<Verification | null>(null);
  onMount(async () => {
    const [j, v] = await Promise.allSettled([chargerJournal(), verifierJournal()]);
    if (j.status === 'fulfilled') dernieres = j.value.entrees.slice(0, 3);
    if (v.status === 'fulfilled') verification = v.value;
  });
</script>

<svelte:head><title>Argos Veille — Ce que les réseaux effacent, Argos le garde</title></svelte:head>

<section class="conteneur une">
  <div class="accroche">
    <span class="surtitre">Veille citoyenne</span>
    <h1>Ce que les réseaux effacent, Argos le garde.</h1>
    <p class="chapo">
      Argos Veille est une veille citoyenne : ce sont des citoyens qui recensent, vérifient, cartographient et archivent les
      abus et violences policières, grâce à des relecteurs tirés au sort et à une carte publique. Sans jamais exposer
      celles et ceux qui filment.
    </p>
    <div class="boutons">
      <a class="bouton principal" href="/envoyer">Envoyer une vidéo</a>
      {#if !session.moi}<a class="bouton" href="/inscription">Créer un compte</a>
      {:else}<a class="bouton" href="/compte">Mon compte</a>{/if}
    </div>
  </div>
  <div class="colonne-carte">
    <ApercuCarte bind:nombre={publiees} />
    <p class="petit second legende">Chaque point : une vidéo vérifiée, là où elle a été filmée.{#if publiees}{' '}<b>{publiees}
      vidéo{publiees > 1 ? 's' : ''} publiée{publiees > 1 ? 's' : ''}</b>.{/if}</p>
  </div>
</section>

<section class="conteneur bloc">
  <span class="surtitre">Comment ça marche</span>
  <ol class="parcours">
    <li>
      <h3>Vous envoyez</h3>
      <p>Anonymement ou avec un compte. L’original est chiffré, et un code secret permet de suivre la vidéo.</p>
    </li>
    <li>
      <h3>Les visages sont floutés</h3>
      <p>Automatiquement. Vous vérifiez et retouchez le résultat avant que quiconque voie la vidéo.</p>
    </li>
    <li>
      <h3>La communauté vérifie</h3>
      <p>Des relecteurs tirés au sort jugent la version floutée. Si le vote est serré, un jury tranche.</p>
    </li>
    <li>
      <h3>C’est publié</h3>
      <p>La vidéo rejoint la carte (lieu arrondi) et y reste archivée, même si les réseaux l’effacent. Vous pouvez la
        retirer à tout moment.</p>
    </li>
  </ol>
  <p><a href="/comment-ca-marche">Tout comprendre →</a></p>
</section>

<section class="conteneur bloc tracabilite">
  <div>
    <span class="surtitre">Transparence</span>
    <h2>Tout est traçable</h2>
    <p class="second">Les décisions, les retraits et les interventions de l’administration sur les vidéos sont inscrits dans un journal public
      que personne, pas même nous, ne peut réécrire sans que cela se voie.<Info>Chaque entrée porte l’empreinte de la
      précédente, et l’état du journal est ancré chaque jour dans la blockchain Bitcoin.</Info></p>
    {#if verification}
      <p class="etat" class:casse={!verification.intact}>
        {verification.intact ? `✓ Chaîne vérifiée : ${verification.entrees} entrées intactes` : `⚠ Chaîne rompue à l’entrée n° ${verification.premiereEntreeInvalide}`}
      </p>
    {/if}
    <a class="bouton" href="/journal">Voir le journal public →</a>
  </div>
  <ol class="dernieres" aria-label="Dernières entrées du journal">
    {#each dernieres as e (e.numero)}
      <li>
        <span class="petit discret">n° {e.numero} · {ilYa(e.le)}</span>
        <span>{#if ficheDe(e)}<a href={ficheDe(e)}>{resume(e)}</a>{:else}{resume(e)}{/if}</span>
      </li>
    {/each}
  </ol>
</section>

<section class="conteneur bloc deux">
  <div class="carte">
    <span class="surtitre">Vous filmez</span>
    <h2>Votre protection d’abord</h2>
    <ul class="liste">
      <li>Anonyme par défaut : ni compte, ni donnée qui vous identifie.</li>
      <li>Le lieu GPS exact et l’heure précise ne sont jamais publiés.</li>
      <li>Tor et VPN bienvenus.</li>
    </ul>
  </div>
  <div class="carte">
    <span class="surtitre">Vous relisez</span>
    <h2>Devenir relecteur</h2>
    <ul class="liste">
      <li>Un pseudo, un mobile et un mail vérifiés, jamais affichés.</li>
      <li>5 relectures par jour au plus, sur convocation. Vous pouvez passer votre tour.</li>
      <li>Votre fiabilité pèse peu à peu dans les décisions.</li>
    </ul>
    {#if !session.moi}<div class="boutons"><a class="bouton principal" href="/inscription">Créer mon compte</a></div>{/if}
  </div>
</section>

<style>
  .une { display: grid; grid-template-columns: 3fr 2fr; gap: 3rem; align-items: center; padding-top: 1.5rem; padding-bottom: 1rem; }
  @media (max-width: 52rem) { .une { grid-template-columns: 1fr; gap: 2rem; } }
  h1 { font-size: clamp(2.125rem, 1.4rem + 3vw, 3.5rem); font-weight: 800; letter-spacing: -0.035em; max-width: 18ch; }
  .chapo { font-size: 1.1875rem; color: var(--texte-2); max-width: 36rem; }
  .bloc { margin-top: 4rem; }
  .colonne-carte { display: grid; gap: 0.625rem; }
  .legende { margin: 0; }
  .parcours { list-style: none; padding: 0; margin: 0 0 1.5rem; display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.5rem; counter-reset: etape; }
  @media (max-width: 60rem) { .parcours { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 34rem) { .parcours { grid-template-columns: 1fr; } }
  .parcours li { counter-increment: etape; border-top: 1px solid var(--trait-fort); padding-top: 1rem; }
  .parcours li::before { content: counter(etape, decimal-leading-zero); display: block; font-weight: 800; color: var(--accent-texte); font-size: 0.875rem; margin-bottom: 0.5rem; }
  .parcours p { color: var(--texte-2); font-size: 0.9375rem; }
  .tracabilite { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; align-items: center; }
  @media (max-width: 46rem) { .tracabilite { grid-template-columns: 1fr; } }
  .etat { font-weight: 600; color: var(--succes); font-size: 0.9375rem; }
  .etat.casse { color: var(--danger); }
  .dernieres { list-style: none; margin: 0; padding: 0; border: 1px solid var(--trait); border-radius: var(--rayon-grand);
               background: var(--surface); }
  .dernieres li { display: grid; gap: 0.125rem; padding: 0.875rem 1.25rem; border-bottom: 1px solid var(--trait); }
  .dernieres li:last-child { border-bottom: 0; }
  .deux { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  .deux .carte + .carte { margin-top: 0; }
  @media (max-width: 46rem) { .deux { grid-template-columns: 1fr; } }
  .liste { padding-left: 1.125rem; color: var(--texte-2); display: grid; gap: 0.5rem; margin: 0; }
</style>
