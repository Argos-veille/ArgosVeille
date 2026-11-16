<script lang="ts">
  // Fiche d'un compte : activité (des totaux), sanctions, statut d'analyste, conversation.
  // Sanctions et statut d'analyste : clé physique + motif (public, au journal, sans le pseudo pour les sanctions) ;
  // le compte est prévenu par mail, avec le motif, de toute suspension, levée ou exclusion.
  import Manque from '#lib/composants/Manque.svelte';
  import { onMount } from 'svelte';
  import { compteAdmin, ecrireAuCompte, sanctionner, STATUTS_COMPTE, changerStatut, STATUTS_SPECIAUX, type StatutCompte, type ActionCompte,
           type FicheCompte } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { sessionExpiree } from '#lib/porte-admin.svelte.ts';

  let { id }: { id: string } = $props();

  let c = $state<FicheCompte | null>(null);
  let erreur = $state('');
  let info = $state('');
  let enCours = $state(false);
  let action = $state<ActionCompte | null>(null);
  let motif = $state('');
  let jours = $state(7);
  let confirmeBan = $state(false);
  let texte = $state('');

  const quand = (iso: string | null) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const SANCTIONS = { logout: 'Déconnexion forcée', suspend: 'Suspension', ban: 'Exclusion' } as const;
  const ACTIONS: Record<ActionCompte, { titre: string; aide: string; danger?: boolean }> = {
    deconnecter: { titre: 'Déconnecter', aide: 'Ferme toutes ses sessions ; il peut se reconnecter tout de suite.' },
    suspendre: { titre: 'Suspendre', aide: 'Plus de connexion pendant la durée choisie ; il reçoit un mail avec le motif.' },
    lever: { titre: 'Lever la suspension', aide: 'Il peut de nouveau se connecter ; il reçoit un mail.' },
    bannir: { titre: 'Exclure', aide: 'Définitif : son téléphone et son mail ne pourront plus servir à s’inscrire. Il reçoit un mail avec le motif.', danger: true },
  };
  const possibles = $derived<ActionCompte[]>(!c || c.superAdmin ? [] : [
    'deconnecter', ...(c.statut === 'suspended' ? ['lever' as const] : c.statut === 'active' ? ['suspendre' as const] : []),
    ...(c.statut !== 'banned' ? ['bannir' as const] : []),
  ]);

  async function charger() {
    try {
      c = await compteAdmin(id);
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
    }
  }
  async function faire(f: () => Promise<unknown>, ok: string) {
    erreur = ''; info = ''; enCours = true;
    try {
      const r = await f() as { prevenu?: boolean };
      info = ok + (r?.prevenu === false ? ' (mail non envoyé : pas d’adresse ou échec)' : '');
      await charger();
      return true;
    } catch (x) {
      if (!sessionExpiree(x)) erreur = message(x);
      return false;
    } finally {
      enCours = false;
    }
  }
  async function valider() {
    const a = action!;
    if (await faire(() => sanctionner(id, a, motif.trim(), a === 'suspendre' ? jours : undefined), `${ACTIONS[a].titre} : fait.`)) {
      action = null; motif = ''; confirmeBan = false;
    }
  }
  async function envoyer(e: SubmitEvent) {
    e.preventDefault();
    if (await faire(() => ecrireAuCompte(id, texte.trim()), 'Message envoyé ; il est prévenu par mail.')) texte = '';
  }

  onMount(charger);
</script>

{#if c}
  <span class="surtitre">Compte</span>
  <h1>{c.pseudo}
    <span class="pastille {c.statut !== 'active' ? 'rouge' : ''}">{STATUTS_COMPTE[c.statut]}{c.suspenduJusqua ? ` jusqu’au ${quand(c.suspenduJusqua)}` : ''}</span>
    {#if c.analyste}<span class="pastille">Analyste OSINT</span>{/if}
    {#if c.superAdmin}<span class="pastille accent">Super-admin</span>{/if}</h1>
  {#if erreur}<div class="message erreur" role="alert">{erreur}</div>{/if}
  {#if info}<div class="message succes" role="status">{info}</div>{/if}

  <div class="grille">
    <div class="colonne">
      <section class="carte">
        <h2>Conversation</h2>
        {#each c.messages as m (m.id)}
          <div class="bulle" class:admin={m.deLAdmin}>
            <div class="petit discret">{m.deLAdmin ? 'Vous (administration)' : c.pseudo} · {quand(m.le)}
              {#if m.deLAdmin}{' · '}{m.luLe ? `lu le ${quand(m.luLe)}` : 'pas encore lu'}{/if}</div>
            <p>{m.texte}</p>
          </div>
        {:else}
          <p class="second petit">Aucun message.</p>
        {/each}
        {#if !c.superAdmin}
          <form onsubmit={envoyer}>
            <div class="champ">
              <label for="message">Écrire à {c.pseudo}</label>
              <textarea id="message" rows="4" maxlength="5000" bind:value={texte}></textarea>
            </div>
            <Manque raisons={[texte.trim().length < 2 && 'message']}><button class="bouton principal" disabled={enCours || texte.trim().length < 2}>Envoyer</button></Manque>
          </form>
        {/if}
      </section>

      <section class="carte">
        <h2>Sanctions</h2>
        {#each c.sanctions as s (s.le)}
          <div class="ligne-sanction">
            <strong>{SANCTIONS[s.type]}</strong>
            <span class="petit discret"> · {quand(s.le)}{s.fin ? ` → ${quand(s.fin)}` : ''}{s.leveeLe ? ` · levée le ${quand(s.leveeLe)}` : ''}</span>
            {#if s.motif}<p class="petit second">{s.motif}</p>{/if}
          </div>
        {:else}
          <p class="second petit">Aucune sanction.</p>
        {/each}
      </section>
    </div>

    <aside class="colonne">
      <section class="carte">
        <h2>Activité</h2>
        <dl>
          <dt>Inscrit</dt><dd>{quand(c.inscritLe)}</dd>
          <dt>Dernière activité</dt><dd>{quand(c.derniereActivite)}</dd>
          <dt>Sessions ouvertes</dt><dd>{c.sessionsOuvertes}</dd>
          <dt>Double authentification</dt><dd>{c.doubleAuth.length ? c.doubleAuth.map((k) => (k === 'totp' ? 'application' : 'clé')).join(', ') : 'non'}</dd>
          <dt>Score</dt><dd>{Number(c.score).toFixed(2)}{c.suspect ? ' · suspect (collusion)' : ''}</dd>
          <dt>Votes (relecture / jury)</dt><dd>{c.activite.votes} / {c.activite.votesJury}</dd>
          <dt>Dernier vote</dt><dd>{quand(c.activite.dernierVote)}</dd>
          <dt>Convocations (30 j)</dt><dd>{c.activite.convocations30j}</dd>
          <dt>Notes d’analyste</dt><dd>{c.activite.notes}{c.activite.notesMasquees ? ` (${c.activite.notesMasquees} masquée${c.activite.notesMasquees > 1 ? 's' : ''})` : ''}</dd>
          <dt>Corrections</dt><dd>{c.activite.corrections}</dd>
          <dt>Signalements envoyés</dt><dd>{c.activite.signalements}</dd>
        </dl>
      </section>

      {#if !c.superAdmin}
        <section class="carte">
          <h2>Statuts</h2>
          <ul class="statuts">
            {#each Object.entries(STATUTS_SPECIAUX) as [s, libelle] (s)}
              {@const actif = (c.statuts ?? []).includes(s as StatutCompte)}
              <!-- Statuts vérifiés : double authentification obligatoire (refusé aussi par la base, 0102). -->
              {@const sans2fa = !actif && s !== 'confiance' && !c.doubleAuth.length}
              {@const echeance = c.echeances?.[s as StatutCompte]}
              {@const renouvelable = !!echeance && new Date(echeance).getTime() - Date.now() <= 30 * 86_400_000}
              <li>
                <span>{libelle} {#if actif}<span class="pastille accent">accordé</span>{/if}
                  {#if echeance}<span class="petit second">jusqu’au {new Date(echeance).toLocaleDateString('fr-FR')}</span>{/if}</span>
                {#if renouvelable}
                  <button class="bouton" disabled={enCours}
                          onclick={() => faire(() => changerStatut(c!.pseudo, s as StatutCompte, true), 'Statut renouvelé pour un an.')}>Renouveler</button>
                {/if}
                <Manque raisons={[sans2fa && 'sa double authentification']}><button class="bouton" disabled={enCours || sans2fa}
                        onclick={() => faire(() => changerStatut(c!.pseudo, s as StatutCompte, !actif), actif ? 'Statut retiré.' : 'Statut accordé.')}>
                  {actif ? 'Retirer' : 'Accorder'}</button></Manque>
              </li>
            {/each}
          </ul>
        </section>

        <section class="carte">
          <h2>Sanctionner</h2>
          <div class="boutons serre">
            {#each possibles as a (a)}
              <button class="bouton {ACTIONS[a].danger ? 'danger' : ''}" aria-pressed={action === a}
                      onclick={() => { action = action === a ? null : a; motif = ''; confirmeBan = false; }}>{ACTIONS[a].titre}</button>
            {/each}
          </div>
          {#if action}
            {#if action === 'suspendre'}
              <label class="champ">Durée
                <select bind:value={jours}>
                  {#each [1, 3, 7, 14, 30, 90] as j (j)}<option value={j}>{j} jour{j > 1 ? 's' : ''}</option>{/each}
                </select>
              </label>
            {/if}
            <div class="champ">
              <label for="motif-sanction">Motif (envoyé au compte et inscrit au journal public, sans son pseudo : n’y mettez aucun nom)</label>
              <textarea id="motif-sanction" placeholder="Public : aucun nom ni détail identifiant" rows="3" maxlength="2000" bind:value={motif}></textarea>
            </div>
            {#if action === 'bannir'}
              <label class="case petit"><input type="checkbox" bind:checked={confirmeBan} /> Je confirme : l’exclusion est définitive.</label>
            {/if}
            <Manque raisons={[motif.trim().length < 10 && 'motif (10 car.)', action === 'bannir' && !confirmeBan && 'case de confirmation']}><button class="bouton principal" onclick={valider}
                    disabled={enCours || motif.trim().length < 10 || (action === 'bannir' && !confirmeBan)}>
              {enCours ? 'Touchez votre clé…' : 'Confirmer'}</button></Manque>
          {/if}
        </section>
      {/if}
    </aside>
  </div>
{:else if erreur}
  <div class="message erreur">{erreur}</div>
{/if}

<style>
  h1 .pastille { vertical-align: middle; font-size: 0.875rem; }
  .pastille.rouge { background: var(--danger-doux); color: var(--danger); border-color: var(--danger); }
  .grille { display: grid; grid-template-columns: minmax(0, 1fr) 24rem; gap: 1.5rem; align-items: start; margin-top: 1.5rem; }
  @media (max-width: 60rem) { .grille { grid-template-columns: 1fr; } }
  .colonne { display: grid; gap: 1rem; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 0.75rem; margin: 0 0 0.75rem; font-size: 0.9375rem; }
  dt { color: var(--texte-2); }
  dd { margin: 0; text-align: right; }
  .bulle { padding: 0.625rem 0.75rem; margin-bottom: 0.5rem; border: 1px solid var(--trait); border-radius: var(--rayon); }
  .bulle.admin { box-shadow: inset 3px 0 0 var(--accent); }
  .bulle p { margin: 0.25rem 0 0; white-space: pre-line; }
  .ligne-sanction { padding: 0.5rem 0; border-bottom: 1px solid var(--trait); }
  .ligne-sanction p { margin: 0.25rem 0 0; }
  .serre { margin-top: 0; }
  [aria-pressed='true'] { border-color: var(--accent); background: var(--accent-doux); }
  .bouton.danger { color: var(--danger); border-color: var(--danger); }
  .statuts { list-style: none; padding: 0; margin: 0.75rem 0 0; display: grid; gap: 0.5rem; }
  .statuts li { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
</style>
