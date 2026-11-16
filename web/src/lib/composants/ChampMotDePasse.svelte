<script lang="ts">
  import Info from '#lib/composants/Info.svelte';
  // Champ de mot de passe avec bouton « afficher » et rappel des règles.
  let { id, libelle, valeur = $bindable(''), nouveau = false, aide = '' }:
    { id: string; libelle: string; valeur?: string; nouveau?: boolean; aide?: string } = $props();
  let visible = $state(false);
  // Explication derrière un « i » : règles d'un nouveau mot de passe, ou texte donné (" " : aucune).
  const explication = $derived(aide.trim()
    || (nouveau && !aide ? '12 caractères au moins. Une phrase de plusieurs mots est idéale ; évitez les mots de passe courants.' : ''));
</script>

<div class="champ">
  <label for={id}>{libelle}{#if explication}<Info>{explication}</Info>{/if}</label>
  <div class="ligne">
    <input {id} type={visible ? 'text' : 'password'} bind:value={valeur} required
           autocomplete={nouveau ? 'new-password' : 'current-password'} minlength={nouveau ? 12 : undefined} maxlength="512"
           />
    <button type="button" class="bouton" onclick={() => (visible = !visible)} aria-pressed={visible}
            aria-label={visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}>
      {visible ? 'Masquer' : 'Afficher'}
    </button>
  </div>
</div>

<style>
  .ligne { display: flex; gap: 0.5rem; }
  .ligne input { flex: 1; }
</style>
