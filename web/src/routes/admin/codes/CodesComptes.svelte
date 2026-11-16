<script lang="ts">
  // Codes de comptes spéciaux : saisis à l'inscription, ils certifient le compte (délais sautés) et lui donnent
  // sa catégorie (journaliste, avocat, association, analyste OSINT, ou confiance seule). Une seule utilisation.
  import Manque from '#lib/composants/Manque.svelte';
  import { confirmer } from '#lib/confirmer.svelte.ts';
  import { onMount } from 'svelte';
  import { get, post } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';
  import { preuveCle } from '#lib/admin.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  type Type = 'journaliste' | 'avocat' | 'association' | 'analyste' | 'confiance';
  const TYPES: Record<Type, string> = {
    journaliste: 'Journaliste', avocat: 'Avocat', association: 'Association', analyste: 'Analyste OSINT',
    confiance: 'Compte de confiance (sans catégorie)',
  };
  interface Code { id: string; nom: string; type: Type; creeLe: string; expireLe: string | null; revoqueLe: string | null;
                   utiliseLe: string | null; utilisePar: string | null; code: string | null }
  let codes = $state<Code[]>([]);
  let nom = $state('');
  let type = $state<Type>('association');
  let expire = $state('');
  let motif = $state('');
  let aRevoquer = $state<string | null>(null);
  let motifRevocation = $state('');
  let erreur = $state('');
  let enCours = $state(false);
  let nouveau = $state<string | null>(null);
  let visibles = $state<Record<string, boolean>>({});
  let copieId = $state('');
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const disponible = (c: Code) => !c.revoqueLe && !c.utiliseLe && (!c.expireLe || new Date(c.expireLe) > new Date());
  const faire = async (f: () => Promise<unknown>) => {
    erreur = ''; enCours = true;
    try { await f(); } catch (x) { if (!sessionExpiree(x)) erreur = message(x); } finally { enCours = false; }
  };
  const charger = () => faire(async () => { codes = (await get<{ codes: Code[] }>('/admin/codes-comptes')).codes; });
  const creer = (e: SubmitEvent) => { e.preventDefault(); return faire(async () => {
    const expireLe = expire ? new Date(`${expire}T23:59:59`).toISOString() : undefined;
    nouveau = (await post<{ code: string }>('/admin/codes-comptes',
      { nom: nom.trim(), type, ...(expireLe ? { expireLe } : {}), motif: motif.trim(), cle: await preuveCle() })).code;
    nom = ''; expire = ''; motif = '';
    codes = (await get<{ codes: Code[] }>('/admin/codes-comptes')).codes;
  }); };
  const revoquer = (c: Code) => faire(async () => {
    await post(`/admin/codes-comptes/${c.id}/revoquer`, { motif: motifRevocation.trim(), cle: await preuveCle() });
    aRevoquer = null; motifRevocation = '';
    await charger();
  });
  const supprimer = (c: Code) => faire(async () => { await post(`/admin/codes-comptes/${c.id}/supprimer`); await charger(); });
  const nettoyer = async () => (await confirmer({ titre: 'Retirer de la liste tous les codes utilisés, révoqués ou expirés ?',
                                                  texte: 'Les comptes gardent leur certification.', oui: 'Retirer de la liste' }))
    && faire(async () => { await post('/admin/codes-comptes/nettoyer'); await charger(); });
  async function copier(c: Code) {
    await navigator.clipboard.writeText(c.code!);
    copieId = c.id;
    setTimeout(() => { if (copieId === c.id) copieId = ''; }, 2000);
  }
  onMount(charger);
</script>

{#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}

<section class="carte">
  <h3>Nouveau code</h3>
  <form onsubmit={creer} class="ligne-form">
    <div class="champ">
      <label for="nom-compte">Pour qui ? (visible de vous seul)</label>
      <input id="nom-compte" bind:value={nom} maxlength="80" required placeholder="Maître X, asso Y" />
    </div>
    <div class="champ">
      <label for="type-compte">Type de compte</label>
      <select id="type-compte" bind:value={type}>
        {#each Object.entries(TYPES) as [cle, libelle] (cle)}<option value={cle}>{libelle}</option>{/each}
      </select>
    </div>
    <div class="champ">
      <label for="expire-compte">Expire le (facultatif)</label>
      <input id="expire-compte" type="date" bind:value={expire} />
    </div>
    <div class="champ">
      <label for="motif-compte">Motif (public, au journal)</label>
      <input id="motif-compte" bind:value={motif} maxlength="2000" placeholder="Sans nom" />
    </div>
    <Manque raisons={[!nom.trim() && 'nom', motif.trim().length < 10 && 'motif (10 car.)']}><button class="bouton principal" type="submit" disabled={enCours || !nom.trim() || motif.trim().length < 10}>{enCours ? 'Touchez votre clé…' : 'Créer le code'}</button></Manque>
  </form>
  {#if nouveau}
    <div class="message succes nouveau"><span>Code créé :</span> <code class="mono grand">{nouveau}</code></div>
  {/if}
</section>

<section class="carte">
  <div class="titre-codes">
    <h3>Codes ({codes.filter(disponible).length} disponible{codes.filter(disponible).length > 1 ? 's' : ''})</h3>
    {#if codes.some((c) => !disponible(c))}
      <button class="bouton" onclick={nettoyer}>Retirer les codes utilisés, révoqués et expirés</button>
    {/if}
  </div>
  {#if !codes.length}
    <p class="petit second">Aucun code pour l’instant.</p>
  {:else}
    <div class="tableau">
      <table>
        <thead><tr><th>Pour</th><th>Type</th><th>Code</th><th>Créé</th><th>Expire</th><th>État</th></tr></thead>
        <tbody>
          {#each codes as c (c.id)}
            <tr class:inactif={!disponible(c)}>
              <td>{c.nom}</td><td>{TYPES[c.type] ?? c.type}</td>
              <td class="code-cellule">{#if !c.code}<span class="discret petit">non conservé</span>
                {:else}<span class="mono">{visibles[c.id] ? c.code : '••••-••••-••••'}</span>
                  <button class="bouton lien" onclick={() => (visibles[c.id] = !visibles[c.id])}>{visibles[c.id] ? 'Masquer' : 'Afficher'}</button>
                  <button class="bouton lien" onclick={() => copier(c)}>{copieId === c.id ? 'Copié ✓' : 'Copier'}</button>{/if}</td>
              <td>{date(c.creeLe)}</td><td>{c.expireLe ? date(c.expireLe) : 'jamais'}</td>
              <td><span class="etat">
                {#if c.utiliseLe}Utilisé le {date(c.utiliseLe)}{c.utilisePar ? ` par ${c.utilisePar}` : ''}
                {:else if c.revoqueLe}Révoqué le {date(c.revoqueLe)}
                {:else if !disponible(c)}Expiré
                {:else if aRevoquer === c.id}
                  <input class="motif-revocation" bind:value={motifRevocation} maxlength="2000" placeholder="Motif (public)" aria-label="Motif de la révocation" />
                  <Manque raisons={[motifRevocation.trim().length < 10 && 'motif (10 car.)']}><button class="bouton lien danger" disabled={enCours || motifRevocation.trim().length < 10} onclick={() => revoquer(c)}>{enCours ? 'Touchez votre clé…' : 'Révoquer'}</button></Manque>
                  <button class="bouton lien" onclick={() => { aRevoquer = null; motifRevocation = ''; }}>Annuler</button>
                {:else}Disponible <button class="bouton lien danger" onclick={() => { aRevoquer = c.id; motifRevocation = ''; }}>Révoquer</button>{/if}
                {#if !disponible(c)}<button class="bouton lien" onclick={() => supprimer(c)}>Retirer</button>{/if}
              </span></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  section { margin-top: 1.5rem; }
  .ligne-form { display: flex; gap: 1rem; align-items: flex-end; flex-wrap: wrap; }
  .ligne-form .champ { margin-bottom: 0; flex: 1 1 11rem; }
  .nouveau { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin-top: 1rem; }
  .grand { font-size: 1.25rem; user-select: all; }
  .mono { font-family: var(--police-mono); letter-spacing: 0.05em; }
  .titre-codes { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .titre-codes h3 { margin: 0; }
  .tableau { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9375rem; }
  th, td { text-align: left; padding: 0.5rem 0.625rem; border-bottom: 1px solid var(--trait); }
  th { color: var(--texte-2); font-weight: 600; }
  tr.inactif td { color: var(--texte-3); }
  .code-cellule { white-space: nowrap; }
  .code-cellule .bouton { margin-left: 0.5rem; }
  .etat { display: inline-flex; gap: 0.75rem; align-items: baseline; flex-wrap: wrap; }
  .danger { color: var(--danger); }
</style>
