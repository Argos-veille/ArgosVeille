// Conversation d'un compte avec l'administration (ouverte par l'administration ; le compte y répond).
//   GET  /compte/messages        les messages (ceux de l'administration sont marqués lus)
//   POST /compte/messages        { texte }  répondre (20 réponses par jour au plus)
import type { FastifyInstance } from 'fastify';
import type { Dependances } from './app.ts';
import { codeArgos, texteLong } from './schemas.ts';

const ERREURS: Record<string, [number, string]> = {
  aucune_conversation: [409, 'aucune_conversation'], message_invalide: [400, 'message_invalide'],
  trop_de_messages: [429, 'trop_de_messages'],
};

export function enregistrerMessages(app: FastifyInstance, deps: Dependances): void {
  const { bases } = deps;

  app.get('/compte/messages', { preHandler: app.exigerSession }, async (req, reply) => {
    const r = await bases.app.query<{ id: string; from_admin: boolean; body: string; created_at: Date; read_at: Date | null }>(
      'SELECT * FROM core.my_messages($1)', [req.compte!.id]);
    return reply.send({
      messages: r.rows.map((m) => ({ id: m.id, deLAdmin: m.from_admin, texte: m.body, le: m.created_at.toISOString(),
                                     luLe: m.read_at?.toISOString() ?? null })),
    });
  });

  app.post<{ Body: { texte: string } }>('/compte/messages', {
    preHandler: app.exigerSession,
    schema: { body: { type: 'object', additionalProperties: false, required: ['texte'], properties: { texte: texteLong(5000) } } },
  }, async (req, reply) => {
    try {
      await bases.app.query('SELECT core.reply_message($1, $2)', [req.compte!.id, req.body.texte]);
      return reply.send({ ok: true });
    } catch (e) {
      const r = ERREURS[codeArgos(e) ?? ''];
      if (r) return reply.code(r[0]).send({ erreur: r[1] });
      throw e;
    }
  });
}
