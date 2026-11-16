// Indicateurs du serveur pour le tableau de bord de l'administration : place sur les disques, dernières sauvegardes
// (fichiers d'état écrits par les scripts de sauvegarde, /var/lib/argos-etat), place occupée sur R2.
import { readFile, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Dependances } from './app.ts';

const ETAT = process.env['ARGOS_ETAT_SAUVEGARDES'] ?? '/var/lib/argos-etat';
const CACHE_R2 = 600;   // la liste complète de R2 coûte des requêtes : 10 minutes

export interface Disque { nom: string; chemin: string; libres: number; total: number }
export interface Sauvegarde { nom: string; le: string | null; ok: boolean | null; detail: string | null }

async function disque(nom: string, chemin: string): Promise<Disque | null> {
  try {
    const s = await statfs(chemin);
    return { nom, chemin, libres: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }   // dossier absent (développement)
}

async function sauvegarde(nom: string, fichier: string): Promise<Sauvegarde> {
  try {
    const e = JSON.parse(await readFile(join(ETAT, fichier), 'utf8')) as { le?: string; ok?: boolean; detail?: string };
    return { nom, le: typeof e.le === 'string' ? e.le : null, ok: typeof e.ok === 'boolean' ? e.ok : null,
             detail: typeof e.detail === 'string' ? e.detail.slice(0, 300) : null };
  } catch { return { nom, le: null, ok: null, detail: null }; }   // jamais lancée, ou script pas encore réinstallé
}

/** B13 : dernier passage de la copie tirée par le serveur de copie (signalé par lui, enregistré en base). */
async function copieChezMoi(deps: Dependances): Promise<Sauvegarde> {
  const nom = 'Copie externe';
  try {
    const r = await deps.bases.app.query<{ received_at: Date; ok: boolean; detail: string | null }>(
      'SELECT received_at, ok, detail FROM core.admin_external_copy()');
    const l = r.rows[0];
    return l ? { nom, le: l.received_at.toISOString(), ok: l.ok, detail: l.detail } : { nom, le: null, ok: null, detail: null };
  } catch { return { nom, le: null, ok: null, detail: null }; }
}

export async function etatServeur(deps: Dependances) {
  const env = process.env;
  const disques = (await Promise.all([
    disque('Système', '/'),
    ...(env['ARGOS_FLOUTEES'] ? [disque('Données', dirname(env['ARGOS_FLOUTEES']))] : []),
    ...(env['ARGOS_QUARANTAINE'] ? [disque('Travail (chiffré)', dirname(env['ARGOS_QUARANTAINE']))] : []),
  ])).filter((d): d is Disque => d !== null);
  const sauvegardes = await Promise.all([
    sauvegarde('Base et réglages', 'sauvegarde.json'), sauvegarde('Vidéos', 'sauvegarde-videos.json'), copieChezMoi(deps),
  ]);
  let r2: { fichiers: number; octets: number; le: string } | null = null;
  let erreurR2: string | null = null;
  if (deps.stockage.occupationDistante) {
    const enCache = await deps.redis.get('serveur:r2');
    if (enCache) r2 = JSON.parse(enCache) as typeof r2;
    else {
      try {
        r2 = { ...(await deps.stockage.occupationDistante()), le: new Date().toISOString() };
        await deps.redis.set('serveur:r2', JSON.stringify(r2), 'EX', CACHE_R2);
      } catch (e) { erreurR2 = String((e as Error).message ?? e).slice(0, 200); }
    }
  }
  return { disques, sauvegardes, r2, erreurR2 };
}
