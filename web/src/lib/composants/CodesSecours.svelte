<script lang="ts">
  import Manque from '#lib/composants/Manque.svelte';
  // Codes de secours, montrés une seule fois : à noter ou télécharger avant de continuer.
  let { codes, pseudo = '', suite }: { codes: string[]; pseudo?: string; suite: () => void } = $props();
  let notes = $state(false);

  function telecharger() {
    const texte = `Argos Veille — codes de secours${pseudo ? ` du compte ${pseudo}` : ''}\n`
      + `Chaque code ne sert qu'une fois. Gardez-les hors de votre téléphone.\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([texte], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'argos-codes-secours.txt' });
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<div class="message attention">
  <strong>Notez ces 10 codes maintenant : ils ne seront plus affichés.</strong>
  Ils remplacent votre téléphone ou votre clé en cas de perte. Chacun ne sert qu’une fois.
</div>
<ol class="codes">
  {#each codes as c (c)}<li><code>{c}</code></li>{/each}
</ol>
<div class="boutons">
  <button class="bouton" onclick={telecharger}>Télécharger (fichier texte)</button>
</div>
<label class="case">
  <input type="checkbox" bind:checked={notes} />
  <span>J’ai noté ou téléchargé mes codes, et je les garde en lieu sûr.</span>
</label>
<div class="boutons">
  <Manque raisons={[!notes && 'la case « codes notés »']}><button class="bouton principal" disabled={!notes} onclick={suite}>Continuer</button></Manque>
</div>

<style>
  .codes { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem 1.5rem; padding: 1rem 1rem 1rem 2.5rem;
           background: var(--surface-2); border-radius: var(--rayon); margin: 0 0 0.5rem; }
  .codes code { font-size: 1rem; letter-spacing: 0.04em; }
</style>
