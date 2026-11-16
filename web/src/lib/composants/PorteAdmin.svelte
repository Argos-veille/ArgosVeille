<script lang="ts">
  // Porte de l'administration : affiche le contenu seulement quand la session d'administration est
  // ouverte (clé physique). Fermée après 10 minutes sans activité, 30 minutes au plus.
  import { goto } from '$app/navigation';
  import { onMount, type Snippet } from 'svelte';
  import { ErreurApi } from '#lib/api.ts';
  import { etatSession, fermerSession, ouvrirSession } from '#lib/admin.ts';
  import { message } from '#lib/erreurs.ts';
  import { porte } from '#lib/porte-admin.svelte.ts';

  let { children }: { children: Snippet } = $props();

  let erreur = $state('');
  let enCours = $state(false);
  let sansCle = $state(false);

  async function verifier() {
    try {
      const s = await etatSession();
      porte.etat = !s.superAdmin ? 'interdit' : s.ouverte ? 'ouverte' : 'fermee';
    } catch (x) {
      if (x instanceof ErreurApi && x.statut === 401) return goto('/connexion');
      if (x instanceof ErreurApi && x.statut === 404) { erreur = 'L’administration n’est pas accessible depuis le site public : passez par le tunnel WireGuard, sur admin.argos-veille.fr.'; return; }
      erreur = message(x);
    }
  }

  async function ouvrir() {
    erreur = '';
    sansCle = false;
    enCours = true;
    try {
      await ouvrirSession();
      porte.etat = 'ouverte';
    } catch (x) {
      if (x instanceof ErreurApi && x.code === 'cle_requise') sansCle = true;
      erreur = message(x);
    } finally {
      enCours = false;
    }
  }

  async function fermer() {
    await fermerSession().catch(() => {});
    porte.etat = 'fermee';
  }

  onMount(() => {
    verifier();
    const minuterie = setInterval(() => { if (porte.etat === 'ouverte') verifier(); }, 60_000);
    return () => clearInterval(minuterie);
  });
</script>

{#if porte.etat === 'interdit'}
  <div class="carte"><p class="second">Cet espace est réservé au super-administrateur.</p></div>
{:else if porte.etat === 'fermee'}
  <div class="carte etroit porte">
    <h2>Session d’administration</h2>
    <p class="second">Touchez votre clé pour ouvrir l’administration.</p>
    {#if erreur}<div class="message erreur">{erreur}</div>{/if}
    {#if sansCle}<p><a href="/compte#double-authentification">Enregistrer une clé physique dans Mon compte</a></p>{/if}
    <div class="boutons">
      <button class="bouton principal" onclick={ouvrir} disabled={enCours}>{enCours ? 'Touchez votre clé…' : 'Ouvrir'}</button>
    </div>
  </div>
{:else if porte.etat === 'ouverte'}
  <div class="barre petit">
    <span class="pastille">Session d’administration ouverte</span>
    <button class="bouton" onclick={fermer}>Fermer la session</button>
  </div>
  {@render children()}
{:else if erreur}
  <div class="message erreur">{erreur}</div>
{/if}

<style>
  .porte { margin-top: 1rem; }
  .barre { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
</style>
