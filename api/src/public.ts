// Partie publique (étape interface I-4) : sans compte, en lecture seule.
//   GET  /public/videos                  vidéos publiées pour la carte (lieu déjà arrondi, date au jour)
//   GET  /public/videos/:id              fiche d'une vidéo publiée ou « en débat »
//   POST /public/videos/:id/video        lien de visionnage de la version floutée (10 minutes)
//   GET  /public/en-debat                vidéos sur lesquelles la communauté n'a pas tranché (hors carte)
//   GET  /public/journal                 journal public, du plus récent au plus ancien (50 par page)
//   GET  /public/journal/verification    la chaîne d'empreintes du journal est-elle intacte ?
//   GET  /public/journal/export          tout le journal, pour recalculer la chaîne soi-même
//   GET  /public/journal/ancrages        ancrages quotidiens dans Bitcoin (OpenTimestamps)
//   GET  /public/regles                  règles de relecture en vigueur (déjà publiques au journal)
//   GET  /public/statistiques            comptes des vidéos publiées (par mois, nature, forces, situation)
//   GET  /public/transparence            rapport de transparence d'un trimestre terminé (petits nombres masqués)
//   GET  /public/journal/ancrages/:jour/preuve.ots   la preuve à vérifier avec l'outil « ots »
// Les vidéos rejetées, retirées, masquées ou de contrôle n'ont pas de fiche : le journal garde seulement
// la trace de leur décision. Rien ici ne relie une vidéo à sa source ni à un relecteur.
import type { FastifyInstance } from 'fastify';
import { listeChoix } from './schemas.ts';
import { appelInterne, type Dependances } from './app.ts';
import { empreinte } from './crypto.ts';
import { consommer } from './limites.ts';
import { correctionDe } from './osint.ts';
import { creerLien } from './suivi.ts';
import { valeurs } from './regles.ts';
import { PERIODES_STATS, statistiques } from './statistiques.ts';
import { TRIMESTRE, transparence } from './transparence.ts';

const ID = {
  type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } },
} as const;
const PERIODES: Record<string, number | null> = { '7j': 7, '30j': 30, '1an': 365, tout: null };
const PAR = { review: 'communaute', jury: 'jury', admin: 'administration', legal: 'administration' } as const;
const hex = (b: Buffer | null) => (b ? b.toString('hex') : null);
/** Date publiée d'une décision : le jour seulement (l'heure d'une décision de l'administration dirait quand elle agit). */
export const jourDe = (d: Date | null | undefined) => (d ? d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }) : null);

export function enregistrerPublic(app: FastifyInstance, deps: Dependances): void {
  const { bases, redis, cles } = deps;
  const limiter = (ip: string, quoi: string, n: number) => consommer(redis, `public-${quoi}:ip:${empreinte(cles, 'ip', ip).toString('hex')}`, n, 3600);

  app.get<{ Querystring: { categorie?: string; periode?: string; forces?: string; situation?: string; du?: string; au?: string;
                            heure?: string } }>('/public/videos', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          categorie: { type: 'string', enum: ['violence', 'abuse'] },
          periode: { type: 'string', enum: Object.keys(PERIODES) },
          forces: { type: 'string', enum: ['national_police', 'gendarmerie', 'municipal_police', 'customs', 'unknown'] },
          situation: { type: 'string', enum: ['demonstration', 'stop', 'arrest', 'other'] },
          du: { type: 'string', format: 'date' },
          au: { type: 'string', format: 'date' },
          heure: { type: 'string', pattern: '^([01]?[0-9]|2[0-3])$' },   // à une heure près, vidéos dont l'heure est connue
        },
      },
    },
  }, async (req, reply) => {
    if (!(await limiter(req.ip, 'carte', 600))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const jours = PERIODES[req.query.periode ?? 'tout'] ?? null;
    const r = await bases.app.query<{
      id: string; lat: number; lon: number; location_precision: string; jour: string; category: string | null;
      subcategory: string | null; extra_subcategories: string[]; extra_situations: string[]; forces: string | null; situation: string | null; pseudonym: string | null;
    }>(
      `SELECT v.id, p.pseudonym, ST_Y(v.location::geometry) AS lat, ST_X(v.location::geometry) AS lon, v.location_precision,
              to_char(v.occurred_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour, v.category, v.subcategory, v.extra_subcategories, v.forces, v.situation, v.extra_situations
         FROM core.videos v LEFT JOIN core.pseudonyms p ON p.video_id = v.id
        WHERE v.status = 'published' AND NOT v.is_control AND v.location IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM core.videos m WHERE m.id = v.duplicate_of AND m.status = 'published')
          AND ($1::text IS NULL OR v.category = $1)
          AND ($2::text IS NULL OR v.forces = $2)
          AND ($3::int IS NULL OR v.occurred_at >= now() - make_interval(days => $3))
          AND ($4::text IS NULL OR v.situation = $4 OR $4 = ANY (v.extra_situations))
          AND ($5::date IS NULL OR (v.occurred_at AT TIME ZONE 'Europe/Paris')::date >= $5)
          AND ($6::date IS NULL OR (v.occurred_at AT TIME ZONE 'Europe/Paris')::date <= $6)
          AND ($7::int IS NULL OR (v.occurred_time_known AND
               least(abs(extract(hour FROM v.occurred_at AT TIME ZONE 'Europe/Paris')::int - $7),
                     24 - abs(extract(hour FROM v.occurred_at AT TIME ZONE 'Europe/Paris')::int - $7)) <= 1))
        ORDER BY v.occurred_at DESC
        LIMIT 5000`, [req.query.categorie ?? null, req.query.forces ?? null, jours, req.query.situation ?? null,
                      req.query.du ?? null, req.query.au ?? null,
                      req.query.heure === undefined ? null : Number(req.query.heure)]);
    return reply.send({
      videos: r.rows.map((v) => ({
        id: v.id, nom: v.pseudonym, lat: v.lat, lon: v.lon, precision: v.location_precision, date: v.jour,
        categorie: v.category, sousCategorie: v.subcategory, sousCategories: listeChoix(v.subcategory, v.extra_subcategories), forces: v.forces, situation: v.situation, situations: listeChoix(v.situation, v.extra_situations),
      })),
    });
  });

  const visible = (id: string) => videoVisible(deps, id);

  app.get<{ Params: { id: string } }>('/public/videos/:id', { schema: { params: ID } }, async (req, reply) => {
    if (!appelInterne(deps, req) && !(await limiter(req.ip, 'fiche', 600))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const f = await fichePublique(deps, req.params.id);
    // Masquée par l'administration (examen en cours) ou retirée pour motif légal : on le dit, sans rien montrer.
    if (f.etat === 'ok') return reply.send(f.fiche);
    if (f.etat === 'introuvable') return reply.code(404).send({ erreur: 'introuvable' });
    return reply.code(410).send({ erreur: f.etat === 'masquee' ? 'video_masquee' : 'video_retiree' });
  });

  app.post<{ Params: { id: string } }>('/public/videos/:id/video', { schema: { params: ID } }, async (req, reply) => {
    if (!(await limiter(req.ip, 'video', 120))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const v = await visible(req.params.id);
    if (!v) return reply.code(404).send({ erreur: 'introuvable' });
    return reply.send(await creerLien(deps, v.id, 'complete'));
  });

  app.get('/public/en-debat', async (req, reply) => {
    if (!(await limiter(req.ip, 'liste', 600))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const r = await bases.app.query<{ id: string; jour: string; category: string | null; subcategory: string | null; extra_subcategories: string[]; extra_situations: string[];
                                      forces: string | null; decided_at: Date | null; description: string | null }>(
      `SELECT v.id, to_char(v.occurred_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour, v.category, v.subcategory, v.extra_subcategories, v.extra_situations,
              v.forces, v.decided_at, v.description
         FROM core.videos v WHERE v.status = 'under_debate' AND NOT v.is_control
        ORDER BY date_trunc('day', v.decided_at, 'Europe/Paris') DESC NULLS LAST, v.id LIMIT 500  -- au jour (audit M3)
      `);
    return reply.send({
      videos: r.rows.map((v) => ({
        id: v.id, date: v.jour, categorie: v.category, sousCategorie: v.subcategory, sousCategories: listeChoix(v.subcategory, v.extra_subcategories), forces: v.forces,
        enDebatDepuis: jourDe(v.decided_at), description: v.description,
      })),
    });
  });

  app.get<{ Querystring: { avant?: string; type?: string } }>('/public/journal', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          avant: { type: 'string', pattern: '^[0-9]{1,18}$' },
          type: { type: 'string', enum: ['decision', 'removal', 'withdrawal', 'rule_change', 'authority_request', 'admin_action', 'event_link', 'video_received'] },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await limiter(req.ip, 'journal', 600))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const r = await bases.app.query<{ seq: string; recorded_at: Date; kind: string; payload: Record<string, unknown>; masque: boolean; hash: Buffer; prev_hash: Buffer }>(
      // Pseudo d'analyste des entrées d'avant la migration 0091 : jamais montré (voir l'export).
      `SELECT seq, recorded_at, kind, payload - 'analyst' AS payload, payload ? 'analyst' AS masque, hash, prev_hash FROM ledger.entries
        WHERE ($1::bigint IS NULL OR seq < $1) AND ($2::text IS NULL OR kind = $2)
        ORDER BY seq DESC LIMIT 50`, [req.query.avant ?? null, req.query.type ?? null]);
    return reply.send({
      entrees: r.rows.map((e) => ({
        numero: Number(e.seq), le: e.recorded_at.toISOString(), type: e.kind, contenu: e.payload, ...(e.masque ? { masque: true } : {}),
        empreinte: e.hash.toString('hex'), precedente: e.prev_hash.toString('hex'),
      })),
      suite: r.rows.length === 50 ? Number(r.rows.at(-1)!.seq) : null,
    });
  });

  // Export complet, pour vérifier la chaîne soi-même : chaque empreinte vaut
  //   SHA-256( empreinte précédente || UTF-8(type + « | » + contenu + « | » + horodatage) )
  // avec le contenu et l'horodatage exactement tels qu'écrits ici (la première « précédente » est l'octet 00).
  // Entrée d'avant la migration 0091 qui nomme un analyste : contenu masqué (donnée personnelle, droit à
  // l'effacement). Son empreinte est donnée telle quelle ; le lien avec la précédente et la suite reste vérifiable.
  app.get('/public/journal/export', async (req, reply) => {
    if (!(await limiter(req.ip, 'export', 30))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const r = await bases.app.query<{ seq: string; kind: string; texte: string; masque: boolean; horodatage: string; hash: Buffer; prev_hash: Buffer }>(
      `SELECT seq, kind, payload::text AS texte, payload ? 'analyst' AS masque,
              to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS horodatage, hash, prev_hash
         FROM ledger.entries ORDER BY seq`);
    return reply.send({
      formule: 'sha256(precedente || utf8(type + "|" + contenu + "|" + horodatage)), precedente initiale = 00 ; '
        + 'entrée « masque » : contenu retiré (donnée personnelle), empreinte donnée telle quelle',
      entrees: r.rows.map((e) => ({ numero: Number(e.seq), type: e.kind, contenu: e.masque ? null : e.texte, ...(e.masque ? { masque: true } : {}),
                                    horodatage: e.horodatage, empreinte: e.hash.toString('hex'), precedente: e.prev_hash.toString('hex') })),
    });
  });

  app.get('/public/journal/ancrages', async (req, reply) => {
    if (!(await limiter(req.ip, 'ancrages', 600))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const r = await bases.app.query<{ day: string; last_seq: string; root_hash: Buffer; bitcoin_block: number | null;
                                      simulated: boolean; published_at: Date; upgraded_at: Date | null; preuve: boolean }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, last_seq, root_hash, bitcoin_block, simulated, published_at, upgraded_at,
              ots_proof IS NOT NULL AS preuve
         FROM ledger.anchors ORDER BY day DESC LIMIT 400`);
    return reply.send({
      ancrages: r.rows.map((a) => ({
        jour: a.day, derniereEntree: Number(a.last_seq), empreinte: a.root_hash.toString('hex'),
        etat: a.simulated ? 'simule' : a.bitcoin_block ? 'confirme' : 'en_attente',
        blocBitcoin: a.bitcoin_block, envoyeLe: a.published_at.toISOString(), confirmeLe: a.upgraded_at?.toISOString() ?? null,
        preuve: a.preuve && !a.simulated,
      })),
    });
  });

  app.get<{ Params: { jour: string } }>('/public/journal/ancrages/:jour/preuve.ots', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['jour'],
                        properties: { jour: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } } },
  }, async (req, reply) => {
    if (!(await limiter(req.ip, 'preuve', 120))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const r = await bases.app.query<{ ots_proof: Buffer }>(
      'SELECT ots_proof FROM ledger.anchors WHERE day = $1::date AND NOT simulated AND ots_proof IS NOT NULL', [req.params.jour]);
    if (!r.rows[0]) return reply.code(404).send({ erreur: 'introuvable' });
    return reply.header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="argos-veille-journal-${req.params.jour}.ots"`)
      .send(r.rows[0].ots_proof);
  });

  // Mots de passe trop courants : vérifiés dans le navigateur, puisque le mot de passe ne part plus au serveur (0101).
  let courants: string | null = null;
  app.get('/public/mots-de-passe-courants', async (_req, reply) => {
    courants ??= [...deps.listes.motsDePasseCourants].join('\n');
    return reply.header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'public, max-age=86400').send(courants);
  });

  app.get('/public/regles', async (_req, reply) => {
    const r = await bases.app.query<{ params: Record<string, unknown> }>('SELECT params FROM core.settings ORDER BY version DESC LIMIT 1');
    return reply.send({ regles: valeurs(r.rows[0]!.params) });
  });

  app.get<{ Querystring: { periode?: string } }>('/public/statistiques', {
    schema: { querystring: { type: 'object', additionalProperties: false,
                             properties: { periode: { type: 'string', enum: Object.keys(PERIODES_STATS) } } } },
  }, async (req, reply) => {
    if (!(await limiter(req.ip, 'statistiques', 600))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    return reply.send(await statistiques(deps, req.query));
  });

  app.get<{ Querystring: { trimestre?: string } }>('/public/transparence', {
    schema: { querystring: { type: 'object', additionalProperties: false,
                             properties: { trimestre: { type: 'string', pattern: TRIMESTRE } } } },
  }, async (req, reply) => {
    if (!(await limiter(req.ip, 'transparence', 600))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const r = await transparence(deps, req.query.trimestre);
    return r ? reply.send(r) : reply.code(404).send({ erreur: 'introuvable' });
  });

  app.get('/public/journal/verification', async (req, reply) => {
    if (!(await limiter(req.ip, 'verification', 60))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const r = await bases.app.query<{ casse: string | null; n: string }>(
      'SELECT ledger.verify() AS casse, (SELECT count(*) FROM ledger.entries) AS n');
    const casse = r.rows[0]!.casse;
    return reply.send({ intact: casse === null, entrees: Number(r.rows[0]!.n), ...(casse !== null ? { premiereEntreeInvalide: Number(casse) } : {}) });
  });
}

/** Vidéo montrée au public : publiée, ou « en débat ». */
export async function videoVisible(deps: Dependances, id: string) {
  const r = await deps.bases.app.query<{
    id: string; status: string; pseudonym: string | null; category: string | null; subcategory: string | null; extra_subcategories: string[]; extra_situations: string[];
    forces: string | null; situation: string | null; heure: string | null; lat: number | null; lon: number | null;
    location_precision: string | null; description: string | null; language: string; envoi: string; decided_at: Date | null;
    decided_by_stage: keyof typeof PAR | null; blurred_sha256: Buffer | null; horodatee: boolean;
    occurred_time_known: boolean; jour: string | null; duplicate_of: string | null; version_de_nom: string | null; est_version: boolean; origine: unknown;
  }>(
    `SELECT v.id, v.status, p.pseudonym, v.category, v.subcategory, v.extra_subcategories, v.forces, v.situation, v.extra_situations,
            to_char(date_trunc('hour', v.occurred_at AT TIME ZONE 'Europe/Paris'), 'YYYY-MM-DD"T"HH24:00') AS heure,
            to_char(v.occurred_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour, v.occurred_time_known,
            ST_Y(v.location::geometry) AS lat, ST_X(v.location::geometry) AS lon, v.location_precision,
            v.description, v.language, to_char(v.submitted_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS envoi,
            v.decided_at, v.decided_by_stage, v.blurred_sha256, v.timestamp_token IS NOT NULL AS horodatee,
            v.duplicate_of,
            (SELECT CASE WHEN o.is_public AND o.hidden_at IS NULL THEN jsonb_build_object('publiePar', o.published_by, 'lien', o.url) END
               FROM core.video_origins o WHERE o.video_id = v.id) AS origine,
            (SELECT pm.pseudonym FROM core.videos m LEFT JOIN core.pseudonyms pm ON pm.video_id = m.id
              WHERE m.id = v.duplicate_of AND m.status = 'published') AS version_de_nom,
            EXISTS (SELECT 1 FROM core.videos m WHERE m.id = v.duplicate_of AND m.status = 'published') AS est_version
       FROM core.videos v LEFT JOIN core.pseudonyms p ON p.video_id = v.id
      WHERE v.id = $1 AND v.status IN ('published', 'under_debate') AND NOT v.is_control`, [id]);
  return r.rows[0];
}

/** Fiche publique d'une vidéo (site, API v1, lecteur intégré). */
export async function fichePublique(deps: Dependances, id: string): Promise<
  { etat: 'ok'; fiche: Record<string, unknown> & { id: string; etat: 'publiee' | 'en_debat' } } | { etat: 'masquee' | 'retiree' | 'introuvable' }> {
  const v = await videoVisible(deps, id);
  if (!v) {
    const m = await deps.bases.app.query<{ status: string }>(
      "SELECT status FROM core.videos WHERE id = $1 AND status IN ('hidden', 'removed') AND NOT is_control", [id]);
    return { etat: m.rowCount ? (m.rows[0]!.status === 'hidden' ? 'masquee' : 'retiree') : 'introuvable' };
  }
  const notes = await deps.bases.app.query<{
    note_id: string; author: string | null; analyst: boolean; created_at: Date; version: number;
    finding: string; explanation: string; links: string[]; state: string;
  }>('SELECT * FROM core.public_notes($1)', [v.id]);
  return { etat: 'ok', fiche: {
    id: v.id,
    etat: v.status === 'published' ? 'publiee' : 'en_debat',
    pseudonyme: v.pseudonym,
    categorie: v.category, sousCategorie: v.subcategory, sousCategories: listeChoix(v.subcategory, v.extra_subcategories), forces: v.forces, situation: v.situation, situations: listeChoix(v.situation, v.extra_situations),
    // À l'heure près (l'heure exacte, avec le lieu, pourrait aider à reconnaître la source) ; la date seule
    // si la source ne connaît pas l'heure.
    date: v.occurred_time_known ? v.heure : v.jour,
    heureConnue: v.occurred_time_known,
    lieu: v.lat !== null && v.lon !== null ? { lat: v.lat, lon: v.lon, precision: v.location_precision } : null,
    description: v.description, langue: v.language,
    envoyeeLe: v.envoi,
    decision: v.decided_at ? { par: v.decided_by_stage ? PAR[v.decided_by_stage] : null, le: jourDe(v.decided_at) } : null,
    // Revue de sécurité A4 : jamais l'empreinte de l'original (elle désignerait la personne qui a filmé si son téléphone
    // était saisi) ; celle de la version floutée suffit à prouver que la vidéo publiée n'a pas changé.
    empreintes: { floutee: hex(v.blurred_sha256), horodatage: v.horodatee },
    origine: v.origine ?? null,
    versionDe: v.est_version ? { id: v.duplicate_of, pseudonyme: v.version_de_nom } : null,
    autresVersions: (await deps.bases.app.query<{ id: string; pseudonym: string | null; decided_at: Date | null }>(
      'SELECT * FROM core.public_versions($1)', [v.id])).rows.map((x) => ({ id: x.id, pseudonyme: x.pseudonym, le: jourDe(x.decided_at) })),
    memeEvenement: (await deps.bases.app.query<{ id: string; pseudonym: string | null }>('SELECT * FROM core.public_event_videos($1)', [v.id]))
      .rows.map((x) => ({ id: x.id, pseudonyme: x.pseudonym })),
    correction: await correctionDe(deps, v.id, true),
    notes: notes.rows.map((n) => ({
      note: n.note_id, auteur: n.author, statutAuteur: n.analyst ? 'analyste_osint_verifie' : 'analyste_retire',
      ecriteLe: n.created_at.toISOString(), version: n.version, constat: n.finding, explication: n.explanation,
      liens: n.links, miseEnAvant: n.state === 'featured',
    })),
  } };
}
