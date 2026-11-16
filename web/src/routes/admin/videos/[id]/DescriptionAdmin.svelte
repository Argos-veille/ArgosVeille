<script lang="ts">
  // Description de la vidéo : corriger ou masquer un passage (« [retiré] »), avec la clé (0113, 0114).
  // Le texte remplacé n'est gardé nulle part (pas d'annulation) ; la justification va au journal public.
  import Manque from '#lib/composants/Manque.svelte';
  import { corrigerDescription, correctionsDescription, type CorrectionDescription } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  let { video, actuelle, apres }: { video: string; actuelle: string | null; apres: () => Promise<void> } = $props();

  const RETIRE = '[retiré]';
  let corrections = $state<CorrectionDescription[]>([]);
  let ouvert = $state(false);
  let texte = $state('');
  let justification = $state('');
  let enCours = $state(false);
  let erreur = $state('');
  let zone = $state<HTMLTextAreaElement | null>(null);

  const quand = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  const pret = $derived(!!texte.trim() && texte.trim() !== (actuelle ?? '') && justification.trim().length >= 10);

  async function charger() {
    try { corrections = (await correctionsDescription(video)).corrections; } catch (x) { if (!sessionExpiree(x)) erreur = message(x); }
  }
  $effect(() => { void video; void charger(); });

  function ouvrir() { texte = actuelle ?? ''; justification = ''; erreur = ''; ouvert = true; }

  /** Remplace la sélection du champ par « [retiré] ». */
  function masquerSelection() {
    if (!zone) return;
    const { selectionStart: d, selectionEnd: f } = zone;
    if (d === f) return;
    texte = texte.slice(0, d) + RETIRE + texte.slice(f);
    queueMicrotask(() => { zone?.focus(); zone?.setSelectionRange(d + RETIRE.length, d + RETIRE.length); });
  }

  async function enregistrer() {
    erreur = ''; enCours = true;
    try {
      await corrigerDescription(video, texte.trim(), justification.trim());
      ouvert = false;
      await charger();
      await apres();
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    } finally {
      enCours = false;
    }
  }
</script>

<section class="carte">
  <h2>Description</h2>
  {#if !ouvert}
    <p class="texte">{actuelle ?? '—'}</p>
    <button class="bouton" onclick={ouvrir}>Corriger</button>
  {:else}
    <div class="champ">
      <label for="desc-texte">Texte publié</label>
      <textarea id="desc-texte" rows="5" maxlength="5000" bind:value={texte} bind:this={zone}></textarea>
    </div>
    <button class="bouton petit" type="button" onclick={masquerSelection}>Remplacer la sélection par « {RETIRE} »</button>
    <div class="champ">
      <label for="desc-justif">Justification (publique, inscrite au journal)</label>
      <textarea id="desc-justif" rows="2" maxlength="2000" placeholder="Ne pas recopier le passage retiré" bind:value={justification}></textarea>
    </div>
    <p class="petit second">Définitif : l’ancien texte n’est gardé nulle part.</p>
    <div class="boutons">
      <Manque raisons={[!texte.trim() && 'texte', texte.trim() === (actuelle ?? '') && 'un changement', justification.trim().length < 10 && 'justification (10 car.)']}>
        <button class="bouton principal" onclick={enregistrer} disabled={enCours || !pret}>{enCours ? 'Touchez votre clé…' : 'Enregistrer'}</button>
      </Manque>
      <button class="bouton lien" onclick={() => (ouvert = false)}>Annuler</button>
    </div>
  {/if}
  {#if erreur}<p class="message erreur" role="alert">{erreur}</p>{/if}

  {#if corrections.length}
    <details>
      <summary class="petit">Corrections ({corrections.length})</summary>
      <ul class="petit">
        {#each corrections as c (c.id)}<li>{quand(c.le)} · {c.justification}</li>{/each}
      </ul>
    </details>
  {/if}
</section>

<style>
  .texte { white-space: pre-wrap; }
</style>
