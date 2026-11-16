// Inscription des relecteurs, en trois appels :
//   POST /inscription/debut  pseudo, mot de passe, téléphone, mail, réponse Turnstile
//   POST /inscription/sms    code reçu par SMS
//   POST /inscription/mail   jeton du lien reçu par mail
// Le compte est créé quand le SMS ET le mail sont confirmés, dans l'ordre que l'on veut.
//
// Aucune donnée personnelle en clair n'est conservée, même temporairement dans Redis :
// le mot de passe est haché tout de suite, le numéro et le mail ne sont gardés que sous forme
// d'empreinte HMAC, le mail en plus chiffré (pour écrire au relecteur), le code SMS et le jeton
// du mail sous forme d'empreinte. Tout expire au bout de 30 minutes.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Dependances } from './app.ts';
import { genererCodes } from './codes.ts';
import { chiffrer, codeSms, egal, empreinte, hacherMotDePasse, jeton } from './crypto.ts';
import { consommer } from './limites.ts';
import { validerMotDePasse } from './motdepasse.ts';
import { normaliserMail, normaliserTelephone, validerPseudo } from './normalisation.ts';
import { codeArgos, texte } from './schemas.ts';
import { signature } from './compte.ts';
import { CONDITIONS_VERSION, VERSION_CONDITIONS } from './conditions.ts';
import { normaliserCodeBeta } from './beta.ts';

const DUREE = 30 * 60;      // durée de vie d'une inscription en cours, en secondes
const ESSAIS_SMS = 5;

const cleInscription = (id: string) => `inscription:${id}`;
const cleMail = (empreinteJeton: string) => `inscription-mail:${empreinteJeton}`;
const clePseudo = (pseudo: string) => `inscription-pseudo:${pseudo.toLowerCase()}`;

interface Debut { pseudo: string; motDePasse: string; telephone: string; mail: string; turnstile: string; conditions: string;
                 codeInvitation?: string }   // code de compte spécial (facultatif) : certifie le compte
interface Sms { inscription: string; code: string }
interface Mail { jeton: string }


export function enregistrerInscription(app: FastifyInstance, deps: Dependances): void {
  const { redis, bases, cles, facteur, turnstile, listes, reglages } = deps;
  const hex = (domaine: string, valeur: string) => empreinte(cles, domaine, valeur).toString('hex');
  const echec = (reply: FastifyReply, code: number, erreur: string, plus: object = {}) =>
    reply.code(code).send({ erreur, ...plus });

  async function supprimer(id: string, donnees: Record<string, string>) {
    const m = redis.multi().del(cleInscription(id));
    if (donnees['jetonMail']) m.del(cleMail(donnees['jetonMail']));
    if (donnees['pseudo']) m.del(clePseudo(donnees['pseudo']));
    await m.exec();
  }

  /** Crée le compte si le SMS et le mail sont confirmés. */
  async function finaliser(id: string, req: FastifyRequest, reply: FastifyReply) {
    const d = await redis.hgetall(cleInscription(id));
    if (!d['pseudo']) {
      await redis.del(cleInscription(id));  // inscription expirée entre-temps : rien ne doit rester
      return echec(reply, 410, 'inscription_expiree');
    }
    if (d['smsOk'] !== '1') return reply.send({ etape: 'attente_sms' });
    if (d['mailOk'] !== '1') return reply.send({ etape: 'attente_mail' });
    // Un seul appel crée le compte, même si les deux confirmations arrivent en même temps.
    if ((await redis.hsetnx(cleInscription(id), 'finalisation', '1')) === 0) return reply.send({ etape: 'en_cours' });
    // Les 10 codes de secours sont créés avec le compte et montrés une seule fois, dans cette réponse.
    const { codes, empreintes } = genererCodes(cles);
    let compte: string;
    try {
      compte = (await bases.identity.query<{ id: string }>(
        'SELECT identity.create_reviewer($1, $2, $3, $4, $5, $6, $7, $8) AS id',
        [d['pseudo'], d['mdp'], Buffer.from(d['tel']!, 'hex'), Buffer.from(d['mailH']!, 'hex'),
         Buffer.from(d['mailEnc']!, 'base64'), empreintes, req.ip, req.socket.remotePort ?? null])).rows[0]!.id;
    } catch (e) {
      await supprimer(id, d);
      const err = e as { code?: string; constraint?: string };
      if (err.code === '23505') {
        return err.constraint === 'accounts_username_ci' ? echec(reply, 409, 'pseudo_pris')
          : echec(reply, 409, 'deja_inscrit', { recuperation: true });
      }
      if (err.code === '42501') return echec(reply, 403, 'refuse');
      throw e;
    }
    // Conditions acceptées au début de l'inscription (version gardée dans Redis jusqu'ici).
    await bases.app.query('SELECT core.accept_terms($1, $2)', [compte, d['conditions'] ?? CONDITIONS_VERSION]);
    // Code de compte spécial : certification et catégorie (null si le code a servi entre-temps à quelqu'un d'autre).
    // Un statut vérifié (journaliste, avocat, association, analyste) exige une double authentification, que le compte
    // n'a pas encore : le code n'est alors pas consommé, il sera saisi dans « Mon compte » une fois celle-ci activée.
    let certification: string | null = null;
    let certificationEnAttente = false;
    if (d['codeCompte']) {
      try {
        certification = (await bases.app.query<{ c: string | null }>('SELECT core.redeem_account_code($1, $2) AS c',
                                                                    [compte, Buffer.from(d['codeCompte'], 'hex')])).rows[0]!.c;
      } catch (e) {
        if (codeArgos(e) !== 'double_auth_requise') throw e;
        certificationEnAttente = true;
      }
    }
    await supprimer(id, d);
    return reply.code(201).send({ compte: 'cree', codesSecours: codes, ...(certification ? { certification } : {}),
                                  ...(certificationEnAttente ? { certificationEnAttente } : {}) });
  }

  app.post<{ Body: Debut }>('/inscription/debut', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['pseudo', 'motDePasse', 'telephone', 'mail', 'turnstile', 'conditions'],
        properties: { pseudo: texte(60), motDePasse: texte(512), telephone: texte(40), mail: texte(254), turnstile: texte(2048),
                      conditions: VERSION_CONDITIONS, codeInvitation: texte(40) },
      },
    },
  }, async (req, reply) => {
    if (req.body.conditions !== CONDITIONS_VERSION) return echec(reply, 409, 'conditions_perimees', { version: CONDITIONS_VERSION });
    if (!(await consommer(redis, `debut:ip:${hex('ip', req.ip)}`, 10, 3600))) return echec(reply, 429, 'trop_de_demandes');
    if (!(await turnstile.verifier(req.body.turnstile))) return echec(reply, 400, 'turnstile');

    const pseudo = validerPseudo(req.body.pseudo, listes.pseudosInterdits);
    if (!pseudo.ok) return echec(reply, 400, pseudo.erreur);
    const mdp = validerMotDePasse(req.body.motDePasse, pseudo.pseudo, listes.motsDePasseCourants);
    if (!mdp.ok) return echec(reply, 400, mdp.erreur);
    const tel = normaliserTelephone(req.body.telephone);
    if (!tel.ok) return echec(reply, 400, tel.erreur);
    const mail = normaliserMail(req.body.mail);
    if (!mail.ok) return echec(reply, 400, mail.erreur);

    // Code de compte spécial : vérifié dès maintenant (sans être consommé), utilisé à la création du compte.
    let codeCompte: string | null = null;
    if (req.body.codeInvitation?.trim()) {
      const c = normaliserCodeBeta(req.body.codeInvitation);
      const h = c ? empreinte(cles, 'code-compte', c) : null;
      const cat = h ? (await bases.app.query<{ c: string | null }>('SELECT core.account_code_category($1) AS c', [h])).rows[0]!.c : null;
      if (!cat) return echec(reply, 400, 'code_invitation_invalide');
      codeCompte = h!.toString('hex');
    }

    const pris = await bases.app.query('SELECT 1 FROM core.accounts WHERE lower(username) = lower($1)', [pseudo.pseudo]);
    if (pris.rowCount) return echec(reply, 409, 'pseudo_pris');

    const telH = empreinte(cles, 'tel', tel.numero);
    const mailH = empreinte(cles, 'mail', mail.canonique);
    // B4 : on ne dit pas ici si ce téléphone ou ce mail est déjà inscrit (sinon n'importe qui pourrait le tester).
    // La réponse ne vient qu'à la fin, une fois le téléphone et le mail confirmés par leurs codes (création du compte).

    // Limites anti-fraude aux SMS : par numéro, puis plafond quotidien pour tout le site.
    if (!(await consommer(redis, `sms:tel:${telH.toString('hex')}`, 3, 24 * 3600))) return echec(reply, 429, 'trop_de_demandes');
    const jour = new Date().toISOString().slice(0, 10);
    if (!(await consommer(redis, `sms:jour:${jour}`, reglages.smsPlafondJour, 2 * 24 * 3600))) {
      return echec(reply, 503, 'sms_indisponible');
    }

    const id = randomUUID();
    // Le pseudo est réservé pendant l'inscription : deux inscriptions simultanées ne peuvent pas le prendre.
    if ((await redis.set(clePseudo(pseudo.pseudo), id, 'EX', DUREE, 'NX')) !== 'OK') return echec(reply, 409, 'pseudo_pris');

    const code = codeSms();
    const lien = jeton();
    const jetonH = hex('jeton-mail', lien);
    await redis.multi()
      .hset(cleInscription(id), {
        pseudo: pseudo.pseudo,
        mdp: await hacherMotDePasse(req.body.motDePasse),
        tel: telH.toString('hex'),
        mailH: mailH.toString('hex'),
        mailEnc: chiffrer(cles, mail.adresse).toString('base64'),
        sms: hex('code-sms', `${id}:${code}`),
        jetonMail: jetonH,
        conditions: CONDITIONS_VERSION,
        ...(codeCompte ? { codeCompte } : {}),
        smsOk: '0', mailOk: '0',
      })
      .expire(cleInscription(id), DUREE)
      .set(cleMail(jetonH), id, 'EX', DUREE)
      .exec();

    try {
      await facteur.sms(tel.numero, `Argos Veille : votre code d'inscription est ${code}. Il expire dans 30 minutes.`);
      await facteur.mail(mail.adresse, 'Argos Veille : confirmez votre adresse',
        `Bonjour,\n\nMerci pour votre inscription sur Argos Veille. Pour confirmer votre adresse, ouvrez ce lien `
        + `dans les 30 minutes :\n\n${reglages.urlPublique}/inscription/mail#${lien}\n\n`
        + `Vous n'avez pas demandé cette inscription ? Ignorez simplement ce message.`
        + signature(deps, 'Vous recevez ce message parce que cette adresse a été indiquée lors d\'une inscription sur Argos Veille.'));
    } catch (e) {
      await supprimer(id, { pseudo: pseudo.pseudo, jetonMail: jetonH });
      req.log.error({ err: e }, "échec de l'envoi du SMS ou du mail d'inscription");
      return echec(reply, 503, 'envoi_impossible');
    }
    return reply.code(201).send({ inscription: id, expireDans: DUREE });
  });

  app.post<{ Body: Sms }>('/inscription/sms', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['inscription', 'code'],
        properties: { inscription: { type: 'string', format: 'uuid' }, code: { type: 'string', pattern: '^[0-9]{6}$' } },
      },
    },
  }, async (req, reply) => {
    if (!(await consommer(redis, `sms-essai:ip:${hex('ip', req.ip)}`, 30, 3600))) return echec(reply, 429, 'trop_de_demandes');
    const id = req.body.inscription;
    const d = await redis.hgetall(cleInscription(id));
    if (!d['sms']) return echec(reply, 410, 'inscription_expiree');
    if (d['smsOk'] !== '1') {
      if (!egal(empreinte(cles, 'code-sms', `${id}:${req.body.code}`), Buffer.from(d['sms'], 'hex'))) {
        const essais = await redis.hincrby(cleInscription(id), 'essais', 1);
        if (essais >= ESSAIS_SMS) {
          await supprimer(id, d);
          return echec(reply, 410, 'trop_d_essais');
        }
        return echec(reply, 400, 'code_faux', { essaisRestants: ESSAIS_SMS - essais });
      }
      await redis.hset(cleInscription(id), 'smsOk', '1');
    }
    return finaliser(id, req, reply);
  });

  app.post<{ Body: Mail }>('/inscription/mail', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['jeton'],
        properties: { jeton: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
      },
    },
  }, async (req, reply) => {
    if (!(await consommer(redis, `mail-essai:ip:${hex('ip', req.ip)}`, 30, 3600))) return echec(reply, 429, 'trop_de_demandes');
    const id = await redis.get(cleMail(hex('jeton-mail', req.body.jeton)));
    if (!id || !(await redis.exists(cleInscription(id)))) return echec(reply, 410, 'lien_expire');
    await redis.hset(cleInscription(id), 'mailOk', '1');
    return finaliser(id, req, reply);
  });
}
