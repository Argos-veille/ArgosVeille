// Messagerie avec les sources (M1, 8 novembre 2026). Chiffrée de bout en bout dans le navigateur
// (navigateur/src/messagerie.ts) : l'API ne voit que des clés publiques, des clés privées chiffrées et des
// messages chiffrés. Elle vérifie qui a le droit d'écrire à qui (la base aussi, par ses déclencheurs) :
//   - un compte vérifié (journaliste, avocat, association) écrit à la source d'une vidéo publiée ou en débat,
//     si la source l'a accepté pour cette vidéo ;
//   - l'administration (session d'administration ouverte) écrit à la source de n'importe quelle vidéo ;
//   - la source répond depuis le suivi (12 mots, ou compte qui a envoyé la vidéo), ferme une conversation
//     (sauf avec l'administration), accepte ou refuse d'être contactée.
// Les clés de compte : créées quand le mot de passe est connu du navigateur (vérifié ici), rechiffrées au
// changement de mot de passe, effacées à sa réinitialisation (anciens messages perdus pour ce compte).
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { Dependances } from './app.ts';
import { aDoubleAuth, ecrire as ecrireMail, verifierMdpConnecte } from './compte.ts';
import { empreinte } from './crypto.ts';
import { consommer } from './limites.ts';
import { codeArgos, texte } from './schemas.ts';

// --- Schémas --------------------------------------------------------------------------------------

const B64 = (min: number, max: number) => ({ type: 'string', minLength: min, maxLength: max, pattern: '^[A-Za-z0-9+/]+={0,2}$' });
const POINT = B64(88, 88);                      // 65 octets
export const SCHEMA_CLE_COMPTE = {
  type: 'object', additionalProperties: false, required: ['publique', 'privee', 'sel', 'iterations'],
  properties: { publique: POINT, privee: B64(40, 700), sel: B64(24, 24), iterations: { type: 'integer', minimum: 100_000, maximum: 5_000_000 } },
} as const;
export const SCELLE = {
  type: 'object', additionalProperties: false, required: ['v', 'epk', 'nonce', 'chiffre'],
  properties: { v: { const: 1 }, epk: POINT, nonce: B64(16, 16), chiffre: B64(40, 700) },
} as const;
export const SCHEMA_CLE_VIDEO = {
  type: 'object', additionalProperties: false, required: ['publique', 'parPhrase'],
  properties: { publique: POINT, parPhrase: B64(40, 700), pourCompte: SCELLE },
} as const;
const SCHEMA_MESSAGE = {
  type: 'object', additionalProperties: false, required: ['v', 'nonce', 'texte', 'destinataires'],
  properties: {
    v: { enum: [1, 2] }, nonce: B64(16, 16), texte: B64(4, 22_000),
    auth: B64(44, 44),   // v2 : preuve de l'expéditeur (HMAC-SHA256, 32 octets), vérifiée par le destinataire seulement
    destinataires: {
      type: 'array', minItems: 2, maxItems: 2,
      items: { type: 'object', additionalProperties: false, required: ['cle', 'epk', 'nonce', 'enveloppe'],
               properties: { cle: { type: 'string', pattern: '^[0-9a-f]{16}$' }, epk: POINT, nonce: B64(16, 16), enveloppe: B64(64, 64) } },
    },
  },
} as const;
const CONVERSATION = { type: 'string', format: 'uuid' };

export interface CleCompte { publique: string; privee: string; sel: string; iterations: number }
export interface CleVideo { publique: string; parPhrase: string; pourCompte?: { v: 1; epk: string; nonce: string; chiffre: string } }
interface Message { v: 1; nonce: string; texte: string; destinataires: { cle: string; epk: string; nonce: string; enveloppe: string }[] }

const STATUTS = ['journalist', 'lawyer', 'association'] as const;
const LIBELLES: Record<string, string> = { journalist: 'Journaliste', lawyer: 'Avocat', association: 'Association', admin: 'Administration d’Argos Veille' };
/** Statuts de vidéo où un compte vérifié peut contacter la source : ceux qui ont une fiche publique. */
const CONTACTABLES = ['published', 'under_debate'];

const b64 = (o: Buffer) => o.toString('base64');
/** Même empreinte que le navigateur (16 premiers caractères hexadécimaux du SHA-256 du point). */
const empreintePoint = (point: Buffer) => createHash('sha256').update(point).digest('hex').slice(0, 16);

/** Le message est-il chiffré pour les deux parties, et seulement pour elles ? */
function pourLesDeux(m: Message, a: Buffer, b: Buffer): boolean {
  const attendues = new Set([empreintePoint(a), empreintePoint(b)]);
  const recues = new Set(m.destinataires.map((d) => d.cle));
  return attendues.size === 2 && recues.size === 2 && [...attendues].every((e) => recues.has(e));
}

// --- Accès communs aux données --------------------------------------------------------------------

/** Statut vérifié actif (journaliste, avocat, association), ou null. */
export async function statutVerifie(deps: Dependances, compteId: string): Promise<string | null> {
  const r = await deps.bases.app.query<{ category: string }>(
    `SELECT category FROM core.verifications WHERE account_id = $1 AND category = ANY($2)
        AND revoked_at IS NULL AND expires_at > now() ORDER BY verified_at DESC LIMIT 1`, [compteId, STATUTS]);
  return r.rows[0]?.category ?? null;
}

async function cleDuCompte(deps: Dependances, compteId: string) {
  const r = await deps.bases.app.query<{ public_key: Buffer; wrapped_private: Buffer; kdf_salt: Buffer; kdf_iterations: number }>(
    'SELECT public_key, wrapped_private, kdf_salt, kdf_iterations FROM core.public_keys WHERE account_id = $1', [compteId]);
  return r.rows[0];
}
const versCleCompte = (k: { public_key: Buffer; wrapped_private: Buffer; kdf_salt: Buffer; kdf_iterations: number }): CleCompte =>
  ({ publique: b64(k.public_key), privee: b64(k.wrapped_private), sel: b64(k.kdf_salt), iterations: k.kdf_iterations });

/** Enregistre la clé de messagerie d'une vidéo (à l'envoi), dans la transaction de l'envoi. */
export async function enregistrerCleVideo(client: PoolClient, pseudonymeId: string, cle: CleVideo): Promise<void> {
  await client.query('INSERT INTO core.public_keys (pseudonym_id, public_key, wrapped_private, owner_wrapped) VALUES ($1, $2, $3, $4)',
    [pseudonymeId, Buffer.from(cle.publique, 'base64'), Buffer.from(cle.parPhrase, 'base64'), cle.pourCompte ? JSON.stringify(cle.pourCompte) : null]);
}

/** Changement de mot de passe : rechiffrée (même point) ou, à la réinitialisation, effacée avec ses enveloppes. */
export async function majCleCompte(client: PoolClient, compteId: string, cle: CleCompte | 'effacer'): Promise<void> {
  if (cle === 'effacer') {
    await client.query('SELECT core.forget_account_message_key($1)', [compteId]);
    return;
  }
  const r = await client.query(
    `UPDATE core.public_keys SET wrapped_private = $3, kdf_salt = $4, kdf_iterations = $5
      WHERE account_id = $1 AND public_key = $2`,
    [compteId, Buffer.from(cle.publique, 'base64'), Buffer.from(cle.privee, 'base64'), Buffer.from(cle.sel, 'base64'), cle.iterations]);
  if (!r.rowCount) throw new Error('argos:cle_messagerie_differente');
}

/** Vidéos du compte (envoi avec compte) ayant des conversations : nombre, non-lus, dernier message. */
export async function conversationsDesVideos(deps: Dependances, session: Buffer) {
  const r = await deps.bases.app.query<{ video_id: string; pseudonym: string; n: number; non_lus: number; dernier: Date }>(
    `SELECT m.video_id, m.pseudonym, count(*)::int AS n,
            count(*) FILTER (WHERE c.last_message_at > coalesce(c.witness_read_at, '-infinity'))::int AS non_lus,
            max(coalesce(c.last_message_at, c.created_at)) AS dernier
       FROM core.my_videos($1) m JOIN core.pseudonyms p ON p.video_id = m.video_id
       JOIN core.conversations c ON c.pseudonym_id = p.id
      GROUP BY m.video_id, m.pseudonym ORDER BY dernier DESC`, [session]);
  return r.rows.map((x) => ({ video: x.video_id, pseudonyme: x.pseudonym, conversations: x.n, nonLus: x.non_lus, dernier: x.dernier.toISOString() }));
}

async function aUneCle(deps: Dependances, compteId: string) {
  return !!(await deps.bases.app.query('SELECT 1 FROM core.public_keys WHERE account_id = $1', [compteId])).rowCount;
}
export { aUneCle as compteAUneCleMessagerie };

interface LigneConversation {
  id: string; with_admin: boolean; closed_at: Date | null; created_at: Date; last_message_at: Date | null;
  witness_read_at: Date | null; verified_read_at: Date | null; pseudonym_id: string; verified_account_id: string;
}

/** Réponse commune : une conversation et ses messages (chiffrés), plus la clé publique de l'autre partie. */
async function detail(deps: Dependances, c: LigneConversation, cote: 'witness' | 'verified') {
  const m = await deps.bases.app.query<{ id: string; sender: string; ciphertext: Buffer; sent_at: Date }>(
    'SELECT id, sender, ciphertext, sent_at FROM core.messages WHERE conversation_id = $1 ORDER BY sent_at, id', [c.id]);
  const autre = cote === 'witness'
    ? await deps.bases.app.query<{ public_key: Buffer }>('SELECT public_key FROM core.public_keys WHERE account_id = $1', [c.verified_account_id])
    : await deps.bases.app.query<{ public_key: Buffer }>('SELECT public_key FROM core.public_keys WHERE pseudonym_id = $1', [c.pseudonym_id]);
  const col = cote === 'witness' ? 'witness_read_at' : 'verified_read_at';
  await deps.bases.app.query(`UPDATE core.conversations SET ${col} = now() WHERE id = $1`, [c.id]);
  const partage = (await deps.bases.app.query<{ p: unknown }>('SELECT core.share_state($1) AS p', [c.id])).rows[0]!.p;
  return {
    id: c.id, admin: c.with_admin, ouverte: !c.closed_at, partage,
    // Clé de l'autre partie : absente si son compte a perdu sa clé (mot de passe réinitialisé, pas encore recréée).
    cleAutre: autre.rows[0] ? b64(autre.rows[0].public_key) : null,
    messages: m.rows.map((x) => ({ id: x.id, de: x.sender, le: x.sent_at.toISOString(), chiffre: JSON.parse(x.ciphertext.toString('utf8')) as Message })),
  };
}

/** Ajoute un message (vérifié chiffré pour les deux parties) ; renvoie l'erreur à afficher, ou null. */
async function ecrire(deps: Dependances, c: LigneConversation, de: 'witness' | 'verified', m: Message): Promise<string | null> {
  if (c.closed_at) return 'conversation_fermee';
  const k = await deps.bases.app.query<{ source: Buffer | null; compte: Buffer | null }>(
    `SELECT (SELECT public_key FROM core.public_keys WHERE pseudonym_id = $1) AS source,
            (SELECT public_key FROM core.public_keys WHERE account_id = $2) AS compte`, [c.pseudonym_id, c.verified_account_id]);
  const { source, compte } = k.rows[0]!;
  if (!source || !compte) return 'cle_absente';
  if (!pourLesDeux(m, source, compte)) return 'message_chiffre_invalide';
  try {
    await deps.bases.app.query('INSERT INTO core.messages (conversation_id, sender, ciphertext) VALUES ($1, $2, $3)',
      [c.id, de, Buffer.from(JSON.stringify(m), 'utf8')]);
  } catch (e) {
    const code = codeArgos(e);
    if (code) return code;
    throw e;
  }
  return null;
}

/** Texte d'un message, avec la clé du message révélée par son destinataire (signalement) : le déchiffrement
 *  authentifié prouve que le texte n'a pas été inventé. null si la clé ne l'ouvre pas. */
export function ouvrirAvecCleRevelee(chiffre: Message, conversation: string, expediteur: string, cleB64: string): string | null {
  try {
    const cle = Buffer.from(cleB64, 'base64');
    if (cle.length !== 32) return null;
    const brut = Buffer.from(chiffre.texte, 'base64');
    const d = createDecipheriv('aes-256-gcm', cle, Buffer.from(chiffre.nonce, 'base64'));
    d.setAAD(Buffer.from(`argos/message/v1|${conversation}|${expediteur}`, 'utf8'));
    d.setAuthTag(brut.subarray(brut.length - 16));
    return Buffer.concat([d.update(brut.subarray(0, brut.length - 16)), d.final()]).toString('utf8');
  } catch { return null; }
}

/** Signale un message REÇU (de l'autre partie) ; avec la clé révélée, le texte est vérifié puis gardé pour l'admin. */
async function signaler(deps: Dependances, reply: FastifyReply, c: LigneConversation, recu: 'witness' | 'verified',
                        messageId: string, cle?: string) {
  const m = await deps.bases.app.query<{ sender: string; ciphertext: Buffer; reported_at: Date | null }>(
    'SELECT sender, ciphertext, reported_at FROM core.messages WHERE id = $1 AND conversation_id = $2', [messageId, c.id]);
  const x = m.rows[0];
  if (!x || x.sender !== recu) return reply.code(404).send({ erreur: 'introuvable' });   // seulement un message reçu
  if (x.reported_at) return reply.code(409).send({ erreur: 'message_deja_signale' });
  let texte: string | null = null;
  if (cle) {
    texte = ouvrirAvecCleRevelee(JSON.parse(x.ciphertext.toString('utf8')) as Message, c.id, x.sender, cle);
    if (texte === null) return reply.code(400).send({ erreur: 'cle_message_invalide' });
  }
  await deps.bases.app.query('UPDATE core.messages SET reported_at = now(), revealed_text = $2 WHERE id = $1', [messageId, texte]);
  return reply.send({ ok: true });
}
const SCHEMA_SIGNALEMENT = { message: { type: 'string', format: 'uuid' }, cle: B64(44, 44) };

const ERREURS_409 = new Set(['conversation_fermee', 'contact_refuse', 'compte_non_verifie', 'video_indisponible',
                             'source_sans_messagerie', 'compte_sans_messagerie', 'cle_absente']);
const repondreErreur = (reply: FastifyReply, code: string) => reply.code(ERREURS_409.has(code) ? 409 : 400).send({ erreur: code });

// --- Côté comptes (clé de compte, comptes vérifiés) ------------------------------------------------

export function enregistrerMessagerie(app: FastifyInstance, deps: Dependances): void {
  const { bases, redis, cles } = deps;
  const hex = (domaine: string, valeur: string) => empreinte(cles, domaine, valeur).toString('hex');
  const session = { preHandler: app.exigerSession };

  // Clé de messagerie du compte (chiffrée par le mot de passe, que le serveur ne peut pas ouvrir).
  app.get('/messagerie/cle', session, async (req, reply) => {
    const k = await cleDuCompte(deps, req.compte!.id);
    return reply.send({ cle: k ? versCleCompte(k) : null });
  });

  // Création : le mot de passe est vérifié ici, pour qu'une faute de frappe ne rende pas la clé inutilisable.
  app.post<{ Body: { motDePasse: string; cle: CleCompte } }>('/messagerie/cle', {
    ...session,
    schema: { body: { type: 'object', additionalProperties: false, required: ['motDePasse', 'cle'],
                      properties: { motDePasse: texte(512), cle: SCHEMA_CLE_COMPTE } } },
  }, async (req, reply) => {
    const v = await verifierMdpConnecte(deps, req.compte!.id, req.body.motDePasse);
    if (v === 'bloque') return reply.code(429).send({ erreur: 'trop_de_demandes' });
    if (v === 'faux') return reply.code(401).send({ erreur: 'mot_de_passe_incorrect' });
    const c = req.body.cle;
    const r = await bases.app.query(
      `INSERT INTO core.public_keys (account_id, public_key, wrapped_private, kdf_salt, kdf_iterations)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (account_id) WHERE account_id IS NOT NULL DO NOTHING`,
      [req.compte!.id, Buffer.from(c.publique, 'base64'), Buffer.from(c.privee, 'base64'), Buffer.from(c.sel, 'base64'), c.iterations]);
    if (!r.rowCount) return reply.code(409).send({ erreur: 'cle_existante' });
    return reply.send({ ok: true });
  });

  // Source qui a envoyé avec son compte : les conversations reçues au sujet de ses vidéos (pour la page « Messages » ;
  // elles se lisent dans le suivi de chaque vidéo).
  app.get('/compte/messagerie-videos', session, async (req, reply) => {
    return reply.send({ videos: await conversationsDesVideos(deps, req.compte!.session) });
  });

  /** Compte vérifié actif ; sinon répond 403. */
  async function exigerVerifie(req: FastifyRequest, reply: FastifyReply) {
    await app.exigerSession(req, reply);
    if (reply.sent) return reply;
    const s = await statutVerifie(deps, req.compte!.id);
    if (!s) return reply.code(403).send({ erreur: 'compte_non_verifie' });
    if (!(await aDoubleAuth(deps, req.compte!.id))) return reply.code(403).send({ erreur: 'double_auth_requise' });
    (req as FastifyRequest & { statut?: string }).statut = s;
  }
  const verifie = { preHandler: exigerVerifie };

  /** Conversation d'un compte (vérifié ou admin) ; l'admin ne la lit que par l'instance d'administration. */
  async function conversationDuCompte(req: FastifyRequest, reply: FastifyReply, id: string): Promise<LigneConversation | null> {
    const r = await bases.app.query<LigneConversation>(
      'SELECT * FROM core.conversations WHERE id = $1 AND verified_account_id = $2', [id, req.compte!.id]);
    const c = r.rows[0];
    if (!c || c.with_admin) { reply.code(404).send({ erreur: 'introuvable' }); return null; }
    return c;
  }

  // Liste des conversations du compte vérifié.
  app.get('/messagerie', verifie, async (req, reply) => {
    const r = await bases.app.query<{ id: string; video_id: string; pseudonym: string; closed_at: Date | null;
                                      last_message_at: Date | null; verified_read_at: Date | null; created_at: Date }>(
      `SELECT c.id, p.video_id, p.pseudonym, c.closed_at, c.last_message_at, c.verified_read_at, c.created_at
         FROM core.conversations c JOIN core.pseudonyms p ON p.id = c.pseudonym_id
        WHERE c.verified_account_id = $1 AND NOT c.with_admin
        ORDER BY coalesce(c.last_message_at, c.created_at) DESC LIMIT 200`, [req.compte!.id]);
    return reply.send({
      conversations: r.rows.map((c) => ({
        id: c.id, video: c.video_id, pseudonyme: c.pseudonym, ouverte: !c.closed_at,
        dernier: (c.last_message_at ?? c.created_at).toISOString(),
        nonLu: !!c.last_message_at && c.last_message_at > (c.verified_read_at ?? new Date(0)),
      })),
    });
  });

  // Fiche publique : le compte vérifié peut-il contacter la source ? (conversation existante, le cas échéant)
  app.get<{ Params: { id: string } }>('/messagerie/videos/:id', {
    ...verifie, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req, reply) => {
    const r = await bases.app.query<{ contact_allowed: boolean; conversation: string | null }>(
      `SELECT p.contact_allowed,
              (SELECT c.id FROM core.conversations c WHERE c.pseudonym_id = p.id AND c.verified_account_id = $2 AND NOT c.with_admin) AS conversation
         FROM core.pseudonyms p JOIN core.videos v ON v.id = p.video_id
        WHERE p.video_id = $1 AND v.status = ANY($3) AND NOT v.is_control
          AND EXISTS (SELECT 1 FROM core.public_keys k WHERE k.pseudonym_id = p.id)`, [req.params.id, req.compte!.id, CONTACTABLES]);
    const x = r.rows[0];
    return reply.send({ possible: !!x?.contact_allowed, conversation: x?.conversation ?? null, cle: await aUneCle(deps, req.compte!.id) });
  });

  // Ouvrir (ou retrouver) la conversation avec la source d'une vidéo, et y écrire le premier message.
  app.post<{ Params: { id: string } }>('/messagerie/videos/:id', {
    ...verifie, schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } },
  }, async (req, reply) => {
    const p = await bases.app.query<{ id: string; public_key: Buffer }>(
      `SELECT p.id, k.public_key FROM core.pseudonyms p JOIN core.videos v ON v.id = p.video_id
         JOIN core.public_keys k ON k.pseudonym_id = p.id
        WHERE p.video_id = $1 AND v.status = ANY($2) AND NOT v.is_control AND p.contact_allowed`, [req.params.id, CONTACTABLES]);
    if (!p.rows[0]) return reply.code(409).send({ erreur: 'contact_refuse' });
    const deja = await bases.app.query<{ id: string }>(
      'SELECT id FROM core.conversations WHERE pseudonym_id = $1 AND verified_account_id = $2', [p.rows[0].id, req.compte!.id]);
    if (deja.rows[0]) return reply.send({ conversation: deja.rows[0].id, cleSource: b64(p.rows[0].public_key) });
    if (!(await consommer(redis, `messagerie:nouvelles:${hex('compte', req.compte!.id)}`, 10, 86_400))) {
      return reply.code(429).send({ erreur: 'trop_de_conversations' });
    }
    try {
      const c = await bases.app.query<{ id: string }>(
        'INSERT INTO core.conversations (pseudonym_id, verified_account_id) VALUES ($1, $2) RETURNING id', [p.rows[0].id, req.compte!.id]);
      return reply.send({ conversation: c.rows[0]!.id, cleSource: b64(p.rows[0].public_key) });
    } catch (e) {
      const code = codeArgos(e);
      if (code) return repondreErreur(reply, code);
      throw e;
    }
  });

  app.get<{ Params: { conversation: string } }>('/messagerie/:conversation', {
    ...verifie, schema: { params: { type: 'object', required: ['conversation'], properties: { conversation: CONVERSATION } } },
  }, async (req, reply) => {
    const c = await conversationDuCompte(req, reply, req.params.conversation);
    if (!c) return reply;
    const p = await bases.app.query<{ video_id: string; pseudonym: string }>('SELECT video_id, pseudonym FROM core.pseudonyms WHERE id = $1', [c.pseudonym_id]);
    return reply.send({ ...(await detail(deps, c, 'verified')), video: p.rows[0]!.video_id, pseudonyme: p.rows[0]!.pseudonym });
  });

  app.post<{ Params: { conversation: string }; Body: { message: Message } }>('/messagerie/:conversation', {
    ...verifie,
    schema: { params: { type: 'object', required: ['conversation'], properties: { conversation: CONVERSATION } },
              body: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: SCHEMA_MESSAGE } } },
  }, async (req, reply) => {
    const c = await conversationDuCompte(req, reply, req.params.conversation);
    if (!c) return reply;
    if (!(await consommer(redis, `messagerie:envois:${hex('compte', req.compte!.id)}`, 100, 86_400))) {
      return reply.code(429).send({ erreur: 'trop_de_messages' });
    }
    const err = await ecrire(deps, c, 'verified', req.body.message);
    return err ? repondreErreur(reply, err) : reply.send({ ok: true });
  });

  app.post<{ Params: { conversation: string }; Body: { message: string; cle?: string } }>('/messagerie/:conversation/signaler', {
    ...verifie,
    schema: { params: { type: 'object', required: ['conversation'], properties: { conversation: CONVERSATION } },
              body: { type: 'object', additionalProperties: false, required: ['message'], properties: SCHEMA_SIGNALEMENT } },
  }, async (req, reply) => {
    const c = await conversationDuCompte(req, reply, req.params.conversation);
    if (!c) return reply;
    return signaler(deps, reply, c, 'witness', req.body.message, req.body.cle);
  });

  // L'original partagé par la source : enveloppe (ouverte par le navigateur), empreinte, lien de téléchargement
  // (10 minutes) du fichier CHIFFRÉ. Le premier appel inscrit la transmission (journal public, vidéo).
  app.post<{ Params: { conversation: string } }>('/messagerie/:conversation/original', {
    ...verifie, schema: { params: { type: 'object', required: ['conversation'], properties: { conversation: CONVERSATION } } },
  }, async (req, reply) => {
    let x: { envelope: unknown; video_id: string; original_sha256: string } | undefined;
    try {
      x = (await bases.app.query<{ envelope: unknown; video_id: string; original_sha256: string }>(
        'SELECT * FROM core.take_share($1, $2)', [req.compte!.id, req.params.conversation])).rows[0];
    } catch (e) {
      const code = codeArgos(e);
      if (code === 'introuvable' || code === 'pas_de_partage') return reply.code(404).send({ erreur: code });
      if (code) return repondreErreur(reply, code);
      throw e;
    }
    const lien = randomBytes(32).toString('base64url');
    await redis.set(`original-partage:${hex('original-partage', lien)}`, x!.video_id, 'EX', 600);
    return reply.send({ enveloppe: x!.envelope, sha256Original: x!.original_sha256, lien: `/messagerie/original/${lien}` });
  });

  // Le fichier chiffré lui-même (même origine : le navigateur le lit pour le déchiffrer). Depuis R2 : relayé.
  app.get<{ Params: { lien: string } }>('/messagerie/original/:lien', {
    ...verifie,
    schema: { params: { type: 'object', additionalProperties: false, required: ['lien'], properties: { lien: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } } } },
  }, async (req, reply) => {
    const id = await redis.get(`original-partage:${hex('original-partage', req.params.lien)}`);
    if (!id) return reply.code(404).send({ erreur: 'lien_expire' });
    reply.header('content-type', 'application/octet-stream').header('cache-control', 'no-store');
    const distant = deps.stockage.lienOriginal?.(id, 600);
    if (distant) {
      const r = await fetch(distant);
      if (!r.ok || !r.body) return reply.code(502).send({ erreur: 'stockage_indisponible' });
      const taille = r.headers.get('content-length');
      if (taille) reply.header('content-length', taille);
      return reply.send(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream));
    }
    const chemin = (deps.stockage as unknown as { chemin(e: string, id: string): string }).chemin('originaux', id);
    let taille: number;
    try { taille = (await stat(chemin)).size; } catch { return reply.code(404).send({ erreur: 'introuvable' }); }
    return reply.header('content-length', taille).send(createReadStream(chemin));
  });

  app.post<{ Params: { conversation: string } }>('/messagerie/:conversation/fermer', {
    ...verifie, schema: { params: { type: 'object', required: ['conversation'], properties: { conversation: CONVERSATION } } },
  }, async (req, reply) => {
    const c = await conversationDuCompte(req, reply, req.params.conversation);
    if (!c) return reply;
    if (!c.closed_at) await bases.app.query('UPDATE core.conversations SET closed_at = now() WHERE id = $1', [c.id]);
    return reply.send({ ok: true });
  });
}

// --- Côté administration (instance d'administration, session ouverte par la clé physique) ---------

export function enregistrerMessagerieAdmin(app: FastifyInstance, deps: Dependances,
                                           exigerAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): void {
  const { bases } = deps;
  const admin = { preHandler: exigerAdmin };
  const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };

  async function conversationAdmin(req: FastifyRequest, reply: FastifyReply, id: string): Promise<LigneConversation | null> {
    const r = await bases.app.query<LigneConversation>(
      'SELECT * FROM core.conversations WHERE id = $1 AND verified_account_id = $2 AND with_admin', [id, req.compte!.id]);
    if (!r.rows[0]) { reply.code(404).send({ erreur: 'introuvable' }); return null; }
    return r.rows[0];
  }

  // Messages signalés (texte seulement s'il a été révélé, vérifié), à traiter ; fermer la conversation au besoin.
  app.get('/admin/messages-signales', admin, async (req, reply) => {
    const r = await bases.app.query<{ r: unknown }>('SELECT core.admin_reported_messages($1) AS r', [req.compte!.id]);
    return reply.send({ messages: r.rows[0]!.r });
  });
  app.post<{ Params: { id: string }; Body: { fermer: boolean } }>('/admin/messages-signales/:id/traiter', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['fermer'], properties: { fermer: { type: 'boolean' } } } },
  }, async (req, reply) => {
    try {
      await bases.app.query('SELECT core.admin_handle_reported_message($1, $2, $3)', [req.compte!.id, req.params.id, req.body.fermer]);
    } catch (e) {
      if (codeArgos(e) === 'introuvable') return reply.code(404).send({ erreur: 'introuvable' });
      throw e;
    }
    return reply.send({ ok: true });
  });

  app.get('/admin/messagerie', admin, async (req, reply) => {
    const r = await bases.app.query<{ id: string; video_id: string; pseudonym: string; last_message_at: Date | null;
                                      verified_read_at: Date | null; created_at: Date; closed_at: Date | null }>(
      `SELECT c.id, p.video_id, p.pseudonym, c.last_message_at, c.verified_read_at, c.created_at, c.closed_at
         FROM core.conversations c JOIN core.pseudonyms p ON p.id = c.pseudonym_id
        WHERE c.verified_account_id = $1 AND c.with_admin
        ORDER BY coalesce(c.last_message_at, c.created_at) DESC LIMIT 200`, [req.compte!.id]);
    return reply.send({
      cle: await aUneCle(deps, req.compte!.id),
      conversations: r.rows.map((c) => ({
        id: c.id, video: c.video_id, pseudonyme: c.pseudonym, ouverte: !c.closed_at,
        dernier: (c.last_message_at ?? c.created_at).toISOString(),
        nonLu: !!c.last_message_at && c.last_message_at > (c.verified_read_at ?? new Date(0)),
      })),
    });
  });

  // Ouvrir (ou retrouver) la conversation de l'administration avec la source d'une vidéo.
  app.post<{ Params: { id: string } }>('/admin/videos/:id/messagerie', { ...admin, schema: { params: ID } }, async (req, reply) => {
    const p = await bases.app.query<{ id: string; public_key: Buffer | null }>(
      `SELECT p.id, (SELECT k.public_key FROM core.public_keys k WHERE k.pseudonym_id = p.id) AS public_key
         FROM core.pseudonyms p WHERE p.video_id = $1`, [req.params.id]);
    if (!p.rows[0]) return reply.code(404).send({ erreur: 'introuvable' });
    if (!p.rows[0].public_key) return reply.code(409).send({ erreur: 'source_sans_messagerie' });
    const deja = await bases.app.query<{ id: string }>(
      'SELECT id FROM core.conversations WHERE pseudonym_id = $1 AND verified_account_id = $2', [p.rows[0].id, req.compte!.id]);
    if (deja.rows[0]) return reply.send({ conversation: deja.rows[0].id, cleSource: b64(p.rows[0].public_key) });
    try {
      const c = await bases.app.query<{ id: string }>(
        'INSERT INTO core.conversations (pseudonym_id, verified_account_id, with_admin) VALUES ($1, $2, true) RETURNING id',
        [p.rows[0].id, req.compte!.id]);
      return reply.send({ conversation: c.rows[0]!.id, cleSource: b64(p.rows[0].public_key) });
    } catch (e) {
      const code = codeArgos(e);
      if (code) return repondreErreur(reply, code);
      throw e;
    }
  });

  app.get<{ Params: { id: string } }>('/admin/messagerie/:id', { ...admin, schema: { params: ID } }, async (req, reply) => {
    const c = await conversationAdmin(req, reply, req.params.id);
    if (!c) return reply;
    const p = await bases.app.query<{ video_id: string; pseudonym: string }>('SELECT video_id, pseudonym FROM core.pseudonyms WHERE id = $1', [c.pseudonym_id]);
    return reply.send({ ...(await detail(deps, c, 'verified')), video: p.rows[0]!.video_id, pseudonyme: p.rows[0]!.pseudonym });
  });

  app.post<{ Params: { id: string }; Body: { message: Message } }>('/admin/messagerie/:id', {
    ...admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: SCHEMA_MESSAGE } } },
  }, async (req, reply) => {
    const c = await conversationAdmin(req, reply, req.params.id);
    if (!c) return reply;
    const err = await ecrire(deps, c, 'verified', req.body.message);
    return err ? repondreErreur(reply, err) : reply.send({ ok: true });
  });
}

// --- Côté source (depuis le suivi : 12 mots, ou compte qui a envoyé la vidéo) ----------------------

type Cible = { jeton?: string; video?: string };
type Ciblee = { v: { video_id: string }; hash: Buffer; compte: string | null };

export function enregistrerMessagerieSource(app: FastifyInstance, deps: Dependances, outils: {
  cibler: (req: FastifyRequest, reply: FastifyReply, corps: Cible) => Promise<Ciblee | null>;
  limiter: (ip: string) => Promise<boolean>;
  JETON: object; VIDEO: object; UN_DES_DEUX: object;
}): void {
  const { bases, redis } = deps;
  const { cibler, limiter, JETON, VIDEO, UN_DES_DEUX } = outils;
  const corps = (extra: Record<string, object> = {}, requis: string[] = []) => ({
    body: { type: 'object', additionalProperties: false, ...UN_DES_DEUX, required: requis, properties: { jeton: JETON, video: VIDEO, ...extra } },
  });

  async function pseudonyme(req: FastifyRequest, reply: FastifyReply, cible: Cible) {
    if (!(await limiter(req.ip))) { reply.code(429).send({ erreur: 'trop_de_demandes' }); return null; }
    const c = await cibler(req, reply, cible);
    if (!c) return null;
    const p = await bases.app.query<{ id: string; contact_allowed: boolean }>(
      'SELECT id, contact_allowed FROM core.pseudonyms WHERE video_id = $1', [c.v.video_id]);
    return { ...c, pseudonymeId: p.rows[0]!.id, contact: p.rows[0]!.contact_allowed };
  }
  async function conversationSource(reply: FastifyReply, pseudonymeId: string, id: string): Promise<LigneConversation | null> {
    const r = await bases.app.query<LigneConversation>('SELECT * FROM core.conversations WHERE id = $1 AND pseudonym_id = $2', [id, pseudonymeId]);
    if (!r.rows[0]) { reply.code(404).send({ erreur: 'introuvable' }); return null; }
    return r.rows[0];
  }

  // État de la messagerie de la vidéo : accord, clé (chiffrée), conversations.
  app.post<{ Body: Cible }>('/suivi/messagerie', { schema: corps() }, async (req, reply) => {
    const s = await pseudonyme(req, reply, req.body);
    if (!s) return reply;
    const k = await bases.app.query<{ public_key: Buffer; wrapped_private: Buffer; owner_wrapped: CleVideo['pourCompte'] | null }>(
      'SELECT public_key, wrapped_private, owner_wrapped FROM core.public_keys WHERE pseudonym_id = $1', [s.pseudonymeId]);
    const c = await bases.app.query<{ id: string; with_admin: boolean; closed_at: Date | null; created_at: Date;
                                      last_message_at: Date | null; witness_read_at: Date | null; verified_account_id: string }>(
      `SELECT id, with_admin, closed_at, created_at, last_message_at, witness_read_at, verified_account_id
         FROM core.conversations WHERE pseudonym_id = $1 ORDER BY coalesce(last_message_at, created_at) DESC`, [s.pseudonymeId]);
    const conversations = [];
    for (const x of c.rows) {
      const statut = x.with_admin ? 'admin' : await statutVerifie(deps, x.verified_account_id);
      const pseudo = x.with_admin ? null
        : (await bases.app.query<{ username: string }>('SELECT username FROM core.accounts WHERE id = $1', [x.verified_account_id])).rows[0]?.username;
      conversations.push({
        id: x.id, admin: x.with_admin, ouverte: !x.closed_at, avec: { statut, libelle: LIBELLES[statut ?? ''] ?? 'Compte qui n’est plus vérifié', pseudo },
        dernier: (x.last_message_at ?? x.created_at).toISOString(),
        nonLu: !!x.last_message_at && x.last_message_at > (x.witness_read_at ?? new Date(0)),
      });
    }
    const cle = k.rows[0];
    const sha = (await bases.app.query<{ h: string | null }>(
      "SELECT encode(original_sha256, 'hex') AS h FROM core.videos WHERE id = $1", [s.v.video_id])).rows[0]?.h ?? null;
    return reply.send({
      contact: s.contact,
      sha256Original: sha,   // pour lier le partage de l'original à CE fichier
      cle: cle ? { publique: b64(cle.public_key), parPhrase: b64(cle.wrapped_private),
                   ...(s.compte && cle.owner_wrapped ? { pourCompte: cle.owner_wrapped } : {}) } : null,
      conversations,
    });
  });

  app.post<{ Body: Cible & { autoriser: boolean } }>('/suivi/messagerie/contact', {
    schema: corps({ autoriser: { type: 'boolean' } }, ['autoriser']),
  }, async (req, reply) => {
    const s = await pseudonyme(req, reply, req.body);
    if (!s) return reply;
    await bases.app.query('UPDATE core.pseudonyms SET contact_allowed = $2 WHERE id = $1', [s.pseudonymeId, req.body.autoriser]);
    return reply.send({ contact: req.body.autoriser });
  });

  app.post<{ Body: Cible & { conversation: string } }>('/suivi/messagerie/lire', {
    schema: corps({ conversation: CONVERSATION }, ['conversation']),
  }, async (req, reply) => {
    const s = await pseudonyme(req, reply, req.body);
    if (!s) return reply;
    const c = await conversationSource(reply, s.pseudonymeId, req.body.conversation);
    if (!c) return reply;
    return reply.send(await detail(deps, c, 'witness'));
  });

  app.post<{ Body: Cible & { conversation: string; message: Message } }>('/suivi/messagerie/ecrire', {
    schema: corps({ conversation: CONVERSATION, message: SCHEMA_MESSAGE }, ['conversation', 'message']),
  }, async (req, reply) => {
    const s = await pseudonyme(req, reply, req.body);
    if (!s) return reply;
    const c = await conversationSource(reply, s.pseudonymeId, req.body.conversation);
    if (!c) return reply;
    if (!(await consommer(redis, `messagerie:source:${c.id}`, 60, 3600))) return reply.code(429).send({ erreur: 'trop_de_messages' });
    const err = await ecrire(deps, c, 'witness', req.body.message);
    return err ? repondreErreur(reply, err) : reply.send({ ok: true });
  });

  app.post<{ Body: Cible & { conversation: string; message: string; cle?: string } }>('/suivi/messagerie/signaler', {
    schema: corps({ conversation: CONVERSATION, ...SCHEMA_SIGNALEMENT }, ['conversation', 'message']),
  }, async (req, reply) => {
    const s = await pseudonyme(req, reply, req.body);
    if (!s) return reply;
    const c = await conversationSource(reply, s.pseudonymeId, req.body.conversation);
    if (!c) return reply;
    return signaler(deps, reply, c, 'verified', req.body.message, req.body.cle);
  });

  // Transmettre l'original à ce compte vérifié : clé de l'original chiffrée par le navigateur de la source.
  app.post<{ Body: Cible & { conversation: string; enveloppe: object } }>('/suivi/messagerie/partager', {
    schema: corps({ conversation: CONVERSATION, enveloppe: SCELLE }, ['conversation', 'enveloppe']),
  }, async (req, reply) => {
    const s = await pseudonyme(req, reply, req.body);
    if (!s) return reply;
    const c = await conversationSource(reply, s.pseudonymeId, req.body.conversation);
    if (!c) return reply;
    try {
      await bases.app.query('SELECT core.share_original($1, $2)', [c.id, JSON.stringify(req.body.enveloppe)]);
    } catch (e) {
      const code = codeArgos(e);
      if (code) return repondreErreur(reply, code);
      throw e;
    }
    return reply.send({ ok: true });
  });

  app.post<{ Body: Cible & { conversation: string } }>('/suivi/messagerie/partage/retirer', {
    schema: corps({ conversation: CONVERSATION }, ['conversation']),
  }, async (req, reply) => {
    const s = await pseudonyme(req, reply, req.body);
    if (!s) return reply;
    const c = await conversationSource(reply, s.pseudonymeId, req.body.conversation);
    if (!c) return reply;
    const r = await bases.app.query<{ ok: boolean }>('SELECT core.revoke_share($1) AS ok', [c.id]);
    return r.rows[0]!.ok ? reply.send({ ok: true }) : reply.code(409).send({ erreur: 'deja_telecharge' });
  });

  app.post<{ Body: Cible & { conversation: string } }>('/suivi/messagerie/fermer', {
    schema: corps({ conversation: CONVERSATION }, ['conversation']),
  }, async (req, reply) => {
    const s = await pseudonyme(req, reply, req.body);
    if (!s) return reply;
    const c = await conversationSource(reply, s.pseudonymeId, req.body.conversation);
    if (!c) return reply;
    if (c.with_admin) return reply.code(409).send({ erreur: 'conversation_admin' });
    if (!c.closed_at) await bases.app.query('UPDATE core.conversations SET closed_at = now() WHERE id = $1', [c.id]);
    return reply.send({ ok: true });
  });
}

/** Tâche fréquente : mail sans contenu, au plus un par jour, aux sources (envoi avec compte) qui ont un message et aux
 *  comptes vérifiés à qui une source a répondu. Aucun mail pour un envoi anonyme. */
export async function prevenirMessages(deps: Dependances): Promise<number> {
  const r = await deps.bases.app.query<{ account_id: string; kind: 'source' | 'verifie' }>('SELECT * FROM core.take_message_notifications()');
  let n = 0;
  for (const x of r.rows) {
    const [sujet, texte] = x.kind === 'source'
      ? ['un message vous attend', `Bonjour,\n\nVous avez reçu un message au sujet d’une vidéo envoyée avec votre compte. Pour le lire, `
         + `connectez-vous, puis ouvrez Messages :\n${deps.reglages.urlPublique}/compte/messages\n\nVous pouvez couper ces mails dans votre compte.`]
      : ['une source vous a répondu', `Bonjour,\n\nUne source vous a répondu. Pour lire sa réponse, connectez-vous, puis ouvrez `
         + `Messages :\n${deps.reglages.urlPublique}/compte/messages\n\nVous pouvez couper ces mails dans votre compte.`];
    if (await ecrireMail(deps, x.account_id, sujet, texte).catch(() => false)) n++;
  }
  return n;
}
