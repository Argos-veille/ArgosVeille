// Cloudflare R2 par son API compatible S3, sans bibliothèque : signature AWS « SigV4 » (vérifiée avec
// les exemples officiels d'Amazon, test/r2.test.ts). Compartiment privé en juridiction européenne ;
// les spectateurs reçoivent des liens signés valables quelques minutes, jamais l'accès au compartiment.
import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export interface ReglagesR2 {
  point: string;        // https://<compte>.eu.r2.cloudflarestorage.com
  compartiment: string; // argos-videos
  cleAcces: string;
  secret: string;
}

const sha256 = (d: string | Buffer) => createHash('sha256').update(d).digest('hex');
const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
/** Encodage RFC 3986 exigé par SigV4 (encodeURIComponent laisse passer !'()*). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const chemin = (p: string) => p.split('/').map(enc).join('/');
const horodatage = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export interface Signature {
  methode: string; hote: string; chemin: string; region: string; service?: string;
  cleAcces: string; secret: string; date: Date;
}

function cleDeSignature(secret: string, jour: string, region: string, service: string) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, jour), region), service), 'aws4_request');
}

/** Adresse pré-signée (requête sans en-tête d'autorisation), valable `secondes`. */
export function preSigner(s: Signature & { secondes: number }): string {
  const service = s.service ?? 's3';
  const quand = horodatage(s.date);
  const jour = quand.slice(0, 8);
  const portee = `${jour}/${s.region}/${service}/aws4_request`;
  const requete: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'], ['X-Amz-Credential', `${s.cleAcces}/${portee}`], ['X-Amz-Date', quand],
    ['X-Amz-Expires', String(s.secondes)], ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonique = requete.map(([k, v]) => `${enc(k)}=${enc(v)}`).sort().join('&');
  const demande = [s.methode, chemin(s.chemin), canonique, `host:${s.hote}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const aSigner = ['AWS4-HMAC-SHA256', quand, portee, sha256(demande)].join('\n');
  const signature = createHmac('sha256', cleDeSignature(s.secret, jour, s.region, service)).update(aSigner).digest('hex');
  return `https://${s.hote}${chemin(s.chemin)}?${canonique}&X-Amz-Signature=${signature}`;
}

/** En-têtes signés d'une requête (en-tête Authorization). `entetes` : en-têtes à signer en plus de host. */
export function signerEntetes(s: Signature & { requete?: string; entetes?: Record<string, string>; empreinteCorps: string }) {
  const service = s.service ?? 's3';
  const quand = horodatage(s.date);
  const jour = quand.slice(0, 8);
  const portee = `${jour}/${s.region}/${service}/aws4_request`;
  const tous: Record<string, string> = { ...(s.entetes ?? {}), host: s.hote, 'x-amz-content-sha256': s.empreinteCorps, 'x-amz-date': quand };
  const noms = Object.keys(tous).map((k) => k.toLowerCase()).sort();
  const bas = Object.fromEntries(Object.entries(tous).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const signes = noms.join(';');
  const canoniques = noms.map((k) => `${k}:${bas[k]}\n`).join('');
  const demande = [s.methode, chemin(s.chemin), s.requete ?? '', canoniques, signes, s.empreinteCorps].join('\n');
  const aSigner = ['AWS4-HMAC-SHA256', quand, portee, sha256(demande)].join('\n');
  const signature = createHmac('sha256', cleDeSignature(s.secret, jour, s.region, service)).update(aSigner).digest('hex');
  const { host: _hote, ...sansHote } = bas;
  return { ...sansHote,
           authorization: `AWS4-HMAC-SHA256 Credential=${s.cleAcces}/${portee}, SignedHeaders=${signes}, Signature=${signature}` };
}

/** Client R2 minimal : déposer un fichier, supprimer, lister un préfixe, lien de lecture signé. */
export class R2 {
  private readonly hote: string;
  constructor(private readonly r: ReglagesR2, private readonly appel: typeof fetch = fetch) {
    this.hote = new URL(r.point).host;
  }

  private base(cle: string) { return `/${this.r.compartiment}/${cle}`; }

  private async requete(methode: string, cle: string, o: { requete?: string; corps?: BodyInit; taille?: number; entetes?: Record<string, string> } = {}) {
    const entetes = signerEntetes({
      methode, hote: this.hote, chemin: this.base(cle), region: 'auto', cleAcces: this.r.cleAcces, secret: this.r.secret,
      date: new Date(), empreinteCorps: 'UNSIGNED-PAYLOAD', ...(o.requete ? { requete: o.requete } : {}),
      ...(o.entetes ? { entetes: o.entetes } : {}),
    });
    const url = `https://${this.hote}${chemin(this.base(cle))}${o.requete ? `?${o.requete}` : ''}`;
    const r = await this.appel(url, {
      method: methode, headers: { ...entetes, ...(o.taille !== undefined ? { 'content-length': String(o.taille) } : {}) },
      ...(o.corps ? { body: o.corps, duplex: 'half' } : {}), signal: AbortSignal.timeout(o.corps ? 30 * 60_000 : 30_000),
    } as RequestInit);
    if (!r.ok && !(methode === 'DELETE' && r.status === 404)) {
      throw new Error(`R2 ${methode} ${cle} : ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    }
    return r;
  }

  /** Dépose un fichier local (jusqu'à 5 Gio en une requête). */
  async deposer(cle: string, fichier: string, type = 'application/octet-stream') {
    const { size } = await stat(fichier);
    await this.requete('PUT', cle, {
      corps: Readable.toWeb(createReadStream(fichier)) as unknown as BodyInit, taille: size, entetes: { 'content-type': type },
    });
  }

  async supprimer(cle: string) { await this.requete('DELETE', cle); }

  /** Clés commençant par `prefixe` (1 000 au plus, largement assez pour un dossier de vidéo). */
  async lister(prefixe: string): Promise<string[]> {
    const requete = `list-type=2&prefix=${enc(prefixe)}`;
    const r = await this.requete('GET', '', { requete });
    const xml = await r.text();
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
  }

  /** Place occupée dans le compartiment : nombre de fichiers et octets (toutes les pages de la liste). */
  async occupation(): Promise<{ fichiers: number; octets: number }> {
    let fichiers = 0;
    let octets = 0;
    let suite: string | null = null;
    for (let page = 0; page < 1000; page++) {
      // Paramètres dans l'ordre alphabétique (signature).
      const requete: string = `${suite ? `continuation-token=${enc(suite)}&` : ''}list-type=2`;
      const xml = await (await this.requete('GET', '', { requete })).text();
      for (const m of xml.matchAll(/<Size>(\d+)<\/Size>/g)) { fichiers++; octets += Number(m[1]); }
      suite = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null) : null;
      if (!suite) break;
    }
    return { fichiers, octets };
  }

  async supprimerPrefixe(prefixe: string) {
    for (const cle of await this.lister(prefixe)) await this.supprimer(cle);
  }

  /** Lien de lecture signé, valable `secondes` (le navigateur lit directement chez R2). */
  lien(cle: string, secondes: number) {
    return preSigner({ methode: 'GET', hote: this.hote, chemin: this.base(cle), region: 'auto', cleAcces: this.r.cleAcces,
                       secret: this.r.secret, date: new Date(), secondes });
  }
}
