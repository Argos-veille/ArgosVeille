<script lang="ts">
  // Liste des comptes (pseudo, statut, activité ; jamais le mail ni le téléphone). Filtres dans l'adresse.
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { comptesAdmin, STATUTS_COMPTE, type CompteListe } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  const CHAMPS = ['texte', 'statut', 'analyste', 'doubleAuth', 'nonLus'] as const;
  type Champ = (typeof CHAMPS)[number];
  let f = $state(Object.fromEntries(CHAMPS.map((c) => [c, page.url.searchParams.get(c) ?? ''])) as Record<Champ, string>);
  let comptes = $state<CompteListe[] | null>(null);
  let erreur = $state('');
  const quand = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

  function appliquer() {
    const q = new URLSearchParams(CHAMPS.filter((c) => f[c].trim()).map((c) => [c, f[c].trim()]));
    goto(`/admin/comptes${q.size ? `?${q}` : ''}`, { replace: true });
  }
  let minuterie: ReturnType<typeof setTimeout> | undefined;
  const saisie = () => { clearTimeout(minuterie); minuterie = setTimeout(appliquer, 400); };
  const coche = (c: Champ) => (e: Event) => { f[c] = (e.currentTarget as HTMLInputElement).checked ? 'true' : ''; appliquer(); };

  $effect(() => {
    const q = page.url.searchParams.toString();
    comptesAdmin(q).then((r) => { comptes = r.comptes; erreur = ''; })
      .catch((x) => { if (!sessionExpiree(x)) erreur = message(x); });
  });
</script>

<form class="carte filtres" onsubmit={(e) => { e.preventDefault(); appliquer(); }}>
  <label class="large">Pseudo
    <input type="search" bind:value={f.texte} oninput={saisie} maxlength="60" placeholder="Tout ou partie du pseudo" />
  </label>
  <label>Statut
    <select bind:value={f.statut} onchange={appliquer}>
      <option value="">Tous</option>
      {#each Object.entries(STATUTS_COMPTE) as [cle, texte] (cle)}<option value={cle}>{texte}</option>{/each}
    </select>
  </label>
  <div class="cases">
    <label class="case"><input type="checkbox" checked={f.nonLus === 'true'} onchange={coche('nonLus')} /> Avec une réponse non lue</label>
    <label class="case"><input type="checkbox" checked={f.analyste === 'true'} onchange={coche('analyste')} /> Analystes OSINT</label>
    <label class="case"><input type="checkbox" checked={f.doubleAuth === 'true'} onchange={coche('doubleAuth')} /> Avec double authentification</label>
  </div>
</form>

{#if erreur}<div class="message erreur">{erreur}</div>{/if}
{#if comptes}
  <p class="petit discret">{comptes.length} compte{comptes.length > 1 ? 's' : ''}{comptes.length === 300 ? ' (les 300 plus récents : affinez)' : ''}</p>
  {#each comptes as c (c.id)}
    <a class="carte ligne" href="/admin/comptes/{c.id}">
      <div>
        <strong>{c.pseudo}</strong>
        {#if c.statut !== 'active'}<span class="pastille rouge">{STATUTS_COMPTE[c.statut]}{c.suspenduJusqua ? ` jusqu’au ${quand(c.suspenduJusqua)}` : ''}</span>{/if}
        {#if c.superAdmin}<span class="pastille accent">Super-admin</span>{/if}
        {#if c.analyste}<span class="pastille">Analyste OSINT</span>{/if}
        {#if c.suspect}<span class="pastille rouge">Suspect (collusion)</span>{/if}
        {#if c.messagesNonLus}<span class="pastille accent">{c.messagesNonLus} réponse{c.messagesNonLus > 1 ? 's' : ''} non lue{c.messagesNonLus > 1 ? 's' : ''}</span>{/if}
        <div class="petit discret">Inscrit le {quand(c.inscritLe)} · score {c.score.toFixed(2)} · {c.votes} vote{c.votes > 1 ? 's' : ''}
          · dernière activité {quand(c.derniereActivite)}{c.doubleAuth ? ' · double authentification' : ''}</div>
      </div>
    </a>
  {:else}
    <div class="carte"><p class="second">Aucun compte ne correspond.</p></div>
  {/each}
{/if}

<style>
  .filtres { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 0.75rem 1rem; align-items: end; margin-bottom: 1rem; }
  .filtres label:not(.case) { display: grid; gap: 0.25rem; font-size: 0.875rem; font-weight: 600; }
  .filtres .large { grid-column: 1 / -1; }
  .cases { display: grid; gap: 0.25rem; font-size: 0.875rem; }
  .ligne { display: block; margin-bottom: 0.75rem; color: var(--texte); text-decoration: none; }
  .ligne:hover { border-color: var(--trait-fort); }
  .pastille { margin-left: 0.375rem; }
  .pastille.rouge { background: var(--danger-doux); color: var(--danger); border-color: var(--danger); }
</style>
