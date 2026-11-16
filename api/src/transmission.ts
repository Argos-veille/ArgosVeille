// Transmission de l'original (étape 3) : ce qui est commun à l'envoi, au suivi et à l'administration.
// L'enveloppe (format ARGOS-E1, voir navigateur/src/enveloppe.ts) contient la clé de l'original chiffrée
// pour la ou les clés publiques d'administration ; le serveur ne peut pas l'ouvrir. Il vérifie seulement
// sa forme, et qu'elle vise bien les clés configurées (ARGOS_CLES_ADMIN).
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Dependances } from './app.ts';

const B64 = (n: number) => ({ type: 'string', pattern: `^[A-Za-z0-9+/]{${n - 2},${n}}={0,2}$`, maxLength: n });
export const SCHEMA_ENVELOPPE = {
  type: 'object', additionalProperties: false, required: ['v', 'destinataires'],
  properties: {
    v: { const: 1 },
    destinataires: {
      type: 'array', minItems: 1, maxItems: 4,
      items: {
        type: 'object', additionalProperties: false, required: ['cle', 'epk', 'nonce', 'enveloppe'],
        properties: { cle: { type: 'string', pattern: '^[0-9a-f]{16}$' }, epk: B64(88), nonce: B64(16), enveloppe: B64(64) },
      },
    },
  },
} as const;
export interface Enveloppe { v: 1; destinataires: { cle: string; epk: string; nonce: string; enveloppe: string }[] }

export const empreinteCle = (publique: string) =>
  createHash('sha256').update(Buffer.from(publique, 'base64')).digest('hex').slice(0, 16);

/** Vraie si l'enveloppe vise toutes les clés d'administration configurées, et rien d'autre. */
export function enveloppeValable(deps: Dependances, e: Enveloppe): boolean {
  const attendues = new Set((deps.reglages.clesAdmin ?? []).map(empreinteCle));
  const recues = new Set(e.destinataires.map((d) => d.cle));
  if (!attendues.size || recues.size !== e.destinataires.length || recues.size !== attendues.size) return false;
  for (const c of recues) if (!attendues.has(c)) return false;
  return e.destinataires.every((d) => Buffer.from(d.epk, 'base64').length === 65 && Buffer.from(d.nonce, 'base64').length === 12
                                      && Buffer.from(d.enveloppe, 'base64').length === 48);
}

export function enregistrerTransmission(app: FastifyInstance, deps: Dependances): void {
  // Clés publiques pour le navigateur de la source (vide : l'autorisation n'est pas proposée).
  app.get('/cles-admin', async () => ({ cles: deps.reglages.clesAdmin ?? [] }));
}
