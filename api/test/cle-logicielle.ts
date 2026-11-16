// Clé de sécurité logicielle pour les tests : se comporte comme une vraie clé WebAuthn (attestation
// « none », algorithme ES256 / P-256), avec un compteur que l'on peut manipuler pour simuler un clonage.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// --- CBOR minimal (RFC 8949) : entiers, octets, texte, dictionnaires — ce dont WebAuthn a besoin ---
function entete(type: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(type << 5) | n]);
  if (n < 256) return Buffer.from([(type << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (type << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (type << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
type Cbor = number | string | Buffer | Map<Cbor, Cbor>;
export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? entete(0, v) : entete(1, -1 - v);
  if (typeof v === 'string') { const t = Buffer.from(v, 'utf8'); return Buffer.concat([entete(3, t.length), t]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([entete(2, v.length), v]);
  const morceaux = [entete(5, v.size)];
  for (const [k, val] of v) morceaux.push(cbor(k), cbor(val));
  return Buffer.concat(morceaux);
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const b64u = (b: Buffer) => b.toString('base64url');

export class CleLogicielle {
  readonly id = randomBytes(32);
  private readonly prive: KeyObject;
  private readonly publique: KeyObject;
  compteur = 0;

  constructor(private readonly origine: string, private readonly rpID: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.prive = privateKey;
    this.publique = publicKey;
  }

  private cleCose(): Buffer {
    const jwk = this.publique.export({ format: 'jwk' }) as { x: string; y: string };
    return cbor(new Map<Cbor, Cbor>([
      [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
    ]));
  }

  private clientData(type: string, defi: string, origine: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge: defi, origin: origine, crossOrigin: false }));
  }

  private compteurOctets(): Buffer {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.compteur);
    return c;
  }

  /** Réponse à navigator.credentials.create(). `origine` permet de simuler un faux site. */
  enregistrer(options: { challenge: string }, origine = this.origine) {
    const idLongueur = Buffer.alloc(2);
    idLongueur.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([
      sha256(this.rpID), Buffer.from([0x45]),   // présence (UP) + vérification (UV) + données de clé (AT)
      this.compteurOctets(), Buffer.alloc(16), idLongueur, this.id, this.cleCose(),
    ]);
    const attestation = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key',
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge, origine)),
        attestationObject: b64u(attestation),
        transports: ['usb', 'nfc'],
      },
      clientExtensionResults: {},
    };
  }

  /** Réponse à navigator.credentials.get(). Le compteur avance à chaque utilisation. */
  prouver(options: { challenge: string }, origine = this.origine) {
    this.compteur += 1;
    const authData = Buffer.concat([sha256(this.rpID), Buffer.from([0x05]), this.compteurOctets()]);
    const clientData = this.clientData('webauthn.get', options.challenge, origine);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.prive);   // DER
    return {
      id: b64u(this.id), rawId: b64u(this.id), type: 'public-key',
      response: {
        clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature),
      },
      clientExtensionResults: {},
    };
  }
}
