// Copie de travail sans lieu ni date : boîtes de métadonnées effacées, dates à zéro, taille identique, vidéo lisible.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lecteurOctets } from '../src/lecteur.ts';
import { lireMetadonnees } from '../src/metadonnees.ts';
import { appliquerCorrectifs, correctifsCopie } from '../src/nettoyage.ts';

const b = (type: string, ...contenu: Buffer[]) => {
  const corps = Buffer.concat(contenu);
  const t = Buffer.alloc(8);
  t.writeUInt32BE(8 + corps.length);
  t.write(type, 4, 'latin1');
  return Buffer.concat([t, corps]);
};
const u32 = (n: number) => { const x = Buffer.alloc(4); x.writeUInt32BE(n); return x; };
const DATE = 3_900_000_000;   // secondes depuis 1904 (2027)
const entete = (type: string, reste: number) => b(type, Buffer.from([0, 0, 0, 0]), u32(DATE), u32(DATE), Buffer.alloc(reste));
const xyz = (s: string) => b('©xyz', Buffer.from([0, s.length, 0x15, 0xc7]), Buffer.from(s));
function appleMeta(cles: Record<string, string>) {
  const noms = Object.keys(cles);
  const keys = b('keys', Buffer.alloc(4), u32(noms.length),
    ...noms.map((n) => Buffer.concat([u32(8 + n.length), Buffer.from('mdta'), Buffer.from(n)])));
  const ilst = b('ilst', ...noms.map((n, i) => b(String.fromCharCode(0, 0, 0, i + 1), b('data', u32(1), u32(0), Buffer.from(cles[n]!)))));
  return b('meta', keys, ilst);
}

async function nettoyer(octets: Uint8Array): Promise<Uint8Array | null> {
  const c = await correctifsCopie(lecteurOctets(octets));
  if (!c) return null;
  // Par morceaux de 1000 octets, comme l'envoi (un correctif peut chevaucher deux morceaux).
  const sortie = new Uint8Array(octets.length);
  for (let d = 0; d < octets.length; d += 1000) sortie.set(appliquerCorrectifs(octets.slice(d, d + 1000), d, c), d);
  return sortie;
}

test('lieu et date retirés (Android, iPhone, XMP), taille identique', async () => {
  const fichier = Buffer.concat([
    b('ftyp', Buffer.from('qt  '), u32(0), Buffer.from('qt  ')),
    b('uuid', Buffer.alloc(16, 1), Buffer.from('<x:xmpmeta>GPSLatitude 48.85</x:xmpmeta>')),
    b('moov', entete('mvhd', 88), xyz('+48.8566+002.3522/'),
      b('udta', xyz('+48.8566+002.3522/')),
      appleMeta({ 'com.apple.quicktime.location.ISO6709': '+43.2965+005.3698/', 'com.apple.quicktime.creationdate': '2026-11-03T14:12:00+0100' }),
      b('trak', entete('tkhd', 72), b('mdia', entete('mdhd', 4), b('minf', b('udta', xyz('+1.0+2.0/')))))),
    b('mdat', Buffer.alloc(3000, 0xab)),
  ]);
  const avant = await lireMetadonnees(lecteurOctets(fichier));
  assert.ok(avant.position && avant.date);
  const propre = (await nettoyer(fichier))!;
  assert.equal(propre.length, fichier.length);
  assert.deepEqual(await lireMetadonnees(lecteurOctets(propre)), {});
  const texte = Buffer.from(propre).toString('latin1');
  assert.ok(!texte.includes('udta') && !texte.includes('meta') && !texte.includes('uuid'));
  assert.ok(!Buffer.from(propre).includes(u32(DATE)));
  assert.ok(Buffer.from(propre.subarray(-3000)).equals(fichier.subarray(-3000)));   // les images ne bougent pas
});

test('format non reconnu (WebM, texte) : rien à corriger', async () => {
  assert.equal(await correctifsCopie(lecteurOctets(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 2, 3]))), null);
  assert.equal(await correctifsCopie(lecteurOctets(Buffer.from('bonjour, ceci n’est pas une vidéo'))), null);
  assert.equal(await correctifsCopie(lecteurOctets(new Uint8Array(0))), null);
});

test('vraies vidéos ffmpeg : plus de lieu ni de date, toujours lisibles', async (t) => {
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); } catch { t.skip('ffprobe absent'); return; }
  const dossier = mkdtempSync(join(tmpdir(), 'argos-nettoyage-'));
  for (const nom of ['ffmpeg.mov', 'ffmpeg.mp4']) {
    const fichier = readFileSync(new URL(`./fixtures/${nom}`, import.meta.url));
    assert.ok((await lireMetadonnees(lecteurOctets(fichier))).position, `${nom} : lieu présent avant`);
    const propre = (await nettoyer(fichier))!;
    assert.deepEqual(await lireMetadonnees(lecteurOctets(propre)), {}, nom);
    const chemin = join(dossier, nom);
    writeFileSync(chemin, propre);
    const sonde = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', chemin]).toString());
    assert.ok(sonde.streams.length >= 1, `${nom} : flux lisibles`);
    const etiquettes = JSON.stringify([sonde.format.tags ?? {}, ...sonde.streams.map((s: { tags?: object }) => s.tags ?? {})]);
    assert.ok(!/location|creation_time|ISO6709/i.test(etiquettes), `${nom} : ${etiquettes}`);
    execFileSync('ffmpeg', ['-v', 'error', '-i', chemin, '-f', 'null', '-']);   // décodage complet sans erreur
  }
});

test('piste de données (télémétrie, GPS de caméra) : ses octets effacés, image et son intacts (B8)', async (t) => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { t.skip('ffmpeg absent'); return; }
  const dossier = mkdtempSync(join(tmpdir(), 'argos-pistes-'));
  const srt = join(dossier, 'tele.srt');
  writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\nGPS 48.853012 2.349823 ALT 35\n\n2\n00:00:01,000 --> 00:00:02,000\nGPS 48.853099 2.349901\n');
  const source = join(dossier, 'drone.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=d=2:s=160x120:r=10', '-f', 'lavfi', '-i', 'sine=d=2', '-i', srt,
                          '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-c:a', 'aac', '-c:s', 'mov_text', source]);
  const octets = new Uint8Array(readFileSync(source));
  assert.ok(Buffer.from(octets).includes('48.853012'));
  const c = await correctifsCopie(lecteurOctets(octets));
  const propre = appliquerCorrectifs(octets.slice(), 0, c!);
  assert.equal(propre.length, octets.length);
  assert.ok(!Buffer.from(propre).includes('48.853'));
  const chemin = join(dossier, 'propre.mp4');
  writeFileSync(chemin, propre);
  const types = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', chemin]).toString().trim().split('\n');
  assert.deepEqual(types, ['video', 'audio']);
  execFileSync('ffmpeg', ['-v', 'error', '-i', chemin, '-f', 'null', '-']);
});
