// Administration, phase A1 : session d'administration, tableau de bord, alertes, rapports de bug.
//   POST /admin/session          { cle }  ouvre une session d'administration (défi : POST /admin/decision/defi)
//   GET  /admin/session          session ouverte ? temps restant
//   POST /admin/session/fin      ferme la session d'administration
//   GET  /admin/tableau-de-bord  chiffres et ce qui demande attention
//   GET  /admin/alertes          vidéos en attente de jurés
//   GET  /admin/bugs?statut=     rapports de bug (open | handled | dismissed)
//   GET  /admin/bugs/:id         un rapport : télémétrie, capture, erreurs serveur liées
//   POST /admin/bugs/:id/statut  { statut }
//   GET  /admin/videos?statut=&categorie=&sousCategorie=&forces=&du=&au=&signalees=&gel=&texte=  liste filtrée (300 au plus)
//   GET  /admin/videos/:id       fiche d'administration : contexte, votes (totaux), signalements, journal
//   POST /admin/videos/:id/video lien de lecture de la version floutée
//   POST /admin/videos/:id/moderation { action, motif, cle }  masquer, rétablir, retirer (motif légal), gel légal
//   GET  /admin/signalements?statut=  signalements (open | handled | dismissed), les graves d'abord
//   POST /admin/videos/:id/supprimer-echec { motif, cle }  supprime une vidéo en échec de traitement
//   GET  /admin/erreurs?heures=   erreurs du serveur récentes (24 h par défaut, 14 jours au plus)
//   GET  /admin/controles         vidéos de contrôle ; POST /admin/controles/:id { active }
//   GET  /admin/contact?traites=  messages du formulaire de contact ; POST /admin/contact/:id { traite }
//   GET  /admin/doublons?ecartes=  vidéos qui se ressemblent (repérées par le worker)
//   POST /admin/doublons/:id      { ecarter }
//   POST /admin/doublons/:id/rattacher { video, motif, cle }  rattache la vidéo à l'autre vidéo de la ressemblance
//   POST /admin/videos/:id/version/annuler { motif, cle }  annule le rattachement à une fiche
//   GET  /admin/evenements        propositions « même événement » en attente
//   POST /admin/evenements/:id    { accepter, motif, cle }
//   POST /admin/videos/:id/evenement { fiche, motif, cle }   relie directement à une fiche publiée
//   POST /admin/videos/:id/evenement/retirer { motif, cle }  retire la vidéo de son événement
//   POST /admin/signalements/:id  { statut, note }  classer ; la personne qui a signalé est prévenue par mail
//   POST /videos/:id/signaler     { motif, details }  signaler une vidéo publique (compte connecté)
//   GET  /admin/comptes?texte=&statut=&analyste=&doubleAuth=&nonLus=  comptes (300 au plus)
//   GET  /admin/comptes/:id       fiche : activité (totaux), sanctions, conversation (réponses marquées lues)
//   POST /admin/comptes/:id/sanction { action, jours?, motif, cle }  déconnecter, suspendre, lever, bannir
//   POST /admin/comptes/:id/messages { texte }  écrire au compte (il est prévenu par mail, répond sur le site)
// Session d'administration : ouverte par la clé physique, liée à la session de connexion, 30 minutes au
// plus, fermée après 10 minutes sans activité (gardée dans Redis). Les actions sensibles (trancher,
// masquer, retirer un statut…) redemandent en plus la clé à chaque fois (admin.ts).
import { enregistrerMessagerieAdmin } from './messagerie.ts';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Dependances } from './app.ts';
import { alerter, ecrire } from './compte.ts';
import { correctionDe, notesDeLaVideo } from './osint.ts';
import { etatServeur } from './serveur.ts';
import { codeArgos, texte, texteLong, listeChoix } from './schemas.ts';
import { creerLien } from './suivi.ts';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chiffrer, dechiffrer, empreinte } from './crypto.ts';
import { empreinteBeta, normaliserCodeBeta, nouveauCodeBeta } from './beta.ts';
import { SCHEMA_REPONSE_CLE, verifierPreuve } from './webauthn.ts';
import { BORNES, valeurs, verifier } from './regles.ts';

// Session d'administration : 30 minutes au plus, 10 sans activité. En base (0119), jamais dans Redis : l'API publique ne
// peut ni l'ouvrir ni la prolonger (audit du 15 novembre 2026, H2).
const INACTIVITE_MS = 10 * 60_000;
const cleDefi = (compteId: string) => `admin-defi:${compteId}`;   // même défi que admin.ts
const STATUTS = ['processing', 'awaiting_author', 'in_review', 'jury', 'published', 'rejected', 'under_debate',
                 'no_decision', 'hidden', 'removed', 'withdrawn', 'failed', 'awaiting_osint'] as const;
const ERREURS: Record<string, [number, string]> = {
  fiche_introuvable: [400, 'fiche_introuvable'],
  origine_invalide: [400, 'origine_invalide'],
  motif: [400, 'motif'], deja_en_cours: [409, 'deja_en_cours'], details: [400, 'details'], date_invalide: [400, 'date_invalide'], video_introuvable: [400, 'video_introuvable'], motif_inconnu: [400, 'motif_inconnu'],
  action_impossible: [409, 'action_impossible'], deja_ainsi: [409, 'deja_ainsi'],
  regles_invalides: [400, 'regles_invalides'],
  deja_signale: [409, 'deja_signale'], message_invalide: [400, 'message_invalide'], trop_de_signalements: [429, 'trop_de_signalements'], compte_inactif: [403, 'compte_inactif'],
  pas_autorisee: [409, 'pas_autorisee'], expiration_passee: [400, 'expiration_passee'], code_encore_actif: [409, 'code_encore_actif'], destinataire_inconnu: [400, 'destinataire_inconnu'],
};
const MOTIFS = ['visible_identity', 'identifying_text', 'illegal_content', 'defamation', 'wrong_context', 'other'] as const;
const SANCTIONS = { deconnecter: 'logout', suspendre: 'suspend', lever: 'lift', bannir: 'ban' } as const;
const ACTIONS = { masquer: 'hide', retablir: 'unhide', retirer: 'remove', geler: 'hold', degeler: 'release' } as const;
const ID = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

export function enregistrerAdministration(app: FastifyInstance, deps: Dependances): void {
  const { bases, redis } = deps;
  const superAdmin = async (id: string) =>
    (await bases.app.query<{ ok: boolean }>('SELECT is_superadmin AS ok FROM core.accounts WHERE id = $1', [id])).rows[0]?.ok === true;

  /** Temps restant de la session d'administration (ms), ou 0 si elle est fermée ou expirée. */
  async function restant(sessionId: string, toucher: boolean): Promise<number> {
    return (await bases.app.query<{ ms: number }>('SELECT core.admin_session_remaining($1, $2) AS ms', [sessionId, toucher])).rows[0]!.ms;
  }

  /** Session de connexion + super-administrateur + session d'administration ouverte. */
  async function exigerAdmin(req: FastifyRequest, reply: FastifyReply) {
    await app.exigerSession(req, reply);
    if (reply.sent) return reply;
    if (!(await superAdmin(req.compte!.id))) return reply.code(403).send({ erreur: 'reserve_super_admin' });
    if (!(await restant(req.compte!.sessionId, true))) return reply.code(401).send({ erreur: 'session_admin_requise' });
  }
  const admin = { preHandler: exigerAdmin };
  enregistrerMessagerieAdmin(app, deps, exigerAdmin);

  const enErreurs = async <T>(reply: FastifyReply, f: () => Promise<T>) => {
    try {
      return await f();
    } catch (e) {
      const code = codeArgos(e);
      if (code === 'introuvable') return reply.code(404).send({ erreur: 'introuvable' });
      if (code === 'reserve_super_admin') return reply.code(403).send({ erreur: code });
      const r = ERREURS[code ?? ''];
      if (r) return reply.code(r[0]).send({ erreur: r[1] });
      throw e;
    }
  };

  /** Vérifie la clé physique sur le défi en cours (à usage unique). */
  async function cleValide(req: FastifyRequest, cle: AuthenticationResponseJSON): Promise<boolean> {
    const compte = req.compte!;
    const defi = await redis.getdel(cleDefi(compte.id));
    const preuve = defi === null ? { ok: false as const } : await verifierPreuve(deps, compte.id, cle, defi, { admin: true });
    if (!preuve.ok && preuve.clonee) {
      await alerter(deps, req.log, compte.id, 'vérification d’une clé de sécurité',
        'Lors d\'une vérification, une clé de sécurité enregistrée sur votre compte a donné une réponse inattendue. Par précaution, '
          + 'l\'opération a été refusée. En cas de doute, retirez cette clé dans « Mon compte » et enregistrez-en une nouvelle.');
    }
    return preuve.ok;
  }

  app.post<{ Body: { cle: AuthenticationResponseJSON } }>('/admin/session', {
    preHandler: app.exigerSession,
    schema: { body: { type: 'object', additionalProperties: false, required: ['cle'], properties: { cle: SCHEMA_REPONSE_CLE } } },
  }, async (req, reply) => {
    const compte = req.compte!;
    if (!(await superAdmin(compte.id))) return reply.code(403).send({ erreur: 'reserve_super_admin' });
    const defi = await redis.getdel(cleDefi(compte.id));
    const preuve = defi === null ? { ok: false as const } : await verifierPreuve(deps, compte.id, req.body.cle, defi, { admin: true });
    if (!preuve.ok) {
      if (preuve.clonee) {
        await alerter(deps, req.log, compte.id, 'vérification d’une clé de sécurité',
          'Lors d\'une vérification, une clé de sécurité enregistrée sur votre compte a donné une réponse inattendue. Par précaution, '
          + 'l\'opération a été refusée. En cas de doute, retirez cette clé dans « Mon compte » et enregistrez-en une nouvelle.');
      }
      return reply.code(401).send({ erreur: 'cle_invalide' });
    }
    await bases.app.query('SELECT core.admin_session_open($1, $2)', [compte.id, compte.sessionId]);
    return reply.send({ ok: true, expireDans: Math.round(INACTIVITE_MS / 1000) });
  });

  app.get('/admin/session', { preHandler: app.exigerSession }, async (req, reply) => {
    const estSuperAdmin = await superAdmin(req.compte!.id);
    const ms = estSuperAdmin ? await restant(req.compte!.sessionId, false) : 0;
    return reply.send({ superAdmin: estSuperAdmin, ouverte: ms > 0, expireDans: Math.round(ms / 1000) });
  });

  app.post('/admin/session/fin', { preHandler: app.exigerSession }, async (req, reply) => {
    await bases.app.query('SELECT core.admin_session_close($1)', [req.compte!.sessionId]);
    return reply.send({ ok: true });
  });

  app.get('/admin/tableau-de-bord', admin, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ t: { aTraiter: Record<string, unknown> } & Record<string, unknown>; m: number; d: number; c: number; i: Record<string, unknown>; o: Record<string, unknown>; s: Record<string, unknown>; st: Record<string, unknown> }>(
      'SELECT core.admin_dashboard($1) AS t, core.admin_dashboard_messages($1) AS m, core.admin_dashboard_matches($1) AS d, core.admin_dashboard_contacts($1) AS c, core.admin_dashboard_indicators($1) AS i, core.admin_dashboard_osint($1) AS o, core.admin_dashboard_recours($1) AS s, core.admin_dashboard_statuses($1) AS st', [req.compte!.id]);
    const t = r.rows[0]!.t;
    return reply.send({ ...t, ...r.rows[0]!.i, analyse: r.rows[0]!.o, recours: r.rows[0]!.s, statutsARenouveler: r.rows[0]!.st, aTraiter: { ...t.aTraiter, messages: r.rows[0]!.m, doublons: r.rows[0]!.d, contacts: r.rows[0]!.c } });
  }));

  app.get('/admin/alertes', admin, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ video_id: string; depuis: Date; vivier: number | null; category: string | null;
                                      subcategory: string | null; occurred_at: Date | null }>(
      'SELECT * FROM core.admin_jury_alerts($1)', [req.compte!.id]);
    return reply.send({
      juresManquants: r.rows.map((a) => ({ video: a.video_id, depuis: a.depuis.toISOString(), vivier: a.vivier,
                                          categorie: a.category, sousCategorie: a.subcategory, date: a.occurred_at?.toISOString() ?? null })),
    });
  }));

  app.get<{ Querystring: { statut?: string } }>('/admin/bugs', {
    ...admin,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { statut: { enum: ['open', 'handled', 'dismissed'] } } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ id: string; created_at: Date; theme: string; subtheme: string; urgent: boolean; description: string;
                                      page: string; source_page: boolean; pseudo: string | null; avec_capture: boolean; status: string }>(
      'SELECT * FROM core.admin_bug_reports($1, $2)', [req.compte!.id, req.query.statut ?? 'open']);
    return reply.send({
      rapports: r.rows.map((b) => ({ id: b.id, le: b.created_at.toISOString(), theme: b.theme, precis: b.subtheme, urgent: b.urgent,
                                     extrait: b.description, page: b.page, pageSource: b.source_page, pseudo: b.pseudo,
                                     capture: b.avec_capture, statut: b.status })),
    });
  }));

  app.get<{ Params: { id: string } }>('/admin/bugs/:id', { ...admin, schema: { params: ID } }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ id: string; created_at: Date; theme: string; subtheme: string; urgent: boolean; description: string;
                                      page: string; source_page: boolean; pseudo: string | null; telemetry: Record<string, unknown> | null;
                                      screenshot: Buffer | null; status: string }>(
      'SELECT * FROM core.admin_bug_report($1, $2)', [req.compte!.id, req.params.id]);
    const b = r.rows[0];
    if (!b) return reply.code(404).send({ erreur: 'introuvable' });
    // Erreurs du serveur correspondant aux numéros de requête joints (gardées 14 jours).
    const appels = Array.isArray(b.telemetry?.['appels']) ? (b.telemetry!['appels'] as { requete?: string }[]) : [];
    const requetes = [...new Set(appels.map((a) => a.requete).filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x)))];
    const erreurs = requetes.length
      ? (await bases.app.query('SELECT * FROM core.admin_request_errors($1, $2)', [req.compte!.id, requetes])).rows : [];
    return reply.send({
      id: b.id, le: b.created_at.toISOString(), theme: b.theme, precis: b.subtheme, urgent: b.urgent, description: b.description,
      page: b.page, pageSource: b.source_page, pseudo: b.pseudo, telemetrie: b.telemetry, statut: b.status,
      capture: b.screenshot ? `data:image/jpeg;base64,${b.screenshot.toString('base64')}` : null,
      erreursServeur: erreurs,
    });
  }));

  app.post<{ Params: { id: string }; Body: { statut: 'open' | 'handled' | 'dismissed' } }>('/admin/bugs/:id/statut', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['statut'],
                                  properties: { statut: { enum: ['open', 'handled', 'dismissed'] } } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    await bases.app.query('SELECT core.admin_set_bug_status($1, $2, $3)', [req.compte!.id, req.params.id, req.body.statut]);
    return reply.send({ ok: true });
  }));

  interface FiltresVideos { statut?: string; categorie?: string; sousCategorie?: string; forces?: string; du?: string; au?: string;
                            signalees?: 'true' | 'false'; gel?: 'true' | 'false'; texte?: string }
  const JOUR = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
  const CLE = { type: 'string', pattern: '^[a-z_]{2,40}$' } as const;
  app.get<{ Querystring: FiltresVideos }>('/admin/videos', {
    ...admin,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      statut: { enum: STATUTS }, categorie: CLE, sousCategorie: CLE, forces: CLE, du: JOUR, au: JOUR,
      signalees: { enum: ['true', 'false'] }, gel: { enum: ['true', 'false'] }, texte: { type: 'string', maxLength: 100 } } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const q = req.query;
    const filtres = { status: q.statut, category: q.categorie, subcategory: q.sousCategorie, forces: q.forces, since: q.du, until: q.au,
                      reports: q.signalees === 'true', hold: q.gel === 'true', text: q.texte };
    const r = await bases.app.query<{ id: string; status: string; submitted_at: Date; decided_at: Date | null; category: string | null;
                                      subcategory: string | null; extra_subcategories: string[]; occurred_at: Date | null; description: string | null;
                                      pseudonym: string | null; open_reports: number; legal_hold: boolean; forces: string | null }>(
      'SELECT * FROM core.admin_videos($1, $2)', [req.compte!.id, JSON.stringify(filtres)]);
    return reply.send({
      videos: r.rows.map((v) => ({ id: v.id, statut: v.status, envoyeeLe: v.submitted_at.toISOString(),
                                   decideeLe: v.decided_at?.toISOString() ?? null, categorie: v.category, sousCategorie: v.subcategory, sousCategories: listeChoix(v.subcategory, v.extra_subcategories),
                                   forces: v.forces, date: v.occurred_at?.toISOString() ?? null, extrait: v.description,
                                   pseudonyme: v.pseudonym, signalements: v.open_reports, gelLegal: v.legal_hold })),
    });
  }));

  app.get<{ Params: { id: string } }>('/admin/videos/:id', { ...admin, schema: { params: ID } }, async (req, reply) => enErreurs(reply, async () => {
    const suivi = (await bases.app.query<{ t: Record<string, unknown> }>('SELECT core.admin_video($1, $2) AS t',
      [req.compte!.id, req.params.id])).rows[0]!.t;
    const c = (await bases.app.query<{ pseudonym: string | null; category: string | null; subcategory: string | null; extra_subcategories: string[]; extra_situations: string[]; forces: string | null;
                                       situation: string | null; occurred_at: Date | null; occurred_time_known: boolean;
                                       date_to_establish: boolean; location_to_establish: boolean;
                                       location_precision: string | null; lat: number | null; lon: number | null;
                                       description: string | null; language: string | null; metadata_check: string | null;
                                       duplicate_of: string | null; version_de_nom: string | null; origine: unknown }>(
      `SELECT p.pseudonym, v.category, v.subcategory, v.extra_subcategories, v.forces, v.situation, v.extra_situations, v.occurred_at, v.occurred_time_known,
              v.date_to_establish, v.location_to_establish,
              v.location_precision, ST_Y(v.location::geometry) AS lat, ST_X(v.location::geometry) AS lon,
              v.description, v.language, v.metadata_check, v.duplicate_of,
              (SELECT jsonb_build_object('publiePar', o.published_by, 'lien', o.url, 'precisions', o.details,
                                         'publique', o.is_public AND o.hidden_at IS NULL)
                 FROM core.video_origins o WHERE o.video_id = v.id) AS origine,
              (SELECT pm.pseudonym FROM core.pseudonyms pm WHERE pm.video_id = v.duplicate_of) AS version_de_nom
         FROM core.videos v LEFT JOIN core.pseudonyms p ON p.video_id = v.id WHERE v.id = $1`, [req.params.id])).rows[0]!;
    return reply.send({
      video: req.params.id,
      pseudonyme: c.pseudonym, categorie: c.category, sousCategorie: c.subcategory, sousCategories: listeChoix(c.subcategory, c.extra_subcategories), forces: c.forces,
      situation: c.situation, situations: listeChoix(c.situation, c.extra_situations),
      date: c.occurred_at?.toISOString() ?? null, heureConnue: c.occurred_time_known,
      aEtablir: { date: c.date_to_establish, lieu: c.location_to_establish },
      lieu: c.lat !== null && c.lon !== null ? { lat: c.lat, lon: c.lon, precision: c.location_precision } : null,
      description: c.description, langue: c.language, metadonnees: c.metadata_check,
      origine: c.origine,
      versionDe: c.duplicate_of ? { id: c.duplicate_of, pseudonyme: c.version_de_nom } : null,
      memeEvenement: (await bases.app.query<{ id: string; pseudonym: string | null; status: string }>('SELECT * FROM core.admin_event_videos($1, $2)',
        [req.compte!.id, req.params.id])).rows.map((x) => ({ id: x.id, pseudonyme: x.pseudonym, statut: x.status })),
      correction: await correctionDe(deps, req.params.id),
      notes: await notesDeLaVideo(deps, req.params.id, undefined, { etat: true, masquees: true }),
      // Transmission de l'original : autorisation de la source et transmissions déjà faites.
      transmission: (await bases.app.query<{ s: Record<string, unknown> }>('SELECT core.release_status($1) AS s', [req.params.id])).rows[0]!.s,
      refloutage: (await bases.app.query<{ s: unknown }>('SELECT core.reblur_state($1) AS s', [req.params.id])).rows[0]!.s,
      ...suivi,
    });
  }));

  // Transmission de l'original (étape 3). L'administration récupère l'original CHIFFRÉ et son enveloppe ;
  // elle ne peut l'ouvrir que sur son PC, avec la YubiKey (deploiement/admin/ouvrir-original.py).
  // Télécharger l'original : clé physique et motif, inscrit au journal public, la source est prévenue.
  app.post<{ Params: { id: string }; Body: { motif: string; cle: AuthenticationResponseJSON } }>('/admin/videos/:id/original', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['motif', 'cle'],
                                  properties: { motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
    const r = await bases.app.query<{ envelope: unknown; original_sha256: string }>(
      'SELECT * FROM core.admin_open_original($1, $2, $3)', [req.compte!.id, req.params.id, req.body.motif]);
    if (!r.rows[0]) return reply.code(409).send({ erreur: 'pas_autorisee' });
    // Lien de téléchargement à usage limité (10 minutes), comme pour la lecture des vidéos.
    const lien = randomBytes(32).toString('base64url');
    await deps.redis.set(`original:${empreinte(deps.cles, 'original', lien).toString('hex')}`, req.params.id, 'EX', 600);
    return reply.send({ lien: `/admin/original/${lien}`, sha256Original: r.rows[0].original_sha256, enveloppe: r.rows[0].envelope });
  }));

  app.get<{ Params: { lien: string } }>('/admin/original/:lien', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['lien'],
                        properties: { lien: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } } } },
  }, async (req, reply) => {
    const id = await deps.redis.get(`original:${empreinte(deps.cles, 'original', req.params.lien).toString('hex')}`);
    if (!id) return reply.code(404).send({ erreur: 'lien_expire' });
    const distant = deps.stockage.lienOriginal?.(id, 600);
    if (distant) return reply.code(302).header('cache-control', 'no-store').redirect(distant);
    const chemin = (deps.stockage as unknown as { chemin(e: string, id: string): string }).chemin('originaux', id);
    let taille: number;
    try { taille = (await stat(chemin)).size; } catch { return reply.code(404).send({ erreur: 'introuvable' }); }
    return reply.header('content-type', 'application/octet-stream').header('content-length', taille)
      .header('content-disposition', `attachment; filename="original-${id}.argos"`).send(createReadStream(chemin));
  });

  // Codes d'accès à la bêta : un par personne, réutilisable, expiration facultative, révocable.
  /** Code bêta déchiffré, ou null (non conservé, ou illisible : une ligne abîmée ne bloque pas la liste). */
  const lisible = (enc: Buffer | null) => { try { return enc ? dechiffrer(deps.cles, enc) : null; } catch { return null; } };
  app.get('/admin/beta', admin, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ id: string; label: string; created_at: Date; expires_at: Date | null; revoked_at: Date | null;
                                      last_used_at: Date | null; entries: number; code_enc: Buffer | null }>(
      'SELECT * FROM core.admin_beta_codes($1)', [req.compte!.id]);
    return reply.send({ codes: r.rows.map((c) => ({
      id: c.id, nom: c.label, creeLe: c.created_at.toISOString(), expireLe: c.expires_at?.toISOString() ?? null,
      revoqueLe: c.revoked_at?.toISOString() ?? null, dernierUsage: c.last_used_at?.toISOString() ?? null, saisies: c.entries,
      // Le code lui-même, pour pouvoir le renvoyer (null : créé avant qu'il soit conservé).
      code: lisible(c.code_enc),
    })) });
  }));

  app.post<{ Body: { nom: string; expireLe?: string } }>('/admin/beta', {
    ...admin,
    schema: { body: { type: 'object', additionalProperties: false, required: ['nom'],
                      properties: { nom: texte(80), expireLe: { type: 'string', format: 'date-time', maxLength: 40 } } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const code = nouveauCodeBeta();
    await bases.app.query('SELECT core.admin_create_beta_code($1, $2, $3, $4, $5)',
      [req.compte!.id, empreinteBeta(deps, normaliserCodeBeta(code)!), req.body.nom, req.body.expireLe ?? null, chiffrer(deps.cles, code)]);
    return reply.code(201).send({ code });
  }));

  app.post<{ Params: { id: string } }>('/admin/beta/:id/revoquer', { ...admin, schema: { params: ID } }, async (req, reply) => enErreurs(reply, async () => {
    await bases.app.query('SELECT core.admin_revoke_beta_code($1, $2)', [req.compte!.id, req.params.id]);
    return reply.send({ ok: true });
  }));

  // Supprimer un code révoqué ou expiré (id), ou tous d'un coup (sans id).
  app.post<{ Params: { id: string } }>('/admin/beta/:id/supprimer', { ...admin, schema: { params: ID } }, async (req, reply) => enErreurs(reply, async () => {
    await bases.app.query('SELECT core.admin_delete_beta_codes($1, $2)', [req.compte!.id, req.params.id]);
    return reply.send({ ok: true });
  }));
  app.post('/admin/beta/nettoyer', admin, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ n: number }>('SELECT core.admin_delete_beta_codes($1) AS n', [req.compte!.id]);
    return reply.send({ supprimes: r.rows[0]!.n });
  }));

  // Codes de comptes spéciaux : certifient le compte à l'inscription (délais sautés) et lui donnent sa catégorie.
  const CATEGORIES_CODE = { journaliste: 'journalist', avocat: 'lawyer', association: 'association', analyste: 'osint_analyst', confiance: 'trusted' } as const;
  app.get('/admin/codes-comptes', admin, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ id: string; label: string; category: string; created_at: Date; expires_at: Date | null;
                                      revoked_at: Date | null; used_at: Date | null; used_by_username: string | null; code_enc: Buffer | null }>(
      'SELECT * FROM core.admin_account_codes($1)', [req.compte!.id]);
    const type = Object.fromEntries(Object.entries(CATEGORIES_CODE).map(([k, v]) => [v, k]));
    return reply.send({ codes: r.rows.map((c) => ({
      id: c.id, nom: c.label, type: type[c.category] ?? c.category, creeLe: c.created_at.toISOString(),
      expireLe: c.expires_at?.toISOString() ?? null, revoqueLe: c.revoked_at?.toISOString() ?? null,
      utiliseLe: c.used_at?.toISOString() ?? null, utilisePar: c.used_by_username, code: lisible(c.code_enc),
    })) });
  }));
  // Codes de comptes vérifiés : clé physique, motif public et journal (audit du 15 novembre 2026, H4).
  app.post<{ Body: { nom: string; type: keyof typeof CATEGORIES_CODE; expireLe?: string; motif: string; cle: AuthenticationResponseJSON } }>('/admin/codes-comptes', {
    ...admin,
    schema: { body: { type: 'object', additionalProperties: false, required: ['nom', 'type', 'motif', 'cle'],
                      properties: { nom: texte(80), type: { enum: Object.keys(CATEGORIES_CODE) },
                                    expireLe: { type: 'string', format: 'date-time', maxLength: 40 },
                                    motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
    const code = nouveauCodeBeta();
    await bases.app.query('SELECT core.admin_create_account_code($1, $2, $3, $4, $5, $6, $7)',
      [req.compte!.id, empreinte(deps.cles, 'code-compte', normaliserCodeBeta(code)!), req.body.nom, CATEGORIES_CODE[req.body.type],
       req.body.expireLe ?? null, chiffrer(deps.cles, code), req.body.motif]);
    return reply.code(201).send({ code });
  }));
  app.post<{ Params: { id: string }; Body: { motif: string; cle: AuthenticationResponseJSON } }>('/admin/codes-comptes/:id/revoquer', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['motif', 'cle'],
                                  properties: { motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
    await bases.app.query('SELECT core.admin_revoke_account_code($1, $2, $3)', [req.compte!.id, req.params.id, req.body.motif]);
    return reply.send({ ok: true });
  }));
  app.post<{ Params: { id: string } }>('/admin/codes-comptes/:id/supprimer', { ...admin, schema: { params: ID } }, async (req, reply) => enErreurs(reply, async () => {
    await bases.app.query('SELECT core.admin_delete_account_codes($1, $2)', [req.compte!.id, req.params.id]);
    return reply.send({ ok: true });
  }));
  app.post('/admin/codes-comptes/nettoyer', admin, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ n: number }>('SELECT core.admin_delete_account_codes($1) AS n', [req.compte!.id]);
    return reply.send({ supprimes: r.rows[0]!.n });
  }));

  const DESTINATAIRES = { association: 'association', avocat: 'lawyer', journaliste: 'journalist', autre: 'other' } as const;
  app.post<{ Params: { id: string }; Body: { destinataire: keyof typeof DESTINATAIRES; motif: string; cle: AuthenticationResponseJSON } }>(
    '/admin/videos/:id/transmission', {
      ...admin,
      schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['destinataire', 'motif', 'cle'],
                                    properties: { destinataire: { enum: Object.keys(DESTINATAIRES) }, motif: texteLong(2000),
                                                  cle: SCHEMA_REPONSE_CLE } } },
    }, async (req, reply) => enErreurs(reply, async () => {
      if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
      await bases.app.query('SELECT core.record_release($1, $2, $3, $4)',
        [req.compte!.id, req.params.id, DESTINATAIRES[req.body.destinataire], req.body.motif]);
      return reply.send({ ok: true });
    }));

  app.post<{ Params: { id: string } }>('/admin/videos/:id/video', { ...admin, schema: { params: ID } }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query('SELECT 1 FROM core.videos WHERE id = $1 AND NOT is_control', [req.params.id]);
    if (!r.rowCount) return reply.code(404).send({ erreur: 'introuvable' });
    return reply.send(await creerLien(deps, req.params.id, 'complete'));
  }));

  app.post<{ Params: { id: string }; Body: { action: keyof typeof ACTIONS; motif: string; cle: AuthenticationResponseJSON } }>(
    '/admin/videos/:id/moderation', {
      ...admin,
      schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['action', 'motif', 'cle'],
                                    properties: { action: { enum: Object.keys(ACTIONS) }, motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE } } },
    }, async (req, reply) => enErreurs(reply, async () => {
      if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
      const r = await bases.app.query<{ suite: string }>('SELECT core.admin_moderate($1, $2, $3, $4) AS suite',
        [req.compte!.id, req.params.id, ACTIONS[req.body.action], req.body.motif]);
      // Retrait légal : la version floutée est effacée ; l'original chiffré (illisible pour nous) est gardé.
      if (r.rows[0]!.suite === 'effacer_floutee') await deps.stockage.supprimer('floutees', req.params.id);
      return reply.send({ ok: true });
    }));

  app.post<{ Params: { id: string }; Body: { video: string; motif: string; cle: AuthenticationResponseJSON } }>('/admin/doublons/:id/rattacher', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['video', 'motif', 'cle'],
                                  properties: { video: { type: 'string', format: 'uuid' }, motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
    const r = await bases.app.query<{ fiche: string }>('SELECT core.admin_attach_version($1, $2, $3, $4) AS fiche',
      [req.compte!.id, req.params.id, req.body.video, req.body.motif]);
    return reply.send({ ok: true, fiche: r.rows[0]!.fiche });
  }));

  app.post<{ Params: { id: string }; Body: { motif: string; cle: AuthenticationResponseJSON } }>('/admin/videos/:id/supprimer-echec', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['motif', 'cle'],
                                  properties: { motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
    await bases.app.query('SELECT core.admin_delete_failed($1, $2, $3)', [req.compte!.id, req.params.id, req.body.motif]);
    for (const espace of ['originaux', 'floutees', 'quarantaine', 'copies'] as const) await deps.stockage.supprimer(espace, req.params.id);
    return reply.send({ ok: true });
  }));

  app.post<{ Params: { id: string }; Body: { publiePar?: string; lien?: string; precisions?: string; publique: boolean; motif: string; cle: AuthenticationResponseJSON } }>('/admin/videos/:id/origine', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['publique', 'motif', 'cle'],
                                  properties: { publiePar: texte(200), lien: { type: 'string', maxLength: 500, pattern: '^https://[^\\s]+$' }, precisions: texteLong(2000),
                                                publique: { type: 'boolean' }, motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
    const { publiePar, lien, precisions, publique, motif } = req.body;
    await bases.app.query('SELECT core.admin_set_origin($1, $2, $3, $4, $5, $6, $7)',
      [req.compte!.id, req.params.id, publiePar?.trim() || null, lien?.trim() || null, precisions?.trim() || null, publique, motif]);
    return reply.send({ ok: true });
  }));

  // Même événement : propositions en attente, décision, lien direct et retrait du groupe (clé physique et motif).
  app.get('/admin/evenements', admin, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ id: string; origin: string; justification: string | null; created_at: Date; video_id: string; video_pseudonym: string | null;
                                      video_status: string; target_id: string; target_pseudonym: string | null; oui: number; non: number }>(
      'SELECT * FROM core.admin_event_proposals($1)', [req.compte!.id]);
    return reply.send({ propositions: r.rows.map((x) => ({
      id: x.id, origine: x.origin, justification: x.justification, le: x.created_at.toISOString(), oui: x.oui, non: x.non,
      video: { id: x.video_id, pseudonyme: x.video_pseudonym, statut: x.video_status }, fiche: { id: x.target_id, pseudonyme: x.target_pseudonym } })) });
  }));

  const AVEC_MOTIF = { motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE } as const;
  app.post<{ Params: { id: string }; Body: { accepter: boolean; motif: string; cle: AuthenticationResponseJSON } }>('/admin/evenements/:id', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['accepter', 'motif', 'cle'],
                                  properties: { accepter: { type: 'boolean' }, ...AVEC_MOTIF } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
    await bases.app.query('SELECT core.admin_decide_event($1, $2, $3, $4)', [req.compte!.id, req.params.id, req.body.accepter, req.body.motif]);
    return reply.send({ ok: true });
  }));

  app.post<{ Params: { id: string }; Body: { fiche: string; motif: string; cle: AuthenticationResponseJSON } }>('/admin/videos/:id/evenement', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['fiche', 'motif', 'cle'],
                                  properties: { fiche: texte(300), ...AVEC_MOTIF } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
    await bases.app.query('SELECT core.admin_link_event($1, $2, $3, $4)', [req.compte!.id, req.params.id, req.body.fiche, req.body.motif]);
    return reply.send({ ok: true });
  }));

  app.post<{ Params: { id: string }; Body: { motif: string; cle: AuthenticationResponseJSON } }>('/admin/videos/:id/evenement/retirer', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['motif', 'cle'], properties: AVEC_MOTIF } },
  }, async (req, reply) => enErreurs(reply, async () => {
    if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
    await bases.app.query('SELECT core.admin_unlink_event($1, $2, $3)', [req.compte!.id, req.params.id, req.body.motif]);
    return reply.send({ ok: true });
  }));

  app.post<{ Params: { id: string }; Body: { motif: string; cle: AuthenticationResponseJSON } }>('/admin/videos/:id/version/annuler', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['motif', 'cle'],
                                  properties: { motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
    await bases.app.query('SELECT core.admin_detach_version($1, $2, $3)', [req.compte!.id, req.params.id, req.body.motif]);
    return reply.send({ ok: true });
  }));

  // Re-floutage (après un signalement) : zones de flou AJOUTÉES sur la version floutée actuelle, motif et clé.
  // La version actuelle est préparée à côté de la vidéo pour le worker (depuis R2 en production), sans faire attendre.
  const RECT = { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number', minimum: 0, maximum: 1 } };
  app.post<{ Params: { id: string }; Body: { zones: { debut: number; fin: number; de: number[]; a: number[] }[]; motif: string;
                                            cle: AuthenticationResponseJSON } }>('/admin/videos/:id/refloutage', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['zones', 'motif', 'cle'], properties: {
      motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE,
      zones: { type: 'array', minItems: 1, maxItems: 500, items: {
        type: 'object', additionalProperties: false, required: ['debut', 'fin', 'de', 'a'],
        properties: { debut: { type: 'number', minimum: 0, maximum: 1200 }, fin: { type: 'number', minimum: 0, maximum: 1200 }, de: RECT, a: RECT },
      } },
    } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    if (req.body.zones.some((z) => z.fin <= z.debut)) return reply.code(400).send({ erreur: 'requete_invalide' });
    if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
    const id = (await bases.app.query<{ id: string }>('SELECT core.admin_request_reblur($1, $2, $3, $4) AS id',
      [req.compte!.id, req.params.id, JSON.stringify(req.body.zones), req.body.motif])).rows[0]!.id;
    void preparerRefloutage(id, req.params.id).catch((e) => req.log.error({ err: e }, 'préparation du re-floutage'));
    return reply.send({ ok: true });
  }));
  app.get<{ Params: { id: string } }>('/admin/videos/:id/refloutage', { ...admin, schema: { params: ID } }, async (req, reply) =>
    reply.send((await bases.app.query<{ s: unknown }>('SELECT core.reblur_state($1) AS s', [req.params.id])).rows[0]!.s));
  async function preparerRefloutage(demande: string, video: string) {
    const distant = deps.stockage.lienDistant?.(video, 'video.mp4', 3600);
    if (distant) {
      const dossier = dirname(deps.stockage.fichierVideo('floutees', video, 'video.mp4'));
      await mkdir(dossier, { recursive: true });
      const r = await fetch(distant);
      if (!r.ok || !r.body) throw new Error(`version actuelle illisible (${r.status})`);
      const provisoire = join(dossier, 'source-refloutage.mp4.part');
      await pipeline(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream), createWriteStream(provisoire));
      await rename(provisoire, join(dossier, 'source-refloutage.mp4'));
    }
    // En local (développement), le worker reprend directement la version en place.
    await bases.app.query('SELECT core.reblur_source_ready($1)', [demande]);
  }

  app.get<{ Querystring: { heures?: '24' | '168' | '336' } }>('/admin/erreurs', {
    ...admin,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { heures: { enum: ['24', '168', '336'] } } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ request_id: string; created_at: Date; method: string; route: string; status: number;
                                      error_name: string | null; message: string | null; stack: string | null }>(
      'SELECT * FROM core.admin_recent_errors($1, $2)', [req.compte!.id, Number(req.query.heures ?? 24)]);
    return reply.send({ erreurs: r.rows.map((x) => ({
      requete: x.request_id, le: x.created_at.toISOString(), route: `${x.method} ${x.route}`, statut: x.status, nom: x.error_name, message: x.message, trace: x.stack })) });
  }));

  app.get('/admin/controles', admin, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ video_id: string; pseudonym: string | null; display_pseudonym: string; truth: boolean; active: boolean;
                                      disabled: boolean; votes: number; corrects: number }>('SELECT * FROM core.admin_controls($1)', [req.compte!.id]);
    return reply.send({ controles: r.rows.map((x) => ({
      video: x.video_id, pseudonyme: x.pseudonym, nomAffiche: x.display_pseudonym, reponse: x.truth, active: x.active, retiree: x.disabled,
      votes: x.votes, corrects: x.corrects })) });
  }));

  app.post<{ Params: { id: string }; Body: { active: boolean } }>('/admin/controles/:id', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['active'], properties: { active: { type: 'boolean' } } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ ok: boolean }>('SELECT core.admin_control_set($1, $2, $3) AS ok', [req.compte!.id, req.params.id, req.body.active]);
    return r.rows[0]!.ok ? reply.send({ ok: true }) : reply.code(404).send({ erreur: 'introuvable' });
  }));

  // Règles de relecture : valeurs en vigueur, bornes, historique des versions (avec ce qui a changé).
  app.get('/admin/regles', admin, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ version: number; effective_from: Date; params: Record<string, unknown>; reason: string | null }>(
      'SELECT version, effective_from, params, reason FROM core.settings ORDER BY version DESC LIMIT 31');
    const versions = r.rows;
    const historique = versions.slice(0, 30).map((v, i) => {
      const avant = versions[i + 1] ? valeurs(versions[i + 1]!.params) : null;
      const apres = valeurs(v.params);
      const changements = avant ? Object.keys(apres).filter((k) => apres[k] !== avant[k]).map((k) => ({ cle: k, avant: avant[k] ?? null, apres: apres[k]! })) : [];
      return { version: v.version, le: v.effective_from.toISOString(), motif: v.reason, changements };
    });
    return reply.send({ version: versions[0]!.version, valeurs: valeurs(versions[0]!.params), bornes: BORNES, historique });
  }));

  app.post<{ Body: { changements: Record<string, number>; motif: string; cle: AuthenticationResponseJSON } }>('/admin/regles', {
    ...admin,
    schema: { body: { type: 'object', additionalProperties: false, required: ['changements', 'motif', 'cle'], properties: {
      changements: { type: 'object', minProperties: 1, maxProperties: 50, additionalProperties: { type: 'number' } },
      motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ params: Record<string, unknown> }>('SELECT params FROM core.settings ORDER BY version DESC LIMIT 1');
    const probleme = verifier(valeurs(r.rows[0]!.params), req.body.changements);
    if (probleme) return reply.code(400).send({ erreur: 'regles_invalides', detail: probleme });
    if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
    const v = await bases.app.query<{ version: number }>('SELECT core.admin_set_rules($1, $2, $3) AS version',
      [req.compte!.id, JSON.stringify(req.body.changements), req.body.motif]);
    return reply.send({ ok: true, version: v.rows[0]!.version });
  }));

  app.get<{ Querystring: { traites?: string } }>('/admin/contact', {
    ...admin,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { traites: { enum: ['oui', 'non'] } } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ id: string; created_at: Date; reason: string; email_enc: Buffer | null; body_enc: Buffer; handled_at: Date | null }>(
      'SELECT * FROM core.admin_contact_messages($1, $2)', [req.compte!.id, req.query.traites === 'oui']);
    return reply.send({ messages: r.rows.map((x) => ({
      id: x.id, le: x.created_at.toISOString(), motif: x.reason, traiteLe: x.handled_at?.toISOString() ?? null,
      mail: x.email_enc ? dechiffrer(deps.cles, x.email_enc) : null, message: dechiffrer(deps.cles, x.body_enc) })) });
  }));

  app.post<{ Params: { id: string }; Body: { traite: boolean } }>('/admin/contact/:id', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['traite'], properties: { traite: { type: 'boolean' } } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ ok: boolean }>('SELECT core.admin_contact_handle($1, $2, $3) AS ok', [req.compte!.id, req.params.id, req.body.traite]);
    return r.rows[0]!.ok ? reply.send({ ok: true }) : reply.code(404).send({ erreur: 'introuvable' });
  }));

  // Notes de l'administration (pense-bêtes privés, date facultative).
  app.get('/admin/notes', admin, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ id: string; title: string; due_date: string | null; details: string | null }>(
      "SELECT id, title, to_char(due_date, 'YYYY-MM-DD') AS due_date, details FROM core.admin_notes_list($1)", [req.compte!.id]);
    return reply.send({ notes: r.rows.map((n) => ({ id: n.id, titre: n.title, date: n.due_date, detail: n.details })) });
  }));

  app.post<{ Body: { id?: string; titre: string; date?: string | null; detail?: string | null } }>('/admin/notes', {
    ...admin,
    schema: { body: { type: 'object', additionalProperties: false, required: ['titre'],
                      properties: { id: { type: 'string', format: 'uuid' }, titre: texte(200),
                                    date: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
                                    detail: { anyOf: [texteLong(2000), { type: 'null' }] } } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const b = req.body;
    const r = await bases.app.query<{ id: string | null }>('SELECT core.admin_note_save($1, $2, $3, $4, $5) AS id',
      [req.compte!.id, b.id ?? null, b.titre, b.date ?? null, b.detail ?? null]);
    return r.rows[0]!.id ? reply.send({ id: r.rows[0]!.id }) : reply.code(404).send({ erreur: 'introuvable' });
  }));

  app.post<{ Params: { id: string } }>('/admin/notes/:id/supprimer', { ...admin, schema: { params: ID } },
    async (req, reply) => enErreurs(reply, async () => {
      const r = await bases.app.query<{ ok: boolean }>('SELECT core.admin_note_delete($1, $2) AS ok', [req.compte!.id, req.params.id]);
      return r.rows[0]!.ok ? reply.send({ ok: true }) : reply.code(404).send({ erreur: 'introuvable' });
    }));

  // Indicateurs du serveur (tableau de bord) : disques, dernières sauvegardes, place sur R2.
  app.get('/admin/serveur', admin, async (_req, reply) => reply.send(await etatServeur(deps)));

  // Demandes des autorités : registre privé (jamais au journal une par une ; comptées au rapport de transparence).
  const AUTEURS = ['police', 'judicial', 'administration', 'other'];
  const OBJETS = ['removal', 'identification', 'preservation', 'other'];
  const SUITES = ['pending', 'complied', 'partial', 'refused'];
  app.get('/admin/autorites', admin, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ id: string; received_on: string; requester: string; nature: string; video_id: string | null;
                                      video_pseudonym: string | null; outcome: string; notes: string | null }>(
      "SELECT id, to_char(received_on, 'YYYY-MM-DD') AS received_on, requester, nature, video_id, video_pseudonym, outcome, notes "
      + 'FROM core.admin_authority_requests($1)', [req.compte!.id]);
    return reply.send({ demandes: r.rows.map((d) => ({
      id: d.id, recueLe: d.received_on, auteur: d.requester, objet: d.nature,
      video: d.video_id ? { id: d.video_id, nom: d.video_pseudonym } : null, suite: d.outcome, notes: d.notes,
    })) });
  }));

  app.post<{ Body: { id?: string; recueLe: string; auteur: string; objet: string; video?: string | null; suite: string; notes?: string | null } }>(
    '/admin/autorites', {
      ...admin,
      schema: { body: { type: 'object', additionalProperties: false, required: ['recueLe', 'auteur', 'objet', 'suite'],
                        properties: { id: { type: 'string', format: 'uuid' }, recueLe: { type: 'string', format: 'date' },
                                      auteur: { enum: AUTEURS }, objet: { enum: OBJETS }, suite: { enum: SUITES },
                                      video: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
                                      notes: { anyOf: [texteLong(5000), { type: 'null' }] } } } },
    }, async (req, reply) => enErreurs(reply, async () => {
      const b = req.body;
      const r = await bases.app.query<{ id: string | null }>('SELECT core.admin_authority_request_save($1, $2, $3, $4, $5, $6, $7, $8) AS id',
        [req.compte!.id, b.id ?? null, b.recueLe, b.auteur, b.objet, b.video ?? null, b.suite, b.notes ?? null]);
      return r.rows[0]!.id ? reply.send({ id: r.rows[0]!.id }) : reply.code(404).send({ erreur: 'introuvable' });
    }));

  // Supprimer une demande (elle disparaît du rapport de transparence) : clé physique exigée (audit M11).
  app.post<{ Params: { id: string }; Body: { cle: AuthenticationResponseJSON } }>('/admin/autorites/:id/supprimer', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['cle'], properties: { cle: SCHEMA_REPONSE_CLE } } },
  }, async (req, reply) => enErreurs(reply, async () => {
      if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
      const r = await bases.app.query<{ ok: boolean }>('SELECT core.admin_authority_request_delete($1, $2) AS ok', [req.compte!.id, req.params.id]);
      return r.rows[0]!.ok ? reply.send({ ok: true }) : reply.code(404).send({ erreur: 'introuvable' });
    }));

  app.get<{ Querystring: { ecartes?: string } }>('/admin/doublons', {
    ...admin,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { ecartes: { enum: ['oui', 'non'] } } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ id: string; level: string; visual_score: number | null; audio_score: number | null;
                                      camera_score: number | null; detected_at: Date; video_id: string; video_pseudonym: string | null;
                                      video_status: string; other_video_id: string; other_pseudonym: string | null; other_status: string }>(
      'SELECT * FROM core.admin_matches($1, $2)', [req.compte!.id, req.query.ecartes === 'oui']);
    return reply.send({
      doublons: r.rows.map((x) => ({
        id: x.id, niveau: x.level, le: x.detected_at.toISOString(),
        scores: { visuel: x.visual_score, son: x.audio_score, camera: x.camera_score },
        video: { id: x.video_id, pseudonyme: x.video_pseudonym, statut: x.video_status },
        autre: { id: x.other_video_id, pseudonyme: x.other_pseudonym, statut: x.other_status },
      })),
    });
  }));

  app.post<{ Params: { id: string }; Body: { ecarter: boolean } }>('/admin/doublons/:id', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['ecarter'], properties: { ecarter: { type: 'boolean' } } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ ok: boolean }>('SELECT core.admin_dismiss_match($1, $2, $3) AS ok', [req.compte!.id, req.params.id, req.body.ecarter]);
    return r.rows[0]!.ok ? reply.send({ ok: true }) : reply.code(404).send({ erreur: 'introuvable' });
  }));

  app.get<{ Querystring: { statut?: string } }>('/admin/signalements', {
    ...admin,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { statut: { enum: ['open', 'handled', 'dismissed'] } } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ id: string; video_id: string; pseudonym: string | null; video_status: string; severity: string;
                                      reason_code: string; details: string | null; created_at: Date; status: string;
                                      handled_at: Date | null; handled_note: string | null; from_account: boolean }>(
      'SELECT * FROM core.admin_reports($1, $2)', [req.compte!.id, req.query.statut ?? 'open']);
    return reply.send({
      signalements: r.rows.map((x) => ({ id: x.id, video: x.video_id, pseudonyme: x.pseudonym, statutVideo: x.video_status,
                                         gravite: x.severity, motif: x.reason_code, details: x.details, le: x.created_at.toISOString(),
                                         statut: x.status, traiteLe: x.handled_at?.toISOString() ?? null, note: x.handled_note,
                                         origine: x.from_account ? 'compte' : 'relecture' })),
    });
  }));

  app.post<{ Params: { id: string }; Body: { statut: 'handled' | 'dismissed'; note: string } }>('/admin/signalements/:id', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['statut', 'note'],
                                  properties: { statut: { enum: ['handled', 'dismissed'] }, note: texteLong(2000) } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ auteur: string | null }>('SELECT core.admin_handle_report($1, $2, $3, $4) AS auteur',
      [req.compte!.id, req.params.id, req.body.statut, req.body.note]);
    const auteur = r.rows[0]!.auteur;
    let prevenu = false;
    if (auteur) {
      try {
        prevenu = await ecrire(deps, auteur, 'suite donnée à votre signalement',
          `Merci pour votre signalement. Il a été ${req.body.statut === 'handled' ? 'traité' : 'examiné, sans suite'}.\n\n`
          + `Réponse de l'administration :\n${req.body.note.trim()}`);
      } catch (e) {
        req.log.error({ err: e }, "échec de l'envoi du mail de suite d'un signalement");
      }
    }
    return reply.send({ ok: true, prevenu });
  }));

  const OUI_NON = { enum: ['true', 'false'] } as const;
  app.get<{ Querystring: { texte?: string; statut?: string; analyste?: string; doubleAuth?: string; nonLus?: string } }>('/admin/comptes', {
    ...admin,
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      texte: { type: 'string', maxLength: 60 }, statut: { enum: ['active', 'suspended', 'banned'] },
      analyste: OUI_NON, doubleAuth: OUI_NON, nonLus: OUI_NON } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    const q = req.query;
    const r = await bases.app.query<{ id: string; username: string; created_at: Date; status: string; suspended_until: Date | null;
                                      score: string; votes: number; last_vote_at: Date | null; last_seen: Date | null; mfa: boolean;
                                      analyst: boolean; suspect: boolean; superadmin: boolean; unread: number }>(
      'SELECT * FROM core.admin_accounts($1, $2)', [req.compte!.id, JSON.stringify({
        text: q.texte, status: q.statut, analyst: q.analyste === 'true', mfa: q.doubleAuth === 'true', unread: q.nonLus === 'true' })]);
    return reply.send({
      comptes: r.rows.map((c) => ({ id: c.id, pseudo: c.username, inscritLe: c.created_at.toISOString(), statut: c.status,
                                    suspenduJusqua: c.suspended_until?.toISOString() ?? null, score: Number(c.score), votes: c.votes,
                                    dernierVote: c.last_vote_at?.toISOString() ?? null, derniereActivite: c.last_seen?.toISOString() ?? null,
                                    doubleAuth: c.mfa, analyste: c.analyst, suspect: c.suspect, superAdmin: c.superadmin,
                                    messagesNonLus: c.unread })),
    });
  }));

  app.get<{ Params: { id: string } }>('/admin/comptes/:id', { ...admin, schema: { params: ID } }, async (req, reply) => enErreurs(reply, async () => {
    const r = await bases.app.query<{ c: Record<string, unknown> }>('SELECT core.admin_account($1, $2) AS c', [req.compte!.id, req.params.id]);
    // Statuts actifs (journaliste, avocat, association, analyste, confiance), avec les noms du site.
    const noms: Record<string, string> = { journalist: 'journaliste', lawyer: 'avocat', association: 'association', osint_analyst: 'analyste', trusted: 'confiance' };
    const s = await bases.app.query<{ s: string[]; e: Record<string, string> }>(
      'SELECT core.admin_account_statuses($1, $2) AS s, core.admin_account_status_dates($1, $2) AS e', [req.compte!.id, req.params.id]);
    // Échéance de chaque statut annuel (renouvelable dans les 30 jours avant, 0118).
    const echeances = Object.fromEntries(Object.entries(s.rows[0]!.e).map(([k, v]) => [noms[k] ?? k, v]));
    return reply.send({ ...r.rows[0]!.c, statuts: s.rows[0]!.s.map((x) => noms[x] ?? x), echeances });
  }));

  app.post<{ Params: { id: string }; Body: { action: keyof typeof SANCTIONS; jours?: number; motif: string; cle: AuthenticationResponseJSON } }>(
    '/admin/comptes/:id/sanction', {
      ...admin,
      schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['action', 'motif', 'cle'], properties: {
        action: { enum: Object.keys(SANCTIONS) }, jours: { type: 'integer', minimum: 1, maximum: 365 }, motif: texteLong(2000),
        cle: SCHEMA_REPONSE_CLE } } },
    }, async (req, reply) => enErreurs(reply, async () => {
      if (!(await cleValide(req, req.body.cle))) return reply.code(401).send({ erreur: 'cle_invalide' });
      const { action, jours, motif } = req.body;
      await bases.app.query('SELECT core.admin_sanction($1, $2, $3, $4, $5)',
        [req.compte!.id, req.params.id, SANCTIONS[action], action === 'suspendre' ? jours ?? null : null, motif]);
      // Le compte est prévenu, avec le motif, de toute suspension, levée ou bannissement.
      const mails: Partial<Record<keyof typeof SANCTIONS, [string, string]>> = {
        suspendre: ['compte suspendu', `Votre compte est suspendu pour ${jours} jour${(jours ?? 0) > 1 ? 's' : ''}.`],
        lever: ['suspension levée', 'La suspension de votre compte a été levée : vous pouvez de nouveau vous connecter.'],
        bannir: ['compte exclu', 'Votre compte a été exclu définitivement d\'Argos Veille.'],
      };
      const m = mails[action];
      let prevenu = false;
      if (m) {
        try {
          prevenu = await ecrire(deps, req.params.id, m[0], `${m[1]}\n\nMotif donné par l'administration :\n${motif.trim()}`);
        } catch (e) {
          req.log.error({ err: e }, "échec du mail de sanction");
        }
      }
      return reply.send({ ok: true, prevenu });
    }));

  app.post<{ Params: { id: string }; Body: { texte: string } }>('/admin/comptes/:id/messages', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['texte'], properties: { texte: texteLong(5000) } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    await bases.app.query('SELECT core.admin_send_message($1, $2, $3)', [req.compte!.id, req.params.id, req.body.texte]);
    let prevenu = false;
    try {
      // Le mail ne contient pas le message ni de lien de connexion directe : seulement l'adresse de la page.
      prevenu = await ecrire(deps, req.params.id, 'un message de l\'administration',
        `L'administration d'Argos Veille vous a écrit. Pour lire le message et y répondre, connectez-vous puis ouvrez :\n\n`
        + `${deps.reglages.urlPublique}/compte/messages`);
    } catch (e) {
      req.log.error({ err: e }, "échec du mail de message de l'administration");
    }
    return reply.send({ ok: true, prevenu });
  }));
}

/** Signaler une vidéo publique : route publique (compte connecté), présente sur toutes les instances. */
export function enregistrerSignalements(app: FastifyInstance, deps: Dependances): void {
  const { bases } = deps;
  const enErreurs = async <T>(reply: FastifyReply, f: () => Promise<T>) => {
    try {
      return await f();
    } catch (e) {
      const r = ERREURS[codeArgos(e) ?? ''];
      if (r) return reply.code(r[0]).send({ erreur: r[1] });
      if (codeArgos(e) === 'introuvable') return reply.code(404).send({ erreur: 'introuvable' });
      throw e;
    }
  };
  app.post<{ Params: { id: string }; Body: { motif: typeof MOTIFS[number]; details?: string } }>('/videos/:id/signaler', {
    preHandler: app.exigerSession,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['motif'],
                                  properties: { motif: { enum: MOTIFS }, details: texteLong(2000) } } },
  }, async (req, reply) => enErreurs(reply, async () => {
    await bases.app.query('SELECT core.report_video($1, $2, $3, $4)', [req.compte!.id, req.params.id, req.body.motif, req.body.details ?? null]);
    return reply.send({ ok: true });
  }));
}
