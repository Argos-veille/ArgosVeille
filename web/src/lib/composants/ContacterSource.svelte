<script lang="ts">
  // Fiche publique, comptes vérifiés seulement (journaliste, avocat, association) : contacter la source de la vidéo,
  // si elle l'accepte. Ouvre la conversation (chiffrée de bout en bout) dans « Messages ».
  import { goto } from '$app/navigation';
  import { get, post } from '#lib/api.ts';
  import DeverrouillerMessagerie from '#lib/composants/DeverrouillerMessagerie.svelte';
  import { message } from '#lib/erreurs.ts';
  import { cleMessagerie, session } from '#lib/session.svelte.ts';

  let { video }: { video: string } = $props();
  let etat = $state<{ possible: boolean; conversation: string | null; cle: boolean } | null>(null);
  let deverrouiller = $state(false);
  let erreur = $state('');
  const verifie = $derived(!!session.moi?.messagerieSources && session.moi.messagerieSources.statut !== 'admin');

  $effect(() => {
    if (!verifie) return;
    void get<typeof etat>(`/messagerie/videos/${video}`).then((r) => (etat = r)).catch(() => {});
  });

  async function contacter() {
    erreur = '';
    // La conversation exige la clé de messagerie du compte (créée en la déverrouillant si besoin).
    if (!etat?.cle && !cleMessagerie.ouverte) { deverrouiller = true; return; }
    try {
      const r = await post<{ conversation: string }>(`/messagerie/videos/${video}`);
      await goto(`/compte/messages/${r.conversation}`);
    } catch (x) { erreur = message(x); }
  }
</script>

{#if verifie && etat && (etat.possible || etat.conversation)}
  <section class="carte">
    <h2>Contacter la source</h2>
    {#if etat.conversation}
      <p class="second petit">Vous avez déjà une conversation avec la source de cette vidéo.</p>
      <a class="bouton" href="/compte/messages/{etat.conversation}">Ouvrir la conversation</a>
    {:else if deverrouiller && !cleMessagerie.ouverte}
      <DeverrouillerMessagerie ouverte={() => { deverrouiller = false; void contacter(); }} />
    {:else}
      <p class="second petit">La source accepte d’être contactée par des journalistes, avocats ou associations vérifiés. Elle
        reste anonyme ; vos messages sont chiffrés de bout en bout.</p>
      {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
      <button class="bouton principal" onclick={contacter}>Écrire à la source</button>
    {/if}
  </section>
{/if}
