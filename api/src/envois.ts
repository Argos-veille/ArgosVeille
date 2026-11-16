// Envoi des vidéos par les sources, sans compte (étape 5b).
//   POST /envois                          ouvrir un envoi (Turnstile, empreinte du jeton de suivi, contexte)
//   PUT  /envois/:id/original/:n          un morceau de l'original chiffré     (en-tête « argos-suivi »)
//   PUT  /envois/:id/copie/:n             un morceau de la copie de travail     (en-tête « argos-suivi »)
//   GET  /envois/:id/etat                 morceaux déjà reçus, pour reprendre   (en-tête « argos-suivi »)
//   POST /envois/:id/finaliser            vérifier, assembler, passer en traitement ; reçoit la clé de copie
// Le serveur ne voit jamais la phrase, la clé de l'original, ni les métadonnées brutes. Seule la
// personne qui a la phrase (donc le jeton de suivi) peut compléter son envoi.
import { type CleVideo, enregistrerCleVideo, SCELLE, SCHEMA_CLE_VIDEO } from './messagerie.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Dependances } from './app.ts';
import { chiffrer, egal, empreinte } from './crypto.ts';
import { lireSession } from './sessions.ts';
import { consommer } from './limites.ts';
import { pseudonymeAleatoire } from './pseudonymes.ts';
import { texte, texteLong } from './schemas.ts';
import { CONDITIONS_VERSION, VERSION_CONDITIONS } from './conditions.ts';
import { enveloppeValable, SCHEMA_ENVELOPPE, type Enveloppe } from './transmission.ts';
import type { Espace } from './stockage.ts';
import { enFrance } from './territoire.ts';

export { enFrance };

// Format du fichier chiffré : doit correspondre à navigateur/src/chiffrement.ts (vérifié par les tests).
export const TAILLE_ENTETE = 20;
export const TAILLE_MORCEAU = 4 * 1024 * 1024;
const ETIQUETTE = 16;
const PAS_CHIFFRE = TAILLE_MORCEAU + ETIQUETTE;
export const TAILLE_MAX = 2 * 1024 ** 3;
const TAILLE_MAX_CHIFFREE = TAILLE_ENTETE + TAILLE_MAX + Math.ceil(TAILLE_MAX / TAILLE_MORCEAU) * ETIQUETTE;
const DUREE_ENVOI = 24 * 3600;
/** Description obligatoire (15 novembre 2026, demande de l’administrateur) : sans contexte, une vidéo ne peut être ni vérifiée ni comprise. */
export const DESCRIPTION_MIN = 20;

const cleEnvoi = (id: string) => `envoi:${id}`;
// B14 : envois commencés et pas encore terminés, avec leur taille annoncée, pour ne pas laisser remplir les disques.
const ENVOIS_ACTIFS = 'envois:actifs';
const MARGE_DISQUE = 2 * 1024 ** 3;   // toujours au moins 2 Gio de libre après les envois en cours
/** Clé de copie en attente du worker (lue par lui sous « argos:cle-copie:<id> », préfixe compris). */
export const cleCopie = (id: string) => `cle-copie:${id}`;
export const cleOriginal = (id: string) => `cle-original:${id}`;

// Sites d'où une vidéo peut être récupérée par son lien (le worker refait ce contrôle).
const SITES_LIEN = ['x.com', 'twitter.com', 'bsky.app', 'facebook.com', 'tiktok.com', 'instagram.com', 'youtube.com', 'youtu.be'];
export function lienPrisEnCharge(lien: string): boolean {
  try {
    const u = new URL(lien);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port
      && SITES_LIEN.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
const DUREE_CLE_COPIE = 24 * 3600;   // au-delà, la vidéo est traitée sans copie gardée (pas de retouches)
const cleRecus = (id: string, espace: Espace) => `envoi:${id}:${espace}`;

/** Morceaux attendus et taille exacte de chacun : rien de plus, rien de moins ne sera accepté. */
export function decoupage(espace: Espace, total: number) {
  if (espace === 'originaux') {
    const n = Math.ceil((total - TAILLE_ENTETE) / PAS_CHIFFRE);
    const taille = (i: number) => {
      const debut = i === 0 ? 0 : TAILLE_ENTETE + i * PAS_CHIFFRE;
      return Math.min(TAILLE_ENTETE + (i + 1) * PAS_CHIFFRE, total) - debut;
    };
    return { n, taille };
  }
  const n = Math.ceil(total / TAILLE_MORCEAU);
  return { n, taille: (i: number) => Math.min(TAILLE_MORCEAU, total - i * TAILLE_MORCEAU) };
}

/** Arrondi côté serveur selon la précision choisie (le navigateur arrondit déjà ; double sécurité). */
export function arrondir(lat: number, lon: number, precision: 'exact' | 'approx_100m' | 'municipality') {
  const d = precision === 'exact' ? 5 : precision === 'approx_100m' ? 3 : 2;
  const f = 10 ** d;
  return { lat: Math.round(lat * f) / f, lon: Math.round(lon * f) / f };
}

/** Signature d'un fichier vidéo : MP4 / MOV (boîte ftyp, moov, mdat, wide, free) ou WebM / MKV (EBML). */
export function ressembleAUneVideo(debut: Buffer): boolean {
  if (debut.length >= 4 && debut.readUInt32BE(0) === 0x1a45dfa3) return true;
  return debut.length >= 8 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(debut.toString('latin1', 4, 8));
}

interface Ouverture {
  turnstile?: string;
  passe?: string;
  conditions: string;
  avecCompte?: boolean;
  messagerie?: CleVideo;      // clé de messagerie de la vidéo (privée chiffrée par les 12 mots, et pour le compte)
  contact?: boolean;          // la source accepte d'être contactée par des comptes vérifiés
  origine?: { publiePar?: string; lien?: string; precisions?: string; publique: boolean };   // qui a publié la vidéo, si c'est connu
  codeScelle?: object;
  lien?: string; cleOriginal?: string; cleCopie?: string;   // envoi par lien : la vidéo est récupérée par le serveur
  evenement?: string;   // fiche publiée du même événement, indiquée par la source (proposition à valider)
  autorisation?: Enveloppe;   // la source autorise la transmission de l'original (enveloppe pour l'administration)
  empreinteSuivi: string;
  tailleOriginal?: number;
  tailleCopie?: number;
  sha256Original?: string;
  schemaEmpreinte?: 1;   // empreinte clée de l'original (H10) ; l'ancien SHA-256 simple est refusé
  metadonnees: 'coherentes' | 'incoherentes' | 'absentes';
  garderSon?: boolean;        // la voix de la source peut l'identifier : elle choisit (garder par défaut)
  masquerVisages?: boolean;   // masquer automatiquement les visages proches (oui par défaut)
  contexte: {
    date: string;
    lieu: { lat: number; lon: number };
    precision: 'exact' | 'approx_100m' | 'municipality';
    forces: 'national_police' | 'gendarmerie' | 'municipal_police' | 'customs' | 'unknown';
    situation: 'demonstration' | 'stop' | 'arrest' | 'other';
    categorie: 'violence' | 'abuse';
    sousCategorie: string;
    autresSousCategories?: string[];   // « Plus précisément » : 3 choix au plus avec le principal
    autresSituations?: ('demonstration' | 'stop' | 'arrest' | 'other')[];
    description: string;
    langue: 'fr' | 'en';
    heureConnue?: boolean;   // false : la source ne connaît pas l'heure précise (date seule)
    dateAEtablir?: boolean;  // la source ne connaît pas la date : « au plus tard le », à établir par un analyste
    lieuAEtablir?: boolean;  // la source ne connaît pas le lieu : repère approximatif (commune), à établir par un analyste
  };
}

const HEX64 = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const ID = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
const ID_N = {
  type: 'object', additionalProperties: false, required: ['id', 'n'],
  properties: { id: { type: 'string', format: 'uuid' }, n: { type: 'string', pattern: '^(0|[1-9][0-9]{0,4})$' } },
};

export function enregistrerEnvois(app: FastifyInstance, deps: Dependances): void {
  const { bases, redis, cles, turnstile, stockage, reglages } = deps;
  const hex = (domaine: string, valeur: string) => empreinte(cles, domaine, valeur).toString('hex');

  // Les morceaux arrivent en octets bruts (4 Mio + en-tête au plus), uniquement sur les routes PUT d'envoi.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: TAILLE_ENTETE + PAS_CHIFFRE },
    (_req, corps, fait) => fait(null, corps));

  /** Vérifie le jeton de suivi d'un envoi en cours ; renvoie son état Redis, ou répond lui-même. */
  async function envoiAutorise(req: FastifyRequest, reply: FastifyReply, id: string) {
    const jeton = req.headers['argos-suivi'];
    const e = await redis.hgetall(cleEnvoi(id));
    if (!e['empreinte']) { reply.code(404).send({ erreur: 'envoi_introuvable' }); return null; }
    if (typeof jeton !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(jeton)
        || !egal(createHash('sha256').update(Buffer.from(jeton, 'base64url')).digest(), Buffer.from(e['empreinte'], 'hex'))) {
      reply.code(404).send({ erreur: 'envoi_introuvable' });   // même réponse : on ne confirme pas qu'un envoi existe
      return null;
    }
    return e;
  }

  // B11 : laissez-passer anti-robot, obtenu sur une page sans code de 12 mots ; la page d'envoi se recharge ensuite sans
  // le script de Cloudflare. Valable 1 heure, pour un seul envoi.
  app.post<{ Body: { turnstile: string } }>('/envois/laissez-passer', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['turnstile'], properties: { turnstile: texte(2048) } } },
  }, async (req, reply) => {
    if (!(await consommer(redis, `envoi-passe:ip:${hex('ip', req.ip)}`, 30, 3600))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
    if (!(await turnstile.verifier(req.body.turnstile))) return reply.code(400).send({ erreur: 'turnstile' });
    const passe = randomBytes(32).toString('base64url');
    await redis.set(`envoi-passe:${hex('passe-envoi', passe)}`, '1', 'EX', 3600);
    return reply.send({ passe, expireDans: 3600 });
  });

  app.post<{ Body: Ouverture }>('/envois', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['empreinteSuivi', 'metadonnees', 'contexte',
                   'conditions'],
        properties: {
          turnstile: texte(2048),
          passe: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },   // laissez-passer obtenu avant (B11)
          conditions: VERSION_CONDITIONS,
          avecCompte: { type: 'boolean' },
          evenement: { type: 'string', format: 'uuid' },
          codeScelle: SCELLE,   // envoi avec un compte : le code, chiffré pour la clé du compte
          lien: { type: 'string', maxLength: 2048, pattern: '^https://[^\\s]+$' },   // vidéo à récupérer, à la place du fichier
          cleOriginal: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
          cleCopie: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
          origine: { type: 'object', additionalProperties: false, required: ['publique'],
                     properties: { publiePar: texte(200), lien: { type: 'string', maxLength: 500, pattern: '^https://[^\\s]+$' },
                                   precisions: texteLong(2000), publique: { type: 'boolean' } } },
          autorisation: SCHEMA_ENVELOPPE,
          messagerie: SCHEMA_CLE_VIDEO,
          contact: { type: 'boolean' },
          empreinteSuivi: HEX64,
          tailleOriginal: { type: 'integer', minimum: TAILLE_ENTETE + ETIQUETTE + 1, maximum: TAILLE_MAX_CHIFFREE },
          tailleCopie: { type: 'integer', minimum: 1, maximum: TAILLE_MAX },
          sha256Original: HEX64,
          schemaEmpreinte: { const: 1 },
          metadonnees: { enum: ['coherentes', 'incoherentes', 'absentes'] },
          garderSon: { type: 'boolean' },
          masquerVisages: { type: 'boolean' },
          contexte: {
            type: 'object', additionalProperties: false,
            required: ['date', 'lieu', 'precision', 'forces', 'situation', 'categorie', 'sousCategorie', 'description', 'langue'],
            properties: {
              date: { type: 'string', format: 'date-time', maxLength: 40 },
              lieu: {
                type: 'object', additionalProperties: false, required: ['lat', 'lon'],
                properties: { lat: { type: 'number', minimum: -90, maximum: 90 }, lon: { type: 'number', minimum: -180, maximum: 180 } },
              },
              precision: { enum: ['exact', 'approx_100m', 'municipality'] },
              forces: { enum: ['national_police', 'gendarmerie', 'municipal_police', 'customs', 'unknown'] },
              situation: { enum: ['demonstration', 'stop', 'arrest', 'other'] },
              categorie: { enum: ['violence', 'abuse'] },
              sousCategorie: { type: 'string', pattern: '^[a-z_]{1,40}$' },
              autresSousCategories: { type: 'array', maxItems: 2, uniqueItems: true, items: { type: 'string', pattern: '^[a-z_]{1,40}$' } },
              autresSituations: { type: 'array', maxItems: 2, uniqueItems: true, items: { enum: ['demonstration', 'stop', 'arrest', 'other'] } },
              description: { type: 'string', minLength: DESCRIPTION_MIN, maxLength: 5000, pattern: '^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]*$' },
              langue: { enum: ['fr', 'en'] },
              heureConnue: { type: 'boolean' },
              dateAEtablir: { type: 'boolean' },
              lieuAEtablir: { type: 'boolean' },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    // Conditions d'utilisation : la version acceptée doit être celle en vigueur (vérifié avant de compter l'envoi).
    if (req.body.conditions !== CONDITIONS_VERSION) {
      return reply.code(409).send({ erreur: 'conditions_perimees', version: CONDITIONS_VERSION });
    }
    // Envoi avec son compte (facultatif) : il faut être connecté ; la vidéo sera rattachée au compte.
    const o = req.body.origine;
    if (o && ((!o.publiePar && !o.lien && !o.precisions) || (o.publique && !o.publiePar))) return reply.code(400).send({ erreur: 'origine_invalide' });
    const compte = req.body.avecCompte ? await lireSession(bases, req) : null;
    if (req.body.avecCompte && !compte) return reply.code(401).send({ erreur: 'non_connecte' });
    if (req.body.codeScelle && !compte) return reply.code(400).send({ erreur: 'requete_invalide' });
    if (req.body.autorisation && !enveloppeValable(deps, req.body.autorisation)) {
      return reply.code(400).send({ erreur: 'enveloppe_invalide' });
    }
    const lien = req.body.lien;
    if (lien) {
      if (!lienPrisEnCharge(lien)) return reply.code(400).send({ erreur: 'lien_non_pris_en_charge' });
      if (!req.body.cleOriginal || !req.body.cleCopie || req.body.autorisation) return reply.code(400).send({ erreur: 'requete_invalide' });
    } else if (req.body.sha256Original && req.body.schemaEmpreinte !== 1) {
      // Onglet ouvert avant la mise à jour (empreinte simple, H10) : refusé, avec une erreur qui dit de recharger.
      return reply.code(409).send({ erreur: 'client_perime' });
    } else if (req.body.tailleOriginal === undefined || req.body.tailleCopie === undefined || !req.body.sha256Original) {
      return reply.code(400).send({ erreur: 'requete_invalide' });
    }
    const ip = hex('ip', req.ip);
    // Compte certifié ou de confiance, envoi avec son compte : limite plus haute, comptée au compte. Un envoi anonyme reste compté à la connexion.
    const certifie = compte ? (await bases.app.query<{ c: boolean }>(
      `SELECT a.certified OR EXISTS (SELECT 1 FROM core.verifications v WHERE v.account_id = a.id AND v.revoked_at IS NULL AND v.expires_at > now()) AS c
         FROM core.accounts a WHERE a.id = $1`, [compte.id])).rows[0]?.c === true : false;
    const limite = certifie ? reglages.envoisCertifiesParHeure ?? 20 : reglages.envoisParIpHeure ?? 5;
    const compteur = `envoi:heure:${certifie ? `compte:${compte!.id}` : `ip:${ip}`}`;
    if (!(await consommer(redis, compteur, limite, 3600))) {
      // Message explicite : combien d'envois sont permis, et dans combien de temps on pourra recommencer.
      const reste = await redis.ttl(`limite:${compteur}`);
      return reply.code(429).send({ erreur: 'limite_envois', limite, ...(reste > 0 ? { disponibleDans: reste } : {}) });
    }
    // B11 : de préférence un laissez-passer obtenu avant, sur une page où le code de 12 mots n'existe pas encore ;
    // il n'est consommé qu'une fois l'envoi créé (une erreur de saisie ne le gâche pas).
    const clePasse = req.body.passe ? `envoi-passe:${hex('passe-envoi', req.body.passe)}` : null;
    if (clePasse ? !(await redis.exists(clePasse)) : !(req.body.turnstile && (await turnstile.verifier(req.body.turnstile)))) {
      return reply.code(400).send({ erreur: 'turnstile' });
    }
    const heure = new Date().toISOString().slice(0, 13);
    if (!(await consommer(redis, `envoi:global:${heure}`, reglages.envoisParHeure, 2 * 3600))) {
      return reply.code(503).send({ erreur: 'envois_satures' });
    }
    // B14 : place réservée par les envois en cours (ceux qui n'existent plus sont oubliés) ; refus si les disques
    // ne peuvent pas la recevoir. Un envoi par lien est récupéré par le worker, sans réservation ici.
    if (!lien) {
      const actifs = await redis.hgetall(ENVOIS_ACTIFS);
      const reserve = { originaux: 0, quarantaine: 0 };
      for (const [autre, tailles] of Object.entries(actifs)) {
        if (!(await redis.exists(cleEnvoi(autre)))) { await redis.hdel(ENVOIS_ACTIFS, autre); continue; }
        const t = JSON.parse(tailles) as { o: number; q: number };
        reserve.originaux += t.o; reserve.quarantaine += t.q;
      }
      const besoin = { originaux: req.body.tailleOriginal!, quarantaine: req.body.tailleCopie! };
      for (const espace of ['originaux', 'quarantaine'] as const) {
        const libre = await stockage.espaceLibre?.(espace);
        if (libre != null && libre - reserve[espace] < besoin[espace] + MARGE_DISQUE) {
          return reply.code(503).send({ erreur: 'serveur_plein' });
        }
      }
    }

    const c = req.body.contexte;
    const quand = new Date(c.date);
    if (quand.getTime() > Date.now() + 10 * 60_000 || quand.getUTCFullYear() < 2000) return reply.code(400).send({ erreur: 'date_invalide' });
    if (!enFrance(c.lieu.lat, c.lieu.lon)) return reply.code(400).send({ erreur: 'lieu_hors_de_france' });
    if ([...c.description.trim()].length < DESCRIPTION_MIN) return reply.code(400).send({ erreur: 'description_trop_courte' });
    // Lieu à établir : le repère est approximatif, gardé à la commune ; date à établir : l'heure n'a pas de sens.
    if (c.lieuAEtablir) c.precision = 'municipality';
    if (c.dateAEtablir) c.heureConnue = false;
    const lieu = arrondir(c.lieu.lat, c.lieu.lon, c.precision);
    const nOriginal = lien ? 0 : decoupage('originaux', req.body.tailleOriginal!).n;
    if (!lien && (req.body.tailleOriginal! - TAILLE_ENTETE) % PAS_CHIFFRE !== 0 && (req.body.tailleOriginal! - TAILLE_ENTETE) % PAS_CHIFFRE <= ETIQUETTE) {
      return reply.code(400).send({ erreur: 'taille_invalide' });   // un morceau chiffré fait au moins 1 octet + l'étiquette
    }

    const id = randomUUID();
    const metadonnees = { coherentes: 'coherent', incoherentes: 'incoherent', absentes: 'absent' }[req.body.metadonnees];
    const client = await bases.app.connect();
    let pseudonyme = '';
    let pseudonymeId = '';
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO core.videos (id, occurred_at, location, location_precision, forces, situation, category, subcategory,
                                  description, language, original_sha256, metadata_check, upload_expires_at, keep_audio,
                                  mask_faces, occurred_time_known, terms_version, extra_subcategories, extra_situations,
                                  date_to_establish, location_to_establish, original_hash_scheme)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 now() + make_interval(secs => $14), $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
        [id, quand, lieu.lat, lieu.lon, c.precision, c.forces, c.situation, c.categorie, c.sousCategorie,
         c.description.trim(), c.langue, lien ? null : Buffer.from(req.body.sha256Original!, 'hex'), metadonnees, DUREE_ENVOI,
         req.body.garderSon ?? true, req.body.masquerVisages ?? true, c.heureConnue ?? true, CONDITIONS_VERSION,
         c.autresSousCategories ?? [], c.autresSituations ?? [], c.dateAEtablir === true, c.lieuAEtablir === true,
         lien ? 0 : 1]);   // empreinte clée (H10) ; envoi par lien : le worker la pose (finish_fetch)
      for (let essai = 0; ; essai++) {
        pseudonyme = pseudonymeAleatoire();
        await client.query('SAVEPOINT p');
        try {
          pseudonymeId = (await client.query<{ id: string }>(
            'INSERT INTO core.pseudonyms (video_id, pseudonym, tracking_code_hash, contact_allowed) VALUES ($1, $2, $3, $4) RETURNING id',
            [id, pseudonyme, Buffer.from(req.body.empreinteSuivi, 'hex'), req.body.contact === true])).rows[0]!.id;
          break;
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT p');
          const err = e as { code?: string; constraint?: string };
          if (err.code === '23505' && err.constraint?.includes('pseudonym') && !err.constraint.includes('tracking') && essai < 5) continue;
          throw e;
        }
      }
      if (compte) await client.query('SELECT core.claim_video($1, $2)', [compte.id, id]);
      if (compte && req.body.codeScelle) await client.query('SELECT core.set_owner_code($1, $2, $3)', [id, compte.id, JSON.stringify(req.body.codeScelle)]);
      if (req.body.messagerie) await enregistrerCleVideo(client, pseudonymeId, req.body.messagerie);
      if (req.body.autorisation) await client.query('SELECT core.grant_release($1, $2, $3)', [id, Buffer.from(req.body.empreinteSuivi, 'hex'), JSON.stringify(req.body.autorisation)]);
      if (req.body.evenement) await client.query('SELECT core.source_propose_event($1, $2)', [id, req.body.evenement]);
      if (o) await client.query('INSERT INTO core.video_origins (video_id, published_by, url, details, is_public) VALUES ($1, $2, $3, $4, $5)',
        [id, o.publiePar ?? null, o.lien ?? null, o.precisions ?? null, o.publique]);
      if (lien) {
        // Clés posées AVANT le passage en traitement : le worker les trouve dès qu'il prend la vidéo.
        await redis.set(cleCopie(id), req.body.cleCopie!, 'EX', DUREE_CLE_COPIE);
        await redis.set(cleOriginal(id), req.body.cleOriginal!, 'EX', DUREE_CLE_COPIE);
        if (compte) await client.query('SELECT core.set_owner_copy_key($1, $2, $3)', [id, compte.id, chiffrer(cles, req.body.cleCopie!)]);
        await client.query('INSERT INTO core.video_fetches (video_id, url) VALUES ($1, $2)', [id, lien]);
        await client.query("UPDATE core.videos SET status = 'processing', upload_expires_at = NULL WHERE id = $1 AND status = 'uploading'", [id]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      const err = e as { code?: string; constraint?: string };
      if (err.code === '23514') return reply.code(400).send({ erreur: 'contexte_invalide' });   // sous-catégorie incohérente…
      if (err.code === '23505') return reply.code(409).send({ erreur: 'phrase_deja_utilisee' });
      throw e;
    } finally {
      client.release();
    }

    if (lien) {
      await bases.identity.query(
        "SELECT identity.log_legal($1, 'upload', $2, $3, $4)",
        [compte?.id ?? null, req.ip, req.socket.remotePort ?? null, id]);
      if (clePasse) await redis.del(clePasse);
      return reply.code(201).send({ envoi: id, pseudonyme });
    }

    await redis.multi()
      .hset(cleEnvoi(id), { empreinte: req.body.empreinteSuivi, originaux: String(req.body.tailleOriginal), quarantaine: String(req.body.tailleCopie!),
                            ...(compte ? { compte: compte.id } : {}) })
      .expire(cleEnvoi(id), DUREE_ENVOI)
      .hset(ENVOIS_ACTIFS, id, JSON.stringify({ o: req.body.tailleOriginal, q: req.body.tailleCopie }))
      .exec();
    if (clePasse) await redis.del(clePasse);
    return reply.code(201).send({
      envoi: id, pseudonyme,
      original: { morceaux: nOriginal }, copie: { morceaux: decoupage('quarantaine', req.body.tailleCopie!).n },
      expireDans: DUREE_ENVOI,
    });
  });

  for (const [chemin, espace] of [['original', 'originaux'], ['copie', 'quarantaine']] as const) {
    app.put<{ Params: { id: string; n: string }; Body: Buffer }>(`/envois/:id/${chemin}/:n`, {
      bodyLimit: TAILLE_ENTETE + PAS_CHIFFRE,
      schema: { params: ID_N },
    }, async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ erreur: 'format_non_accepte' });
      if (!(await consommer(redis, `morceau:ip:${hex('ip', req.ip)}`, 3000, 3600))) return reply.code(429).send({ erreur: 'trop_de_demandes' });
      const e = await envoiAutorise(req, reply, req.params.id);
      if (!e) return reply;
      if (e['finalisation']) return reply.code(409).send({ erreur: 'deja_finalise' });
      const { n, taille } = decoupage(espace, Number(e[espace]));
      const i = Number(req.params.n);
      if (i >= n) return reply.code(400).send({ erreur: 'morceau_inconnu' });
      if (req.body.length !== taille(i)) return reply.code(400).send({ erreur: 'taille_de_morceau', attendue: taille(i) });
      await stockage.ecrireMorceau(espace, req.params.id, i, req.body);
      await redis.multi().sadd(cleRecus(req.params.id, espace), String(i)).expire(cleRecus(req.params.id, espace), DUREE_ENVOI).exec();
      return reply.send({ ok: true });
    });
  }

  app.get<{ Params: { id: string } }>('/envois/:id/etat', { schema: { params: ID } }, async (req, reply) => {
    const e = await envoiAutorise(req, reply, req.params.id);
    if (!e) return reply;
    const recus = async (espace: Espace) =>
      (await redis.smembers(cleRecus(req.params.id, espace))).map(Number).sort((a, b) => a - b);
    return reply.send({
      original: { attendus: decoupage('originaux', Number(e['originaux'])).n, recus: await recus('originaux') },
      copie: { attendus: decoupage('quarantaine', Number(e['quarantaine'])).n, recus: await recus('quarantaine') },
    });
  });

  // La clé de copie (dérivée de la phrase) chiffrera la copie de travail gardée 7 jours pour les
  // retouches. Elle ne va que dans Redis, le temps du traitement : le worker la lit puis l'efface.
  // Jamais en base, jamais au journal (le corps des requêtes n'y est pas écrit).
  app.post<{ Params: { id: string }; Body: { cleCopie: string } }>('/envois/:id/finaliser', {
    schema: {
      params: ID,
      body: { type: 'object', additionalProperties: false, required: ['cleCopie'],
              properties: { cleCopie: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } } },
    },
  }, async (req, reply) => {
    const id = req.params.id;
    const e = await envoiAutorise(req, reply, id);
    if (!e) return reply;
    // Une seule finalisation, même si le navigateur insiste.
    if ((await redis.hsetnx(cleEnvoi(id), 'finalisation', '1')) === 0) return reply.code(409).send({ erreur: 'deja_finalise' });

    const manquants: Record<string, number> = {};
    for (const espace of ['originaux', 'quarantaine'] as const) {
      const attendus = decoupage(espace, Number(e[espace])).n;
      const recus = await redis.scard(cleRecus(id, espace));
      if (recus !== attendus) manquants[espace === 'originaux' ? 'original' : 'copie'] = attendus - recus;
    }
    if (Object.keys(manquants).length) {
      await redis.hdel(cleEnvoi(id), 'finalisation');
      return reply.code(409).send({ erreur: 'morceaux_manquants', manquants });
    }

    const original = await stockage.assembler('originaux', id, decoupage('originaux', Number(e['originaux'])).n);
    await stockage.assembler('quarantaine', id, decoupage('quarantaine', Number(e['quarantaine'])).n);
    if (original.taille !== Number(e['originaux']) || !ressembleAUneVideo(await stockage.debut('quarantaine', id, 16))) {
      await abandonner(id);
      return reply.code(400).send({ erreur: 'fichier_invalide' });
    }

    // Clé posée AVANT le passage en traitement : le worker la trouve dès qu'il prend la vidéo.
    await redis.set(cleCopie(id), req.body.cleCopie, 'EX', DUREE_CLE_COPIE);
    // Vidéo rattachée à un compte : la clé de copie est aussi gardée, chiffrée, pour retoucher le
    // floutage depuis « Mes vidéos » sans le code de 12 mots.
    if (e['compte']) await bases.app.query('SELECT core.set_owner_copy_key($1, $2, $3)', [id, e['compte'], chiffrer(cles, req.body.cleCopie)]);
    await bases.app.query(
      `UPDATE core.videos SET status = 'processing', upload_expires_at = NULL, original_enc_sha256 = $2, r2_original_enc_key = $3
        WHERE id = $1 AND status = 'uploading'`, [id, original.sha256, original.cle]);
    // Journal légal (décret 2021-1362, 0122) : l'opération d'envoi, l'identifiant de la vidéo, le compte s'il y en a un.
    await bases.identity.query(
      "SELECT identity.log_legal($1, 'upload', $2, $3, $4)",
      [e['compte'] ?? null, req.ip, req.socket.remotePort ?? null, id]);
    await redis.del(cleEnvoi(id), cleRecus(id, 'originaux'), cleRecus(id, 'quarantaine'));
    return reply.send({ ok: true, statut: 'traitement' });
  });

  /** Efface un envoi en cours : ligne en base, morceaux, fichiers, état Redis. */
  async function abandonner(id: string) {
    await bases.app.query('SELECT core.abandon_upload($1)', [id]);
    await stockage.supprimer('originaux', id);
    await stockage.supprimer('quarantaine', id);
    await redis.del(cleEnvoi(id), cleRecus(id, 'originaux'), cleRecus(id, 'quarantaine'), cleCopie(id));
  }
}

/** Nettoyage périodique : envois non finalisés depuis plus de 24 h (base, fichiers). */
export async function nettoyerEnvois(deps: Dependances): Promise<number> {
  const r = await deps.bases.app.query<{ id: string }>('SELECT id FROM core.purge_expired_uploads() AS id');
  for (const { id } of r.rows) {
    await deps.stockage.supprimer('originaux', id);
    await deps.stockage.supprimer('quarantaine', id);
  }
  return r.rowCount ?? 0;
}
