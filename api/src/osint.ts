// Notes d'analyse OSINT (étape 7d-1).
// Côté analyste OSINT vérifié (statut accordé par le super-administrateur, double authentification) :
//   GET  /osint/videos                     vidéos en relecture ou au jury (contexte, sans source ni votes)
//   POST /osint/videos/:id/video           lien de visionnage (version floutée seulement), 10 minutes
//   GET  /osint/videos/:id/notes           notes de la vidéo, avec l'historique de leurs versions
//   POST /osint/videos/:id/notes           { constat, explication, liens, publier } — 3 notes actives au plus
//   PUT  /osint/notes/:id                  correction (nouvelle version) ou choix pour la fiche publique
//   POST /osint/notes/:id/retrait          retrait par l'auteur (la note reste dans l'historique)
// Côté relecteur et juré :
//   GET  /relecture/:convocation/notes     seulement après avoir ouvert la vidéo (première impression seul)
//   POST /relecture/:convocation/notes/:note/jugement   après son vote (7d-2) : pertinente oui / en partie / non
// Une note n'est pas un vote. Le site n'ouvre jamais les liens (ni aperçu, ni requête) : ils sont
// rendus en texte, et c'est au lecteur de les suivre s'il le veut.
import type { FastifyRequest, FastifyInstance } from 'fastify';
import { alerterJournalLegal } from './suivi.ts';
import type { Dependances } from './app.ts';
import { codeArgos, texte, texteLong, listeChoix } from './schemas.ts';
import { arrondir } from './envois.ts';
import { creerLien } from './suivi.ts';
import { enFrance } from './territoire.ts';
import { aDoubleAuth } from './compte.ts';

export const RAPPEL_NOTES = 'Les notes des analystes éclairent, elles ne décident pas : votre vote reste le vôtre.';

/** Raisons du jugement d'une note, propres au oui et au non ; « en partie » propose les deux. */
export const RAISONS_NOTES = {
  oui: {
    sources_fiables: ['reliable_sources', 'Les sources sont fiables'],
    claire: ['clear', "L'explication est claire"],
    apporte_du_contexte: ['adds_context', 'Elle apporte un contexte utile'],
    verifiable: ['verifiable', 'On peut la vérifier soi-même'],
  },
  non: {
    sources_douteuses: ['dubious_sources', 'Les sources sont douteuses'],
    hors_sujet: ['off_topic', 'Elle ne concerne pas cette vidéo'],
    opinion: ['opinion', "C'est une opinion plutôt qu'un constat"],
    incorrecte: ['incorrect', 'Elle contient une erreur'],
    liens_morts: ['dead_links', 'Les liens ne fonctionnent pas'],
  },
} as const;
/** Raisons qui se contredisent : jamais cochées ensemble (« en partie » propose les deux listes). */
export const NOTES_INCOMPATIBLES: readonly (readonly [string, string])[] = [
  ['sources_fiables', 'sources_douteuses'], ['verifiable', 'liens_morts'], ['apporte_du_contexte', 'hors_sujet'],
];

/** Les raisons contraires d'une raison, selon une liste de paires incompatibles. */
export const contraires = (paires: readonly (readonly [string, string])[], cle: string) =>
  paires.flatMap(([a, b]) => (a === cle ? [b] : b === cle ? [a] : []));
export const contradictoires = (paires: readonly (readonly [string, string])[], raisons: readonly string[]) =>
  paires.some(([a, b]) => raisons.includes(a) && raisons.includes(b));

export const TOUTES_RAISONS_NOTES = { ...RAISONS_NOTES.oui, ...RAISONS_NOTES.non } as Record<string, readonly [string, string]>;
export const AVIS = { oui: 'yes', en_partie: 'somewhat', non: 'no' } as const;
const DEPUIS_AVIS = { yes: 'oui', somewhat: 'en_partie', no: 'non' } as const;
const DEPUIS_RAISON = Object.fromEntries(Object.entries(TOUTES_RAISONS_NOTES).map(([cle, [code]]) => [code, cle]));
export const ETATS = { featured: 'mise_en_avant', needs_ratings: 'a_evaluer', unhelpful: 'peu_utile' } as const;

const ERREURS: Record<string, [number, string]> = {
  reserve_analyste: [403, 'reserve_analyste'],
  double_auth_requise: [403, 'double_auth_requise'],
  video_hors_relecture: [409, 'video_hors_relecture'],
  plafond_notes: [409, 'plafond_notes'],
  note_invalide: [400, 'note_invalide'],
  liens_invalides: [400, 'liens_invalides'],
  note_introuvable: [404, 'introuvable'],
  date_invalide: [400, 'date_invalide'],
  lieu_invalide: [400, 'lieu_invalide'],
  justification: [400, 'justification'],
  fiche_introuvable: [400, 'fiche_introuvable'],
  deja_tranchee: [409, 'deja_tranchee'],
  propre_proposition: [409, 'propre_proposition'],
  introuvable: [404, 'introuvable'],
};

type Precision = 'exact' | 'approx_100m' | 'municipality';
interface Correction { date: string; heureConnue: boolean; lieu: { lat: number; lon: number }; precision: Precision; justification: string; liens: string[];
                     etablit?: { date?: boolean; lieu?: boolean } }   // vidéo « à établir » : ce que cette correction établit

/** Dernière correction active d'une vidéo, et ce que la source avait déclaré (pour l'afficher à côté). */
/** `publique` : pour la fiche publique, la date déclarée est arrondie à l'heure, comme la date de la vidéo (audit M1). */
export async function correctionDe(deps: Dependances, videoId: string, publique = false) {
  const r = await deps.bases.app.query<{
    pseudo: string | null; analyste: boolean; created_at: Date; justification: string; links: string[];
    declared_occurred_at: Date; declared_time_known: boolean; lat: number; lon: number; declared_location_precision: string;
  }>(
    `SELECT CASE WHEN a.is_superadmin THEN 'Administration' ELSE a.username END AS pseudo, coalesce(core.is_osint_analyst(c.author_id), false) AS analyste, c.created_at, c.justification, c.links,
            v.declared_occurred_at, v.declared_time_known, ST_Y(v.declared_location::geometry) AS lat, ST_X(v.declared_location::geometry) AS lon,
            v.declared_location_precision
       FROM core.context_corrections c JOIN core.videos v ON v.id = c.video_id LEFT JOIN core.accounts a ON a.id = c.author_id
      WHERE c.video_id = $1 AND c.cancelled_at IS NULL ORDER BY c.created_at DESC LIMIT 1`, [videoId]);
  const c = r.rows[0];
  return c ? {
    par: c.pseudo, statutAuteur: c.analyste ? 'analyste_osint_verifie' : 'analyste_retire', le: c.created_at.toISOString(),
    justification: c.justification, liens: c.links,
    declare: { date: (publique ? new Date(Math.floor(c.declared_occurred_at.getTime() / 3_600_000) * 3_600_000) : c.declared_occurred_at).toISOString(),
               heureConnue: c.declared_time_known,
               lieu: { lat: c.lat, lon: c.lon, precision: c.declared_location_precision } },
  } : null;
}

const ID = {
  type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;
const CONTENU = {
  constat: texte(200),
  explication: texteLong(5000),
  liens: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true,
           items: { type: 'string', maxLength: 2000, pattern: '^https://\\S+$' } },
  publier: { type: 'boolean' },
} as const;

interface Contenu { constat: string; explication: string; liens: string[]; publier?: boolean }

/** Notes affichables d'une vidéo (ni retirées, ni masquées), avec leur historique.
 *  `compteId` : vue de l'analyste (ses notes repérées). `etat` : état de la mise en avant, montré à
 *  l'analyste et au relecteur qui a déjà voté. `convocation` : jugements de ce relecteur. */
export async function notesDeLaVideo(deps: Dependances, videoId: string, compteId?: string,
                                     options: { etat?: boolean; juge?: { compte: string; convocation: string }; masquees?: boolean } = {}) {
  const r = await deps.bases.app.query<{
    id: string; pseudo: string | null; analyste: boolean; mienne: boolean; created_at: Date; updated_at: Date;
    etat: keyof typeof ETATS; mises_en_avant: number; masked_at: Date | null; mask_reason: string | null;
    version: number; finding: string; explanation: string; links: string[]; wants_public: boolean;
    versions: { version: number; date: string; constat: string; explication: string; liens: string[] }[];
  }>(
    `SELECT n.id, CASE WHEN a.is_superadmin THEN 'Administration' ELSE a.username END AS pseudo, coalesce(core.is_osint_analyst(n.author_id), false) AS analyste,
            n.author_id IS NOT DISTINCT FROM $2::uuid AS mienne,
            core.note_state(n.id) AS etat, coalesce(core.analyst_featured_notes(n.author_id), 0) AS mises_en_avant,
            n.created_at, n.updated_at, n.version, n.finding, n.explanation, n.links, n.wants_public, n.masked_at, n.mask_reason,
            (SELECT json_agg(json_build_object('version', ve.version, 'date', ve.created_at, 'constat', ve.finding,
                                               'explication', ve.explanation, 'liens', ve.links) ORDER BY ve.version)
               FROM core.osint_note_versions ve WHERE ve.note_id = n.id) AS versions
       FROM core.osint_notes n LEFT JOIN core.accounts a ON a.id = n.author_id
      WHERE n.video_id = $1 AND n.withdrawn_at IS NULL AND ($3 OR n.masked_at IS NULL)
      ORDER BY n.created_at`, [videoId, compteId ?? null, options.masquees === true]);
  const jugements = new Map<string, { avis: string; raisons: string[] }>();
  if (options.juge) {
    const j = await deps.bases.app.query<{ note_id: string; helpful: keyof typeof DEPUIS_AVIS; reasons: string[] }>(
      'SELECT note_id, helpful, reasons FROM core.my_note_ratings($1, $2)', [options.juge.compte, options.juge.convocation]);
    for (const x of j.rows) {
      jugements.set(x.note_id, { avis: DEPUIS_AVIS[x.helpful], raisons: x.reasons.map((c) => DEPUIS_RAISON[c]!) });
    }
  }
  return r.rows.map((n) => ({
    note: n.id,
    auteur: n.pseudo,
    // « analyste OSINT vérifié », ou « analyste retiré » si le statut a été retiré ou a expiré
    statutAuteur: n.analyste ? 'analyste_osint_verifie' : 'analyste_retire',
    auteurNotesMisesEnAvant: n.mises_en_avant,   // simple mention, sans effet sur son score
    ...(options.etat ? { etat: ETATS[n.etat] } : {}),
    ...(options.juge ? { monJugement: jugements.get(n.id) ?? null } : {}),
    ...(compteId ? { mienne: n.mienne, publier: n.mienne ? n.wants_public : undefined } : {}),
    ecriteLe: n.created_at.toISOString(),
    corrigeeLe: n.version > 1 ? n.updated_at.toISOString() : null,
    version: n.version,
    constat: n.finding,
    explication: n.explanation,
    liens: n.links,
    historique: n.versions.map((v) => ({ ...v, date: new Date(v.date).toISOString() })),
    // Administration seulement : note masquée (date et motif), pour la revoir et la démasquer.
    ...(options.masquees && n.masked_at ? { masquee: { le: n.masked_at.toISOString(), motif: n.mask_reason } } : {}),
  }));
}

export function enregistrerOsint(app: FastifyInstance, deps: Dependances): void {
  const { bases } = deps;

  // Journal légal (décret 2021-1362, art. 6 et 7) : une note ou une correction publique d'analyste est un contenu mis en
  // ligne, comme une vidéo. En cas d'échec, l'opération reste faite et l'erreur est journalisée (code et message seuls).
  const journalLegal = async (req: FastifyRequest, action: 'upload' | 'modify' | 'delete', contenu: string) => {
    // Pas pour l'éditeur lui-même (super-administrateur) : le décret vise les contributions des utilisateurs (Q50).
    if ((await bases.app.query('SELECT 1 FROM core.accounts WHERE id = $1 AND is_superadmin', [req.compte!.id])).rowCount) return;
    try {
      await bases.identity.query('SELECT identity.log_legal($1, $2, $3, $4, $5)',
        [req.compte!.id, action, req.ip, req.socket.remotePort ?? null, contenu]);
    } catch (x) {
      req.log.error({ code: (x as { code?: string }).code, message: (x as Error).message }, 'journal légal : opération d’analyste non inscrite');
      await alerterJournalLegal(deps).catch(() => {});
    }
  };

  /** Session exigée, puis statut d'analyste en titre. */
  const analyste = {
    preHandler: [app.exigerSession, async (req: Parameters<typeof app.exigerSession>[0], reply: Parameters<typeof app.exigerSession>[1]) => {
      const r = await bases.app.query<{ ok: boolean }>('SELECT core.is_osint_analyst($1) AS ok', [req.compte!.id]);
      if (!r.rows[0]?.ok) return reply.code(403).send({ erreur: 'reserve_analyste' });
      if (!(await aDoubleAuth(deps, req.compte!.id))) return reply.code(403).send({ erreur: 'double_auth_requise' });
    }],
  };

  async function enRelecture(id: string): Promise<boolean> {
    const r = await bases.app.query(
      `SELECT 1 FROM core.videos WHERE id = $1 AND status IN ('in_review', 'jury', 'awaiting_osint') AND NOT is_control`, [id]);
    return r.rowCount === 1;
  }

  async function base<T>(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, f: () => Promise<T>) {
    try {
      return await f();
    } catch (e) {
      const r = ERREURS[codeArgos(e) ?? ''];
      if (r) return reply.code(r[0]).send({ erreur: r[1] });
      throw e;
    }
  }

  app.get('/osint/videos', analyste, async (req, reply) => {
    const r = await bases.app.query<{
      id: string; status: string; pseudonym: string | null; category: string | null; subcategory: string | null; extra_subcategories: string[]; extra_situations: string[];
      forces: string | null; situation: string | null; occurred_at: Date | null; location_precision: string | null;
      lat: number | null; lon: number | null; description: string | null; language: string | null;
      metadata_check: string | null; notes: number; miennes: number; occurred_time_known: boolean;
      date_to_establish: boolean; location_to_establish: boolean;
    }>(
      `SELECT v.id, v.status, p.pseudonym, v.category, v.subcategory, v.extra_subcategories, v.forces, v.situation, v.extra_situations, v.occurred_at,
              v.location_precision, ST_Y(v.location::geometry) AS lat, ST_X(v.location::geometry) AS lon,
              v.description, v.language, v.metadata_check, v.occurred_time_known, v.date_to_establish, v.location_to_establish,
              (SELECT count(*)::int FROM core.osint_notes n
                WHERE n.video_id = v.id AND n.withdrawn_at IS NULL AND n.masked_at IS NULL) AS notes,
              (SELECT count(*)::int FROM core.osint_notes n
                WHERE n.video_id = v.id AND n.author_id = $1 AND n.withdrawn_at IS NULL AND n.masked_at IS NULL) AS miennes
         , (SELECT jsonb_build_object('publiePar', o.published_by, 'lien', o.url, 'precisions', o.details) FROM core.video_origins o WHERE o.video_id = v.id) AS origine
         FROM core.videos v LEFT JOIN core.pseudonyms p ON p.video_id = v.id
        WHERE v.status IN ('in_review', 'jury', 'awaiting_osint') AND NOT v.is_control
        ORDER BY v.status = 'awaiting_osint' DESC, v.review_started_at NULLS LAST
        LIMIT 200`, [req.compte!.id]);
    const corrections = await Promise.all(r.rows.map((v) => correctionDe(deps, v.id)));
    return reply.send({
      plafondNotesParVideo: 3,
      videos: r.rows.map((v, i) => ({
        video: v.id,
        correction: corrections[i],
        origine: (v as unknown as { origine: unknown }).origine,
        etape: v.status === 'jury' ? 'jury' : v.status === 'awaiting_osint' ? 'analyse' : 'relecture',
        pseudonyme: v.pseudonym,
        categorie: v.category,
        sousCategorie: v.subcategory, sousCategories: listeChoix(v.subcategory, v.extra_subcategories),
        forces: v.forces,
        situation: v.situation, situations: listeChoix(v.situation, v.extra_situations),
        date: v.occurred_at?.toISOString() ?? null,
        heureConnue: v.occurred_time_known,
        aEtablir: { date: v.date_to_establish, lieu: v.location_to_establish },
        lieu: v.lat !== null && v.lon !== null ? { lat: v.lat, lon: v.lon, precision: v.location_precision } : null,
        description: v.description,
        langue: v.language,
        metadonnees: v.metadata_check,
        notes: v.notes,
        mesNotes: v.miennes,
      })),
    });
  });

  app.post<{ Params: { id: string }; Body: { qualite?: 'apercu' | 'complete' } }>('/osint/videos/:id/video', {
    ...analyste,
    schema: {
      params: ID,
      body: { type: 'object', additionalProperties: false, properties: { qualite: { type: 'string', enum: ['apercu', 'complete'] } } },
    },
  }, async (req, reply) => {
    if (!(await enRelecture(req.params.id))) return reply.code(404).send({ erreur: 'introuvable' });
    return reply.send(await creerLien(deps, req.params.id, req.body?.qualite ?? 'complete'));
  });

  app.get<{ Params: { id: string } }>('/osint/videos/:id/notes', { ...analyste, schema: { params: ID } }, async (req, reply) => {
    if (!(await enRelecture(req.params.id))) return reply.code(404).send({ erreur: 'introuvable' });
    return reply.send({ notes: await notesDeLaVideo(deps, req.params.id, req.compte!.id, { etat: true }) });
  });

  app.post<{ Params: { id: string }; Body: Contenu }>('/osint/videos/:id/notes', {
    ...analyste,
    schema: {
      params: ID,
      body: { type: 'object', additionalProperties: false, required: ['constat', 'explication', 'liens'], properties: CONTENU },
    },
  }, async (req, reply) => base(reply, async () => {
    const { constat, explication, liens, publier } = req.body;
    const r = await bases.app.query<{ id: string }>('SELECT core.osint_note_create($1, $2, $3, $4, $5, $6) AS id',
      [req.compte!.id, req.params.id, constat, explication, liens, publier ?? false]);
    await journalLegal(req, 'upload', r.rows[0]!.id);
    return reply.code(201).send({ note: r.rows[0]!.id });
  }));

  app.put<{ Params: { id: string }; Body: Contenu }>('/osint/notes/:id', {
    ...analyste,
    schema: {
      params: ID,
      body: { type: 'object', additionalProperties: false, required: ['constat', 'explication', 'liens'], properties: CONTENU },
    },
  }, async (req, reply) => base(reply, async () => {
    const { constat, explication, liens, publier } = req.body;
    const r = await bases.app.query<{ version: number }>('SELECT core.osint_note_edit($1, $2, $3, $4, $5, $6) AS version',
      [req.compte!.id, req.params.id, constat, explication, liens, publier ?? null]);
    await journalLegal(req, 'modify', req.params.id);
    return reply.send({ ok: true, version: r.rows[0]!.version });
  }));

  // Corriger la date, l'heure ou le lieu : appliqué tout de suite, tracé, annulable par l'administration.
  app.post<{ Params: { id: string }; Body: Correction }>('/osint/videos/:id/correction', {
    ...analyste,
    schema: {
      params: ID,
      body: {
        type: 'object', additionalProperties: false, required: ['date', 'heureConnue', 'lieu', 'precision', 'justification', 'liens'],
        properties: {
          date: { type: 'string', format: 'date-time', maxLength: 40 },
          heureConnue: { type: 'boolean' },
          lieu: { type: 'object', additionalProperties: false, required: ['lat', 'lon'],
                  properties: { lat: { type: 'number', minimum: -90, maximum: 90 }, lon: { type: 'number', minimum: -180, maximum: 180 } } },
          precision: { enum: ['exact', 'approx_100m', 'municipality'] },
          justification: texteLong(5000),
          liens: CONTENU.liens,
          etablit: { type: 'object', additionalProperties: false, properties: { date: { type: 'boolean' }, lieu: { type: 'boolean' } } },
        },
      },
    },
  }, async (req, reply) => base(reply, async () => {
    const b = req.body;
    if (!enFrance(b.lieu.lat, b.lieu.lon)) return reply.code(400).send({ erreur: 'lieu_hors_de_france' });
    const lieu = arrondir(b.lieu.lat, b.lieu.lon, b.precision);
    const r = await bases.app.query<{ id: string }>(
      'SELECT core.osint_correct_context($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS id',
      [req.compte!.id, req.params.id, b.date, b.heureConnue, lieu.lat, lieu.lon, b.precision, b.justification, b.liens,
       b.etablit?.date === true, b.etablit?.lieu === true]);
    await journalLegal(req, 'upload', r.rows[0]!.id);
    return reply.code(201).send({ correction: r.rows[0]!.id });
  }));

  app.get<{ Params: { id: string } }>('/osint/videos/:id/corrections', { ...analyste, schema: { params: ID } }, async (req, reply) => {
    const r = await bases.app.query<{
      id: string; pseudo: string | null; created_at: Date; occurred_at: Date; time_known: boolean; lat: number; lon: number;
      location_precision: string; justification: string; links: string[]; cancelled_at: Date | null; cancel_reason: string | null;
    }>(
      `SELECT c.id, CASE WHEN a.is_superadmin THEN 'Administration' ELSE a.username END AS pseudo, c.created_at, c.occurred_at, c.time_known, ST_Y(c.location::geometry) AS lat,
              ST_X(c.location::geometry) AS lon, c.location_precision, c.justification, c.links, c.cancelled_at, c.cancel_reason
         FROM core.context_corrections c LEFT JOIN core.accounts a ON a.id = c.author_id
        WHERE c.video_id = $1 ORDER BY c.created_at DESC`, [req.params.id]);
    return reply.send({
      corrections: r.rows.map((c) => ({
        correction: c.id, par: c.pseudo, le: c.created_at.toISOString(), date: c.occurred_at.toISOString(), heureConnue: c.time_known,
        lieu: { lat: c.lat, lon: c.lon, precision: c.location_precision }, justification: c.justification, liens: c.links,
        annulee: c.cancelled_at ? { le: c.cancelled_at.toISOString(), motif: c.cancel_reason } : null,
      })),
    });
  });

  // Le retrait reste possible même si le statut d'analyste a été retiré entre-temps.
  // Même événement : les propositions portant sur deux vidéos publiées attendent l'accord de 2 autres analystes.
  app.get('/osint/evenements', analyste, async (req, reply) => base(reply, async () => {
    const r = await bases.app.query<{ id: string; origin: string; justification: string | null; created_at: Date; video_id: string;
                                      video_pseudonym: string | null; target_id: string; target_pseudonym: string | null }>(
      'SELECT * FROM core.osint_event_queue($1)', [req.compte!.id]);
    return reply.send({ propositions: r.rows.map((x) => ({
      id: x.id, origine: x.origin, justification: x.justification, le: x.created_at.toISOString(),
      video: { id: x.video_id, pseudonyme: x.video_pseudonym }, fiche: { id: x.target_id, pseudonyme: x.target_pseudonym } })) });
  }));

  app.post<{ Body: { video: string; fiche: string; justification: string } }>('/osint/evenements', {
    ...analyste,
    schema: { body: { type: 'object', additionalProperties: false, required: ['video', 'fiche', 'justification'],
                      properties: { video: texte(300), fiche: texte(300), justification: texteLong(2000) } } },
  }, async (req, reply) => base(reply, async () => {
    const r = await bases.app.query<{ id: string }>('SELECT core.osint_propose_event($1, $2, $3, $4) AS id',
      [req.compte!.id, req.body.video, req.body.fiche, req.body.justification]);
    await journalLegal(req, 'upload', r.rows[0]!.id);
    return reply.code(201).send({ proposition: r.rows[0]!.id });
  }));

  app.post<{ Params: { id: string }; Body: { accord: boolean } }>('/osint/evenements/:id', {
    ...analyste,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['accord'], properties: { accord: { type: 'boolean' } } } },
  }, async (req, reply) => base(reply, async () => {
    const r = await bases.app.query<{ s: string }>('SELECT core.osint_review_event($1, $2, $3) AS s', [req.compte!.id, req.params.id, req.body.accord]);
    await journalLegal(req, 'modify', req.params.id);   // l'accord peut rendre le lien public
    return reply.send({ ok: true, etat: r.rows[0]!.s });
  }));

  app.post<{ Params: { id: string } }>('/osint/notes/:id/retrait', {
    preHandler: app.exigerSession, schema: { params: ID },
  }, async (req, reply) => base(reply, async () => {
    await bases.app.query('SELECT core.osint_note_withdraw($1, $2)', [req.compte!.id, req.params.id]);
    await journalLegal(req, 'delete', req.params.id);
    return reply.send({ ok: true });
  }));
}
