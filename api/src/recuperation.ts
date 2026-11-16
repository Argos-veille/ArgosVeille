// Récupération du compte et gestion du mot de passe (étape 4d).
//   POST /recuperation/demande               mail + Turnstile → lien par mail (réponse toujours identique)
//   POST /recuperation/nouveau-mot-de-passe  jeton du lien + nouveau mot de passe
//   POST /recuperation/code                  pseudo + code de secours + nouveau mot de passe
//   POST /mot-de-passe                       (connecté) ancien + nouveau mot de passe
//   POST /codes-secours                      (connecté) mot de passe → 10 nouveaux codes, les anciens annulés
// Après chaque changement : sessions fermées et mail d'alerte.
import { type CleCompte, compteAUneCleMessagerie, SCHEMA_CLE_COMPTE } from './messagerie.ts';
import type { FastifyInstance } from 'fastify';
import type { Dependances } from './app.ts';
import { regenererCodes, utiliserCode } from './codes.ts';
import { alerter, changerMotDePasse, signature, verifierMdpConnecte as verifierMdpConnecteCommun } from './compte.ts';
import { dechiffrer, empreinte, jeton } from './crypto.ts';
import { consommer } from './limites.ts';
import { validerMotDePasse } from './motdepasse.ts';
import { normaliserMail, normaliserPseudo } from './normalisation.ts';
import { codeArgos, texte } from './schemas.ts';

const DUREE_LIEN = 30 * 60;
const cleLien = (empreinteJeton: string) => `recuperation:${empreinteJeton}`;
const JETON = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };

export function enregistrerRecuperation(app: FastifyInstance, deps: Dependances): void {
  const { bases, redis, cles, facteur, turnstile, listes, reglages } = deps;
  const hex = (domaine: string, valeur: string) => empreinte(cles, domaine, valeur).toString('hex');

  async function compteParPseudo(pseudo: string) {
    const r = await bases.app.query<{ id: string; username: string; status: string; password_hash: string }>(
      `SELECT a.id, a.username, a.status, c.password_hash
         FROM core.accounts a JOIN core.credentials c ON c.account_id = a.id
        WHERE lower(a.username) = lower($1)`, [normaliserPseudo(pseudo)]);
    return r.rows[0];
  }

  // --- Par mail ---------------------------------------------------------------------------

  // N3 (second audit) : sur le site public, le super-administrateur ne réinitialise pas son mot de passe (il y serait tapé).
  // Il le fait depuis l'administration. Refus silencieux là où une réponse différente révélerait le compte.
  // Lien de réinitialisation : sur l'instance d'administration, vers l'administration (jamais le site public, où le
  // nouveau mot de passe serait tapé) ; relecture croisée de N3.
  const baseLiens = reglages.administration === true && reglages.origine ? reglages.origine : reglages.urlPublique;
  // Compteurs par instance : des essais sur le site public ne bloquent pas la récupération depuis l'administration.
  const instance = reglages.administration === true ? 'admin' : 'public';
  const superAdminSurPublic = async (compteId: string) => deps.reglages.administration === false
    && !!(await bases.app.query('SELECT 1 FROM core.accounts WHERE id = $1 AND is_superadmin', [compteId])).rowCount;

  app.post<{ Body: { mail: string; turnstile: string } }>('/recuperation/demande', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['mail', 'turnstile'],
        properties: { mail: texte(254), turnstile: texte(2048) },
      },
    },
  }, async (req, reply) => {
    if (!(await consommer(redis, `recup:ip:${hex('ip', req.ip)}`, 5, 3600))) {
      return reply.code(429).send({ erreur: 'trop_de_demandes' });
    }
    if (!(await turnstile.verifier(req.body.turnstile))) return reply.code(400).send({ erreur: 'turnstile' });
    const mail = normaliserMail(req.body.mail);
    if (!mail.ok) return reply.code(400).send({ erreur: 'mail_invalide' });

    // Réponse identique dans tous les cas : personne ne peut savoir si un mail a un compte.
    const reponse = { ok: true, message: 'Si un compte correspond à cette adresse, un mail vient de lui être envoyé.' };

    const mailH = empreinte(cles, 'mail', mail.canonique);
    if (!(await consommer(redis, `recup:mail:${mailH.toString('hex')}`, 3, 24 * 3600))) return reply.send(reponse);
    const ident = await bases.identity.query<{ account_id: string | null; banned: boolean; email_enc: Buffer }>(
      'SELECT account_id, banned, email_enc FROM identity.account_identities WHERE email_hmac = $1', [mailH]);
    const i = ident.rows[0];
    if (!i?.account_id || i.banned) return reply.send(reponse);
    const compte = await bases.app.query<{ username: string; status: string }>(
      'SELECT username, status FROM core.accounts WHERE id = $1', [i.account_id]);
    const c = compte.rows[0];
    if (!c || c.status === 'banned' || c.status === 'deleted') return reply.send(reponse);
    if (await superAdminSurPublic(i.account_id)) {
      // Aucun lien, même réponse, et le même travail qu'un vrai lien (pas d'écart de temps révélant le compte).
      await redis.set(cleLien(hex('jeton-recuperation', jeton())), 'refus', 'EX', 1);
      return reply.send(reponse);
    }

    const lien = jeton();
    await redis.set(cleLien(hex('jeton-recuperation', lien)), i.account_id, 'EX', DUREE_LIEN);
    // Mail envoyé sans l'attendre : sinon la réponse, plus lente quand un compte existe, le révélerait.
    void (async () => {
      try {
        await facteur.mail(dechiffrer(cles, i.email_enc), 'Argos Veille : réinitialiser votre mot de passe',
          `Bonjour,\n\nVous avez demandé à choisir un nouveau mot de passe pour votre compte Argos Veille.\n\n`
          + `Votre pseudo : ${c.username}\n\n`
          + `Ouvrez ce lien dans les 30 minutes (il ne sert qu'une fois) :\n\n`
          + `${baseLiens}/recuperation#${lien}\n\n`
          + `Vous n'avez rien demandé ? Ignorez simplement ce message : votre mot de passe ne change pas.`
          + signature(deps, 'Vous recevez ce message parce qu\'une demande a été faite pour votre compte sur Argos Veille.'));
      } catch (e) {
        req.log.error({ err: e }, "échec de l'envoi du mail de récupération");
      }
    })();
    return reply.send(reponse);
  });

  // Pseudo du compte d'un lien encore valable, sans le consommer : le navigateur en a besoin pour tirer le secret de
  // connexion du nouveau mot de passe (0101). Même limite que le changement lui-même.
  app.post<{ Body: { jeton: string } }>('/recuperation/pseudo', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['jeton'], properties: { jeton: JETON } } },
  }, async (req, reply) => {
    if (!(await consommer(redis, `recup-lien:ip:${hex('ip', req.ip)}`, 30, 3600))) {
      return reply.code(429).send({ erreur: 'trop_de_demandes' });
    }
    const compteId = await redis.get(cleLien(hex('jeton-recuperation', req.body.jeton)));
    if (!compteId) return reply.code(410).send({ erreur: 'lien_expire' });
    const c = await bases.app.query<{ username: string }>('SELECT username FROM core.accounts WHERE id = $1', [compteId]);
    return c.rows[0] ? reply.send({ pseudo: c.rows[0].username }) : reply.code(410).send({ erreur: 'lien_expire' });
  });

  app.post<{ Body: { jeton: string; motDePasse: string } }>('/recuperation/nouveau-mot-de-passe', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['jeton', 'motDePasse'],
        properties: { jeton: JETON, motDePasse: texte(512) },
      },
    },
  }, async (req, reply) => {
    if (!(await consommer(redis, `recup-lien:ip:${hex('ip', req.ip)}`, 30, 3600))) {
      return reply.code(429).send({ erreur: 'trop_de_demandes' });
    }
    const cle = cleLien(hex('jeton-recuperation', req.body.jeton));
    const compteId = await redis.get(cle);
    if (!compteId) return reply.code(410).send({ erreur: 'lien_expire' });
    const c = await bases.app.query<{ username: string }>('SELECT username FROM core.accounts WHERE id = $1', [compteId]);
    if (!c.rows[0]) return reply.code(410).send({ erreur: 'lien_expire' });
    if (await superAdminSurPublic(compteId)) return reply.code(403).send({ erreur: 'super_admin_administration_seulement' });
    // Le mot de passe est vérifié AVANT de consommer le lien : une faute de frappe ne le gâche pas.
    const regle = validerMotDePasse(req.body.motDePasse, c.rows[0].username, listes.motsDePasseCourants);
    if (!regle.ok) return reply.code(400).send({ erreur: regle.erreur });
    if ((await redis.getdel(cle)) === null) return reply.code(410).send({ erreur: 'lien_expire' });   // déjà utilisé entre-temps

    await changerMotDePasse(deps, compteId, req.body.motDePasse, undefined, 'effacer');
    await alerter(deps, req.log, compteId, 'votre mot de passe a été modifié',
      'Le mot de passe de votre compte a été réinitialisé avec le lien envoyé par mail. '
      + 'Toutes vos sessions ont été fermées.');
    return reply.send({ ok: true });
  });

  // --- Par code de secours -----------------------------------------------------------------

  app.post<{ Body: { pseudo: string; code: string; motDePasse: string } }>('/recuperation/code', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['pseudo', 'code', 'motDePasse'],
        properties: { pseudo: texte(60), code: texte(20), motDePasse: texte(512) },
      },
    },
  }, async (req, reply) => {
    if (!(await consommer(redis, `recup-code:${instance}:ip:${hex('ip', req.ip)}`, 20, 3600))
        || !(await consommer(redis, `recup-code:${instance}:pseudo:${hex('pseudo', normaliserPseudo(req.body.pseudo).toLowerCase())}`, 10, 3600))) {
      return reply.code(429).send({ erreur: 'trop_de_demandes' });
    }
    // Règles du mot de passe vérifiées avant d'utiliser le code (pour ne pas le gâcher), avec le pseudo SAISI et que le
    // compte existe ou non : la réponse ne révèle pas si un pseudo est pris (point bas de la revue, 15 novembre 2026).
    const regle = validerMotDePasse(req.body.motDePasse, normaliserPseudo(req.body.pseudo), listes.motsDePasseCourants);
    if (!regle.ok) return reply.code(400).send({ erreur: regle.erreur });
    const c = await compteParPseudo(req.body.pseudo);
    // Super-administrateur sur le site public : refusé comme un code faux, sans consommer de code (N3).
    const actif = c && c.status !== 'banned' && c.status !== 'deleted' && !(await superAdminSurPublic(c.id));
    // Pseudo inconnu : la même vérification de code, sur un compte qui n'existe pas (même travail, même temps).
    if (!(await utiliserCode(bases, cles, actif ? c.id : '00000000-0000-0000-0000-000000000000', req.body.code)) || !actif) {
      return reply.code(401).send({ erreur: 'code_invalide' });
    }
    await changerMotDePasse(deps, c.id, req.body.motDePasse, undefined, 'effacer');
    await alerter(deps, req.log, c.id, 'votre mot de passe a été modifié',
      'Le mot de passe de votre compte a été réinitialisé avec un code de secours. '
      + 'Toutes vos sessions ont été fermées.');
    return reply.send({ ok: true });
  });

  // --- Connecté ----------------------------------------------------------------------------

  const verifierMdpConnecte = (compteId: string, mdp: string) => verifierMdpConnecteCommun(deps, compteId, mdp);

  app.post<{ Body: { ancien: string; nouveau: string; cleMessagerie?: CleCompte } }>('/mot-de-passe', {
    preHandler: app.exigerSession,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['ancien', 'nouveau'],
        properties: { ancien: texte(512), nouveau: texte(512), cleMessagerie: SCHEMA_CLE_COMPTE },
      },
    },
  }, async (req, reply) => {
    const compte = req.compte!;
    const v = await verifierMdpConnecte(compte.id, req.body.ancien);
    if (v === 'bloque') return reply.code(429).send({ erreur: 'trop_de_demandes' });
    if (v === 'faux') return reply.code(401).send({ erreur: 'mot_de_passe_incorrect' });
    const regle = validerMotDePasse(req.body.nouveau, compte.pseudo, listes.motsDePasseCourants);
    if (!regle.ok) return reply.code(400).send({ erreur: regle.erreur });
    // Clé de messagerie : le navigateur la rechiffre avec le nouveau mot de passe (sinon elle serait perdue).
    if (!req.body.cleMessagerie && (await compteAUneCleMessagerie(deps, compte.id))) {
      return reply.code(400).send({ erreur: 'cle_messagerie_requise' });
    }
    try {
      await changerMotDePasse(deps, compte.id, req.body.nouveau, compte.sessionId, req.body.cleMessagerie);
    } catch (e) {
      if (codeArgos(e) === 'cle_messagerie_differente') return reply.code(400).send({ erreur: 'cle_messagerie_differente' });
      throw e;
    }
    await alerter(deps, req.log, compte.id, 'votre mot de passe a été modifié',
      'Le mot de passe de votre compte a été changé. Vos autres sessions ont été fermées.');
    return reply.send({ ok: true });
  });

  app.post<{ Body: { motDePasse: string } }>('/codes-secours', {
    preHandler: app.exigerSession,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['motDePasse'],
        properties: { motDePasse: texte(512) },
      },
    },
  }, async (req, reply) => {
    const compte = req.compte!;
    const v = await verifierMdpConnecte(compte.id, req.body.motDePasse);
    if (v === 'bloque') return reply.code(429).send({ erreur: 'trop_de_demandes' });
    if (v === 'faux') return reply.code(401).send({ erreur: 'mot_de_passe_incorrect' });
    const codes = await regenererCodes(bases, cles, compte.id);
    await alerter(deps, req.log, compte.id, 'nouveaux codes de secours',
      'De nouveaux codes de secours ont été créés pour votre compte. Les anciens ne fonctionnent plus.');
    return reply.send({ codesSecours: codes });
  });
}
