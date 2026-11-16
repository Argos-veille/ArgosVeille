<script lang="ts">
  // Mes convocations : tirées au hasard par le site, délai réglable (summons_days), 5 relectures par jour.
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { ErreurApi } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';
  import { CATEGORIES, dansCombienDeTemps, SOUS_CATEGORIES, libellesChoix } from '#lib/libelles.ts';
  import { chargerRelecture, type Relecture } from '#lib/relecture.ts';
  import { session } from '#lib/session.svelte.ts';

  let r = $state<Relecture | null>(null);
  // Rappel de la double authentification : on peut le fermer (pas d'envie de jury ni d'analyse) ; le choix
  // est gardé dans ce navigateur seulement. La section reste dans « Mon compte ».
  const cleRappel = () => `argos-rappel-2fa-ferme:${session.moi?.pseudo ?? ''}`;
  let rappelFerme = $state(false);
  $effect(() => {
    if (!session.moi) return;
    try { rappelFerme = localStorage.getItem(cleRappel()) === '1'; } catch { /* stockage indisponible */ }
  });
  function fermerRappel() {
    rappelFerme = true;
    try { localStorage.setItem(cleRappel(), '1'); } catch { /* le choix vaut pour cette page */ }
  }
  let erreur = $state('');

  onMount(async () => {
    try {
      r = await chargerRelecture();
    } catch (x) {
      if (x instanceof ErreurApi && x.statut === 401) return goto('/connexion');
      erreur = message(x);
    }
  });
</script>

<svelte:head><title>Relecture — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">Espace relecteur</span>
  <h1>Relecture</h1>
  {#if erreur}<div class="message erreur">{erreur}</div>{/if}

  {#if session.moi && !session.moi.doubleAuthentification.length && !rappelFerme}
    <div class="message attention rappel-2fa">
      <button class="fermer" onclick={fermerRappel} aria-label="Fermer ce message" title="Ne plus afficher">×</button>
      <strong>Activez la double authentification</strong> : elle est obligatoire pour le jury et les analystes.
      <a href="/compte#securite">Activer →</a>
    </div>
  {/if}

  {#if r}
    <div class="jauge" aria-label="Relectures des dernières 24 heures">
      <div><strong>{r.relecturesAujourdhui}</strong> / {r.plafondParJour} relectures sur les dernières 24 h</div>
      <div class="barre"><span style:width="{(100 * r.relecturesAujourdhui) / r.plafondParJour}%"></span></div>
    </div>

    <section>
      <h2>Mes convocations</h2>
      {#each r.convocations as c (c.convocation)}
        <a class="convocation" href="/relecture/{c.convocation}">
          <div class="haut">
            {#if c.secondExamen}<span class="pastille accent">Second examen — jury</span>{:else}<span class="pastille">Relecture</span>{/if}
            <span class="petit discret">Expire dans {dansCombienDeTemps(c.expireLe)}</span>
          </div>
          <strong>{c.categorie ? CATEGORIES[c.categorie] : 'Nature non précisée'}{#if c.sousCategorie}{' · '}{libellesChoix(c.sousCategories, SOUS_CATEGORIES)}{/if}</strong>
          <span class="second petit">{c.description ?? ''}</span>
          {#if c.notesAnalystes}<span class="petit discret">{c.notesAnalystes} note{c.notesAnalystes > 1 ? 's' : ''} d’analyste</span>{/if}
        </a>
      {:else}
        <div class="carte vide">
          <p><strong>Aucune convocation pour l’instant.</strong></p>
          <p class="second">Les vidéos sont confiées au hasard. {#if !r.mailConvocations}Mail de convocation coupé
            (<a href="/compte#mails">réactiver</a>).{:else}Un mail vous prévient (pensez aux indésirables).{/if}</p>
        </div>
      {/each}
    </section>

    {#if r.notesAJuger.length}
      <section>
        <h2>Notes d’analystes à juger</h2>
        <p class="second">Après votre vote, dites si les notes des analystes vous ont paru pertinentes : c’est ce qui
          permet de mettre en avant les plus utiles.</p>
        {#each r.notesAJuger as n (n.convocation)}
          <a class="convocation" href="/relecture/{n.convocation}">
            <strong>{n.notes - n.dejaJugees} note{n.notes - n.dejaJugees > 1 ? 's' : ''} à juger</strong>
            <span class="petit discret">sur une vidéo que vous avez relue</span>
          </a>
        {/each}
      </section>
    {/if}

    <section class="carte rappel">
      <h2>Les règles du jeu</h2>
      <ul>
        <li>Vous ne voyez que la version floutée. Ne cherchez jamais à identifier une personne ni la source.</li>
        <li>Regardez la vidéo en entier : la réponse et les notes des analystes s’ouvrent à 90 % du visionnage.</li>
        <li>Répondez à ce que montre la vidéo, pas à votre opinion sur les faits.</li>
        <li>Dans le doute, passez votre tour : aucune pénalité.</li>
        <li>Certaines vidéos servent de contrôle : leur réponse est connue, et une erreur fait baisser votre score.</li>
      </ul>
    </section>
  {/if}
</div>

<style>
  section { margin-top: 2rem; }
  .rappel-2fa { position: relative; padding-right: 2.75rem; }
  .fermer { position: absolute; top: 0.375rem; right: 0.5rem; width: 2rem; height: 2rem; border: 0; background: none;
            font-size: 1.375rem; line-height: 1; color: var(--texte-2); cursor: pointer; border-radius: var(--rayon); }
  .fermer:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--texte); }
  .jauge { max-width: 28rem; }
  .jauge strong { font-size: 1.25rem; }
  .barre { height: 6px; background: var(--surface-3); border-radius: 3px; overflow: hidden; margin-top: 0.375rem; }
  .barre span { display: block; height: 100%; background: var(--accent); }
  .convocation { display: grid; gap: 0.25rem; padding: 1rem 1.25rem; background: var(--surface); border: 1px solid var(--trait);
                 border-radius: var(--rayon-grand); text-decoration: none; color: var(--texte); margin-bottom: 0.75rem; }
  .convocation:hover { border-color: var(--trait-fort); box-shadow: var(--ombre); }
  .haut { display: flex; justify-content: space-between; gap: 1rem; }
  .rappel ul { padding-left: 1.125rem; color: var(--texte-2); display: grid; gap: 0.375rem; margin: 0; }
  .vide p:last-child { margin: 0; }
</style>
