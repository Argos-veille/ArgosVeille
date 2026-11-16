// Validation et mise en forme des données saisies à l'inscription.
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

// France métropolitaine et outre-mer (DROM et COM). À étendre plus tard.
const PAYS = ['FR', 'RE', 'GP', 'MQ', 'GF', 'YT', 'PM', 'BL', 'MF', 'WF', 'PF', 'NC'] as const;

export type ResultatTelephone =
  | { ok: true; numero: string }                         // format international E.164
  | { ok: false; erreur: 'telephone_invalide' | 'telephone_non_mobile' | 'telephone_pays' | 'telephone_ambigu' };

/** Un numéro de mobile français (métropole ou outre-mer), au format international. */
export function normaliserTelephone(saisie: string): ResultatTelephone {
  const s = saisie.trim();
  if (s.length > 30) return { ok: false, erreur: 'telephone_invalide' };
  const candidats = s.startsWith('+') || s.startsWith('00')
    ? [parsePhoneNumberFromString(s.replace(/^00/, '+'))]
    : PAYS.map((p) => parsePhoneNumberFromString(s, p));
  const valides = candidats.filter((n) => n?.isValid());
  if (valides.length === 0) return { ok: false, erreur: 'telephone_invalide' };
  if (!valides.some((n) => n!.country && (PAYS as readonly string[]).includes(n!.country))) {
    return { ok: false, erreur: 'telephone_pays' };
  }
  const mobiles = new Set(valides
    .filter((n) => n!.country && (PAYS as readonly string[]).includes(n!.country) && n!.getType() === 'MOBILE')
    .map((n) => n!.number));
  if (mobiles.size === 0) return { ok: false, erreur: 'telephone_non_mobile' };
  // Un même numéro national valable dans deux territoires : on demande le format international.
  if (mobiles.size > 1) return { ok: false, erreur: 'telephone_ambigu' };
  return { ok: true, numero: [...mobiles][0]! };
}

export type ResultatMail =
  | { ok: true; adresse: string; canonique: string }
  | { ok: false; erreur: 'mail_invalide' };

/**
 * adresse   : telle que saisie (espaces retirés), pour écrire au relecteur.
 * canonique : forme nettoyée pour l'empreinte anti-doublons. Minuscules, sans « +étiquette »,
 *             et pour Gmail sans les points, qu'il ignore : plusieurs variantes d'une même boîte
 *             donnent la même empreinte.
 */
export function normaliserMail(saisie: string): ResultatMail {
  const adresse = saisie.trim().normalize('NFC');
  if (adresse.length > 254) return { ok: false, erreur: 'mail_invalide' };
  const m = /^([^\s@"<>()[\]\\,;:]{1,64})@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i
    .exec(adresse);
  if (!m) return { ok: false, erreur: 'mail_invalide' };
  let local = m[1]!.toLowerCase().replace(/\+.*$/, '');
  let domaine = m[2]!.toLowerCase();
  if (domaine === 'googlemail.com') domaine = 'gmail.com';
  if (domaine === 'gmail.com') local = local.replace(/\./g, '');
  if (local === '') return { ok: false, erreur: 'mail_invalide' };
  return { ok: true, adresse, canonique: `${local}@${domaine}` };
}

export type ResultatPseudo = { ok: true; pseudo: string } | { ok: false; erreur: 'pseudo_invalide' | 'pseudo_interdit' };

// 3 à 30 caractères : lettres de l'alphabet latin (accents compris), chiffres 0 à 9, point, tiret,
// tiret bas. Plus strict que la base : l'alphabet latin seul empêche les sosies (« Аdmin » avec un
// А cyrillique), et la normalisation NFKC ramène les lettres « pleine chasse » (« Ａｄｍｉｎ ») à la normale.
const FORME_PSEUDO = /^[\p{Script=Latin}0-9._-]{3,30}$/u;

/** Forme canonique d'un pseudo, à l'inscription comme à la connexion. */
export const normaliserPseudo = (saisie: string) => saisie.trim().normalize('NFKC');

/** Pour le filtre : minuscules, sans accents, chiffres « leet » remplacés. */
function aplatir(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[0@4]/g, (c) => ({ '0': 'o', '@': 'a', '4': 'a' })[c]!)
    .replace(/1/g, 'i').replace(/3/g, 'e').replace(/5/g, 's').replace(/7/g, 't');
}

/** « =mot » : mot entier ou pseudo entier ; « mot » : n'importe où (séparateurs ignorés). */
function interdit(pseudo: string, mots: readonly string[]): boolean {
  const plat = aplatir(pseudo);
  const colle = plat.replace(/[._-]/g, '');
  const morceaux = new Set([colle, ...plat.split(/[._-]+/)]);
  return mots.some((m) => (m.startsWith('=') ? morceaux.has(m.slice(1)) : colle.includes(m)));
}

export function validerPseudo(saisie: string, interdits: readonly string[]): ResultatPseudo {
  const pseudo = normaliserPseudo(saisie);
  if (!FORME_PSEUDO.test(pseudo)) return { ok: false, erreur: 'pseudo_invalide' };
  if (interdit(pseudo, interdits)) return { ok: false, erreur: 'pseudo_interdit' };
  return { ok: true, pseudo };
}
