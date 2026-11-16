// Outils communs aux tests : base argos_test à jour, connexions réelles à PostgreSQL et Redis.
// Seuls l'envoi des SMS/mails et Cloudflare Turnstile sont remplacés par des faux contrôlables.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Dependances } from '../src/app.ts';
import { lireConfig } from '../src/config.ts';
import { ouvrirBases } from '../src/db.ts';
import type { Facteur } from '../src/facteur.ts';
import { chargerListes } from '../src/listes.ts';
import { ouvrirRedis } from '../src/redis.ts';
import type { Turnstile } from '../src/turnstile.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StockageFichier } from '../src/stockage.ts';

const MIGRATE = fileURLToPath(new URL('../../db/migrate.py', import.meta.url));

/** Facteur de test : garde les envois en mémoire pour lire les codes et les liens. */
export class FacteurMemoire implements Facteur {
  sms_: { numero: string; texte: string }[] = [];
  mails: { adresse: string; sujet: string; texte: string }[] = [];
  enPanne = false;
  async sms(numero: string, texte: string) {
    if (this.enPanne) throw new Error('panne simulée');
    this.sms_.push({ numero, texte });
  }
  async mail(adresse: string, sujet: string, texte: string) {
    if (this.enPanne) throw new Error('panne simulée');
    this.mails.push({ adresse, sujet, texte });
  }
  dernierCode(): string {
    return /(\d{6})/.exec(this.sms_.at(-1)!.texte)![1]!;
  }
  dernierJeton(): string {
    return /#([A-Za-z0-9_-]{43})/.exec(this.mails.at(-1)!.texte)![1]!;
  }
}

export class TurnstileFaux implements Turnstile {
  accepte = true;
  async verifier() {
    return this.accepte;
  }
}

export function preparer() {
  const config = lireConfig();
  if (config.pg.database !== 'argos_test') throw new Error('les tests ne tournent que sur argos_test');
  execFileSync('python3', [MIGRATE, '--db', 'argos_test'], { stdio: 'pipe' });
  const bases = ouvrirBases(config);
  const redis = ouvrirRedis(config);
  return { config, bases, redis };
}

/** Dépendances complètes pour construireApp, avec des clés aléatoires propres au test. */
export function dependances(socle: ReturnType<typeof preparer>, plafondSms = 1000, envoisParHeure = 1000) {
  const facteur = new FacteurMemoire();
  const turnstile = new TurnstileFaux();
  // Stockage propre à chaque test, dans un dossier temporaire.
  const racine = mkdtempSync(join(tmpdir(), 'argos-test-'));
  const stockage = new StockageFichier({
    originaux: join(racine, 'originaux'), quarantaine: join(racine, 'quarantaine'), floutees: join(racine, 'floutees'), copies: join(racine, 'copies'),
  });
  const deps: Dependances = {
    bases: socle.bases,
    redis: socle.redis,
    cles: { hmac: randomBytes(32), mail: randomBytes(32), mfa: randomBytes(32) },
    facteur,
    turnstile,
    listes: chargerListes(),
    stockage,
    reglages: { urlPublique: 'https://argos.test', smsPlafondJour: plafondSms, envoisParHeure },
  };
  return { deps, facteur, turnstile, stockage, racine };
}

/** Exécute une requête avec le rôle propriétaire (préparation des tests uniquement : statuts, journaux). */
export function proprietaire(requete: string): string {
  // Lecture du journal : on inscrit d'abord les entrées différées (0091), comme le moteur le ferait dans les 24 heures.
  if (/ledger\.entries/.test(requete) && !/flush_pending/.test(requete)) proprietaire('SELECT ledger.flush_pending(true)');
  const script = 'import sys; sys.path.insert(0, sys.argv[1]); import migrate; '
    + 'r = migrate.psql("argos_test", sys.argv[2]); '
    + 'sys.stderr.write(r.stderr); print(r.stdout.strip()); sys.exit(r.returncode)';
  return execFileSync('python3', ['-c', script, fileURLToPath(new URL('../../db', import.meta.url)), requete],
                      { encoding: 'utf8' }).trim();
}

/** Code SQLSTATE d'une erreur PostgreSQL (indépendant de la langue du serveur). */
export async function codeErreur(promesse: Promise<unknown>): Promise<string | undefined> {
  try {
    await promesse;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

export const REFUSE = '42501';
