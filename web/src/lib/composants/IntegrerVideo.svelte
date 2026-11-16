<script lang="ts">
  // « Intégrer cette vidéo » : le code à copier dans un autre site (comme pour YouTube), et le lien oEmbed.
  let { video }: { video: string } = $props();
  let ouvert = $state(false);
  let copie = $state(false);
  const site = typeof location === 'undefined' ? '' : location.origin;
  const code = $derived(`<iframe src="${site}/integrer/${video}" width="640" height="456" style="border:0;max-width:100%" `
    + `title="Vidéo Argos Veille" loading="lazy" referrerpolicy="no-referrer" `
    + `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>`);
  async function copier() {
    await navigator.clipboard.writeText(code);
    copie = true;
    setTimeout(() => (copie = false), 2000);
  }
</script>

<section class="carte">
  <h2>Partager, intégrer</h2>
  {#if !ouvert}
    <button class="bouton" onclick={() => (ouvert = true)}>Intégrer cette vidéo</button>
  {:else}
    <p class="petit second">À copier dans votre site (sans cookie ni traceur). Licence <a href="/donnees">CC BY 4.0</a> :
      gardez la mention « faits allégués, non jugés ».</p>
    <textarea class="mono" rows="4" readonly onfocus={(e) => e.currentTarget.select()}>{code}</textarea>
    <div class="boutons"><button class="bouton principal" onclick={copier}>{copie ? 'Copié' : 'Copier le code'}</button></div>
    <p class="petit discret">WordPress, Mastodon et les autres outils compatibles oEmbed intègrent aussi la vidéo à partir du
      simple lien de cette page.</p>
  {/if}
</section>

<style>
  textarea { width: 100%; font-size: 0.75rem; }
</style>
