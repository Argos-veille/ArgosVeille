// SMS réels par l'API d'OVHcloud (décision du 5 novembre 2026). Requêtes signées selon le schéma d'OVH :
//   X-Ovh-Signature = « $1$ » + SHA-1( secret d'application + « + » + clé de consommateur + « + » + méthode
//                     + « + » + adresse complète + « + » + corps + « + » + horodatage )
// Les clés sont lues dans un fichier de secret (systemd-creds en production), jamais dans les réglages.
// Un seul SMS existe : le code d'inscription. Message transactionnel, sans mention « STOP » (noStopClause).
import { createHash } from 'node:crypto';
import { sansCoordonnees, type FournisseurSms } from './facteur.ts';

export interface ReglagesOvh {
  point: string;              // https://eu.api.ovh.com/1.0
  service: string;            // nom du compte SMS chez OVH (sms-xx00000-1)
  cleApplication: string;
  secretApplication: string;
  cleConsommateur: string;
  expediteur?: string;        // nom d'expéditeur validé par OVH ; sans lui, numéro court d'OVH
}

/** Signature d'une requête à l'API d'OVH. */
export function signatureOvh(secret: string, cleConsommateur: string, methode: string, url: string, corps: string, horodatage: number) {
  return `$1$${createHash('sha1').update([secret, cleConsommateur, methode, url, corps, String(horodatage)].join('+')).digest('hex')}`;
}

export class SmsOvh implements FournisseurSms {
  private decalage = 0;   // écart entre notre horloge et celle d'OVH, en secondes (mesuré une fois)
  private decalageMesure = false;

  constructor(private readonly r: ReglagesOvh, private readonly appel: typeof fetch = fetch) {}

  private async heureOvh(): Promise<number> {
    if (!this.decalageMesure) {
      const t = await this.appel(`${this.r.point}/auth/time`, { signal: AbortSignal.timeout(5_000) });
      if (t.ok) this.decalage = Number(await t.text()) - Math.floor(Date.now() / 1000);
      this.decalageMesure = true;
    }
    return Math.floor(Date.now() / 1000) + this.decalage;
  }

  async sms(numero: string, texte: string): Promise<void> {
    const url = `${this.r.point}/sms/${encodeURIComponent(this.r.service)}/jobs`;
    const corps = JSON.stringify({
      message: texte, receivers: [numero], charset: 'UTF-8', priority: 'high', noStopClause: true,
      ...(this.r.expediteur ? { sender: this.r.expediteur } : { senderForResponse: true }),
    });
    const horodatage = await this.heureOvh();
    const r = await this.appel(url, {
      method: 'POST', body: corps, signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'X-Ovh-Application': this.r.cleApplication,
        'X-Ovh-Consumer': this.r.cleConsommateur,
        'X-Ovh-Timestamp': String(horodatage),
        'X-Ovh-Signature': signatureOvh(this.r.secretApplication, this.r.cleConsommateur, 'POST', url, corps, horodatage),
      },
    });
    if (!r.ok) {
      // Le détail d'OVH est utile au diagnostic ; le numéro n'est jamais repris dans l'erreur (OVH peut le citer).
      const detail = sansCoordonnees((await r.text().catch(() => '')).slice(0, 300));
      throw new Error(`envoi du SMS refusé par OVH (${r.status}) : ${detail}`);
    }
    const res = (await r.json().catch(() => ({}))) as { invalidReceivers?: string[] };
    if (res.invalidReceivers?.length) throw new Error('numéro refusé par OVH');
  }
}
