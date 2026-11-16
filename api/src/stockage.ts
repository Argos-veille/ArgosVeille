// Stockage des envois. Deux espaces :
//   « originaux »   : originaux chiffrés, durables (dossier local en dev, Cloudflare R2 en production) ;
//   « quarantaine » : copies de travail en clair, en attente du floutage (volume chiffré à clé jetable en production),
//                     jamais conservées : effacées après traitement ou au bout de 24 h ;
//   « floutees »    : versions floutées produites par le worker (un dossier par vidéo) ;
//   « copies »      : copie de travail chiffrée par la clé de copie de la source et pistes des flous
//                     (un dossier par vidéo), le temps de la vérification par la source (7 jours au plus).
// Les chemins ne sont construits qu'à partir d'identifiants générés par le site (UUID) et de
// numéros de morceaux : aucune donnée fournie par la source n'entre dans un chemin.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { R2 } from './r2.ts';

export type Espace = 'originaux' | 'quarantaine' | 'floutees' | 'copies';
const DOSSIERS: readonly Espace[] = ['floutees', 'copies'];   // un dossier par vidéo
/** Fichiers lisibles dans un dossier de vidéo : liste fermée, jamais un nom venu d'une requête. */
export type Fichier = 'apercu.mp4' | 'video.mp4' | 'pistes.json' | 'retouche.json' | 'demande.json' | 'verif';
const FICHIERS: readonly Fichier[] = ['apercu.mp4', 'video.mp4', 'pistes.json', 'retouche.json', 'demande.json', 'verif'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Stockage {
  ecrireMorceau(espace: Espace, id: string, index: number, octets: Uint8Array): Promise<void>;
  /** Assemble les morceaux 0..n-1 en un seul fichier, efface les morceaux, renvoie SHA-256 et taille. */
  assembler(espace: Espace, id: string, n: number): Promise<{ sha256: Buffer; taille: number; cle: string }>;
  /** Premiers octets du fichier assemblé (pour vérifier qu'il s'agit bien d'une vidéo). */
  debut(espace: Espace, id: string, longueur: number): Promise<Buffer>;
  supprimer(espace: Espace, id: string): Promise<void>;
  /** Chemin d'un fichier produit par le worker (dossier de vidéo). */
  fichierVideo(espace: 'floutees' | 'copies', id: string, nom: Fichier): string;
  /** Identifiants des vidéos qui ont un dossier dans un espace (nettoyage). */
  identifiants(espace: 'floutees' | 'copies'): Promise<string[]>;
  /** Lien de lecture signé d'une version floutée déposée sur R2 (null en stockage local seul). */
  lienDistant?(id: string, nom: 'apercu.mp4' | 'video.mp4', secondes: number): string | null;
  /** Lien signé de l'original CHIFFRÉ déposé sur R2 (administration : transmission de l'original). */
  lienOriginal?(id: string, secondes: number): string | null;
  /** Octets libres sur le disque d'un espace local (null si inconnu). */
  espaceLibre?(espace: 'originaux' | 'quarantaine'): Promise<number | null>;
  /** Place occupée sur R2 (tableau de bord ; absent en stockage local seul). */
  occupationDistante?(): Promise<{ fichiers: number; octets: number }>;
}

function verifier(id: string, index = 0) {
  if (!UUID.test(id) || !Number.isInteger(index) || index < 0 || index > 100_000) throw new Error('chemin de stockage refusé');
}

/** Stockage dans des dossiers locaux (développement ; en production, quarantaine sur un volume chiffré à clé jetable). */
export class StockageFichier implements Stockage {
  constructor(private readonly racines: Record<Espace, string>) {}

  async espaceLibre(espace: 'originaux' | 'quarantaine'): Promise<number | null> {
    try {
      const s = await statfs(this.racines[espace]);
      return s.bavail * s.bsize;
    } catch { return null; }
  }

  private dossierMorceaux(espace: Espace, id: string) { return join(this.racines[espace], `${id}.morceaux`); }
  private fichier(espace: Espace, id: string) {
    return DOSSIERS.includes(espace) ? join(this.racines[espace], id)
      : join(this.racines[espace], `${id}.${espace === 'originaux' ? 'argos' : 'video'}`);
  }

  async ecrireMorceau(espace: Espace, id: string, index: number, octets: Uint8Array) {
    verifier(id, index);
    const dossier = this.dossierMorceaux(espace, id);
    await mkdir(dossier, { recursive: true, mode: 0o770 });
    // Écriture atomique : un morceau renvoyé (reprise après coupure) remplace l'ancien d'un coup.
    const tmp = join(dossier, `.${index}.${randomBytes(6).toString('hex')}`);
    await writeFile(tmp, octets, { mode: 0o660 });
    await rename(tmp, join(dossier, String(index)));
  }

  async assembler(espace: Espace, id: string, n: number) {
    verifier(id);
    const dossier = this.dossierMorceaux(espace, id);
    const cible = this.fichier(espace, id);
    const h = createHash('sha256');
    const sortie = createWriteStream(cible, { mode: 0o660 });
    for (let i = 0; i < n; i++) {
      const source = createReadStream(join(dossier, String(i)));
      source.on('data', (c) => h.update(c));
      await pipeline(source, sortie, { end: i === n - 1 });
    }
    if (n === 0) sortie.end();
    await rm(dossier, { recursive: true, force: true });
    return { sha256: h.digest(), taille: (await stat(cible)).size, cle: `${espace}/${id}` };
  }

  async debut(espace: Espace, id: string, longueur: number) {
    verifier(id);
    const f = await open(this.fichier(espace, id), 'r');
    try {
      const b = Buffer.alloc(longueur);
      const { bytesRead } = await f.read(b, 0, longueur, 0);
      return b.subarray(0, bytesRead);
    } finally {
      await f.close();
    }
  }

  async supprimer(espace: Espace, id: string) {
    verifier(id);
    await rm(this.dossierMorceaux(espace, id), { recursive: true, force: true });
    await rm(this.fichier(espace, id), { recursive: DOSSIERS.includes(espace), force: true });
  }

  fichierVideo(espace: 'floutees' | 'copies', id: string, nom: Fichier) {
    verifier(id);
    if (!FICHIERS.includes(nom)) throw new Error('fichier refusé');
    return join(this.fichier(espace, id), nom);
  }

  async identifiants(espace: 'floutees' | 'copies') {
    return (await this.lister(espace)).filter((n) => UUID.test(n));
  }

  /** Pour les tests et le nettoyage : contenu brut d'un espace. */
  async lister(espace: Espace): Promise<string[]> {
    try { return await readdir(this.racines[espace]); } catch { return []; }
  }

  chemin(espace: Espace, id: string) { verifier(id); return this.fichier(espace, id); }
}

/**
 * Production : originaux chiffrés et versions floutées sur Cloudflare R2 ; le reste (morceaux en cours,
 * copies de travail, sortie du worker avant dépôt) dans les dossiers locaux.
 *   originaux/<id>.argos        déposé par synchroniser(), puis effacé du serveur
 *   floutees/<id>/<fichier>.mp4 déposé par synchroniser() une fois produit par le worker, puis effacé du serveur
 * Dépôts par lots, à l'heure pile (point bas de la revue, 15 novembre 2026) : un fichier écrit pendant l'heure en cours
 * attend l'heure suivante. R2 ne date donc un dépôt qu'à l'heure, comme la base (0107) : sa date ne relie pas une vidéo
 * à l'adresse IP du journal légal. Avant son dépôt, le fichier est lu sur le serveur (aucun retard pour personne).
 */
// Après son dépôt sur R2, une version floutée reste un moment sur le serveur : une lecture déjà commencée continue ainsi
// au même endroit (un navigateur abandonne si la suite d'une vidéo vient d'un autre site). Les liens durent 10 minutes.
const GARDE_APRES_DEPOT_MS = 15 * 60_000;

export class StockageR2 extends StockageFichier {
  constructor(racines: Record<Espace, string>, private readonly r2: R2) { super(racines); }

  /** Horloge des lots (remplaçable dans les tests). */
  horloge = () => Date.now();

  /** Vrai si le fichier a été écrit avant l'heure en cours : il part dans le lot de cette heure. */
  private duLot(mtimeMs: number) {
    return mtimeMs < Math.floor(this.horloge() / 3_600_000) * 3_600_000;
  }

  override async assembler(espace: Espace, id: string, n: number) {
    const r = await super.assembler(espace, id, n);
    // L'original reste sur le serveur jusqu'au lot de l'heure suivante (synchroniser).
    return espace === 'originaux' ? { ...r, cle: `originaux/${id}.argos` } : r;
  }

  override async supprimer(espace: Espace, id: string) {
    await super.supprimer(espace, id);
    if (espace === 'originaux') await this.r2.supprimer(`originaux/${id}.argos`);
    if (espace === 'floutees') await this.r2.supprimerPrefixe(`floutees/${id}/`);
  }

  occupationDistante() { return this.r2.occupation(); }

  lienDistant(id: string, nom: 'apercu.mp4' | 'video.mp4', secondes: number) {
    verifier(id);
    return this.r2.lien(`floutees/${id}/${nom}`, secondes);
  }

  lienOriginal(id: string, secondes: number) {
    verifier(id);
    if (existsSync(this.chemin('originaux', id))) return null;   // pas encore déposé : lu sur le serveur
    return this.r2.lien(`originaux/${id}.argos`, secondes);
  }

  /**
   * Dépose sur R2 les versions floutées que le worker vient de produire, puis les efface du serveur.
   * `encorePresente(id)` : faux si la vidéo a été retirée entre-temps (le dépôt est alors effacé aussitôt).
   * `enTraitement(id)` : vrai tant que le worker écrit ces fichiers ; ils n'y sont pas encore complets, on n'y touche pas.
   */
  async synchroniser(encorePresente: (id: string) => Promise<boolean>,
                     enTraitement: (id: string) => Promise<boolean> = async () => false,
                     garderMs = GARDE_APRES_DEPOT_MS,
                     envoiEnCours: (id: string) => Promise<boolean> = async () => false): Promise<number> {
    let n = 0;
    // Originaux chiffrés : assemblés par l'API (envoi de fichier) ou par le worker (envoi par lien).
    for (const nom of await this.lister('originaux')) {
      const m = /^([0-9a-f-]{36})\.argos$/.exec(nom);
      if (!m || !UUID.test(m[1]!) || await envoiEnCours(m[1]!)) continue;
      const f = this.chemin('originaux', m[1]!);
      const ecrit = await stat(f).catch(() => null);
      if (!ecrit || !this.duLot(ecrit.mtimeMs)) continue;
      await this.r2.deposer(`originaux/${nom}`, f);
      await rm(f, { force: true });
      if (!(await encorePresente(m[1]!))) await this.r2.supprimer(`originaux/${nom}`);
      n++;
    }
    for (const id of await this.identifiants('floutees')) {
      if (await enTraitement(id)) continue;
      for (const nom of ['apercu.mp4', 'video.mp4'] as const) {
        const f = this.fichierVideo('floutees', id, nom);
        const marque = `${f}.depose`;
        let fichier;
        try { fichier = await stat(f); } catch { continue; }
        const depose = await stat(marque).catch(() => null);
        // Déposé une seule fois, sauf si le fichier a changé depuis (retouche, re-floutage).
        if ((!depose || fichier.mtimeMs > depose.mtimeMs) && this.duLot(fichier.mtimeMs)) {
          await this.r2.deposer(`floutees/${id}/${nom}`, f, 'video/mp4');
          await writeFile(marque, '', { mode: 0o660 });
          n++;
        }
        // Effacé du serveur seulement si la version déposée est la dernière (une retouche peut attendre son lot).
        const depuis = await stat(marque).catch(() => null);
        const actuel = await stat(f).catch(() => null);
        if (depuis && actuel && actuel.mtimeMs <= depuis.mtimeMs && Date.now() - depuis.mtimeMs >= garderMs) {
          await rm(f, { force: true });
          await rm(marque, { force: true });
        }
      }
      if (!(await encorePresente(id))) await this.r2.supprimerPrefixe(`floutees/${id}/`);
    }
    return n;
  }
}
