// Conditions d'utilisation : version en vigueur (date du texte). Le texte lui-même est sur le site
// (web/src/routes/conditions) ; changer le texte = changer cette date ici ET dans web/src/lib/conditions.ts.
// Une version périmée est refusée (409 conditions_perimees) : le site recharge le texte à jour.
import type { FastifyInstance } from 'fastify';
import type { Dependances } from './app.ts';

export const CONDITIONS_VERSION = '2026-11-15';   // + retrait d'un passage de la description par l'administration
export const VERSION_CONDITIONS = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;

export function enregistrerConditions(app: FastifyInstance, deps: Dependances): void {
  app.get('/conditions', async () => ({ version: CONDITIONS_VERSION }));

  // Un compte accepte la version en vigueur (comptes inscrits avant, ou après un changement du texte).
  app.post<{ Body: { version: string } }>('/compte/conditions', {
    preHandler: app.exigerSession,
    schema: { body: { type: 'object', additionalProperties: false, required: ['version'], properties: { version: VERSION_CONDITIONS } } },
  }, async (req, reply) => {
    if (req.body.version !== CONDITIONS_VERSION) return reply.code(409).send({ erreur: 'conditions_perimees', version: CONDITIONS_VERSION });
    await deps.bases.app.query('SELECT core.accept_terms($1, $2)', [req.compte!.id, CONDITIONS_VERSION]);
    return reply.send({ version: CONDITIONS_VERSION });
  });
}
