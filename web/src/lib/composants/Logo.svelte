<script lang="ts">
  // Œil-repère d'Argos Veille, aux couleurs du thème (le fond suit la page, l'iris reste ambre).
  let { taille = 32, texte = true }: { taille?: number; texte?: boolean } = $props();
</script>

<span class="logo">
  <svg viewBox="30 10 140 184" width={taille * 0.76} height={taille} aria-hidden="true">
    <path d="M100 188 C100 188 38 122 38 80 A62 62 0 1 1 162 80 C162 122 100 188 100 188 Z" fill="var(--texte)" />
    <path d="M52 80 Q100 34 148 80 Q100 126 52 80 Z" fill="var(--fond)" />
    <g fill="var(--texte)">
      <circle cx="100" cy="53" r="2" /><circle cx="113.5" cy="56.6" r="2" /><circle cx="123.4" cy="66.5" r="2" />
      <circle cx="127" cy="80" r="2" /><circle cx="123.4" cy="93.5" r="2" /><circle cx="113.5" cy="103.4" r="2" />
      <circle cx="100" cy="107" r="2" /><circle cx="86.5" cy="103.4" r="2" /><circle cx="76.6" cy="93.5" r="2" />
      <circle cx="73" cy="80" r="2" /><circle cx="76.6" cy="66.5" r="2" /><circle cx="86.5" cy="56.6" r="2" />
    </g>
    <circle cx="100" cy="80" r="20" fill="#E8A33D" />
    <circle cx="100" cy="80" r="8" fill="#1F2328" />
  </svg>
  {#if texte}
    <span class="nom" style:font-size="{taille * 0.62}px"><span class="argos">Argos</span> <span class="veille">Veille</span></span>
  {/if}
</span>

<style>
  .logo { display: inline-flex; align-items: center; gap: 0.5rem; }
  .nom { letter-spacing: -0.03em; color: var(--texte); line-height: 1; white-space: nowrap; }
  .argos { font-weight: 800; }
  .veille { font-weight: 450; color: var(--texte-2); }
</style>
