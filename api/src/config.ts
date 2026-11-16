import { readFileSync } from 'node:fs';

// Réglages de l'API, lus dans les variables d'environnement et vérifiés au démarrage.
// Un réglage absent ou invalide arrête le serveur : jamais de valeur par défaut pour un secret.

export interface Config {
  host: string;
  port: number;
  /** Socket Unix (chemin absolu) au lieu d'un port : API d'administration, joignable par Caddy seulement (audit H3). */
  socket?: string;
  pg: {
    host: string;
    port: number;
    database: string;
    appPassword: string;       // rôle argos_api (hérite d'argos_app)
    adminPassword: string | null;   // rôle argos_api_admin (argos_administration) : instance d'administration seulement
    identityPassword: string;  // rôle argos_api_identity (hérite d'argos_identity)
  };
  redisUrl: string;
  redisPassword: string | null;   // mot de passe Redis (production : fichier systemd ; développement : aucun)
  cles: {
    hmacFichier: string;     // clé HMAC du téléphone et du mail (à sauvegarder : sans elle, plus de bannis reconnus)
    mailFichier: string;     // clé de chiffrement des mails
    mfaFichier: string;      // clé de chiffrement des secrets de double authentification
  };
  turnstileSecret: string;   // clé secrète Cloudflare Turnstile
  urlPublique: string;       // adresse du site, pour les liens envoyés par mail (et domaine des clés de sécurité)
  origine: string;           // origine acceptée des requêtes (admin.argos-veille.fr pour l'instance d'administration)
  proxyLocal: boolean;       // derrière cloudflared : adresse du visiteur prise dans X-Forwarded-For (boucle locale seulement)
  prefixeApi: string;        // « /api » en production (le tunnel envoie /api/… à l'API), vide en développement
  taches: boolean;           // tâches de fond (nettoyage, dépôt R2, convocations) : une seule instance
  // Envoi des mails et des SMS : « fichier » = faux envoi local (développement, interdit en production).
  mail: { mode: 'fichier' } | { mode: 'smtp'; hote: string; port: number; utilisateur: string; motDePasseFichier: string; expediteur: string };
  sms: { mode: 'fichier' } | { mode: 'ovh'; point: string; service: string; secretsFichier: string; expediteur?: string };
  boite: string;             // dossier du faux envoi local
  // Cloudflare R2 (production) : originaux chiffrés et versions floutées. Absent : dossiers locaux seulement.
  r2: { point: string; compartiment: string; secretsFichier: string } | null;
  administration: boolean;   // routes /admin/* servies par cette instance (obligatoirement explicite en production)
  smsPlafondJour: number;    // nombre maximal de SMS d'inscription par jour, pour tout le site
  stockage: string;          // dossier des originaux chiffrés (développement ; R2 en production)
  quarantaine: string;       // dossier des copies de travail en attente du floutage (volume chiffré à clé jetable en production)
  floutees: string;          // dossier des versions floutées (produites par le worker)
  copies: string;            // copies de travail chiffrées (clé de copie de la source) et pistes, 7 jours au plus
  envoisParHeure: number;    // plafond global d'envois de vidéos par heure
  envoisParIpHeure: number;   // envois par adresse IP et par heure (5 par défaut ; plus en développement)
  envoisCertifiesParHeure: number;   // envois par heure d'un compte certifié ou de confiance, avec son compte (20 par défaut)
  clesAdmin: string[];       // clés publiques d'administration (transmission de l'original), séparées par des virgules
  copieExterne?: string;     // secret du signal de la copie tirée par le serveur de copie (B13), facultatif
  beta: boolean;             // ARGOS_BETA=oui : site réservé aux codes bêta (instance publique)
  deuxFacteursFactice: boolean;   // ARGOS_2FA_FACTICE=oui : DÉVELOPPEMENT SEULEMENT, « 000000 » vaut code de double authentification
}

export class ConfigError extends Error {}

function cheminSocket(chemin: string): string {
  if (!/^\/run\/[a-z0-9-]+\/[a-z0-9-]+\.sock$/.test(chemin)) throw new ConfigError('ARGOS_SOCKET doit être un chemin /run/<dossier>/<nom>.sock');
  return chemin;
}

/** Fausse double authentification (tests à la main en développement) : refusée sur la base de production, avec le
 *  vrai facteur SMTP ou derrière le tunnel. */
function facticeDev(env: NodeJS.ProcessEnv): boolean {
  if (!ouiNon(env, 'ARGOS_2FA_FACTICE', false)) return false;
  if (env['ARGOS_PG_DATABASE'] === 'argos' || env['ARGOS_MAIL'] === 'smtp' || ouiNon(env, 'ARGOS_PROXY_LOCAL', false)) {
    throw new ConfigError('ARGOS_2FA_FACTICE est réservé au développement (refusé avec la base « argos », le SMTP ou le tunnel)');
  }
  return true;
}

/** Clés publiques d'administration : points P-256 non compressés (65 octets, commençant par 04), en base64. */
function clesPubliques(valeur: string): string[] {
  const cles = valeur.split(',').map((c) => c.trim()).filter(Boolean);
  for (const c of cles) {
    const o = Buffer.from(c, 'base64');
    if (o.length !== 65 || o[0] !== 4 || o.toString('base64') !== c) throw new ConfigError('ARGOS_CLES_ADMIN : clé publique P-256 invalide');
  }
  return cles;
}

/** Secret : lu dans le fichier indiqué par CLE_FICHIER (systemd-creds en production), sinon dans CLE. */
function secret(env: NodeJS.ProcessEnv, cle: string): string {
  const fichier = env[`${cle}_FICHIER`]?.trim();
  if (fichier) {
    const v = readFileSync(fichier, 'utf8').trim();
    if (!v) throw new ConfigError(`fichier de secret vide : ${cle}_FICHIER`);
    return v;
  }
  return requis(env, cle);
}

const ouiNon = (env: NodeJS.ProcessEnv, cle: string, defaut: boolean): boolean => {
  const v = env[cle]?.trim();
  if (!v) return defaut;
  if (v !== 'oui' && v !== 'non') throw new ConfigError(`${cle} : oui ou non`);
  return v === 'oui';
};

function requis(env: NodeJS.ProcessEnv, cle: string): string {
  const v = env[cle];
  if (v === undefined || v.trim() === '') throw new ConfigError(`réglage manquant : ${cle}`);
  return v.trim();
}

function entier(env: NodeJS.ProcessEnv, cle: string, min: number, max: number): number {
  const v = requis(env, cle);
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`valeur invalide : ${cle}=${v}`);
  return n;
}

export function lireConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const redisUrl = requis(env, 'ARGOS_REDIS_URL');
  if (!/^rediss?:\/\//.test(redisUrl)) throw new ConfigError('ARGOS_REDIS_URL doit commencer par redis:// ou rediss://');
  const urlPublique = requis(env, 'ARGOS_URL_PUBLIQUE').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(urlPublique)) throw new ConfigError('ARGOS_URL_PUBLIQUE doit être une adresse de site, sans chemin');
  // ARGOS_FACTEUR=fichier (ancien réglage) vaut ARGOS_MAIL=fichier et ARGOS_SMS=fichier.
  const ancien = env['ARGOS_FACTEUR']?.trim();
  if (ancien && ancien !== 'fichier') throw new ConfigError(`ARGOS_FACTEUR inconnu : ${ancien}`);
  const modeMail = env['ARGOS_MAIL']?.trim() || (ancien ? 'fichier' : requis(env, 'ARGOS_MAIL'));
  const modeSms = env['ARGOS_SMS']?.trim() || (ancien ? 'fichier' : requis(env, 'ARGOS_SMS'));
  let mail: Config['mail'];
  if (modeMail === 'fichier') mail = { mode: 'fichier' };
  else if (modeMail === 'smtp') {
    const expediteur = requis(env, 'ARGOS_SMTP_EXPEDITEUR');
    if (!/<[^@\s<>]+@[^@\s<>]+>$/.test(expediteur)) throw new ConfigError('ARGOS_SMTP_EXPEDITEUR : « Nom <adresse> »');
    mail = { mode: 'smtp', hote: requis(env, 'ARGOS_SMTP_HOTE'), port: entier(env, 'ARGOS_SMTP_PORT', 1, 65535),
             utilisateur: requis(env, 'ARGOS_SMTP_UTILISATEUR'), motDePasseFichier: requis(env, 'ARGOS_SMTP_MOT_DE_PASSE_FICHIER'),
             expediteur };
  } else throw new ConfigError(`ARGOS_MAIL inconnu : ${modeMail}`);
  let sms: Config['sms'];
  if (modeSms === 'fichier') sms = { mode: 'fichier' };
  else if (modeSms === 'ovh') {
    const point = (env['ARGOS_OVH_POINT']?.trim() || 'https://eu.api.ovh.com/1.0').replace(/\/+$/, '');
    if (!/^https:\/\/[a-z.-]+\.ovh\.com\/1\.0$/.test(point)) throw new ConfigError('ARGOS_OVH_POINT invalide');
    const expediteur = env['ARGOS_OVH_SMS_EXPEDITEUR']?.trim();
    sms = { mode: 'ovh', point, service: requis(env, 'ARGOS_OVH_SMS_SERVICE'),
            secretsFichier: requis(env, 'ARGOS_OVH_SECRETS_FICHIER'), ...(expediteur ? { expediteur } : {}) };
  } else throw new ConfigError(`ARGOS_SMS inconnu : ${modeSms}`);
  if (env['NODE_ENV'] === 'production' && (mail.mode === 'fichier' || sms.mode === 'fichier')) {
    throw new ConfigError('le faux envoi local est interdit en production');
  }
  const admin = env['ARGOS_ADMINISTRATION']?.trim();
  if (admin !== undefined && admin !== '' && admin !== 'oui' && admin !== 'non') throw new ConfigError('ARGOS_ADMINISTRATION : oui ou non');
  if (env['NODE_ENV'] === 'production' && !admin) {
    throw new ConfigError('ARGOS_ADMINISTRATION obligatoire en production (non pour l\'instance publique, oui pour celle du VPN)');
  }
  const administration = admin ? admin === 'oui' : true;   // développement : oui par défaut
  // Audit M12 : en production, l'administration ne démarre pas sans la liste des clés physiques autorisées
  // (15-cles-admin.sh) ; sinon n'importe quelle clé ajoutée au compte du super-administrateur serait acceptée.
  if (administration && env['NODE_ENV'] === 'production' && !(env['ARGOS_PASSKEYS_ADMIN'] ?? '').split(',').some((x) => x.trim())) {
    throw new ConfigError('ARGOS_PASSKEYS_ADMIN obligatoire pour l\'administration en production (lancer 15-cles-admin.sh)');
  }
  const origine = (env['ARGOS_ORIGINE']?.trim() || urlPublique).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(origine)) throw new ConfigError('ARGOS_ORIGINE doit être une adresse de site, sans chemin');
  const prefixeApi = env['ARGOS_PREFIXE_API']?.trim() ?? '';
  if (prefixeApi && !/^\/[a-z]+$/.test(prefixeApi)) throw new ConfigError('ARGOS_PREFIXE_API : « /api » ou vide');
  let r2: Config['r2'] = null;
  if (env['ARGOS_R2_POINT']?.trim()) {
    const point = env['ARGOS_R2_POINT'].trim().replace(/\/+$/, '');
    if (!/^https:\/\/[0-9a-f]{32}\.(eu\.)?r2\.cloudflarestorage\.com$/.test(point)) throw new ConfigError('ARGOS_R2_POINT invalide');
    const compartiment = requis(env, 'ARGOS_R2_COMPARTIMENT');
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(compartiment)) throw new ConfigError('ARGOS_R2_COMPARTIMENT invalide');
    r2 = { point, compartiment, secretsFichier: requis(env, 'ARGOS_R2_SECRETS_FICHIER') };
  } else if (env['NODE_ENV'] === 'production') {
    throw new ConfigError('ARGOS_R2_POINT est obligatoire en production (vidéos sur Cloudflare R2)');
  }
  return {
    host: requis(env, 'ARGOS_HOST'),
    port: env['ARGOS_SOCKET'] ? 0 : entier(env, 'ARGOS_PORT', 1, 65535),
    ...(env['ARGOS_SOCKET'] ? { socket: cheminSocket(env['ARGOS_SOCKET']) } : {}),
    pg: {
      host: requis(env, 'ARGOS_PG_HOST'),
      port: entier(env, 'ARGOS_PG_PORT', 1, 65535),
      database: requis(env, 'ARGOS_PG_DATABASE'),
      appPassword: secret(env, 'ARGOS_PG_APP_PASSWORD'),
      // Instance d'administration : son propre rôle, seul autorisé à exécuter les fonctions d'administration (0099).
      adminPassword: administration ? secret(env, 'ARGOS_PG_ADMIN_PASSWORD') : null,
      identityPassword: secret(env, 'ARGOS_PG_IDENTITY_PASSWORD'),
    },
    redisUrl,
    redisPassword: env['ARGOS_REDIS_PASSWORD_FICHIER']?.trim() || env['ARGOS_REDIS_PASSWORD']?.trim()
      ? secret(env, 'ARGOS_REDIS_PASSWORD') : null,
    cles: {
      hmacFichier: requis(env, 'ARGOS_CLE_HMAC'),
      mailFichier: requis(env, 'ARGOS_CLE_MAIL'),
      mfaFichier: requis(env, 'ARGOS_CLE_MFA'),
    },
    turnstileSecret: secret(env, 'ARGOS_TURNSTILE_SECRET'),
    urlPublique,
    mail,
    sms,
    r2,
    administration,
    origine,
    proxyLocal: ouiNon(env, 'ARGOS_PROXY_LOCAL', false),
    prefixeApi,
    taches: ouiNon(env, 'ARGOS_TACHES', true),
    boite: mail.mode === 'fichier' || sms.mode === 'fichier' ? requis(env, 'ARGOS_BOITE') : (env['ARGOS_BOITE'] ?? ''),
    smsPlafondJour: entier(env, 'ARGOS_SMS_PLAFOND_JOUR', 1, 1_000_000),
    stockage: requis(env, 'ARGOS_STOCKAGE'),
    quarantaine: requis(env, 'ARGOS_QUARANTAINE'),
    floutees: requis(env, 'ARGOS_FLOUTEES'),
    copies: requis(env, 'ARGOS_COPIES'),
    envoisParHeure: entier(env, 'ARGOS_ENVOIS_PAR_HEURE', 1, 100_000),
    envoisParIpHeure: env['ARGOS_ENVOIS_PAR_IP_HEURE'] ? entier(env, 'ARGOS_ENVOIS_PAR_IP_HEURE', 1, 10_000) : 5,
    envoisCertifiesParHeure: env['ARGOS_ENVOIS_CERTIFIES_HEURE'] ? entier(env, 'ARGOS_ENVOIS_CERTIFIES_HEURE', 1, 10_000) : 20,
    clesAdmin: clesPubliques(env['ARGOS_CLES_ADMIN'] ?? ''),
    beta: ouiNon(env, 'ARGOS_BETA', false),
    ...(env['ARGOS_COPIE_EXTERNE_FICHIER']?.trim() ? { copieExterne: secret(env, 'ARGOS_COPIE_EXTERNE') } : {}),
    deuxFacteursFactice: facticeDev(env),
  };
}
