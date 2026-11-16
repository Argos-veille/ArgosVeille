// Limites de fréquence dans Redis (fenêtre fixe). Les clés ne contiennent jamais de donnée en
// clair : une IP ou un numéro y figure sous forme d'empreinte HMAC.
import type { Redis } from 'ioredis';

/** Compte une tentative ; renvoie false si la limite est dépassée pour cette fenêtre. */
export async function consommer(redis: Redis, cle: string, limite: number, fenetreSecondes: number): Promise<boolean> {
  const k = `limite:${cle}`;
  // INCR et EXPIRE dans la même transaction : la fenêtre démarre au premier essai, jamais de clé éternelle.
  const r = await redis.multi().incr(k).expire(k, fenetreSecondes, 'NX').exec();
  const n = r?.[0]?.[1];
  if (typeof n !== 'number') throw new Error('limite : réponse Redis inattendue');
  return n <= limite;
}
