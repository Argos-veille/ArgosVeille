<script lang="ts">
  // Suivi d'une vidéo par sa source, avec le code de 12 mots. Le code ne quitte pas cet onglet : il
  // n'est ni dans l'adresse, ni gardé par le navigateur ; seul le jeton qui en dérive est envoyé.
  import Manque from '#lib/composants/Manque.svelte';
  import { deriverSecrets, entropieVideo, lirePhrase } from 'argos-navigateur';
  import SuiviVideo from '#lib/composants/SuiviVideo.svelte';
  import { videosDuCode } from '#lib/envoi.ts';
  import { message } from '#lib/erreurs.ts';
  import { session } from '#lib/session.svelte.ts';

  let saisie = $state('');
  let cible = $state<{ jeton: string; cleCopie: string; entropie: Uint8Array } | null>(null);
  let erreur = $state('');
  let occupe = $state(false);
  // Code utilisé pour plusieurs vidéos : la liste, le temps de choisir.
  interface VideoDuCode { position: number; pseudonyme: string; libelle: string; envoyeeLe: string }
  let choix = $state<{ code: Uint8Array; videos: VideoDuCode[] } | null>(null);

  async function ouvrirVideo(code: Uint8Array, position: number) {
    const entropie = await entropieVideo(code, position);
    const secrets = await deriverSecrets(entropie);
    cible = { jeton: secrets.jetonSuivi, cleCopie: secrets.cleCopie, entropie };
  }

  async function ouvrir(e: SubmitEvent) {
    e.preventDefault();
    erreur = ''; occupe = true;
    try {
      const lu = await lirePhrase(saisie);
      if (!lu.ok) {
        erreur = lu.erreur === 'nombre_de_mots' ? `Il faut 12 mots (vous en avez saisi ${lu.nombre}).`
          : lu.erreur === 'mot_inconnu' ? `Le mot n° ${lu.position} n’est pas reconnu : vérifiez son orthographe.`
          : 'Ce code n’est pas valable : un mot est sans doute mal recopié ou dans le désordre.';
        return;
      }
      const videos = await videosDuCode<VideoDuCode>(lu.entropie);
      if (videos.length === 1) await ouvrirVideo(lu.entropie, videos[0]!.position);
      else choix = { code: lu.entropie, videos };
      saisie = '';   // le code n'est plus nécessaire : seul le jeton est gardé, en mémoire
    } catch (x) {
      erreur = message(x) === 'Introuvable.' ? 'Aucune vidéo ne correspond à ce code (une vidéo retirée n’est plus liée à son code).' : message(x);
    } finally {
      occupe = false;
    }
  }
</script>

<svelte:head><title>Suivre ma vidéo — Argos Veille</title></svelte:head>

<div class="conteneur texte-long">
  <span class="surtitre">Suivi</span>
  <h1>{choix ? 'Suivre mes vidéos' : 'Suivre ma vidéo'}</h1>
  {#if !cible && choix}
    <div class="carte">
      <h2>Vos vidéos</h2>
      {#each choix.videos as v (v.position)}
        <p><button class="bouton lien" onclick={() => ouvrirVideo(choix!.code, v.position)}>{v.pseudonyme}</button>
          <span class="petit discret"> {v.libelle} · {new Date(v.envoyeeLe).toLocaleDateString('fr-FR')}</span></p>
      {/each}
    </div>
    <p><button class="bouton lien" onclick={() => (choix = null)}>Fermer (oublier le code sur cette page)</button></p>
  {:else if !cible}
    {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
    {#if session.moi}
      <p class="second">Vidéo envoyée avec votre compte ? Retrouvez-la dans <a href="/compte/videos">Mes vidéos</a>.</p>
    {/if}
    <form class="carte" onsubmit={ouvrir}>
      <div class="champ">
        <label for="code">Votre code de suivi (12 mots)</label>
        <textarea id="code" bind:value={saisie} rows="3" autocomplete="off" autocapitalize="none" spellcheck="false"
                  placeholder="mot1 mot2 mot3 …"></textarea>
        <span class="aide">Majuscules, accents et séparateurs n’ont pas d’importance ; les 4 premières lettres de chaque mot
          suffisent. Le code ne quitte pas cette page.</span>
      </div>
      <Manque raisons={[!saisie.trim() && 'les 12 mots du code']}><button class="bouton principal" type="submit" disabled={occupe || !saisie.trim()}>{occupe ? 'Vérification…' : 'Voir ma vidéo'}</button></Manque>
    </form>
  {:else}
    <SuiviVideo cible={cible} />
    {#if choix}<p><button class="bouton lien" onclick={() => (cible = null)}>← Mes autres vidéos</button></p>{/if}
    <p><button class="bouton lien" onclick={() => { cible = null; choix = null; }}>Fermer (oublier le code sur cette page)</button></p>
  {/if}
</div>
