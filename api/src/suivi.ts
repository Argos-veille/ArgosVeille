// Page de suivi de la source (étape 5c). La source n'a ni compte ni cookie : son navigateur dérive le
// jeton de suivi de la phrase de 12 mots et l'envoie dans le CORPS de la requête (jamais dans
// l'adresse, qui finit dans les historiques et les journaux).
//   POST /suivi           jeton → pseudonyme, état, dates (jamais les votes ni les scores)
//   POST /suivi/retirer   jeton + pseudonyme retapé → retrait irréversible de la vidéo
// Vérification du floutage par la source (étape 6c), tant que la vidéo est « à vérifier » :
//   POST /suivi/apercu    jeton → lien de visionnage valable 10 minutes (GET /apercu/:lien)
//   POST /suivi/masques   jeton → pistes des visages floutés, et la dernière retouche appliquée
//   POST /suivi/retoucher jeton + clé de copie + flous retirés + zones ajoutées → nouveau rendu (10 fois au plus)
//   POST /suivi/valider   jeton → la vidéo part en relecture ; la copie de travail est effacée
// Sans réponse de la source au bout de 7 jours (au moins 24 h après la dernière retouche), la vidéo
// part en relecture d'elle-même.
// Vidéo envoyée avec un compte (« Mes vidéos ») : les mêmes routes, avec { video } au lieu de { jeton }
// et la session du compte ; la base retrouve l'empreinte du code de suivi. Le retrait demande alors le
// mot de passe (+ second facteur si actif) au lieu du pseudonyme retapé.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Dependances } from './app.ts';
import { chiffrer, dechiffrer, egal, empreinte } from './crypto.ts';
import { enregistrerMessagerieSource, SCELLE } from './messagerie.ts';
import { verifierIdentite } from './mfa.ts';
import { ecrire } from './compte.ts';
import { lireSession } from './sessions.ts';
import { SCHEMA_REPONSE_CLE } from './webauthn.ts';
import { enveloppeValable, SCHEMA_ENVELOPPE, type Enveloppe } from './transmission.ts';
import { cleCopie as cleRedisCopie, cleOriginal } from './envois.ts';
import { consommer } from './limites.ts';
import { codeArgos, texte } from './schemas.ts';

const JETON = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const VIDEO = { type: 'string', format: 'uuid' };
/** Le code de suivi (envoi anonyme) OU la vidéo d'un compte connecté, jamais les deux. */
const UN_DES_DEUX = { oneOf: [{ required: ['jeton'] }, { required: ['video'] }] };
const CORPS_JETON = { type: 'object', additionalProperties: false, properties: { jeton: JETON, video: VIDEO }, ...UN_DES_DEUX } as const;
interface Cible { jeton?: string; video?: string }
export const DELAI_VERIFICATION_JOURS = 7;   // l'échéance elle-même est calculée par la base (review_deadline)
export const RETOUCHES_MAX = 10;
const DUREE_LIEN = 600;   // secondes
/** États où la version floutée existe et peut être revue par sa source. */
const RECT = { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number', minimum: 0, maximum: 1 } };
const ZONES_MAX = 500;
/** Une zone ajoutée par la source : rectangle au début et à la fin (relatifs à l'image), le flou glisse de l'un à l'autre. */
interface Zone { debut: number; fin: number; de: number[]; a: number[] }
const rectangleValable = (r: number[]) => {
  const [x, y, l, h] = r as [number, number, number, number];
  return l >= 0.01 && h >= 0.01 && x + l <= 1.000001 && y + h <= 1.000001;
};
const VISIBLES = new Set(['awaiting_author', 'in_review', 'jury', 'published', 'rejected', 'under_debate', 'no_decision', 'awaiting_osint']);

/** En-tête Range (une seule plage d'octets) → bornes incluses ; null = fichier entier ; 'invalide' = 416. */
export function plage(entete: string | undefined, taille: number): { debut: number; fin: number } | null | 'invalide' {
  if (entete === undefined) return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(entete.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalide';
  let debut: number, fin: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalide';
    debut = Math.max(0, taille - n); fin = taille - 1;
  } else {
    debut = Number(m[1]);
    fin = m[2] === '' ? taille - 1 : Math.min(Number(m[2]), taille - 1);
  }
  return debut >= taille || debut > fin ? 'invalide' : { debut, fin };
}

/** États montrés à la source : une clé stable (pour l'interface) et un libellé. */
export const ETATS: Record<string, { cle: string; libelle: string }> = {
  uploading: { cle: 'envoi_en_cours', libelle: 'Envoi en cours' },
  processing: { cle: 'floutage_en_cours', libelle: 'Floutage en cours' },
  failed: { cle: 'echec', libelle: 'Échec du traitement' },
  awaiting_author: { cle: 'a_verifier', libelle: 'À vérifier par vous' },
  in_review: { cle: 'en_relecture', libelle: 'En relecture' },
  jury: { cle: 'devant_le_jury', libelle: 'Devant le jury' },
  awaiting_osint: { cle: 'en_attente_analyse', libelle: 'Validée, lieu ou date à établir' },
  published: { cle: 'publiee', libelle: 'Publiée' },
  rejected: { cle: 'rejetee', libelle: 'Rejetée' },
  under_debate: { cle: 'en_debat', libelle: 'En débat' },
  no_decision: { cle: 'sans_decision', libelle: 'Sans décision' },
  hidden: { cle: 'masquee', libelle: 'Masquée pour motif légal' },
  removed: { cle: 'retiree_motif_legal', libelle: 'Retirée pour motif légal' },
  withdrawn: { cle: 'retiree', libelle: 'Retirée par vous' },
};

/** Raisons d'un échec, expliquées à la source (qui peut renvoyer sa vidéo). */
export const ECHECS: Record<string, string> = {
  not_a_video: "Le fichier envoyé n'est pas une vidéo.",
  unsupported_format: "Le format de cette vidéo n'est pas pris en charge.",
  too_long: 'La vidéo dépasse 20 minutes.',
  too_large: "L'image de la vidéo est trop grande (plus de 4K).",
  unreadable: 'La vidéo est illisible ou abîmée.',
  fetch_failed: "La vidéo n'a pas pu être récupérée depuis ce lien. Ouvrez-le, copiez l'adresse complète de la vidéo et réessayez, ou envoyez le fichier.",
  processing_error: "Le traitement a échoué plusieurs fois. Vous pouvez renvoyer la vidéo.",
};

/** Comparaison tolérante du pseudonyme retapé : majuscules, accents et espaces indifférents. */
const simplifier = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, '');

/** Lien de visionnage de la version floutée, valable 10 minutes. Redis ne garde que son empreinte. */
export async function creerLien(deps: Dependances, videoId: string, qualite: 'apercu' | 'complete') {
  const lien = randomBytes(32).toString('base64url');
  const fichier = qualite === 'complete' ? 'video.mp4' : 'apercu.mp4';
  await deps.redis.set(`apercu:${empreinte(deps.cles, 'apercu', lien).toString('hex')}`, `${videoId}|${fichier}`, 'EX', DUREE_LIEN);
  return { lien: `/apercu/${lien}`, expireDans: DUREE_LIEN };
}

export function enregistrerSuivi(app: FastifyInstance, deps: Dependances): void {
  const { bases, redis, cles, stockage } = deps;
  const hex = (domaine: string, valeur: string) => empreinte(cles, domaine, valeur).toString('hex');
  const empreinteJeton = (jeton: string) => createHash('sha256').update(Buffer.from(jeton, 'base64url')).digest();

  async function lire(hash: Buffer) {
    const r = await bases.app.query<{ video_id: string; pseudonym: string; status: string; submitted_at: Date;
                                      decided_at: Date | null; withdrawn_at: Date | null;
                                      processing_progress: number | null; failure_reason: string | null;
                                      review_deadline: Date | null; retouches: number; sha256: string | null }>(
      `SELECT p.video_id, p.pseudonym, v.status, v.submitted_at, v.decided_at, v.withdrawn_at,
              v.processing_progress, v.failure_reason, v.review_deadline, v.retouches,
              encode(v.original_sha256, 'hex') AS sha256
         FROM core.pseudonyms p JOIN core.videos v ON v.id = p.video_id
        WHERE p.tracking_code_hash = $1`, [hash]);
    return r.rows[0];
  }
  // Deviner un code de suivi au hasard est hors de portée (256 bits), mais on freine quand même les
  // essais : 30 codes REFUSÉS par heure et par adresse. Avec le bon code, la limite est large (la page
  // de suivi s'actualise pendant le floutage) : 600 requêtes par heure.
  const ECHECS_MAX = 30;
  const cleEchecs = (ip: string) => `limite:suivi-echec:ip:${hex('ip', ip)}`;
  const limiter = async (ip: string) =>
    Number(await redis.get(cleEchecs(ip))) < ECHECS_MAX && consommer(redis, `suivi:ip:${hex('ip', ip)}`, 600, 3600);
  const echec = (ip: string) => consommer(redis, `suivi-echec:ip:${hex('ip', ip)}`, ECHECS_MAX, 3600);
  const echeance = (date: Date | null) =>
    (date ?? new Date(Date.now() + DELAI_VERIFICATION_JOURS * 86_400_000)).toISOString();
  /** Retrouve la vidéo visée : par le code de suivi, ou par le compte connecté qui l'a envoyée.
   *  Répond lui-même (et renvoie null) si elle est introuvable. */
  async function cibler(req: FastifyRequest, reply: FastifyReply, corps: Cible) {
    let hash: Buffer;
    let cleCopieEnc: Buffer | null = null;
    let compte: string | null = null;
    let sessionCompte: Buffer | null = null;
    if (corps.jeton) {
      hash = empreinteJeton(corps.jeton);
    } else {
      const session = await lireSession(bases, req);
      if (!session) { reply.code(401).send({ erreur: 'non_connecte' }); return null; }
      const o = await bases.app.query<{ tracking_code_hash: Buffer; copy_key_enc: Buffer | null }>(
        'SELECT * FROM core.owned_video($1, $2)', [session.session, corps.video]);
      if (!o.rows[0]) { reply.code(404).send({ erreur: 'introuvable' }); return null; }
      hash = o.rows[0].tracking_code_hash;
      cleCopieEnc = o.rows[0].copy_key_enc;
      compte = session.id;
      sessionCompte = session.session;
    }
    const v = await lire(hash);
    if (!v) {
      if (corps.jeton) await echec(req.ip);
      reply.code(404).send({ erreur: 'introuvable' });
      return null;
    }
    return { v, hash, cleCopieEnc, compte, sessionCompte };
  }
  /** Journal légal (décret 2021-1362, 0122) : opération sur un contenu, avec l'adresse, l'heure exacte et la vidéo. */
  const journalLegal = (req: FastifyRequest, compte: string | null, action: 'modify' | 'delete', video: string) =>
    bases.identity.query(
      'SELECT identity.log_legal($1, $2, $3, $4, $5)',
      [compte, action, req.ip, req.socket.remotePort ?? null, video]);
  const lireJson = async (id: string, nom: 'pistes.json' | 'retouche.json'): Promise<unknown> => {
    try { return JSON.parse(await readFile(stockage.fichierVideo('copies', id, nom), 'utf8')); } catch { return null; }
  };

  // Envoi avec un compte : le code, chiffré pour la clé du compte (le navigateur seul peut l'ouvrir).
  app.post<{ Body: Cible }>('/suivi/code', { schema: { body: CORPS_JETON } }, async (req, reply) => {
    if (!(await limiter(req.ip))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const c = await cibler(req, reply, req.body);
    if (!c) return reply;
    if (!c.compte || !c.sessionCompte) return reply.code(404).send({ erreur: 'introuvable' });
    const r = await bases.app.query<{ c: unknown }>('SELECT core.owned_code($1, $2) AS c', [c.sessionCompte, c.v.video_id]);
    return reply.send({ code: r.rows[0]?.c ?? null });
  });

  // Code unique : les vidéos d'un code, d'après les jetons de ses vidéos possibles (le navigateur les calcule).
  // Rien n'est enregistré : aucun lien entre ces vidéos ne reste dans la base. Le navigateur envoie les jetons par
  // paquets (places `depuis` à `depuis` + n) et s'arrête au premier paquet vide : le serveur ne voit pas d'avance les
  // jetons des vidéos futures (point bas de la revue, 15 novembre 2026). Un paquet suivant vide n'est pas un échec.
  app.post<{ Body: { jetons: string[]; depuis?: number } }>('/suivi/videos', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['jetons'],
                      properties: { jetons: { type: 'array', minItems: 1, maxItems: 50, items: JETON },
                                    depuis: { type: 'integer', minimum: 1, maximum: 49 } } } },
  }, async (req, reply) => {
    if (!(await limiter(req.ip))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const depuis = req.body.depuis ?? 0;
    if (depuis + req.body.jetons.length > 50) return reply.code(400).send({ erreur: 'requete_invalide' });
    const hashes = req.body.jetons.map(empreinteJeton);
    const r = await bases.app.query<{ tracking_code_hash: Buffer; pseudonym: string; status: string; submitted_at: Date }>(
      `SELECT p.tracking_code_hash, p.pseudonym, v.status, v.submitted_at
         FROM core.pseudonyms p JOIN core.videos v ON v.id = p.video_id WHERE p.tracking_code_hash = ANY($1::bytea[])`, [hashes]);
    if (!r.rowCount) {
      if (depuis) return reply.send({ videos: [] });
      await echec(req.ip);
      return reply.code(404).send({ erreur: 'introuvable' });
    }
    const videos = r.rows.map((v) => ({
      position: depuis + hashes.findIndex((h) => h.equals(v.tracking_code_hash)), pseudonyme: v.pseudonym,
      libelle: (ETATS[v.status] ?? { libelle: 'État inconnu' }).libelle, envoyeeLe: v.submitted_at.toISOString(),
    })).sort((a, b) => a.position - b.position);
    return reply.send({ videos });
  });

  app.post<{ Body: Cible }>('/suivi', { schema: { body: CORPS_JETON } }, async (req, reply) => {
    if (!(await limiter(req.ip))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const c = await cibler(req, reply, req.body);
    if (!c) return reply;
    const { v } = c;
    const etat = ETATS[v.status] ?? { cle: 'inconnu', libelle: 'État inconnu' };
    return reply.send({
      pseudonyme: v.pseudonym,
      etat: etat.cle,
      libelle: etat.libelle,
      envoyeeLe: v.submitted_at.toISOString(),
      ...(v.decided_at ? { decideeLe: v.decided_at.toISOString() } : {}),
      ...(v.withdrawn_at ? { retireeLe: v.withdrawn_at.toISOString() } : {}),
      ...(v.status === 'uploading' ? { envoi: v.video_id } : {}),   // pour reprendre l'envoi (GET /envois/:id/etat)
      ...(v.status === 'processing' ? { avancement: v.processing_progress ?? 0 } : {}),   // barre de progression, en %
      // En file d'attente : place dans la file (1 = la prochaine) ; 0 = en cours de traitement.
      ...(v.status === 'processing'
        ? { fileAttente: (await bases.app.query<{ n: number }>('SELECT core.processing_queue_position($1) AS n', [v.video_id])).rows[0]!.n }
        : {}),
      ...(v.status === 'failed' ? { raison: ECHECS[v.failure_reason ?? ''] ?? ECHECS['processing_error'] } : {}),
      // À vérifier : date à laquelle la vidéo partira d'elle-même en relecture, retouches restantes.
      ...(v.status === 'awaiting_author'
        ? { echeance: echeance(v.review_deadline), retouchesRestantes: Math.max(0, RETOUCHES_MAX - v.retouches) } : {}),
      // Ressemblance avec une vidéo déjà publiée (jamais une vidéo non publiée).
      ...((await bases.app.query<{ id: string; pseudonym: string | null }>('SELECT * FROM core.published_lookalike($1)', [v.video_id]))
        .rows.map((x) => ({ ressemblance: { video: x.id, pseudonyme: x.pseudonym } }))[0] ?? {}),
      // Transmission de l'original : autorisation en cours, transmissions faites (date, type de destinataire).
      transmission: {
        ...(await bases.app.query<{ s: Record<string, unknown> }>('SELECT core.release_status($1) AS s', [v.video_id])).rows[0]!.s,
        proposee: (deps.reglages.clesAdmin ?? []).length > 0,
        // Empreinte de l'original en clair (déjà publique sur la fiche) : le navigateur en a besoin pour l'enveloppe.
        ...(v.sha256 ? { empreinte: v.sha256 } : {}),
      },
    });
  });

  // Autoriser (plus tard) la transmission de l'original : le navigateur a refait l'enveloppe à partir du
  // code de 12 mots (seul moyen de retrouver la clé de l'original).
  // Rattacher après coup un envoi anonyme à son compte : connecté, la personne prouve avec le code de 12 mots (jeton)
  // que la vidéo est la sienne. Lien DÉFINITIF. Le navigateur fournit aussi la clé de copie (retouche depuis « Mes
  // vidéos ») et la clé de messagerie de la vidéo chiffrée pour le compte (messages lisibles sans les 12 mots).
  app.post<{ Body: { jeton: string; cleCopie?: string; pourCompte?: object } }>('/suivi/rattacher', {
    preHandler: app.exigerSession,
    schema: { body: { type: 'object', additionalProperties: false, required: ['jeton'],
                      properties: { jeton: JETON, cleCopie: JETON, pourCompte: SCELLE } } },
  }, async (req, reply) => {
    if (!(await limiter(req.ip))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    let video: string;
    try {
      video = (await bases.app.query<{ v: string }>('SELECT core.claim_video_with_code($1, $2) AS v',
        [req.compte!.id, empreinteJeton(req.body.jeton)])).rows[0]!.v;
    } catch (e) {
      const code = codeArgos(e);
      if (code === 'introuvable') { await echec(req.ip); return reply.code(404).send({ erreur: 'introuvable' }); }
      if (code === 'deja_rattachee' || code === 'compte_inactif') return reply.code(409).send({ erreur: code });
      throw e;
    }
    if (req.body.cleCopie) await bases.app.query('SELECT core.set_owner_copy_key($1, $2, $3)', [video, req.compte!.id, chiffrer(deps.cles, req.body.cleCopie)]);
    if (req.body.pourCompte) {
      await bases.app.query(
        `UPDATE core.public_keys k SET owner_wrapped = $2 FROM core.pseudonyms p
          WHERE k.pseudonym_id = p.id AND p.video_id = $1 AND k.owner_wrapped IS NULL`, [video, JSON.stringify(req.body.pourCompte)]);
    }
    return reply.send({ video });
  });

  app.post<{ Body: Cible & { enveloppe: Enveloppe } }>('/suivi/autoriser', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['enveloppe'], ...UN_DES_DEUX,
                      properties: { jeton: JETON, video: VIDEO, enveloppe: SCHEMA_ENVELOPPE } } },
  }, async (req, reply) => {
    if (!(await limiter(req.ip))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const c = await cibler(req, reply, req.body);
    if (!c) return reply;
    if (!enveloppeValable(deps, req.body.enveloppe)) return reply.code(400).send({ erreur: 'enveloppe_invalide' });
    if (['withdrawn', 'removed', 'uploading'].includes(c.v.status)) return reply.code(409).send({ erreur: 'action_impossible' });
    await bases.app.query('SELECT core.grant_release($1, $2, $3)', [c.v.video_id, c.hash, JSON.stringify(req.body.enveloppe)]);
    return reply.send({ ok: true });
  });

  // Retirer l'autorisation : l'enveloppe est effacée (les transmissions déjà faites restent).
  app.post<{ Body: Cible }>('/suivi/autorisation/retirer', { schema: { body: CORPS_JETON } }, async (req, reply) => {
    if (!(await limiter(req.ip))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const c = await cibler(req, reply, req.body);
    if (!c) return reply;
    const r = await bases.app.query<{ ok: boolean }>('SELECT core.revoke_release($1, $2) AS ok', [c.v.video_id, c.hash]);
    return r.rows[0]!.ok ? reply.send({ ok: true }) : reply.code(409).send({ erreur: 'pas_autorisee' });
  });

  // Lien de visionnage : un jeton aléatoire à usage limité dans le temps, pour que le lecteur vidéo
  // du navigateur puisse lire le fichier par morceaux (GET) sans que le jeton de suivi passe dans
  // une adresse. Le lien ne donne accès qu'à la version floutée.
  app.post<{ Body: Cible & { qualite?: 'apercu' | 'complete' } }>('/suivi/apercu', {
    schema: {
      body: { type: 'object', additionalProperties: false, ...UN_DES_DEUX,
              properties: { jeton: JETON, video: VIDEO, qualite: { type: 'string', enum: ['apercu', 'complete'] } } },
    },
  }, async (req, reply) => {
    if (!(await limiter(req.ip))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const c = await cibler(req, reply, req.body);
    if (!c) return reply;
    const { v } = c;
    if (!VISIBLES.has(v.status)) return reply.code(409).send({ erreur: 'pas_de_version_floutee' });
    return reply.send(await creerLien(deps, v.video_id, req.body.qualite ?? 'apercu'));
  });

  app.get<{ Params: { lien: string } }>('/apercu/:lien', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['lien'], properties: { lien: JETON } } },
  }, async (req, reply) => {
    const valeur = await redis.get(`apercu:${hex('apercu', req.params.lien)}`);
    if (!valeur) return reply.code(404).send({ erreur: 'lien_expire' });
    const [id, fichier] = valeur.split('|') as [string, 'apercu.mp4' | 'video.mp4'];
    const chemin = stockage.fichierVideo('floutees', id, fichier);
    let taille: number;
    try {
      taille = (await stat(chemin)).size;
    } catch {
      // Production : la version floutée est sur R2 ; le navigateur la lit directement par un lien signé
      // (10 minutes), sans passer par le serveur. Le fichier local ne sert qu'avant son dépôt.
      const distant = stockage.lienDistant?.(id, fichier, DUREE_LIEN);
      if (distant) return reply.code(302).header('cache-control', 'no-store').redirect(distant);
      return reply.code(404).send({ erreur: 'introuvable' });
    }
    const p = plage(req.headers.range, taille);
    reply.header('content-type', 'video/mp4').header('accept-ranges', 'bytes');
    if (p === 'invalide') return reply.code(416).header('content-range', `bytes */${taille}`).send();
    if (p === null) return reply.header('content-length', taille).send(createReadStream(chemin));
    return reply.code(206).header('content-range', `bytes ${p.debut}-${p.fin}/${taille}`)
      .header('content-length', p.fin - p.debut + 1).send(createReadStream(chemin, { start: p.debut, end: p.fin }));
  });

  app.post<{ Body: Cible }>('/suivi/masques', { schema: { body: CORPS_JETON } }, async (req, reply) => {
    if (!(await limiter(req.ip))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const c = await cibler(req, reply, req.body);
    if (!c) return reply;
    const { v } = c;
    if (v.status !== 'awaiting_author') return reply.code(409).send({ erreur: 'pas_a_verifier' });
    // Sans copie gardée (clé de copie jamais reçue), la vidéo ne peut pas être retouchée.
    const lu = await lireJson(v.video_id, 'pistes.json');
    const pistes = Array.isArray(lu) ? lu : null;
    const retouche = await lireJson(v.video_id, 'retouche.json');
    return reply.send({
      retouchable: pistes !== null,
      pistes: pistes ?? [],
      retouche: retouche ?? { retirees: [], zones: [] },   // dernière retouche appliquée
      retouchesRestantes: Math.max(0, RETOUCHES_MAX - v.retouches),
      echeance: echeance(v.review_deadline),
    });
  });

  // Retouche : la demande décrit l'état voulu en entier (flous retirés, zones ajoutées), pas une
  // différence avec la précédente. La clé de copie, re-dérivée de la phrase par le navigateur, permet
  // au worker de relire la copie chiffrée ; elle ne va que dans Redis, le temps du traitement.
  app.post<{ Body: Cible & { cleCopie?: string; retirees: number[]; zones: Zone[] } }>('/suivi/retoucher', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['retirees', 'zones'],
        // Avec le code : la clé de copie, re-dérivée de la phrase. Depuis un compte : gardée par le site.
        oneOf: [{ required: ['jeton', 'cleCopie'] }, { required: ['video'], not: { required: ['cleCopie'] } }],
        properties: {
          jeton: JETON,
          video: VIDEO,
          cleCopie: JETON,
          retirees: { type: 'array', maxItems: 500, uniqueItems: true, items: { type: 'integer', minimum: 0, maximum: 100_000 } },
          zones: {
            type: 'array', maxItems: ZONES_MAX,
            items: {
              type: 'object', additionalProperties: false, required: ['debut', 'fin', 'de', 'a'],
              properties: { debut: { type: 'number', minimum: 0, maximum: 1200 }, fin: { type: 'number', minimum: 0, maximum: 1200 },
                            de: RECT, a: RECT },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await limiter(req.ip))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const { retirees, zones } = req.body;
    if (zones.some((z) => z.fin <= z.debut || !rectangleValable(z.de) || !rectangleValable(z.a))) {
      return reply.code(400).send({ erreur: 'zone_invalide' });
    }
    const c = await cibler(req, reply, req.body);
    if (!c) return reply;
    const { v } = c;
    const cleCopie = req.body.cleCopie ?? (c.cleCopieEnc ? dechiffrer(cles, c.cleCopieEnc) : null);
    if (v.status !== 'awaiting_author') return reply.code(409).send({ erreur: 'pas_a_verifier' });
    if (!cleCopie) return reply.code(409).send({ erreur: 'non_retouchable' });
    if (v.retouches >= RETOUCHES_MAX) return reply.code(409).send({ erreur: 'retouches_epuisees' });
    const pistes = await lireJson(v.video_id, 'pistes.json');
    if (!Array.isArray(pistes)) return reply.code(409).send({ erreur: 'non_retouchable' });
    const ids = new Set(pistes.map((p: { id: number }) => p.id));
    if (retirees.some((id) => !ids.has(id))) return reply.code(400).send({ erreur: 'piste_inconnue' });
    let verif: Buffer;
    try { verif = Buffer.from(await readFile(stockage.fichierVideo('copies', v.video_id, 'verif'), 'utf8'), 'hex'); }
    catch { return reply.code(409).send({ erreur: 'non_retouchable' }); }
    if (!egal(createHash('sha256').update(cleCopie).digest(), verif)) return reply.code(400).send({ erreur: 'cle_copie' });

    // Ligne verrouillée par l'UPDATE jusqu'à la fin : le worker ne voit la vidéo « en traitement »
    // qu'une fois la demande et la clé en place, et deux demandes simultanées ne passent pas toutes les deux.
    const cx = await bases.app.connect();
    try {
      await cx.query('BEGIN');
      const r = await cx.query(
        `UPDATE core.videos SET status = 'processing', retouches = retouches + 1, processing_attempts = 0,
                processing_progress = 0, processing_started_at = NULL
          WHERE id = $1 AND status = 'awaiting_author' AND retouches < $2 RETURNING retouches`, [v.video_id, RETOUCHES_MAX]);
      if (!r.rowCount) {
        await cx.query('ROLLBACK');
        return reply.code(409).send({ erreur: 'pas_a_verifier' });
      }
      const demande = stockage.fichierVideo('copies', v.video_id, 'demande.json');
      const tmp = `${demande}.${randomBytes(6).toString('hex')}`;
      try {
        await writeFile(tmp, JSON.stringify({ retirees, zones }), { mode: 0o660 });
        await rename(tmp, demande);
        await redis.set(cleRedisCopie(v.video_id), cleCopie, 'EX', 24 * 3600);
        await cx.query('COMMIT');
      } catch (e) {
        await cx.query('ROLLBACK');
        await rm(tmp, { force: true });
        await rm(demande, { force: true });
        await redis.del(cleRedisCopie(v.video_id));
        throw e;
      }
      // Journal légal (0122) : la retouche du floutage modifie le contenu.
      await journalLegal(req, c.compte, 'modify', v.video_id);
      return reply.send({ ok: true, etat: ETATS['processing']!.cle, retouchesRestantes: RETOUCHES_MAX - r.rows[0].retouches });
    } finally {
      cx.release();
    }
  });

  app.post<{ Body: Cible }>('/suivi/valider', { schema: { body: CORPS_JETON } }, async (req, reply) => {
    if (!(await limiter(req.ip))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const c = await cibler(req, reply, req.body);
    if (!c) return reply;
    const { v } = c;
    const r = await bases.app.query(
      `UPDATE core.videos SET status = 'in_review' WHERE id = $1 AND status = 'awaiting_author' RETURNING id`, [v.video_id]);
    if (!r.rowCount) return reply.code(409).send({ erreur: 'pas_a_verifier' });
    await stockage.supprimer('copies', v.video_id);
    return reply.send({ ok: true, etat: ETATS['in_review']!.cle });
  });

  app.post<{ Body: Cible & { confirmation?: string; motDePasse?: string; code?: string; cle?: AuthenticationResponseJSON } }>('/suivi/retirer', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        // Avec le code : le pseudonyme retapé. Depuis un compte : mot de passe (+ second facteur si actif).
        oneOf: [{ required: ['jeton', 'confirmation'] }, { required: ['video', 'motDePasse'] }],
        properties: { jeton: JETON, video: VIDEO, confirmation: texte(80), motDePasse: texte(512), code: texte(20), cle: SCHEMA_REPONSE_CLE },
      },
    },
  }, async (req, reply) => {
    if (!(await limiter(req.ip))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    const c = await cibler(req, reply, req.body);
    if (!c) return reply;
    const { v } = c;
    if (c.compte) {
      // Un compte volé ne doit pas pouvoir effacer une preuve en un clic.
      const refus = await verifierIdentite(app, deps, c.compte,
        { motDePasse: req.body.motDePasse!, ...(req.body.code !== undefined ? { code: req.body.code } : {}),
          ...(req.body.cle !== undefined ? { cle: req.body.cle } : {}) });
      if (refus) return reply.code(refus.statut).send({ erreur: refus.erreur });
    } else if (simplifier(req.body.confirmation ?? '') !== simplifier(v.pseudonym)) {
      // Retaper le pseudonyme : le retrait est irréversible, on veut être sûr de l'intention.
      return reply.code(400).send({ erreur: 'confirmation' });
    }

    const r = (await bases.app.query<{ r: { resultat: string; video?: string; original?: string | null; floutee?: string | null } }>(
      'SELECT core.withdraw_video($1) AS r', [c.hash])).rows[0]!.r;
    switch (r.resultat) {
      case 'introuvable': return reply.code(404).send({ erreur: 'introuvable' });
      case 'deja_retiree': return reply.code(409).send({ erreur: 'deja_retiree' });
      case 'bloque': return reply.code(423).send({ erreur: 'retrait_bloque' });
      case 'envoi_en_cours': {
        // Envoi jamais finalisé : tout disparaît, comme un abandon.
        await bases.app.query('SELECT core.abandon_upload($1)', [r.video]);
        await stockage.supprimer('originaux', r.video!);
        await stockage.supprimer('quarantaine', r.video!);
        // B15 : les clés de copie et d'original en attente du worker partent aussi.
        await redis.del(`envoi:${r.video}`, `envoi:${r.video}:originaux`, `envoi:${r.video}:quarantaine`,
                        cleRedisCopie(r.video!), cleOriginal(r.video!));
        return reply.send({ ok: true, etat: 'effacee' });
      }
      case 'ok':
        // B15 : les clés en attente du worker partent aussi (vidéo retirée pendant son traitement).
        await redis.del(cleRedisCopie(r.video!), cleOriginal(r.video!));
        // La base a déjà tout effacé de son côté ; restent les fichiers : original chiffré, versions
        // floutées, et copie de travail au cas où le floutage ne serait pas encore passé.
        // Fichiers effacés AVANT le journal, chacun indépendamment (contre-vérification du second audit) : un échec
        // (R2 injoignable) ne doit ni sauter les autres ni le journal ; il est inscrit et retenté chaque heure (0127).
        const echecs = await effacerFichiersVideo(deps, r.video!, req.log);
        // Journal légal (décret 2021-1362, 0122) : une suppression de contenu est une opération à conserver. En cas
        // d'échec, le retrait reste fait (décision de l’administrateur, 15 novembre) et l'administrateur est prévenu. Seuls le
        // code et le message de l'erreur sont journalisés (le détail d'une erreur de la base recopie la ligne).
        try {
          await journalLegal(req, c.compte, 'delete', r.video!);
        } catch (x) {
          req.log.error({ code: (x as { code?: string }).code, message: (x as Error).message }, 'journal légal : retrait non inscrit');
          await alerterJournalLegal(deps).catch(() => {});
        }
        if (echecs) await alerterSuppressions(deps).catch(() => {});
        return reply.send({ ok: true, etat: 'retiree' });
      default:
        throw new Error(`résultat de retrait inattendu : ${r.resultat}`);
    }
  });

  // Messagerie avec les comptes vérifiés et l'administration (messagerie.ts).
  enregistrerMessagerieSource(app, deps, { cibler, limiter, JETON, VIDEO, UN_DES_DEUX });
}

/** Retrait fait sans inscription au journal légal : mail au super-administrateur (sans identifiant de vidéo). */
export async function alerterJournalLegal(deps: Dependances): Promise<void> {
  const admin = (await deps.bases.app.query<{ id: string }>('SELECT id FROM core.accounts WHERE is_superadmin LIMIT 1')).rows[0];
  if (!admin) return;
  await ecrire(deps, admin.id, 'journal légal : opération non inscrite',
    'Une opération (retrait de vidéo, ou note ou correction d’analyste) n’a pas pu être inscrite au journal légal (clé de scellement absente, base indisponible…).'
    + '\n\nL’opération est faite. Vérifiez le journal légal (redéploiement : ligne « journal légal ») et l’administration, page « Erreurs du serveur ».');
}

/** Efface les 4 espaces de fichiers d'une vidéo, chacun indépendamment ; un échec est inscrit et retenté (0127). */
async function effacerFichiersVideo(deps: Dependances, video: string, log: FastifyBaseLogger): Promise<number> {
  let echecs = 0;
  for (const espace of ['originaux', 'floutees', 'quarantaine', 'copies'] as const) {
    try {
      await deps.stockage.supprimer(espace, video);
    } catch (x) {
      echecs++;
      log.error({ code: (x as { code?: string }).code, message: (x as Error).message }, `suppression reportée (${espace})`);
      await deps.bases.app.query('INSERT INTO core.pending_deletions (video_id, espace) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                                 [video, espace]).catch(() => {});
    }
  }
  return echecs;
}

/**
 * Tâche horaire (T1, décision de l’administrateur) : vidéos refusées ou sans décision depuis 30 jours, ni gelées ni de contrôle.
 * La base efface leur contenu (0128) ; restent leurs fichiers et les clés en attente du worker.
 */
export async function purgerNonPubliees(deps: Dependances, log: FastifyBaseLogger): Promise<number> {
  const ids = (await deps.bases.app.query<{ v: string }>('SELECT v FROM core.purge_unpublished_videos(30) v')).rows.map((r) => r.v);
  let echecs = 0;
  for (const id of ids) {
    await deps.redis.del(cleRedisCopie(id), cleOriginal(id));
    echecs += await effacerFichiersVideo(deps, id, log);
  }
  if (echecs) await alerterSuppressions(deps).catch(() => {});
  return ids.length;
}

/** Suppressions de fichiers reportées (stockage injoignable au retrait) : mail au super-administrateur. */
async function alerterSuppressions(deps: Dependances): Promise<void> {
  const admin = (await deps.bases.app.query<{ id: string }>('SELECT id FROM core.accounts WHERE is_superadmin LIMIT 1')).rows[0];
  if (!admin) return;
  await ecrire(deps, admin.id, 'retrait : suppression de fichiers reportée',
    'Une vidéo a été retirée, mais certains de ses fichiers n’ont pas pu être effacés du stockage. Ils seront retentés '
    + 'chaque heure. Si ce mail revient, vérifiez le stockage (R2) et l’administration, page « Erreurs du serveur ».');
}

/** Tâche horaire : retente les suppressions reportées (0127) ; une ligne part quand sa suppression réussit. */
export async function reprendreSuppressions(deps: Dependances): Promise<number> {
  const r = await deps.bases.app.query<{ video_id: string; espace: 'originaux' | 'floutees' | 'quarantaine' | 'copies' }>(
    'SELECT video_id, espace FROM core.pending_deletions ORDER BY created_on LIMIT 200');
  let n = 0;
  for (const l of r.rows) {
    try {
      await deps.stockage.supprimer(l.espace, l.video_id);
      await deps.bases.app.query('DELETE FROM core.pending_deletions WHERE video_id = $1 AND espace = $2', [l.video_id, l.espace]);
      n++;
    } catch { /* retenté à l'heure suivante */ }
  }
  return n;
}

/** Tâche horaire : les vidéos non vérifiées à l'échéance partent en relecture, et toute copie de
 *  travail qui n'a plus lieu d'être (vidéo validée, retirée, ou course avec un retrait) est effacée.
 *  Une copie en cours de retouche (« processing ») est gardée. */
export async function validerSansReponse(deps: Dependances): Promise<number> {
  const r = await deps.bases.app.query<{ id: string }>(
    `UPDATE core.videos SET status = 'in_review'
      WHERE status = 'awaiting_author' AND review_deadline < now() RETURNING id::text`);
  const restantes = await deps.stockage.identifiants('copies');
  if (restantes.length) {
    const a = await deps.bases.app.query<{ id: string }>(
      `SELECT id::text FROM core.videos WHERE id = ANY($1::uuid[]) AND status IN ('awaiting_author', 'processing')`, [restantes]);
    const gardees = new Set(a.rows.map((x) => x.id));
    for (const id of restantes) if (!gardees.has(id)) await deps.stockage.supprimer('copies', id);
  }
  return r.rowCount ?? 0;
}
