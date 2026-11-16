<script lang="ts">
  // Suivi ouvert avec le code de 12 mots, personne connectée : rattacher la vidéo à son compte (lien DÉFINITIF).
  // La vidéo rejoint « Mes vidéos » : mails d'avancement, messages lisibles sans les 12 mots, retouche du floutage.
  import Info from '#lib/composants/Info.svelte';
  import { goto } from '$app/navigation';
  import { cleVideoPourCompte, type CleVideo } from 'argos-navigateur';
  import { post } from '#lib/api.ts';
  import { appelSource } from '#lib/envoi.ts';
  import { confirmer } from '#lib/confirmer.svelte.ts';
  import { message } from '#lib/erreurs.ts';
  import DeverrouillerMessagerie from '#lib/composants/DeverrouillerMessagerie.svelte';
  import { publiqueOuverte } from '#lib/messagerie.ts';
  import { cleMessagerie, session } from '#lib/session.svelte.ts';

  let { jeton, cleCopie, entropie }: { jeton: string; cleCopie: string; entropie?: Uint8Array } = $props();
  let erreur = $state('');
  let occupe = $state(false);
  // Mot de passe demandé seulement APRÈS le choix de rattacher (et si la messagerie n'est pas déjà ouverte).
  let motDePasseDemande = $state(false);

  async function rattacher() {
    if (!(await confirmer({
      titre: `Rattacher cette vidéo au compte ${session.moi?.pseudo ?? ''} ?`,
      texte: 'C’est définitif : votre compte sera lié à cette vidéo, comme si vous l’aviez envoyée avec lui. Sur demande de la justice, '
        + 'ce lien pourrait révéler que c’est vous qui l’avez envoyée. Pour rester totalement anonyme, ne la rattachez pas.',
      oui: 'Rattacher définitivement', ton: 'danger',
    }))) return;
    if (entropie && !cleMessagerie.ouverte) { motDePasseDemande = true; return; }
    await finir();
  }

  async function finir() {
    motDePasseDemande = false;
    erreur = ''; occupe = true;
    try {
      // Messages lisibles depuis le compte : la clé de messagerie de la vidéo, chiffrée pour la clé du compte OUVERTE par
      // le mot de passe dans ce navigateur, jamais celle que renvoie le serveur (audit du 15 novembre, N1).
      let pourCompte: object | undefined;
      const publique = publiqueOuverte();
      if (entropie && publique) {
        const { cle } = await appelSource<{ cle: CleVideo | null }>('/suivi/messagerie', { jeton });
        if (cle) pourCompte = await cleVideoPourCompte(cle, entropie, publique).catch(() => undefined);
      }
      const r = await post<{ video: string }>('/suivi/rattacher', { jeton, cleCopie, ...(pourCompte ? { pourCompte } : {}) });
      await goto(`/compte/videos/${r.video}`);
    } catch (x) {
      erreur = message(x);
    } finally {
      occupe = false;
    }
  }
</script>

{#if session.moi}
  <div class="carte">
    <h2>Rattacher à mon compte<Info>Rattachée à votre compte ({session.moi.pseudo}), cette vidéo se suit dans « Mes vidéos »,
      sans le code : mails à chaque étape, messages, retouche du floutage.</Info></h2>
    <p class="petit discret">Attention : c’est définitif, et la vidéo ne sera plus anonyme vis-à-vis de votre compte.</p>
    {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
    {#if motDePasseDemande}
      <p class="petit second">Votre mot de passe, pour que les messages de cette vidéo soient lisibles depuis votre compte.</p>
      <DeverrouillerMessagerie ouverte={() => void finir()} />
      <button class="bouton lien" onclick={() => (motDePasseDemande = false)}>Annuler</button>
    {:else}
    <button class="bouton" onclick={rattacher} disabled={occupe}>{occupe ? 'Rattachement…' : 'Rattacher à mon compte…'}</button>
    {/if}
  </div>
{/if}
