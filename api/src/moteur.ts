import { readFileSync } from 'node:fs';
// Moteur de relecture : processus à part du site, seul à utiliser le rôle argos_scoring (le seul qui
// relie votes et comptes). Chaque minute : décisions du premier tour et scores (7b), tirage des
// convocations (7a) ; décisions du jury et tirage des jurés (7c) ; une fois par jour : retour
// progressif des scores inactifs.
//
//   node --env-file=.env.moteur --import tsx src/moteur.ts
import pg from 'pg';
import { surveillerPool } from './db.ts';

function requis(cle: string): string {
  const v = process.env[cle]?.trim();
  if (!v) throw new Error(`réglage manquant : ${cle}`);
  return v;
}

export function ouvrirMoteur(env = process.env): pg.Pool {
  return surveillerPool(new pg.Pool({
    host: env['ARGOS_PG_HOST'] ?? requis('ARGOS_PG_HOST'),
    port: Number(env['ARGOS_PG_PORT'] ?? requis('ARGOS_PG_PORT')),
    database: env['ARGOS_PG_DATABASE'] ?? requis('ARGOS_PG_DATABASE'),
    user: 'argos_scoring_conn',
    // Production : mot de passe lu dans le fichier fourni par systemd (ARGOS_PG_SCORING_PASSWORD_FICHIER).
    password: env['ARGOS_PG_SCORING_PASSWORD_FICHIER']
      ? readFileSync(env['ARGOS_PG_SCORING_PASSWORD_FICHIER'], 'utf8').trim()
      : env['ARGOS_PG_SCORING_PASSWORD'] ?? requis('ARGOS_PG_SCORING_PASSWORD'),
    application_name: 'argos-moteur',
    max: 2,
  }), 'argos-moteur');
}

/** Un tour du moteur : trancher ce qui peut l'être (premier tour, puis jury), puis compléter les
 *  convocations (y compris celles d'un élargissement ou d'un jury décidés à l'instant). */
export async function tour(pool: pg.Pool): Promise<{
  decisions: number; decisionsJury: number; convocations: number; convocationsJury: number;
  enAttenteDeJures: number; scoresInactifs: number; suspensionsLevees: number; comptesEffaces: number; votesDetaches: number;
}> {
  const n = async (f: string) => (await pool.query<{ n: number }>(`SELECT ${f} AS n`)).rows[0]!.n;
  const decisions = await n('core.decide_reviews()');
  const decisionsJury = await n('core.decide_juries()');
  const convocations = await n('core.draw_summons()');
  const convocationsJury = await n('core.draw_jury()');
  await n('core.draw_controls()');
  await n('core.score_controls()');
  const enAttenteDeJures = await n(
    "(SELECT count(*)::int FROM core.admin_alerts WHERE kind = 'jury_waiting' AND resolved_at IS NULL)");
  const scoresInactifs = await n('core.decay_scores()');
  const suspensionsLevees = await n('core.lift_expired_suspensions()');   // suspensions arrivées à échéance
  await n('core.expire_certifications()');   // statuts annuels expirés : la certification tombe avec (0116)
  const comptesEffaces = await n('core.purge_closed_accounts()');   // fermés depuis plus de 30 jours
  await n('ledger.flush_pending()');   // entrées du journal différées arrivées à échéance (0091)
  const votesDetaches = await n('core.unlink_old_votes()');          // lien vote ↔ compte coupé après 6 mois
  return { decisions, decisionsJury, convocations, convocationsJury, enAttenteDeJures, scoresInactifs, suspensionsLevees, comptesEffaces,
           votesDetaches };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = ouvrirMoteur();
  let arret = false;
  // L'attente entre deux tours garde le processus en vie (sans « unref ») : sinon, une fois les connexions
  // à la base fermées pour inactivité (10 s), plus rien ne le retient et il s'arrête — ce qui arrivait en
  // production jusqu'au 7 novembre 2026. Un arrêt demandé (systemd) interrompt l'attente aussitôt.
  let reveil: (() => void) | null = null;
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  const attendre = (ms: number) => new Promise<void>((ok) => { reveil = ok; minuteur = setTimeout(ok, ms); });
  const boucle = async () => {
    console.log(`${new Date().toISOString()} moteur démarré (un tour par minute)`);
    while (!arret) {
      try {
        const r = await tour(pool);
        if (r.decisions || r.decisionsJury || r.convocations || r.convocationsJury) {
          console.log(`${new Date().toISOString()} ${r.decisions} décision(s), ${r.decisionsJury} décision(s) du jury, `
            + `${r.convocations} convocation(s), ${r.convocationsJury} convocation(s) au jury`);
        }
        if (r.enAttenteDeJures) {
          console.warn(`${new Date().toISOString()} ${r.enAttenteDeJures} vidéo(s) en attente de jurés (vivier trop petit)`);
        }
      } catch (e) {
        console.error(`${new Date().toISOString()} échec du tour du moteur`, e);
      }
      if (!arret) await attendre(60_000);
    }
    await pool.end();
    console.log(`${new Date().toISOString()} moteur arrêté`);
  };
  for (const s of ['SIGINT', 'SIGTERM'] as const) {
    process.once(s, () => { arret = true; clearTimeout(minuteur); reveil?.(); });
  }
  void boucle();
}
