// Base redémarrée (mise à jour de PostgreSQL) : une connexion inactive coupée ne doit pas arrêter l'API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { lireConfig } from '../src/config.ts';
import { ouvrirBases } from '../src/db.ts';

test('connexion inactive coupée par la base : le pool survit et se reconnecte', async () => {
  const config = lireConfig();
  const bases = ouvrirBases(config);
  const temoin = new pg.Client({
    host: config.pg.host, port: config.pg.port, database: config.pg.database,
    // même rôle que le pool « app » (argos_api_admin quand l'instance sert aussi l'administration) : on ne coupe que les siens
    ...(config.pg.adminPassword ? { user: 'argos_api_admin', password: config.pg.adminPassword } : { user: 'argos_api', password: config.pg.appPassword }),
  });
  await temoin.connect();
  // sans écouteur 'error' posé par db.ts, la coupure arrêterait le processus
  assert.equal(bases.app.listenerCount('error'), 1);
  assert.equal(bases.identity.listenerCount('error'), 1);
  try {
    const client = await bases.app.connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    client.release();   // inactive dans le pool, comme la nuit
    const perdue = new Promise<void>((ok) => bases.app.once('error', () => ok()));
    await temoin.query('SELECT pg_terminate_backend($1)', [pid]);
    await perdue;
    const r = await bases.app.query<{ un: number }>('SELECT 1 AS un');
    assert.equal(r.rows[0]!.un, 1);
  } finally {
    await temoin.end();
    await bases.fermer();
  }
});
