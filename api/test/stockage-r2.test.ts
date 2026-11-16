// Stockage R2 (avec un faux R2 en mémoire) : originaux déposés puis effacés du serveur, versions floutées
// déposées par la synchronisation, suppression des deux côtés.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { R2 } from '../src/r2.ts';
import { StockageR2 } from '../src/stockage.ts';

function fauxR2() {
  const objets = new Map<string, number>();
  const r2 = {
    objets,
    deposer: async (cle: string, fichier: string) => { objets.set(cle, (await import('node:fs')).statSync(fichier).size); },
    supprimer: async (cle: string) => { objets.delete(cle); },
    supprimerPrefixe: async (p: string) => { for (const k of [...objets.keys()]) if (k.startsWith(p)) objets.delete(k); },
    lister: async (p: string) => [...objets.keys()].filter((k) => k.startsWith(p)),
    lien: (cle: string, s: number) => `https://r2.exemple/${cle}?expire=${s}`,
  };
  return r2;
}

test('stockage R2 : originaux, synchronisation des versions floutées, suppression', async () => {
  const racine = await mkdtemp(join(tmpdir(), 'argos-r2-'));
  const racines = { originaux: join(racine, 'o'), quarantaine: join(racine, 'q'), floutees: join(racine, 'f'), copies: join(racine, 'c') };
  for (const d of Object.values(racines)) await mkdir(d, { recursive: true });
  const r2 = fauxR2();
  const s = new StockageR2(racines, r2 as unknown as R2);
  // Horloge fixée au début du test : un passage d'heure pendant le test ne change rien (fichiers toujours plus récents).
  const debut = Date.now();
  s.horloge = () => debut;
  const id = randomUUID();

  // Original : assemblé, gardé sur le serveur (lu sur place) jusqu'au lot de l'heure suivante.
  await s.ecrireMorceau('originaux', id, 0, new Uint8Array([1, 2, 3]));
  const r = await s.assembler('originaux', id, 1);
  assert.equal(r.cle, `originaux/${id}.argos`);
  assert.equal(r2.objets.size, 0);
  assert.equal(s.lienOriginal(id, 600), null);

  // Versions floutées produites par le worker : rien ne part pendant l'heure en cours.
  await mkdir(join(racines.floutees, id));
  await writeFile(join(racines.floutees, id, 'apercu.mp4'), 'aperçu');
  await writeFile(join(racines.floutees, id, 'video.mp4'), 'vidéo complète');
  assert.equal(await s.synchroniser(async () => true, async () => false, 0), 0);
  assert.equal(r2.objets.size, 0);
  assert.ok((await readdir(join(racines.floutees, id))).includes('video.mp4'));   // pas effacée avant son dépôt
  // Heure suivante : le lot part (original + 2 versions floutées), l'original est effacé du serveur.
  s.horloge = () => debut + 7_200_000;   // lot suivant
  assert.equal(await s.synchroniser(async () => true), 3);
  assert.equal(r2.objets.get(`originaux/${id}.argos`), 3);
  assert.deepEqual(await readdir(racines.originaux), []);
  assert.equal(s.lienOriginal(id, 600), `https://r2.exemple/originaux/${id}.argos?expire=600`);
  // Gardées sur le serveur un moment : une lecture commencée continue au même endroit ; un seul dépôt.
  assert.ok((await readdir(join(racines.floutees, id))).includes('video.mp4'));
  assert.equal(await s.synchroniser(async () => true), 0);
  // Fichier remplacé (retouche, re-floutage) : déposé de nouveau.
  await new Promise((ok) => setTimeout(ok, 20));
  await writeFile(join(racines.floutees, id, 'video.mp4'), 'vidéo retouchée');
  assert.equal(await s.synchroniser(async () => true), 1);
  // Passé le délai : effacées du serveur, marques comprises.
  assert.equal(await s.synchroniser(async () => true, async () => false, 0), 0);
  assert.deepEqual(await readdir(join(racines.floutees, id)), []);
  assert.deepEqual((await r2.lister(`floutees/${id}/`)).sort(), [`floutees/${id}/apercu.mp4`, `floutees/${id}/video.mp4`]);
  assert.equal(s.lienDistant(id, 'video.mp4', 600), `https://r2.exemple/floutees/${id}/video.mp4?expire=600`);
  assert.throws(() => s.lienDistant('../x', 'video.mp4', 600));

  // Vidéo encore en cours de floutage : ses fichiers, incomplets, ne sont ni déposés ni effacés.
  const enCours = randomUUID();
  await mkdir(join(racines.floutees, enCours));
  await writeFile(join(racines.floutees, enCours, 'video.mp4'), 'en cours');
  assert.equal(await s.synchroniser(async () => true, async (v) => v === enCours), 0);
  assert.deepEqual(await readdir(join(racines.floutees, enCours)), ['video.mp4']);
  assert.deepEqual(await r2.lister(`floutees/${enCours}/`), []);
  assert.equal(await s.synchroniser(async () => true, async () => false, 0), 1);   // traitement terminé : déposé
  await s.supprimer('floutees', enCours);

  // Original chiffré par le worker (envoi par lien) : déposé sous le même nom, puis effacé ; ignoré pendant un envoi de fichier.
  const parLien = randomUUID();
  await writeFile(join(racines.originaux, `${parLien}.argos`), 'chiffré');
  assert.equal(await s.synchroniser(async () => true, async () => false, 0, async () => true), 0);
  assert.equal(await s.synchroniser(async () => true, async () => false, 0, async () => false), 1);
  assert.deepEqual(await readdir(racines.originaux), []);
  assert.ok(r2.objets.has(`originaux/${parLien}.argos`));
  await r2.supprimer(`originaux/${parLien}.argos`);

  // Vidéo retirée pendant le dépôt : ce qui vient d'être déposé est effacé aussitôt.
  const autre = randomUUID();
  await mkdir(join(racines.floutees, autre));
  await writeFile(join(racines.floutees, autre, 'video.mp4'), 'x');
  await s.synchroniser(async (v) => v !== autre, async () => false, 0);
  assert.deepEqual(await r2.lister(`floutees/${autre}/`), []);

  // Retouche en attente de son lot : jamais effacée du serveur, même passé le délai (R2 n'a que l'ancienne version).
  const retouchee = randomUUID();
  await mkdir(join(racines.floutees, retouchee));
  await writeFile(join(racines.floutees, retouchee, 'video.mp4'), 'v1');
  assert.equal(await s.synchroniser(async () => true, async () => false, 60_000), 1);
  const avantV2 = Date.now();
  s.horloge = () => avantV2;   // l'heure de la retouche : elle attend son lot
  await new Promise((ok) => setTimeout(ok, 20));
  await writeFile(join(racines.floutees, retouchee, 'video.mp4'), 'v2');
  assert.equal(await s.synchroniser(async () => true, async () => false, 0), 0);
  assert.ok((await readdir(join(racines.floutees, retouchee))).includes('video.mp4'));
  await s.supprimer('floutees', retouchee);

  // Retrait : effacé des deux côtés.
  await s.supprimer('floutees', id);
  await s.supprimer('originaux', id);
  assert.equal(r2.objets.size, 0);
});
