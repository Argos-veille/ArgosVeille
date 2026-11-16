// Mails réels : le message produit (sans rien envoyer), grâce au transport « flux » de nodemailer.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import nodemailer from 'nodemailer';
import { FacteurCompose, FacteurMail, sansCoordonnees } from '../src/facteur.ts';

test('mail SMTP : expéditeur, sujet accentué encodé, texte brut, en-têtes de mail automatique', async () => {
  const brut: string[] = [];
  const flux = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const transport = { ...flux, sendMail: async (e: Parameters<typeof flux.sendMail>[0]) => {
    const r = await flux.sendMail(e);
    brut.push(String(r.message));
    return r;
  }, verify: flux.verify.bind(flux), close: flux.close.bind(flux) };
  const mails = new FacteurMail({ hote: 'x', port: 587, utilisateur: 'u', motDePasse: 'p', expediteur: 'Argos Veille <contact@argos-veille.fr>' },
                                transport);
  const textos: string[] = [];
  const facteur = new FacteurCompose(mails, { sms: async (n, t) => { textos.push(`${n}|${t}`); } });
  await facteur.mail('relecteur@exemple.fr', 'Argos Veille : réinitialiser votre mot de passe', 'Bonjour,\nvoici le lien : https://argos-veille.fr/recuperation#abc');
  await facteur.sms('+33600000000', 'code 123456');
  const m = brut[0]!;
  assert.match(m, /^From: Argos Veille <contact@argos-veille\.fr>$/m);
  assert.match(m, /^To: relecteur@exemple\.fr$/m);
  assert.match(m, /^Subject: =\?UTF-8\?/m);              // accents encodés selon la norme des en-têtes
  assert.match(m, /^Auto-Submitted: auto-generated$/m);
  assert.match(m, /^Content-Type: text\/plain; charset=utf-8$/m);
  assert.ok(!/text\/html/.test(m));                       // texte brut : ni HTML, ni image, ni pixel de suivi
  assert.deepEqual(textos, ['+33600000000|code 123456']);
});

test('SMS OVH : requête signée selon le schéma d\'OVH, horloge alignée sur celle d\'OVH', async () => {
  const { SmsOvh, signatureOvh } = await import('../src/sms.ts');
  const appels: { url: string; init?: RequestInit }[] = [];
  const faux = (async (url: string | URL | Request, init?: RequestInit) => {
    appels.push({ url: String(url), ...(init ? { init } : {}) });
    if (String(url).endsWith('/auth/time')) return new Response('1800000000');
    return Response.json({ ids: [1], invalidReceivers: [], totalCreditsRemoved: 1 });
  }) as typeof fetch;
  const sms = new SmsOvh({ point: 'https://eu.api.ovh.com/1.0', service: 'sms-ab12345-1', cleApplication: 'APP',
                           secretApplication: 'SECRET', cleConsommateur: 'CONSO' }, faux);
  await sms.sms('+33600000001', "Argos Veille : votre code d'inscription est 123456.");
  const envoi = appels[1]!;
  assert.equal(envoi.url, 'https://eu.api.ovh.com/1.0/sms/sms-ab12345-1/jobs');
  const h = envoi.init!.headers as Record<string, string>;
  const corps = String(envoi.init!.body);
  assert.deepEqual(JSON.parse(corps).receivers, ['+33600000001']);
  assert.equal(JSON.parse(corps).noStopClause, true);
  assert.equal(h['X-Ovh-Signature'], signatureOvh('SECRET', 'CONSO', 'POST', envoi.url, corps, Number(h['X-Ovh-Timestamp'])));
  assert.ok(Math.abs(Number(h['X-Ovh-Timestamp']) - 1800000000) < 5);
  // Exemple calculé à la main : $1$ + sha1("S+C+GET+https://eu.api.ovh.com/1.0/me++1")
  assert.equal(signatureOvh('S', 'C', 'GET', 'https://eu.api.ovh.com/1.0/me', '', 1),
               `$1$${(await import('node:crypto')).createHash('sha1').update('S+C+GET+https://eu.api.ovh.com/1.0/me++1').digest('hex')}`);
  // Refus d'OVH : erreur explicite, sans le numéro.
  const refus = new SmsOvh({ point: 'https://eu.api.ovh.com/1.0', service: 's', cleApplication: 'a', secretApplication: 'b', cleConsommateur: 'c' },
    (async (u: string | URL | Request) => (String(u).endsWith('/auth/time') ? new Response('1') : new Response('{"message":"crédits épuisés"}', { status: 403 }))) as typeof fetch);
  await assert.rejects(refus.sms('+33600000002', 'x'), (e: Error) => /403/.test(e.message) && !e.message.includes('+3360'));
  // OVH qui cite le numéro dans son refus : retiré.
  const citeLeNumero = new SmsOvh({ point: 'https://eu.api.ovh.com/1.0', service: 's', cleApplication: 'a', secretApplication: 'b', cleConsommateur: 'c' },
    (async (u: string | URL | Request) => (String(u).endsWith('/auth/time') ? new Response('1')
      : new Response('{"message":"Invalid receiver +33600000003 (06 00 00 00 03)"}', { status: 400 }))) as typeof fetch);
  await assert.rejects(citeLeNumero.sms('+33600000003', 'x'), (e: Error) => /400/.test(e.message) && !/0{4}/.test(e.message));
});

test('mail SMTP refusé : l\'erreur ne contient pas le destinataire', async () => {
  const refus = Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <victime@exemple.fr>: unknown"),
                              { code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO', rejected: ['victime@exemple.fr'] });
  const transport = { sendMail: async () => { throw refus; }, verify: async () => true, close: () => {} };
  const mails = new FacteurMail({ hote: 'x', port: 587, utilisateur: 'u', motDePasse: 'p', expediteur: 'a@b.fr' },
                                transport as unknown as ConstructorParameters<typeof FacteurMail>[1]);
  await assert.rejects(mails.mail('victime@exemple.fr', 's', 't'), (e: Error) =>
    /550/.test(e.message) && /EENVELOPE/.test(e.message) && !JSON.stringify({ ...e, m: e.message }).includes('victime'));
  assert.equal(sansCoordonnees('refus de a.b@c.fr et du 06 12 34 56 78'), 'refus de [adresse] et du [numéro]');
});
