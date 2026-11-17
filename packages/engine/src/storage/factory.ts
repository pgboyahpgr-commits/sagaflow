import type { StorageAdapter, StorageConfig } from './interface.js';
import { JsonFileStorageAdapter } from './json-file.js';
import { PostgresStorageAdapter } from './postgres.js';
import { LibSqlStorageAdapter } from './sqlite.js';

export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  switch (config.driver) {
    case 'json':
      return new JsonFileStorageAdapter(config);
    case 'postgres':
      return new PostgresStorageAdapter(config);
    case 'sqlite':
    default:
      return new LibSqlStorageAdapter(config);
  }
}

export function loadStorageConfigFromEnv(env: Record<string, string | undefined> = process.env): StorageConfig {
  const rawDriver = (env.STORAGE_DRIVER ?? 'sqlite').toLowerCase();
  const driver: StorageConfig['driver'] =
    rawDriver === 'json' || rawDriver === 'postgres' ? rawDriver : 'sqlite';

  const rawIsolation = (env.STORAGE_ISOLATION ?? (driver === 'postgres' ? 'rls' : 'db-per-tenant')).toLowerCase();
  const isolation: StorageConfig['isolation'] =
    rawIsolation === 'shared' || rawIsolation === 'rls' ? rawIsolation : 'db-per-tenant';

  const queueDriver: StorageConfig['queueDriver'] =
    (env.QUEUE_DRIVER ?? 'local').toLowerCase() === 'nats' ? 'nats' : 'local';

  const workerConcurrency = Math.min(
    Math.max(Number.parseInt(env.WORKER_CONCURRENCY ?? '16', 10) || 16, 1),
    200
  );

  return {
    driver,
    isolation,
    storagePath: env.STORAGE_PATH ?? './data',
    databaseUrl: env.DATABASE_URL,
    libsqlAuthToken: env.LIBSQL_AUTH_TOKEN,
    queueDriver,
    workerConcurrency,
  };
}
