<script lang="ts">
  // Boîte de confirmation du site (voir #lib/confirmer.svelte.ts). Échap ou « Annuler » : refus.
  import { confirmation } from '#lib/confirmer.svelte.ts';

  let boite: HTMLDialogElement | undefined = $state();
  const d = $derived(confirmation.demande);
  $effect(() => {
    if (!boite) return;
    if (d && !boite.open) boite.showModal();
    else if (!d && boite.open) boite.close();
  });
  const CLASSES = { valider: 'bouton valider', danger: 'bouton danger', neutre: 'bouton principal' } as const;
</script>

<dialog bind:this={boite} class="confirmation" aria-labelledby="titre-confirmation"
        oncancel={(e) => { e.preventDefault(); d?.repondre(false); }}>
  {#if d}
    <h2 id="titre-confirmation">{d.titre}</h2>
    {#if d.texte}<p class="second">{d.texte}</p>{/if}
    <div class="boutons">
      <button class={CLASSES[d.ton ?? 'neutre']} onclick={() => d.repondre(true)}>{d.oui ?? 'Confirmer'}</button>
      <button class="bouton lien" onclick={() => d.repondre(false)}>{d.non ?? 'Annuler'}</button>
    </div>
  {/if}
</dialog>

<style>
  .confirmation { width: min(30rem, calc(100vw - 2rem)); border: 1px solid var(--trait); border-radius: var(--rayon-grand);
                  padding: 1.5rem; background: var(--surface); color: var(--texte); box-shadow: var(--ombre); }
  .confirmation::backdrop { background: rgb(18 20 23 / 0.6); }
  .confirmation h2 { margin-top: 0; font-size: 1.15rem; }
  .boutons { margin-top: 1.25rem; }
</style>
