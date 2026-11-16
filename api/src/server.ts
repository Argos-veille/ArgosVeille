// Point d'entrée : lit les réglages, ouvre les connexions et démarre le serveur.
import { prevenirMessages } from './messagerie.ts';
import { construireApp } from './app.ts';
import { lireConfig } from './config.ts';
import { lireCle } from './crypto.ts';
import { ouvrirBases } from './db.ts';
import { nettoyerEnvois } from './envois.ts';
import { readFileSync, rmSync } from 'node:fs';
import { FacteurCompose, FacteurFichier, FacteurMail } from './facteur.ts';
import { SmsOvh } from './sms.ts';
import { R2 } from './r2.ts';
import { StockageFichier, StockageR2 } from './stockage.ts';
import { purgerNonPubliees, reprendreSuppressions, validerSansReponse } from './suivi.ts';
import { alerterErreurs } from './alertes.ts';
import { prevenirSources } from './mesvideos.ts';
import { rappelerStatuts } from './compte.ts';
import { prevenirConvocations } from './relecture.ts';
import { chargerListes } from './listes.ts';
import { ouvrirRedis } from './redis.ts';
import { TurnstileCloudflare } from './turnstile.ts';

const config = lireConfig();
const cles = {
  hmac: lireCle(config.cles.hmacFichier),
  mail: lireCle(config.cles.mailFichier),
  mfa: lireCle(config.cles.mfaFichier),
};
const bases = ouvrirBases(config);

// Mails et SMS : faux envoi local (développement) ou réel, chacun de son côté.
const boite = new FacteurFichier(config.boite);
const mails = config.mail.mode === 'smtp'
  ? new FacteurMail({ hote: config.mail.hote, port: config.mail.port, utilisateur: config.mail.utilisateur,
                      motDePasse: readFileSync(config.mail.motDePasseFichier, 'utf8').trim(), expediteur: config.mail.expediteur })
  : boite;
if (mails instanceof FacteurMail) await mails.verifier();   // connexion et identification SMTP vérifiées au démarrage
// Clés OVH : fichier JSON { cleApplication, secretApplication, cleConsommateur } (systemd-creds en production).
const textos = config.sms.mode === 'ovh'
  ? new SmsOvh({ point: config.sms.point, service: config.sms.service, ...(config.sms.expediteur ? { expediteur: config.sms.expediteur } : {}),
                 ...(JSON.parse(readFileSync(config.sms.secretsFichier, 'utf8')) as { cleApplication: string; secretApplication: string; cleConsommateur: string }) })
  : boite;
const facteur = new FacteurCompose(mails, textos);
const redis = ouvrirRedis(config);
await redis.connect();

// Vidéos : Cloudflare R2 en production (clés dans un fichier JSON { cleAcces, secret }), dossiers locaux en dev.
const racines = { originaux: config.stockage, quarantaine: config.quarantaine, floutees: config.floutees, copies: config.copies };
const stockage = config.r2
  ? new StockageR2(racines, new R2({ point: config.r2.point, compartiment: config.r2.compartiment,
                                     ...(JSON.parse(readFileSync(config.r2.secretsFichier, 'utf8')) as { cleAcces: string; secret: string }) }))
  : new StockageFichier(racines);

const deps = {
  bases, redis, cles,
  stockage,
  facteur,
  turnstile: new TurnstileCloudflare(config.turnstileSecret),
  listes: chargerListes(),
  reglages: {
    urlPublique: config.urlPublique, smsPlafondJour: config.smsPlafondJour, envoisParHeure: config.envoisParHeure,
    envoisParIpHeure: config.envoisParIpHeure, envoisCertifiesParHeure: config.envoisCertifiesParHeure,
    administration: config.administration,
    deuxFacteursFactice: config.deuxFacteursFactice,
    origine: config.origine,
    proxyLocal: config.proxyLocal,
    surSocket: !!config.socket,
    prefixeApi: config.prefixeApi,
    clesAdmin: config.clesAdmin,
    beta: config.beta,
    ...(config.copieExterne ? { copieExterne: config.copieExterne } : {}),
    // Le faux facteur local n'existe qu'en développement (refusé par la configuration en production).
    ...(config.mail.mode === 'fichier' || config.sms.mode === 'fichier' ? { boiteDev: config.boite } : {}),
  },
};
const app = construireApp(deps, { journal: true });

// Tâches de fond : une seule instance les fait (ARGOS_TACHES=non pour l'instance d'administration).
// Toutes les heures : effacer les envois jamais finalisés depuis plus de 24 h ; envoyer en relecture
// les vidéos que leur source n'a pas vérifiées en 7 jours (et effacer leur copie de travail).
const nettoyage = !config.taches ? null : setInterval(() => {
  nettoyerEnvois(deps).then((n) => n && app.log.info(`${n} envoi(s) abandonné(s) effacé(s)`))
    .catch((e) => app.log.error({ err: e }, 'échec du nettoyage des envois'));
  validerSansReponse(deps).then((n) => n && app.log.info(`${n} vidéo(s) partie(s) en relecture sans vérification`))
    .catch((e) => app.log.error({ err: e }, 'échec de la validation automatique'));
  purgerNonPubliees(deps, app.log).then((n) => n && app.log.info(`${n} vidéo(s) refusée(s) ou sans décision effacée(s) (30 jours)`))
    .catch((e) => app.log.error({ code: e?.code, message: e?.message }, 'échec de l\'effacement des vidéos refusées'));
  reprendreSuppressions(deps).then((n) => n && app.log.info(`${n} suppression(s) reportée(s) faite(s)`))
    .catch((e) => app.log.error({ code: e?.code, message: e?.message }, 'échec de la reprise des suppressions'));
  deps.bases.app.query<{ n: number }>('SELECT core.purge_request_errors() AS n')
    .catch((e) => app.log.error({ err: e }, 'échec de l\'effacement des erreurs anciennes'));
  // Journaux de connexion imposés par la loi (décret 2021-1362) : effacés au bout d'un an.
  deps.bases.identity.query<{ n: number }>('SELECT identity.purge_legal_logs() AS n')
    .catch((e) => app.log.error({ err: e }, 'échec de l\'effacement des journaux de connexion anciens'));
  deps.bases.app.query<{ n: number }>('SELECT core.purge_contact_messages() AS n')
    .catch((e) => app.log.error({ err: e }, 'échec de l\'effacement des messages de contact anciens'));
  prevenirConvocations(deps).then((n) => n && app.log.info(`${n} relecteur(s) prévenu(s) de nouvelles convocations`))
    .catch((e) => app.log.error({ err: e }, 'échec des mails de convocation'));
  // Statuts annuels : rappel au titulaire 30 jours puis 7 jours avant l'échéance (0118).
  rappelerStatuts(deps).then((n) => n && app.log.info(`${n} rappel(s) d'échéance de statut envoyé(s)`))
    .catch((e) => app.log.error({ err: e }, 'échec des rappels de statut'));
}, 3600_000);
nettoyage?.unref();

// Chaque minute : les mails d'avancement aux personnes qui ont envoyé avec leur compte.
const mailsSources = !config.taches ? null : setInterval(() => {
  prevenirSources(deps).then((n) => n && app.log.info(`${n} mail(s) d'avancement envoyé(s)`))
    .catch((e) => app.log.error({ err: e }, 'échec des mails d\'avancement'));
  prevenirMessages(deps).then((n) => n && app.log.info(`${n} mail(s) de messagerie envoyé(s)`))
    .catch((e) => app.log.error({ err: e }, 'échec des mails de messagerie'));
}, 60_000);
mailsSources?.unref();

// Erreurs en série : alerte par mail au super-administrateur.
const alerteErreurs = !config.taches ? null : setInterval(() => {
  alerterErreurs(deps).catch((e) => app.log.error({ err: e }, 'échec de l\'alerte sur les erreurs du serveur'));
}, 5 * 60_000);
alerteErreurs?.unref();

// R2 : toutes les 15 secondes, déposer les versions floutées que le worker vient de produire.
if (config.taches && stockage instanceof StockageR2) {
  let enCours = false;
  const presente = async (id: string) => (await bases.app.query(
    "SELECT 1 FROM core.videos WHERE id = $1 AND status NOT IN ('withdrawn', 'removed')", [id])).rowCount === 1;
  const enTraitement = async (id: string) => (await bases.app.query(
    "SELECT 1 FROM core.videos WHERE id = $1 AND status = 'processing'", [id])).rowCount === 1;
  const envoiEnCours = async (id: string) => (await bases.app.query(
    "SELECT 1 FROM core.videos WHERE id = $1 AND status = 'uploading'", [id])).rowCount === 1;
  const depot = setInterval(() => {
    if (enCours) return;
    enCours = true;
    stockage.synchroniser(presente, enTraitement, undefined, envoiEnCours).then((n) => n && app.log.info(`${n} version(s) floutée(s) déposée(s) sur R2`))
      .catch((e) => app.log.error({ err: e }, 'échec du dépôt sur R2'))
      .finally(() => { enCours = false; });
  }, 15_000);
  depot.unref();
}

async function arreter(signal: string) {
  app.log.info(`arrêt (${signal})`);
  await app.close();
  await Promise.allSettled([bases.fermer(), redis.quit()]);
  process.exit(0);
}
process.once('SIGINT', () => void arreter('SIGINT'));
process.once('SIGTERM', () => void arreter('SIGTERM'));

if (config.socket) {
  // Socket Unix (API d'administration) : un ancien fichier laissé par un arrêt brutal empêcherait l'écoute.
  rmSync(config.socket, { force: true });
  await app.listen({ path: config.socket });
} else {
  await app.listen({ host: config.host, port: config.port });
}
