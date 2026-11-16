// Connexions à PostgreSQL : un pool par rôle, pour que chaque partie du code n'ait que ses droits.
//   app      : le site (argos_api -> argos_app), aucun accès au schéma identity
//   identity : inscription (argos_api_identity -> argos_identity), uniquement le schéma identity
import pg from 'pg';
import type { Config } from './config.ts';

export interface Bases {
  app: pg.Pool;
  identity: pg.Pool;
  fermer(): Promise<void>;
}

/** Une connexion inactive coupée par la base (redémarrage, mise à jour) émet 'error' sur le pool :
 *  sans écouteur, Node s'arrête. On l'inscrit au journal ; le pool en rouvre une à la demande. */
export function surveillerPool(p: pg.Pool, nom: string): pg.Pool {
  p.on('error', (e) => {
    console.error(`${new Date().toISOString()} ${nom} : connexion à la base perdue (${e.message})`);
  });
  return p;
}

function pool(config: Config, user: string, password: string): pg.Pool {
  return surveillerPool(new pg.Pool({
    host: config.pg.host,
    port: config.pg.port,
    database: config.pg.database,
    user,
    password,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idle_in_transaction_session_timeout: 10_000,
    statement_timeout: 10_000,
    application_name: `argos-api/${user}`,
  }), `argos-api/${user}`);
}

export function ouvrirBases(config: Config): Bases {
  // Instance d'administration : rôle argos_api_admin (fonctions d'administration en plus du site, 0099).
  const app = config.pg.adminPassword ? pool(config, 'argos_api_admin', config.pg.adminPassword)
                                      : pool(config, 'argos_api', config.pg.appPassword);
  const identity = pool(config, 'argos_api_identity', config.pg.identityPassword);
  return {
    app,
    identity,
    async fermer() {
      await Promise.all([app.end(), identity.end()]);
    },
  };
}
