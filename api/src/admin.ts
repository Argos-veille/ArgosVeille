// Actions du super-administrateur. Clé physique exigée à chaque fois (défi à usage unique,
// 5 minutes) ; la base vérifie le compte et inscrit l'action au journal public.
// Cette partie passera dans une interface d'administration séparée à l'étape Administration.
//   POST /admin/decision/defi              défi pour la clé physique (sert à toutes les actions)
//   POST /admin/videos/:id/decision        { decision: publier | rejeter, motif, cle }   (7b)
//   POST /admin/comptes/:pseudo/osint      { accorder: true | false, cle }  statut d'analyste OSINT (7d)
//   POST /admin/notes/:id/masquer          { motif, cle }  masquer une note d'analyste (7d)
//   POST /admin/notes/:id/demasquer        { motif, cle }  la démasquer (motif au journal public)
//   POST /admin/corrections/:id/annuler    { motif, cle }  annuler la dernière correction de date, heure ou lieu
//   GET  /admin/videos/:id/description      corrections passées de la description (date et justification seulement)
//   POST /admin/videos/:id/description      { description, justification, cle }  corriger ou masquer un passage (sans copie)
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Dependances } from './app.ts';
import { alerter } from './compte.ts';
import { codeArgos, texte, texteLong } from './schemas.ts';
import { optionsPreuve, SCHEMA_REPONSE_CLE, verifierPreuve } from './webauthn.ts';

const DUREE_DEFI = 5 * 60;
const cleDefi = (compteId: string) => `admin-defi:${compteId}`;
const ERREURS: Record<string, [number, string]> = {
  reserve_super_admin: [403, 'reserve_super_admin'],
  motif: [400, 'motif'],
  video_hors_decision: [409, 'video_hors_decision'],
  deja_ainsi: [409, 'deja_ainsi'],
  statut_inconnu: [400, 'statut_inconnu'],
  compte_inconnu: [404, 'introuvable'],
  double_auth_requise: [409, 'double_auth_requise'],
  note_introuvable: [404, 'introuvable'],
  correction_introuvable: [404, 'introuvable'],
  correction_pas_la_derniere: [409, 'correction_pas_la_derniere'],
  justification: [400, 'justification'],
  description_invalide: [400, 'description_invalide'],
  introuvable: [404, 'introuvable'],
};
const ID = {
  type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export function enregistrerAdmin(app: FastifyInstance, deps: Dependances): void {
  const { bases, redis } = deps;
  const session = { preHandler: app.exigerSession };
  const superAdmin = async (id: string) =>
    (await bases.app.query<{ ok: boolean }>('SELECT is_superadmin AS ok FROM core.accounts WHERE id = $1', [id])).rows[0]?.ok === true;

  /** Super-administrateur, clé physique valable pour le défi en cours, puis l'action en base
   *  (ses erreurs « argos:… » traduites). */
  async function avecCle(req: FastifyRequest, reply: FastifyReply, cle: AuthenticationResponseJSON,
                         action: () => Promise<unknown>) {
    const compte = req.compte!;
    if (!(await superAdmin(compte.id))) return reply.code(403).send({ erreur: 'reserve_super_admin' });
    const defi = await redis.getdel(cleDefi(compte.id));
    const preuve = defi === null ? { ok: false as const } : await verifierPreuve(deps, compte.id, cle, defi, { admin: true });
    if (!preuve.ok) {
      if (preuve.clonee) {
        await alerter(deps, req.log, compte.id, 'vérification d’une clé de sécurité',
          'Lors d\'une vérification, une clé de sécurité enregistrée sur votre compte a donné une réponse inattendue. Par précaution, '
          + 'l\'opération a été refusée. En cas de doute, retirez cette clé dans « Mon compte » et enregistrez-en une nouvelle.');
      }
      return reply.code(401).send({ erreur: 'cle_invalide' });
    }
    try {
      return await action();
    } catch (e) {
      const r = ERREURS[codeArgos(e) ?? ''];
      if (r) return reply.code(r[0]).send({ erreur: r[1] });
      throw e;
    }
  }

  app.post('/admin/decision/defi', session, async (req, reply) => {
    if (!(await superAdmin(req.compte!.id))) return reply.code(403).send({ erreur: 'reserve_super_admin' });
    const options = await optionsPreuve(deps, req.compte!.id);
    if (!options) return reply.code(409).send({ erreur: 'cle_requise' });   // aucune clé enregistrée
    await redis.set(cleDefi(req.compte!.id), options.challenge, 'EX', DUREE_DEFI);
    return reply.send({ options });
  });

  app.post<{ Params: { id: string }; Body: { decision: 'publier' | 'rejeter' | 'debat' | 'relecture'; motif: string; cle: AuthenticationResponseJSON } }>(
    '/admin/videos/:id/decision', {
      ...session,
      schema: {
        params: ID,
        body: {
          type: 'object', additionalProperties: false, required: ['decision', 'motif', 'cle'],
          properties: { decision: { type: 'string', enum: ['publier', 'rejeter', 'debat', 'relecture'] }, motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE },
        },
      },
    }, async (req, reply) => avecCle(req, reply, req.body.cle, async () => {
      const r = await bases.app.query<{ statut: string }>('SELECT core.admin_decide($1, $2, $3, $4) AS statut',
        [req.compte!.id, req.params.id,
         ({ publier: 'publish', rejeter: 'reject', debat: 'debate', relecture: 'review' } as const)[req.body.decision], req.body.motif]);
      const statuts: Record<string, string> = { published: 'publiee', awaiting_osint: 'en_attente_analyse', under_debate: 'en_debat',
                                                in_review: 'en_relecture' };
      return reply.send({ ok: true, statut: statuts[r.rows[0]!.statut] ?? 'rejetee' });
    }));

  app.post<{ Params: { pseudo: string }; Body: { accorder: boolean; cle: AuthenticationResponseJSON } }>(
    '/admin/comptes/:pseudo/osint', {
      ...session,
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['pseudo'],
                  properties: { pseudo: { type: 'string', pattern: '^[A-Za-z0-9._-]{3,30}$' } } },
        body: {
          type: 'object', additionalProperties: false, required: ['accorder', 'cle'],
          properties: { accorder: { type: 'boolean' }, cle: SCHEMA_REPONSE_CLE },
        },
      },
    }, async (req, reply) => avecCle(req, reply, req.body.cle, async () => {
      const c = await bases.app.query<{ id: string }>('SELECT id FROM core.accounts WHERE lower(username) = lower($1)',
        [req.params.pseudo]);
      if (!c.rowCount) return reply.code(404).send({ erreur: 'introuvable' });
      await bases.app.query('SELECT core.admin_set_osint($1, $2, $3)', [req.compte!.id, c.rows[0]!.id, req.body.accorder]);
      return reply.send({ ok: true, analysteOsint: req.body.accorder });
    }));

  // Tous les statuts d'un compte : journaliste, avocat, association, analyste OSINT, compte de confiance.
  const STATUTS = { journaliste: 'journalist', avocat: 'lawyer', association: 'association', analyste: 'osint_analyst', confiance: 'trusted' } as const;
  app.post<{ Params: { pseudo: string }; Body: { statut: keyof typeof STATUTS; accorder: boolean; cle: AuthenticationResponseJSON } }>(
    '/admin/comptes/:pseudo/statut', {
      ...session,
      schema: {
        params: { type: 'object', additionalProperties: false, required: ['pseudo'],
                  properties: { pseudo: { type: 'string', pattern: '^[A-Za-z0-9._-]{3,30}$' } } },
        body: { type: 'object', additionalProperties: false, required: ['statut', 'accorder', 'cle'],
                properties: { statut: { enum: Object.keys(STATUTS) }, accorder: { type: 'boolean' }, cle: SCHEMA_REPONSE_CLE } },
      },
    }, async (req, reply) => avecCle(req, reply, req.body.cle, async () => {
      const c = await bases.app.query<{ id: string }>('SELECT id FROM core.accounts WHERE lower(username) = lower($1)', [req.params.pseudo]);
      if (!c.rowCount) return reply.code(404).send({ erreur: 'introuvable' });
      await bases.app.query('SELECT core.admin_set_status($1, $2, $3, $4)',
        [req.compte!.id, c.rows[0]!.id, STATUTS[req.body.statut], req.body.accorder]);
      return reply.send({ ok: true });
    }));

  app.post<{ Params: { id: string }; Body: { motif: string; cle: AuthenticationResponseJSON } }>(
    '/admin/notes/:id/masquer', {
      ...session,
      schema: {
        params: ID,
        body: {
          type: 'object', additionalProperties: false, required: ['motif', 'cle'],
          properties: { motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE },
        },
      },
    }, async (req, reply) => avecCle(req, reply, req.body.cle, async () => {
      await bases.app.query('SELECT core.admin_mask_note($1, $2, $3)', [req.compte!.id, req.params.id, req.body.motif]);
      return reply.send({ ok: true });
    }));

  app.post<{ Params: { id: string }; Body: { motif: string; cle: AuthenticationResponseJSON } }>(
    '/admin/notes/:id/demasquer', {
      ...session,
      schema: {
        params: ID,
        body: { type: 'object', additionalProperties: false, required: ['motif', 'cle'], properties: { motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE } },
      },
    }, async (req, reply) => avecCle(req, reply, req.body.cle, async () => {
      await bases.app.query('SELECT core.admin_unmask_note($1, $2, $3)', [req.compte!.id, req.params.id, req.body.motif]);
      return reply.send({ ok: true });
    }));

  app.post<{ Params: { id: string }; Body: { motif: string; cle: AuthenticationResponseJSON } }>(
    '/admin/corrections/:id/annuler', {
      ...session,
      schema: {
        params: ID,
        body: { type: 'object', additionalProperties: false, required: ['motif', 'cle'], properties: { motif: texteLong(2000), cle: SCHEMA_REPONSE_CLE } },
      },
    }, async (req, reply) => avecCle(req, reply, req.body.cle, async () => {
      await bases.app.query('SELECT core.admin_cancel_correction($1, $2, $3)', [req.compte!.id, req.params.id, req.body.motif]);
      return reply.send({ ok: true });
    }));

  // Description : correction ou masquage d'un passage (« [retiré] ») par l'administration seule (0113, 0114). Le texte
  // remplacé n'est gardé nulle part ; restent la date et la justification (aussi au journal public).
  app.get<{ Params: { id: string } }>('/admin/videos/:id/description', { ...session, schema: { params: ID } }, async (req, reply) => {
    if (!(await superAdmin(req.compte!.id))) return reply.code(403).send({ erreur: 'reserve_super_admin' });
    const r = await bases.app.query<{ c: unknown }>('SELECT core.admin_description_corrections($1, $2) AS c', [req.compte!.id, req.params.id]);
    return reply.send({ corrections: r.rows[0]!.c });
  });

  app.post<{ Params: { id: string }; Body: { description: string; justification: string; cle: AuthenticationResponseJSON } }>(
    '/admin/videos/:id/description', {
      ...session,
      schema: {
        params: ID,
        body: { type: 'object', additionalProperties: false, required: ['description', 'justification', 'cle'],
                properties: { description: texteLong(5000), justification: texteLong(2000), cle: SCHEMA_REPONSE_CLE } },
      },
    }, async (req, reply) => avecCle(req, reply, req.body.cle, async () => {
      const r = await bases.app.query<{ id: string }>('SELECT core.admin_correct_description($1, $2, $3, $4) AS id',
        [req.compte!.id, req.params.id, req.body.description, req.body.justification]);
      return reply.send({ correction: r.rows[0]!.id });
    }));
}
