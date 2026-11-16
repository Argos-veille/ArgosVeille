// Envoi des SMS et des mails. Une interface, plusieurs facteurs : le faux envoi local en
// développement ; en production, les mails par SMTP (Infomaniak, contact@argos-veille.fr) et les SMS
// par un fournisseur (sms.ts).
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer, { type Transport } from 'nodemailer';

export interface Facteur {
  sms(numero: string, texte: string): Promise<void>;
  mail(adresse: string, sujet: string, texte: string): Promise<void>;
}

/** Développement : écrit chaque envoi dans un fichier local (dossier gitignoré, droits 700). */
export class FacteurFichier implements Facteur {
  constructor(private readonly dossier: string) {}

  private async ecrire(fichier: string, envoi: object) {
    await mkdir(this.dossier, { recursive: true, mode: 0o700 });
    await appendFile(join(this.dossier, fichier), JSON.stringify({ date: new Date().toISOString(), ...envoi }) + '\n',
                     { mode: 0o600 });
  }

  sms(numero: string, texte: string) {
    return this.ecrire('sms.log', { numero, texte });
  }

  mail(adresse: string, sujet: string, texte: string) {
    return this.ecrire('mails.log', { adresse, sujet, texte });
  }
}

export interface ReglagesSmtp {
  hote: string;            // mail.infomaniak.com
  port: number;            // 587 (STARTTLS obligatoire)
  utilisateur: string;     // contact@argos-veille.fr
  motDePasse: string;      // lu dans un fichier de secret (systemd-creds en production), jamais dans .env
  expediteur: string;      // « Argos Veille <contact@argos-veille.fr> »
}

/** Mails réels par SMTP : chiffrement exigé (STARTTLS, TLS 1.2 au moins), texte brut, aucun traceur. */
export class FacteurMail {
  private readonly transport: Transport;

  constructor(private readonly r: ReglagesSmtp, transport?: Transport) {
    this.transport = transport ?? nodemailer.createTransport({
      host: r.hote, port: r.port, secure: r.port === 465, requireTLS: r.port !== 465,
      auth: { user: r.utilisateur, pass: r.motDePasse },
      tls: { minVersion: 'TLSv1.2', servername: r.hote },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    });
  }

  async mail(adresse: string, sujet: string, texte: string) {
    try {
      await this.transport.sendMail({
        from: this.r.expediteur, to: adresse, subject: sujet, text: texte,
        // Mail automatique : pas de réponse automatique d'absence en retour.
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
      });
    } catch (e) {
      throw erreurSansAdresse(e);
    }
  }

  /** Vérifie la connexion et l'identification au démarrage (sans rien envoyer). */
  verifier() {
    return this.transport.verify();
  }
}

/** Erreur SMTP réécrite sans destinataire : nodemailer reprend l'adresse refusée dans son message et dans ses champs
 *  (rejected, response…), que le journal de l'API recopierait. On ne garde que les codes, utiles au diagnostic. */
export function erreurSansAdresse(e: unknown): Error {
  const err = (e ?? {}) as { code?: unknown; responseCode?: unknown; command?: unknown };
  const morceaux = [typeof err.code === 'string' ? err.code : null,
                    typeof err.responseCode === 'number' ? `réponse ${err.responseCode}` : null,
                    typeof err.command === 'string' ? `commande ${err.command}` : null].filter(Boolean);
  return new Error(`envoi du mail refusé${morceaux.length ? ` (${morceaux.join(', ')})` : ''}`);
}

/** Retire d'un texte de fournisseur tout ce qui ressemble à une adresse ou à un numéro de téléphone. */
export function sansCoordonnees(texte: string) {
  return texte.replace(/[^\s"'<>,;:()]+@[^\s"'<>,;:()]+/g, '[adresse]').replace(/\+?\d[\d .-]{6,}\d/g, '[numéro]');
}

export interface FournisseurSms {
  sms(numero: string, texte: string): Promise<void>;
}

/** Assemble un envoyeur de mails et un envoyeur de SMS (faux envoi local ou réel, chacun de son côté). */
export class FacteurCompose implements Facteur {
  constructor(private readonly mails: Pick<Facteur, 'mail'>, private readonly textos: FournisseurSms) {}
  sms(numero: string, texte: string) { return this.textos.sms(numero, texte); }
  mail(adresse: string, sujet: string, texte: string) { return this.mails.mail(adresse, sujet, texte); }
}

/** Développement : les derniers envois de la boîte locale (pour la page « boîte de dev » du site). */
export async function derniersEnvois(dossier: string, n = 10) {
  const { readFile } = await import('node:fs/promises');
  const lire = async (f: string) => {
    try {
      return (await readFile(join(dossier, f), 'utf8')).trim().split('\n').filter(Boolean).slice(-n)
        .map((l) => JSON.parse(l) as Record<string, string>).reverse();
    } catch {
      return [];
    }
  };
  return { sms: await lire('sms.log'), mails: await lire('mails.log') };
}
