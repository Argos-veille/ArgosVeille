<script lang="ts">
  // Indicateurs du serveur : place sur les disques, dernières sauvegardes (chaque nuit), place occupée sur R2.
  import { onMount } from 'svelte';
  import { get } from '#lib/api.ts';
  import { message } from '#lib/erreurs.ts';

  interface Etat {
    disques: { nom: string; chemin: string; libres: number; total: number }[];
    sauvegardes: { nom: string; le: string | null; ok: boolean | null; detail: string | null }[];
    r2: { fichiers: number; octets: number; le: string } | null;
    erreurR2: string | null;
  }
  const R2_GRATUIT = 10e9;   // offre gratuite de Cloudflare R2 : 10 Go

  let e = $state<Etat | null>(null);
  let erreur = $state('');
  onMount(async () => {
    try { e = await get<Etat>('/admin/serveur'); } catch (x) { erreur = message(x); }
  });

  const go = (o: number) => `${(o / 1e9).toLocaleString('fr-FR', { maximumFractionDigits: o < 10e9 ? 1 : 0 })} Go`;
  const quand = (d: string) => new Date(d).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  // Une sauvegarde de plus de 30 heures a manqué au moins une nuit.
  const enRetard = (d: string | null) => d === null || Date.now() - new Date(d).getTime() > 30 * 3600_000;
</script>

{#if erreur}<div class="message erreur">{erreur}</div>{/if}
{#if e}
  <div class="tuiles">
    {#each e.disques as d (d.chemin)}
      {@const part = d.total ? 1 - d.libres / d.total : 0}
      <div class="tuile {part > 0.85 ? 'alerte' : ''}">
        <span class="nombre">{go(d.libres)}</span><span>libres · {d.nom}</span>
        <span class="petit discret">sur {go(d.total)} ({Math.round(part * 100)} % utilisés)</span>
      </div>
    {/each}
    {#each e.sauvegardes as s (s.nom)}
      <div class="tuile {s.ok === false || enRetard(s.le) ? 'alerte' : ''}">
        <span class="nombre">{s.ok === null ? '—' : s.ok ? 'OK' : 'Échec'}</span><span>sauvegarde · {s.nom}</span>
        <span class="petit discret">{s.le ? quand(s.le) : 'aucun passage enregistré'}{s.detail ? ` · ${s.detail}` : ''}</span>
      </div>
    {/each}
    {#if e.r2}
      <div class="tuile {e.r2.octets > 0.8 * R2_GRATUIT ? 'alerte' : ''}">
        <span class="nombre">{go(e.r2.octets)}</span><span>sur R2 · {e.r2.fichiers.toLocaleString('fr-FR')} fichiers</span>
        <span class="petit discret">offre gratuite : 10 Go · mesuré {quand(e.r2.le)}</span>
      </div>
    {:else if e.erreurR2}
      <div class="tuile alerte"><span class="nombre">R2</span><span>illisible</span><span class="petit discret">{e.erreurR2}</span></div>
    {/if}
  </div>
{/if}

<style>
  .tuiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 0.75rem; }
  .tuile { display: grid; gap: 0.25rem; padding: 1rem 1.25rem; background: var(--surface); border: 1px solid var(--trait);
           border-radius: var(--rayon-grand); color: var(--texte); }
  .tuile.alerte { border-color: var(--danger); background: var(--danger-doux); }
  .nombre { font-size: 2rem; font-weight: 700; line-height: 1; }
</style>
