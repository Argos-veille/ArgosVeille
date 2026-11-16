// « Mes vidéos » : vidéos envoyées avec son compte (étape 2, 7 novembre 2026).
//   GET  /compte/videos      liste (pseudonyme, état, dates) ; le détail passe par les routes /suivi avec { video }
//   POST /compte/relecture   { convoquer } : « ne pas me convoquer pour relire » (pour qui veut seulement envoyer)
// Mails d'avancement (prevenirSources, chaque minute) : floutage prêt (toujours), en relecture, décision,
// motif légal (désactivables dans /compte/notifications). Rien sur la vidéo elle-même dans le mail.
import type { FastifyInstance } from 'fastify';
import type { Dependances } from './app.ts';
import { ecrire } from './compte.ts';
import { normaliserCodeBeta } from './beta.ts';
import { empreinte } from './crypto.ts';
import { consommer } from './limites.ts';
import { ETATS } from './suivi.ts';
import { codeArgos } from './schemas.ts';

export function enregistrerMesVideos(app: FastifyInstance, deps: Dependances): void {
  const { bases } = deps;
  const session = { preHandler: app.exigerSession };

  app.get('/compte/videos', session, async (req, reply) => {
    const r = await bases.app.query<{ video_id: string; pseudonym: string; status: string; submitted_at: Date;
                                      decided_at: Date | null; withdrawn_at: Date | null }>(
      'SELECT * FROM core.my_videos($1)', [req.compte!.session]);
    return reply.send({
      videos: r.rows.map((v) => {
        const etat = ETATS[v.status] ?? { cle: 'inconnu', libelle: 'État inconnu' };
        return {
          video: v.video_id, pseudonyme: v.pseudonym, etat: etat.cle, libelle: etat.libelle,
          envoyeeLe: v.submitted_at.toISOString(),
          ...(v.decided_at ? { decideeLe: v.decided_at.toISOString() } : {}),
          ...(v.withdrawn_at ? { retireeLe: v.withdrawn_at.toISOString() } : {}),
        };
      }),
    });
  });

  // Code de compte spécial saisi après l'inscription : certifie le compte et lui donne sa catégorie.
  app.post<{ Body: { code: string } }>('/compte/code-special', {
    ...session,
    schema: { body: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', maxLength: 40 } } } },
  }, async (req, reply) => {
    if (!(await consommer(deps.redis, `code-special:${req.compte!.id}`, 10, 3600))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const code = normaliserCodeBeta(req.body.code);
    let r: { rows: { c: string | null }[] } | null = null;
    try {
      r = code ? await bases.app.query<{ c: string | null }>('SELECT core.redeem_account_code($1, $2) AS c',
                                                             [req.compte!.id, empreinte(deps.cles, 'code-compte', code)]) : null;
    } catch (e) {
      // Statut vérifié sans double authentification active : refusé, le code n'est pas consommé (0102).
      if (codeArgos(e) === 'double_auth_requise') return reply.code(403).send({ erreur: 'double_auth_requise' });
      throw e;
    }
    const categorie = r?.rows[0]!.c ?? null;
    if (!categorie) return reply.code(400).send({ erreur: 'code_invitation_invalide' });
    return reply.send({ certification: categorie });
  });

  app.post<{ Body: { convoquer: boolean } }>('/compte/relecture', {
    ...session,
    schema: { body: { type: 'object', additionalProperties: false, required: ['convoquer'], properties: { convoquer: { type: 'boolean' } } } },
  }, async (req, reply) => {
    const id = req.compte!.id;
    // Plus de convocation : celles en attente sont annulées par la base.
    await bases.app.query('SELECT core.set_review_opt_out($1, $2)', [id, !req.body.convoquer]);
    return reply.send({ convoquer: req.body.convoquer });
  });
}

const MAILS: Record<string, (statut: string) => { sujet: string; texte: string }> = {
  ready: () => ({ sujet: 'votre vidéo est prête à vérifier',
    texte: 'Les visages de votre vidéo sont floutés. Vérifiez le résultat, retouchez-le si besoin, puis validez : '
      + 'personne ne la verra avant votre accord. Sans réponse de votre part sous 7 jours, elle partira en relecture '
      + 'avec le floutage automatique.' }),
  in_review: () => ({ sujet: 'votre vidéo est en relecture',
    texte: 'Votre vidéo est entre les mains de relecteurs tirés au sort.' }),
  decided: (statut) => ({ sujet: 'décision sur votre vidéo',
    texte: statut === 'published' ? 'Votre vidéo a été vérifiée et publiée sur la carte.'
      : statut === 'rejected' ? 'Les relecteurs ont estimé que votre vidéo ne montrait pas ce qui était annoncé : elle n\'est pas publiée.'
      : statut === 'under_debate' ? 'Les relecteurs ne sont pas parvenus à trancher : votre vidéo reste « en débat », hors de la carte.'
      : 'Pas assez de relecteurs n\'ont répondu à temps : votre vidéo n\'a pas pu être tranchée.' }),
  original_downloaded: () => ({ sujet: 'l’original de votre vidéo a été téléchargé',
    texte: 'Comme vous l’aviez autorisé, l’administration d’Argos Veille a téléchargé l’original de votre vidéo. Cette action est inscrite au journal public.' }),
  released: () => ({ sujet: 'l’original de votre vidéo a été transmis',
    texte: 'Comme vous l’aviez autorisé, l’original de votre vidéo a été transmis par Argos Veille. Le type de destinataire '
      + '(association, avocat ou journaliste) est indiqué dans Mes vidéos et au journal public, jamais son nom. '
      + 'Vous pouvez retirer votre autorisation à tout moment pour les transmissions futures.' }),
  legal: (statut) => ({ sujet: 'votre vidéo a été ' + (statut === 'removed' ? 'retirée' : 'masquée'),
    texte: `Votre vidéo a été ${statut === 'removed' ? 'retirée' : 'masquée'} pour un motif légal. Le motif est inscrit au journal public.` }),
};

/** Tâche (chaque minute) : les mails d'avancement aux personnes qui ont envoyé avec leur compte. */
export async function prevenirSources(deps: Dependances): Promise<number> {
  const r = await deps.bases.app.query<{ id: string; account_id: string; kind: string; status: string }>(
    'SELECT * FROM core.take_owner_notifications(100) ORDER BY id');   // dans l'ordre des événements
  let n = 0;
  for (const m of r.rows) {
    const { sujet, texte } = MAILS[m.kind]!(m.status);
    try {
      await ecrire(deps, m.account_id, sujet, `Bonjour,\n\n${texte}\n\nRetrouvez-la dans Mes vidéos :\n`
        + `${deps.reglages.urlPublique}/compte/videos\n\nVous pouvez choisir les mails que vous recevez dans votre compte.`);
      n++;
    } catch {
      await deps.bases.app.query('SELECT core.retry_owner_notification($1)', [m.id]);   // repart au tour suivant
    }
  }
  return n;
}
