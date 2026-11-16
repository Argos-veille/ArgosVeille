// Revue de sécurité B13 : signal de la copie des sauvegardes tirée par un serveur à part de l’administration.
//   POST /etat/copie-externe  { ok, detail? }  en-tête « authorization: Bearer <secret> »
// Le secret (fichier « copie-externe » du VPS) n'est connu que du serveur de copie ; sans lui, refus sans détail. Le serveur de copie ne lit rien
// ici : il signale seulement son passage, affiché au tableau de bord de l'administration (tuile « Copie externe »).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Dependances } from './app.ts';
import { consommer } from './limites.ts';

const empreinte = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export function enregistrerCopieExterne(app: FastifyInstance, deps: Dependances): void {
  const secret = deps.reglages.copieExterne;
  if (!secret) return;   // pas de secret configuré : l'adresse n'existe pas (404)
  const attendu = empreinte(secret);
  app.post<{ Body: { ok: boolean; detail?: string } }>('/etat/copie-externe', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['ok'],
                      properties: { ok: { type: 'boolean' }, detail: { type: 'string', maxLength: 300 } } } },
  }, async (req, reply) => {
    const ip = createHash('sha256').update(`copie-externe:${req.ip}`).digest('hex');
    if (!(await consommer(deps.redis, `copie-externe:ip:${ip}`, 10, 3600))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const entete = req.headers.authorization ?? '';
    const recu = entete.startsWith('Bearer ') ? entete.slice(7).trim() : '';
    if (!recu || !timingSafeEqual(empreinte(recu), attendu)) return reply.code(401).send({ erreur: 'non_autorise' });
    await deps.bases.app.query('SELECT core.external_copy_record($1, $2)', [req.body.ok, req.body.detail ?? null]);
    return reply.code(204).send();
  });
}
