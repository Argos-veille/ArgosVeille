import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, lireConfig } from '../src/config.ts';

const complet = {
  ARGOS_HOST: '127.0.0.1', ARGOS_PORT: '3000',
  ARGOS_PG_HOST: '127.0.0.1', ARGOS_PG_PORT: '5432', ARGOS_PG_DATABASE: 'argos_test',
  ARGOS_PG_APP_PASSWORD: 'a', ARGOS_PG_IDENTITY_PASSWORD: 'b', ARGOS_PG_ADMIN_PASSWORD: 'c',
  ARGOS_REDIS_URL: 'redis://127.0.0.1:6379/15',
  ARGOS_CLE_HMAC: '.secrets/hmac.key', ARGOS_CLE_MAIL: '.secrets/mail.key', ARGOS_CLE_MFA: '.secrets/mfa.key',
  ARGOS_TURNSTILE_SECRET: 'x', ARGOS_URL_PUBLIQUE: 'https://argos.test',
  ARGOS_FACTEUR: 'fichier', ARGOS_BOITE: '.boite', ARGOS_SMS_PLAFOND_JOUR: '200',
  ARGOS_STOCKAGE: '.stockage/o', ARGOS_QUARANTAINE: '.stockage/q', ARGOS_FLOUTEES: '.stockage/f', ARGOS_COPIES: '.stockage/c', ARGOS_ENVOIS_PAR_HEURE: '60',
};

test('réglages complets acceptés', () => {
  const c = lireConfig(complet);
  assert.equal(c.port, 3000);
  assert.equal(c.pg.database, 'argos_test');
});

test('un mot de passe manquant ou vide arrête le démarrage', () => {
  assert.throws(() => lireConfig({ ...complet, ARGOS_PG_APP_PASSWORD: undefined }), ConfigError);
  assert.throws(() => lireConfig({ ...complet, ARGOS_PG_IDENTITY_PASSWORD: '  ' }), ConfigError);
});

test('le faux envoi local est interdit en production', () => {
  assert.throws(() => lireConfig({ ...complet, NODE_ENV: 'production' }), ConfigError);
});

test('adresse publique invalide refusée', () => {
  for (const u of ['argos.test', 'https://argos.test/chemin', 'ftp://argos.test']) {
    assert.throws(() => lireConfig({ ...complet, ARGOS_URL_PUBLIQUE: u }), ConfigError, u);
  }
});

test('port invalide refusé', () => {
  for (const p of ['0', '70000', 'abc', '30.5']) {
    assert.throws(() => lireConfig({ ...complet, ARGOS_PORT: p }), ConfigError, p);
  }
});

test('adresse Redis invalide refusée', () => {
  assert.throws(() => lireConfig({ ...complet, ARGOS_REDIS_URL: 'http://127.0.0.1' }), ConfigError);
});

test('mails par SMTP : réglages exigés, faux envoi des SMS toujours interdit en production', () => {
  const smtp = { ...complet, ARGOS_FACTEUR: undefined, ARGOS_MAIL: 'smtp', ARGOS_SMS: 'fichier',
                 ARGOS_SMTP_HOTE: 'mail.infomaniak.com', ARGOS_SMTP_PORT: '587', ARGOS_SMTP_UTILISATEUR: 'contact@argos-veille.fr',
                 ARGOS_SMTP_MOT_DE_PASSE_FICHIER: '/run/credentials/argos-api/smtp', ARGOS_SMTP_EXPEDITEUR: 'Argos Veille <contact@argos-veille.fr>' };
  const c = lireConfig(smtp);
  assert.deepEqual([c.mail.mode, c.sms.mode], ['smtp', 'fichier']);
  assert.throws(() => lireConfig({ ...smtp, ARGOS_SMTP_MOT_DE_PASSE_FICHIER: undefined }), ConfigError);
  assert.throws(() => lireConfig({ ...smtp, ARGOS_SMTP_EXPEDITEUR: 'contact@argos-veille.fr' }), ConfigError);
  assert.throws(() => lireConfig({ ...smtp, NODE_ENV: 'production' }), /interdit en production/);
  assert.throws(() => lireConfig({ ...smtp, ARGOS_MAIL: 'pigeon' }), ConfigError);
});

test('administration : explicite en production, oui par défaut en développement', () => {
  assert.equal(lireConfig(complet).administration, true);
  assert.equal(lireConfig({ ...complet, ARGOS_ADMINISTRATION: 'non' }).administration, false);
  assert.throws(() => lireConfig({ ...complet, ARGOS_ADMINISTRATION: 'peut-être' }), ConfigError);
});

test('fausse double authentification : développement seulement', () => {
  assert.equal(lireConfig(complet).deuxFacteursFactice, false);
  assert.equal(lireConfig({ ...complet, ARGOS_2FA_FACTICE: 'oui' }).deuxFacteursFactice, true);
  assert.throws(() => lireConfig({ ...complet, ARGOS_2FA_FACTICE: 'oui', ARGOS_PG_DATABASE: 'argos' }), ConfigError);
  assert.throws(() => lireConfig({ ...complet, ARGOS_2FA_FACTICE: 'oui', ARGOS_PROXY_LOCAL: 'oui' }), ConfigError);
});

test('rôle de base de l’administration : exigé pour l’instance d’administration, jamais donné à l’instance publique', () => {
  assert.throws(() => lireConfig({ ...complet, ARGOS_PG_ADMIN_PASSWORD: undefined }), ConfigError);   // développement : admin par défaut
  const publique = lireConfig({ ...complet, ARGOS_ADMINISTRATION: 'non', ARGOS_PG_ADMIN_PASSWORD: undefined });
  assert.equal(publique.pg.adminPassword, null);
  assert.equal(lireConfig({ ...complet, ARGOS_ADMINISTRATION: 'non' }).pg.adminPassword, null);   // ignoré s'il traîne
});

test('Redis : sans mot de passe en développement', () => {
  assert.equal(lireConfig(complet).redisPassword, null);
});

test('socket Unix au lieu du port (API d\'administration, audit H3)', () => {
  const c = lireConfig({ ...complet, ARGOS_SOCKET: '/run/argos-admin/api.sock', ARGOS_PORT: undefined });
  assert.equal(c.socket, '/run/argos-admin/api.sock');
  assert.throws(() => lireConfig({ ...complet, ARGOS_SOCKET: '/tmp/api.sock' }), ConfigError);
  assert.throws(() => lireConfig({ ...complet, ARGOS_SOCKET: '/run/../etc/x.sock' }), ConfigError);
  assert.equal(lireConfig(complet).socket, undefined);
});

test('administration en production : liste des clés physiques obligatoire (audit M12)', async () => {
  const { cleAdminAutorisee } = await import('../src/webauthn.ts');
  assert.equal(cleAdminAutorisee('a', { NODE_ENV: 'production' }), false);   // liste vide en production : aucune clé
  assert.equal(cleAdminAutorisee('a', { NODE_ENV: 'development' }), true);
  assert.equal(cleAdminAutorisee('a', { NODE_ENV: 'production', ARGOS_PASSKEYS_ADMIN: 'b, a' }), true);
});
