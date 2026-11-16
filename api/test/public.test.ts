// Partie publique (I-4) : carte, fiche, « en débat », journal. Seules les vidéos publiées ou en débat
// sont visibles ; jamais les rejetées, retirées ou de contrôle.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { construireApp } from '../src/app.ts';
import { dependances, preparer, proprietaire } from './aide.ts';

const socle = preparer();
const { bases, redis } = socle;
before(() => redis.connect());
beforeEach(() => redis.flushdb());
after(async () => {
  await bases.fermer();
  await redis.quit();
});

function video(statut: string, plus: { controle?: boolean; categorie?: string; sous?: string; forces?: string; quand?: string } = {}) {
  const id = randomUUID();
  proprietaire(`INSERT INTO core.videos (id, status, category, subcategory, forces, situation, occurred_at, location, location_precision,
                  description, language, original_sha256, is_control, control_truth, withdrawn_at, decided_at, decided_by_stage)
                VALUES ('${id}', '${statut}', '${plus.categorie ?? 'violence'}', '${plus.sous ?? 'weapons'}', '${plus.forces ?? 'national_police'}',
                  'demonstration', ${plus.quand ?? "now() - interval '2 days' + interval '17 minutes'"}, ST_GeogFromText('POINT(2.352 48.857)'),
                  'approx_100m', 'Tir de LBD', 'fr', '\\x${'ab'.repeat(32)}', ${plus.controle ? 'true, true' : 'false, NULL'},
                  ${statut === 'withdrawn' ? 'now()' : 'NULL'},
                  ${['published', 'rejected', 'under_debate'].includes(statut) ? "now(), 'jury'" : 'NULL, NULL'})`);
  return id;
}

test('carte : seulement les vidéos publiées (ni contrôle, ni rejetée), filtres', async () => {
  const app = construireApp(dependances(socle).deps);
  const pub = video('published');
  const abus = video('published', { categorie: 'abuse', sous: 'insults', forces: 'gendarmerie' });
  const vieille = video('published', { quand: "now() - interval '400 days'" });
  const cachees = [video('rejected'), video('under_debate'), video('no_decision', { controle: true }), video('in_review')];
  const get = async (q = '') => (await app.inject({ method: 'GET', url: `/public/videos${q}` })).json().videos as { id: string }[];
  const ids = (await get()).map((v) => v.id);
  assert.ok([pub, abus, vieille].every((i) => ids.includes(i)));
  assert.ok(cachees.every((i) => !ids.includes(i)));
  const un = (await get()).find((v) => v.id === pub)!;
  assert.deepEqual(Object.keys(un).sort(), ['categorie', 'date', 'forces', 'id', 'lat', 'lon', 'nom', 'precision', 'situation', 'situations', 'sousCategorie', 'sousCategories']);
  assert.match((un as unknown as { date: string }).date, /^\d{4}-\d{2}-\d{2}$/);   // au jour près
  const violences = (await get('?categorie=violence')).map((v) => v.id);
  assert.ok(violences.includes(pub) && !violences.includes(abus));
  const gendarmerie = (await get('?forces=gendarmerie')).map((v) => v.id);
  assert.ok(gendarmerie.includes(abus) && !gendarmerie.includes(pub));
  const recentes = (await get('?periode=30j')).map((v) => v.id);
  assert.ok(recentes.includes(pub) && !recentes.includes(vieille));
  assert.equal((await app.inject({ method: 'GET', url: '/public/videos?periode=hier' })).statusCode, 400);

  // Jour (du… au…), heure à une heure près (heure connue seulement), situation.
  const precise = video('published', { quand: "'2026-03-14 18:20:00+01'" });
  proprietaire(`UPDATE core.videos SET situation = 'stop' WHERE id = '${precise}'`);
  const sansHeure = video('published', { quand: "'2026-03-14 18:00:00+01'" });
  proprietaire(`UPDATE core.videos SET occurred_time_known = false WHERE id = '${sansHeure}'`);
  const jourJ = (await get('?du=2026-03-14&au=2026-03-14')).map((v) => v.id);
  assert.ok(jourJ.includes(precise) && jourJ.includes(sansHeure) && !jourJ.includes(pub));
  assert.ok(!(await get('?du=2026-03-15')).some((v) => v.id === precise));
  const versDixNeuf = (await get('?heure=19')).map((v) => v.id);
  assert.ok(versDixNeuf.includes(precise) && !versDixNeuf.includes(sansHeure));
  assert.ok(!(await get('?heure=21')).some((v) => v.id === precise));
  const controles = (await get('?situation=stop')).map((v) => v.id);
  assert.ok(controles.includes(precise) && !controles.includes(pub));
  // Plusieurs choix : la vidéo sort si au moins un de ses choix correspond, et la liste commence par le principal.
  const multiple = video('published');
  proprietaire(`UPDATE core.videos SET extra_situations = '{arrest}', extra_subcategories = '{strikes}' WHERE id = '${multiple}'`);
  const interpellations = await get('?situation=arrest');
  const trouvee = interpellations.find((v) => v.id === multiple) as unknown as { situations: string[]; sousCategories: string[] };
  assert.deepEqual(trouvee.situations, ['demonstration', 'arrest']);
  assert.deepEqual(trouvee.sousCategories, ['weapons', 'strikes']);
  assert.ok(!interpellations.some((v) => v.id === pub));
  assert.equal((await app.inject({ method: 'GET', url: '/public/videos?heure=25' })).statusCode, 400);
  await app.close();
});

test('fiche : publiée ou en débat seulement, heure arrondie, décision, empreintes, lien de visionnage', async () => {
  const app = construireApp(dependances(socle).deps);
  const pub = video('published');
  const f = (await app.inject({ method: 'GET', url: `/public/videos/${pub}` })).json();
  assert.equal(f.etat, 'publiee');
  assert.match(f.date, /T\d{2}:00$/);   // à l'heure près
  assert.deepEqual(f.decision.par, 'jury');
  assert.ok(!('original' in f.empreintes) && !JSON.stringify(f).includes('ab'.repeat(32)));   // jamais l'empreinte de l'original (A4)
  assert.deepEqual(f.notes, []);
  assert.equal((await app.inject({ method: 'GET', url: `/public/videos/${video('under_debate')}` })).json().etat, 'en_debat');
  for (const cachee of [video('rejected'), video('withdrawn'), video('in_review'), video('no_decision', { controle: true }), randomUUID()]) {
    assert.equal((await app.inject({ method: 'GET', url: `/public/videos/${cachee}` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/public/videos/${cachee}/video`, payload: {} })).statusCode, 404);
  }
  assert.match((await app.inject({ method: 'POST', url: `/public/videos/${pub}/video`, payload: {} })).json().lien, /^\/apercu\//);
  await app.close();
});

test('en débat : liste à part', async () => {
  const app = construireApp(dependances(socle).deps);
  const d = video('under_debate');
  const p = video('published');
  const ids = (await app.inject({ method: 'GET', url: '/public/en-debat' })).json().videos.map((v: { id: string }) => v.id);
  assert.ok(ids.includes(d) && !ids.includes(p));
  await app.close();
});

test('journal : du plus récent au plus ancien, par type, pages, chaîne vérifiable', async () => {
  const app = construireApp(dependances(socle).deps);
  const v = video('in_review');
  proprietaire(`UPDATE core.videos SET status = 'published', decided_at = now(), decided_by_stage = 'review' WHERE id = '${v}'`);
  const j = (await app.inject({ method: 'GET', url: '/public/journal?type=decision' })).json();
  assert.ok(j.entrees.length >= 1 && j.entrees.every((e: { type: string }) => e.type === 'decision'));
  const e = j.entrees.find((x: { contenu: { video?: string } }) => x.contenu.video === v);
  assert.deepEqual([e.contenu.status, e.contenu.stage], ['published', 'review']);
  assert.match(e.empreinte, /^[0-9a-f]{64}$/);
  const numeros = j.entrees.map((x: { numero: number }) => x.numero);
  assert.deepEqual(numeros, [...numeros].sort((a: number, b: number) => b - a));
  const page2 = (await app.inject({ method: 'GET', url: `/public/journal?avant=${numeros.at(-1)}` })).json();
  assert.ok(page2.entrees.every((x: { numero: number }) => x.numero < numeros.at(-1)));
  // La base de test contient une entrée falsifiée exprès par les tests de sécurité de la base : la
  // vérification doit la signaler, avec son numéro (sur une base saine : intact, sans numéro).
  const verif = (await app.inject({ method: 'GET', url: '/public/journal/verification' })).json();
  assert.ok(verif.entrees >= 1);
  if (verif.intact) assert.equal('premiereEntreeInvalide' in verif, false);
  else assert.ok(Number.isInteger(verif.premiereEntreeInvalide) && verif.premiereEntreeInvalide >= 1);
  await app.close();
});

test('export du journal : la chaîne se recalcule hors du serveur, et le recalcul trouve la même rupture que la base', async () => {
  const { createHash } = await import('node:crypto');
  const app = construireApp(dependances(socle).deps);
  const { entrees, formule } = (await app.inject({ method: 'GET', url: '/public/journal/export' })).json();
  assert.match(formule, /sha256/);
  let precedente = Buffer.from([0]);
  let rupture: number | null = null;
  for (const e of entrees as { numero: number; type: string; contenu: string | null; masque?: boolean; horodatage: string; empreinte: string; precedente: string }[]) {
    if (e.masque) {  // contenu masqué : seul le lien avec la précédente se vérifie
      if (rupture === null && e.precedente !== precedente.toString('hex')) rupture = e.numero;
      precedente = Buffer.from(e.empreinte, 'hex');
      continue;
    }
    const attendue = createHash('sha256').update(Buffer.concat([precedente, Buffer.from(`${e.type}|${e.contenu}|${e.horodatage}`, 'utf8')])).digest();
    if (rupture === null && (e.precedente !== precedente.toString('hex') || e.empreinte !== attendue.toString('hex'))) rupture = e.numero;
    precedente = Buffer.from(e.empreinte, 'hex');
  }
  const verif = (await app.inject({ method: 'GET', url: '/public/journal/verification' })).json();
  assert.equal(rupture ?? undefined, verif.premiereEntreeInvalide);
  await app.close();
});

test('journal : le pseudo d’analyste d’une entrée ancienne n’est jamais montré, ni dans la liste ni dans l’export', async () => {
  const app = construireApp(dependances(socle).deps);
  const seq = Number(proprietaire(`SELECT ledger.write('admin_action', '{"action": "osint_grant", "analyst": "PseudoCache"}'::jsonb)`));
  const liste = await app.inject({ method: 'GET', url: `/public/journal?type=admin_action&avant=${seq + 1}` });
  const e = liste.json().entrees.find((x: { numero: number }) => x.numero === seq);
  assert.deepEqual([e.contenu, e.masque], [{ action: 'osint_grant' }, true]);
  const exp = await app.inject({ method: 'GET', url: '/public/journal/export' });
  const x = exp.json().entrees.find((y: { numero: number }) => y.numero === seq);
  assert.deepEqual([x.contenu, x.masque], [null, true]);
  assert.doesNotMatch(liste.body + exp.body, /PseudoCache/);
  await app.close();
});

test('ancrages : liste, preuve .ots téléchargeable, rien pour une ancre simulée', async () => {
  const app = construireApp(dependances(socle).deps);
  const tete = proprietaire('SELECT seq FROM ledger.entries ORDER BY seq DESC LIMIT 1');
  const jour = `2${String(Math.floor(Math.random() * 900) + 100)}-0${Math.floor(Math.random() * 9) + 1}-1${Math.floor(Math.random() * 9)}`;
  proprietaire(`INSERT INTO ledger.anchors (day, last_seq, root_hash, ots_proof, simulated, bitcoin_block)
                SELECT '${jour}', seq, hash, '\\x004f70656e54696d657374616d7073', false, 921000 FROM ledger.entries WHERE seq = ${tete}`);
  const { ancrages } = (await app.inject({ method: 'GET', url: '/public/journal/ancrages' })).json();
  const a = ancrages.find((x: { jour: string }) => x.jour === jour);
  assert.deepEqual([a.etat, a.blocBitcoin, a.preuve, a.derniereEntree], ['confirme', 921000, true, Number(tete)]);
  const p = await app.inject({ method: 'GET', url: `/public/journal/ancrages/${jour}/preuve.ots` });
  assert.equal(p.statusCode, 200);
  assert.match(String(p.headers['content-disposition']), /argos-veille-journal-.*\.ots/);
  assert.equal(p.rawPayload.toString('hex'), '004f70656e54696d657374616d7073');
  assert.equal((await app.inject({ method: 'GET', url: '/public/journal/ancrages/2000-01-01/preuve.ots' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/public/journal/ancrages/hier/preuve.ots' })).statusCode, 400);
  await app.close();
});

test('versions : un doublon confirmé et publié sort de la carte, apparaît sur la fiche d’origine, inscrit au journal', async () => {
  const { deps } = dependances(socle);
  const app = construireApp(deps);
  const origine = randomUUID();
  const copie = randomUUID();
  const point = "ST_GeogFromText('POINT(2.35 48.85)')";
  proprietaire(`INSERT INTO core.videos (id, status, category, subcategory, forces, situation, occurred_at, location, location_precision, decided_at)
                VALUES ('${origine}', 'published', 'violence', 'weapons', 'national_police', 'demonstration', now(), ${point}, 'approx_100m', now()),
                       ('${copie}', 'jury', 'violence', 'weapons', 'national_police', 'demonstration', now(), ${point}, 'approx_100m', NULL);
                UPDATE core.videos SET duplicate_of = '${origine}' WHERE id = '${copie}';
                UPDATE core.videos SET status = 'published', decided_at = now() WHERE id = '${copie}'`);
  const ids = async () => (await app.inject({ method: 'GET', url: '/public/videos', remoteAddress: '198.51.100.70' })).json().videos.map((v: { id: string }) => v.id);
  const fiche = async (id: string) => (await app.inject({ method: 'GET', url: `/public/videos/${id}`, remoteAddress: '198.51.100.71' })).json();

  const l = await ids();
  assert.ok(l.includes(origine));
  assert.ok(!l.includes(copie));
  assert.deepEqual((await fiche(origine)).autresVersions.map((x: { id: string }) => x.id), [copie]);
  assert.equal((await fiche(copie)).versionDe.id, origine);
  assert.match(proprietaire(`SELECT payload::text FROM ledger.entries WHERE kind = 'event_link' AND payload ->> 'video' = '${copie}'`), /version_of/);

  // L'origine n'est plus publiée : la copie retrouve sa propre place sur la carte.
  proprietaire(`UPDATE core.videos SET status = 'hidden' WHERE id = '${origine}'`);
  assert.ok((await ids()).includes(copie));
  assert.equal((await fiche(copie)).versionDe, null);
  await app.close();
});
