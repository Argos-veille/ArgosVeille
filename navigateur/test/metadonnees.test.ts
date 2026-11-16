// Métadonnées MP4/MOV : fichiers fabriqués boîte par boîte, comme les produisent Android et iPhone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distanceKm, indicateur } from '../src/coherence.ts';
import { lecteurOctets } from '../src/lecteur.ts';
import { lireIso6709, lireMetadonnees } from '../src/metadonnees.ts';

const b = (type: string, ...contenu: Buffer[]) => {
  const corps = Buffer.concat(contenu);
  const t = Buffer.alloc(8);
  t.writeUInt32BE(8 + corps.length);
  t.write(type, 4, 'latin1');
  return Buffer.concat([t, corps]);
};
const u32 = (n: number) => { const x = Buffer.alloc(4); x.writeUInt32BE(n); return x; };
const SECONDES_1904_A_1970 = 2082844800;
function mvhd(date: Date) {
  return b('mvhd', Buffer.from([0, 0, 0, 0]), u32(Math.floor(date.getTime() / 1000) + SECONDES_1904_A_1970),
           u32(0), Buffer.alloc(88));
}
const ftyp = b('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2mp41'));
const mdat = b('mdat', Buffer.alloc(5000, 0xab));
const xyz = (s: string) => b('©xyz', Buffer.from([0, s.length, 0x15, 0xc7]), Buffer.from(s));   // ©xyz en latin1

function appleMeta(cles: Record<string, string>) {
  const noms = Object.keys(cles);
  const keys = b('keys', Buffer.alloc(4), u32(noms.length),
    ...noms.map((n) => Buffer.concat([u32(8 + n.length), Buffer.from('mdta'), Buffer.from(n)])));
  const ilst = b('ilst', ...noms.map((n, i) => {
    const data = b('data', u32(1), u32(0), Buffer.from(cles[n]!));
    const item = Buffer.concat([u32(8 + data.length), u32(i + 1), data]);
    return item;
  }));
  return b('meta', b('hdlr', Buffer.alloc(24)), keys, ilst);
}

const DATE = new Date('2026-11-03T14:12:00Z');

test('Android / ffmpeg : date dans mvhd, position dans udta/©xyz (moov après mdat)', async () => {
  const f = Buffer.concat([ftyp, mdat, b('moov', mvhd(DATE), b('udta', xyz('+48.8566+002.3522/')))]);
  assert.deepEqual(await lireMetadonnees(lecteurOctets(f)), { date: DATE, position: { lat: 48.8566, lon: 2.3522 } });
});

test('iPhone : clés Apple (position et date locale), prioritaires sur mvhd', async () => {
  const meta = appleMeta({
    'com.apple.quicktime.location.ISO6709': '+43.2965+005.3698+012.000/',
    'com.apple.quicktime.creationdate': '2026-11-03T15:12:00+0100',
    'com.apple.quicktime.make': 'Apple',
  });
  const f = Buffer.concat([ftyp, b('moov', mvhd(new Date('2026-11-03T14:13:00Z')), meta), mdat]);
  assert.deepEqual(await lireMetadonnees(lecteurOctets(f)), { date: DATE, position: { lat: 43.2965, lon: 5.3698 } });
});

test('sans métadonnées (vidéo passée par WhatsApp) : rien', async () => {
  const sansDate = b('mvhd', Buffer.alloc(100));
  assert.deepEqual(await lireMetadonnees(lecteurOctets(Buffer.concat([ftyp, b('moov', sansDate), mdat]))), {});
  assert.deepEqual(await lireMetadonnees(lecteurOctets(Buffer.concat([ftyp, mdat]))), {});
});

function imbrique(n: number, contenu: Buffer): Buffer {
  let x = contenu;
  for (let i = 0; i < n; i++) x = b('trak', x);
  return x;
}

test('fichiers piégés ou abîmés : aucune erreur, aucune boucle', async () => {
  const cas: Buffer[] = [
    Buffer.alloc(0),
    Buffer.from('pas une vidéo du tout'),
    Buffer.concat([u32(0xffffffff), Buffer.from('moov'), Buffer.alloc(10)]),          // taille mensongère
    Buffer.concat([u32(4), Buffer.from('ftyp')]),                                        // taille trop petite
    Buffer.concat([ftyp, u32(1), Buffer.from('moov'), Buffer.alloc(8, 0xff)]),           // taille 64 bits géante
    Buffer.concat([ftyp, b('moov', b('udta', xyz('n importe quoi')))]),
    Buffer.concat([ftyp, b('moov', imbrique(12, mvhd(DATE)))]),                       // imbrication profonde
    Buffer.concat([ftyp, b('moov', b('meta', b('keys', u32(0), u32(1000000))))]),       // nombre de clés mensonger
  ];
  for (const f of cas) await lireMetadonnees(lecteurOctets(f));
});

test('ISO 6709', () => {
  assert.deepEqual(lireIso6709('+48.8566+002.3522+035.000/'), { lat: 48.8566, lon: 2.3522 });
  assert.deepEqual(lireIso6709('-21.1151+055.5364/'), { lat: -21.1151, lon: 55.5364 });   // La Réunion
  for (const faux of ['', '+95.0+010.0/', '+10.0+190.0/', '+00.0000+000.0000/', 'abc']) assert.equal(lireIso6709(faux), undefined, faux);
});

test('indicateur de cohérence', () => {
  const decl = { date: DATE, lat: 48.8566, lon: 2.3522, precision: 'exact' as const };
  assert.equal(indicateur({}, decl), 'absentes');
  assert.equal(indicateur({ date: new Date(DATE.getTime() + 3600_000), position: { lat: 48.86, lon: 2.35 } }, decl), 'coherentes');
  assert.equal(indicateur({ date: new Date(DATE.getTime() + 7 * 3600_000) }, decl), 'incoherentes');
  assert.equal(indicateur({ position: { lat: 43.2965, lon: 5.3698 } }, decl), 'incoherentes');   // Marseille
  assert.equal(indicateur({ position: { lat: 48.95, lon: 2.35 } }, decl), 'incoherentes');       // ~10 km
  assert.equal(indicateur({ position: { lat: 48.95, lon: 2.35 } }, { ...decl, precision: 'municipality' }), 'coherentes');
  assert.ok(Math.abs(distanceKm({ lat: 48.8566, lon: 2.3522 }, { lat: 43.2965, lon: 5.3698 }) - 661) < 5);
  // Heure inconnue : seule la date compte (à 36 h près autour de midi)
  const sansHeure = { ...decl, heureConnue: false };
  assert.equal(indicateur({ date: new Date(DATE.getTime() + 7 * 3600_000) }, sansHeure), 'coherentes');
  assert.equal(indicateur({ date: new Date(DATE.getTime() + 3 * 86400_000) }, sansHeure), 'incoherentes');
});

// Vraies vidéos produites par ffmpeg 6 : MP4 (position dans « loci ») et MOV (position dans « ©xyz »).
test('vraies vidéos ffmpeg : MP4 et MOV, avec et sans métadonnées', async () => {
  const { readFileSync } = await import('node:fs');
  const lire = (nom: string) => lireMetadonnees(lecteurOctets(readFileSync(new URL(`./fixtures/${nom}`, import.meta.url))));
  for (const nom of ['ffmpeg.mp4', 'ffmpeg.mov']) {
    const m = await lire(nom);
    assert.deepEqual(m.date, DATE, nom);
    assert.ok(m.position && Math.abs(m.position.lat - 43.2965) < 1e-4 && Math.abs(m.position.lon - 5.3698) < 1e-4,
              `${nom} : ${JSON.stringify(m.position)}`);
  }
  assert.deepEqual(await lire('sans-metadonnees.mp4'), {});
});
