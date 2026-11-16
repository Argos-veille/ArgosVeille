// Formulaire de contact : POST /contact { motif, message, mail?, turnstile }.
// Message et adresse sont chiffrés ; l'adresse IP ne sert qu'à limiter les envois et n'est pas conservée avec le message.
import type { FastifyInstance } from 'fastify';
import type { Dependances } from './app.ts';
import { ecrire } from './compte.ts';
import { chiffrer, empreinte } from './crypto.ts';
import { consommer } from './limites.ts';
import { normaliserMail } from './normalisation.ts';
import { texte, texteLong } from './schemas.ts';

export const MOTIFS_CONTACT = {
  contenu: 'content', droit_de_reponse: 'right_of_reply', donnees: 'personal_data', autorite: 'authority', presse: 'press', certification: 'certification', autre: 'other',
} as const;
const MAIL_OBLIGATOIRE: readonly string[] = ['droit_de_reponse', 'donnees', 'certification'];
const MESSAGE_MIN = 10;
const MESSAGE_MAX = 5000;

export function enregistrerContact(app: FastifyInstance, deps: Dependances): void {
  const { bases, cles, redis, turnstile } = deps;

  app.post<{ Body: { motif: keyof typeof MOTIFS_CONTACT; message: string; mail?: string; turnstile: string } }>('/contact', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['motif', 'message', 'turnstile'],
        properties: { motif: { enum: Object.keys(MOTIFS_CONTACT) }, message: texteLong(MESSAGE_MAX), mail: texte(254), turnstile: texte(2048) },
      },
    },
  }, async (req, reply) => {
    const { motif, mail, turnstile: jeton } = req.body;
    const message = req.body.message.trim();
    if (message.length < MESSAGE_MIN) return reply.code(400).send({ erreur: 'message_trop_court' });
    const adresse = mail?.trim() || undefined;
    if (MAIL_OBLIGATOIRE.includes(motif) && !adresse) return reply.code(400).send({ erreur: 'mail_requis' });
    if (adresse && !normaliserMail(adresse).ok) return reply.code(400).send({ erreur: 'mail_invalide' });
    if (!(await consommer(redis, `contact:ip:${empreinte(cles, 'ip', req.ip).toString('hex')}`, 5, 3600))) {
      return reply.code(429).send({ erreur: 'trop_de_demandes' });
    }
    if (!(await turnstile.verifier(jeton))) return reply.code(400).send({ erreur: 'turnstile' });
    await bases.app.query('SELECT core.contact_create($1, $2, $3)',
      [MOTIFS_CONTACT[motif], adresse ? chiffrer(cles, adresse) : null, chiffrer(cles, message)]);

    // Alerte sans contenu, une par heure au plus.
    if (await consommer(redis, 'contact:alerte', 1, 3600)) {
      const admin = (await bases.app.query<{ id: string }>('SELECT id FROM core.accounts WHERE is_superadmin LIMIT 1')).rows[0];
      if (admin) {
        await ecrire(deps, admin.id, 'nouveau message de contact', 'Un message attend dans l’administration.')
          .catch((e) => req.log.error({ err: e }, 'échec du mail d’alerte de contact'));
      }
    }
    return reply.send({ ok: true });
  });
}
