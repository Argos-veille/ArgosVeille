// Codes de secours : 10 par compte, de la forme K7M2P-9XWQR, montrés une seule fois.
// La base n'en garde que l'empreinte HMAC (clé hors de la base).
import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Bases } from './db.ts';
import { empreinte, type Cles } from './crypto.ts';

// Ni 0/O, ni 1/I/L : rien qui se confonde à la lecture ou à la saisie. 31 signes, ~49,5 bits par code.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const NOMBRE_CODES = 10;

function unCode(): string {
  let c = '';
  for (let i = 0; i < 10; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return `${c.slice(0, 5)}-${c.slice(5)}`;
}

/** Forme saisie → forme canonique (10 signes, sans tiret ni espace), ou null si impossible. */
export function normaliserCode(saisie: string): string | null {
  const c = saisie.toUpperCase().replace(/[\s-]/g, '');
  return new RegExp(`^[${ALPHABET}]{10}$`).test(c) ? c : null;
}

export const empreinteCode = (cles: Cles, code: string) =>
  empreinte(cles, 'code-secours', normaliserCode(code) ?? '').toString('hex');

export function genererCodes(cles: Cles): { codes: string[]; empreintes: string[] } {
  const codes = Array.from({ length: NOMBRE_CODES }, unCode);
  return { codes, empreintes: codes.map((c) => empreinteCode(cles, c)) };
}

/** Annule les codes restants et en crée 10 nouveaux, dans une transaction. */
export async function regenererCodes(bases: Bases, cles: Cles, compteId: string): Promise<string[]> {
  const { codes, empreintes } = genererCodes(cles);
  const client: PoolClient = await bases.app.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE core.backup_codes SET invalidated_at = now()
        WHERE account_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`, [compteId]);
    await client.query(
      'INSERT INTO core.backup_codes (account_id, code_hash) SELECT $1, unnest($2::text[])', [compteId, empreintes]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return codes;
}

/** Utilise un code (une seule fois, de façon atomique). Renvoie false s'il est faux, utilisé ou annulé. */
export async function utiliserCode(bases: Bases, cles: Cles, compteId: string, saisie: string): Promise<boolean> {
  if (!normaliserCode(saisie)) return false;
  const r = await bases.app.query(
    `UPDATE core.backup_codes SET used_at = now()
      WHERE account_id = $1 AND code_hash = $2 AND used_at IS NULL AND invalidated_at IS NULL`,
    [compteId, empreinteCode(cles, saisie)]);
  return r.rowCount === 1;
}

export async function codesRestants(bases: Bases, compteId: string): Promise<number> {
  const r = await bases.app.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM core.backup_codes
      WHERE account_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`, [compteId]);
  return r.rows[0]!.n;
}
