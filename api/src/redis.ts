// Redis : données temporaires (codes de vérification, limites de tentatives). Rien de durable.
import { Redis } from 'ioredis';
import type { Config } from './config.ts';

export function ouvrirRedis(config: Config): Redis {
  return new Redis(config.redisUrl, {
    ...(config.redisPassword ? { password: config.redisPassword } : {}),
    keyPrefix: 'argos:',
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
}
