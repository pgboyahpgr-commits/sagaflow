import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  CronScheduler,
  LocalDurableQueue,
  NatsJetStreamQueue,
  RunEventBus,
  SagaOrchestrator,
  SecretCipher,
  createStorageAdapter,
  loadStorageConfigFromEnv,
  seedDemoData,
} from '@sagaflow/engine';
import { createApiApp } from './app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load a local `.env` file when present (Node >= 20.12). Hosted platforms such
 * as Vercel/Render/Fly inject real environment variables, so a missing file is
 * expected and never fatal.
 */
function loadLocalEnv(): void {
  try {
    if (typeof (process as NodeJS.Process & { loadEnvFile?: (path?: string) => void }).loadEnvFile === 'function') {
      (process as NodeJS.Process & { loadEnvFile: (path?: string) => void }).loadEnvFile('.env');
    }
  } catch {
    /* No .env file (or an unreadable one): rely on the process environment. */
  }
}

loadLocalEnv();

export interface ServerOverrides {
  port?: number;
  host?: string;
  role?: 'all' | 'api' | 'worker';
  storageDriver?: 'sqlite' | 'json' | 'postgres';
  storagePath?: string;
}

export async function startSagaFlowServer(overrides: ServerOverrides = {}): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (overrides.storageDriver) env.STORAGE_DRIVER = overrides.storageDriver;
  if (overrides.storagePath) env.STORAGE_PATH = overrides.storagePath;

  const role =
    overrides.role ??
    ((env.ROLE === 'api' || env.ROLE === 'worker' ? env.ROLE : 'all') as 'all' | 'api' | 'worker');

  const storageConfig = loadStorageConfigFromEnv(env);
  const cipher = new SecretCipher({
    masterKey: env.SAGAFLOW_MASTER_KEY,
    storagePath: storageConfig.storagePath,
  });
  const jwtSecret =
    env.SAGAFLOW_JWT_SECRET ?? env.SAGAFLOW_MASTER_KEY ?? cipher.getSigningSecret().toString('hex');

  const storage = createStorageAdapter(storageConfig);
  await storage.init();

  // Demo tenants/workflows are a zero-config convenience for local use. Skip
  // them automatically in production auth mode unless SEED_DEMO is explicit.
  const shouldSeedDemo =
    env.SEED_DEMO !== undefined
      ? env.SEED_DEMO.toLowerCase() !== 'false'
      : (env.AUTH_MODE ?? 'dev') !== 'prod';
  if (shouldSeedDemo && role !== 'worker') {
    await seedDemoData(storage, cipher);
  }

  const eventBus = new RunEventBus(storage);
  const queue =
    storageConfig.queueDriver === 'nats' && env.NATS_URL
      ? new NatsJetStreamQueue(env.NATS_URL, storageConfig.workerConcurrency)
      : new LocalDurableQueue(storage, storageConfig.workerConcurrency);

  const orchestrator = new SagaOrchestrator(storage, queue, eventBus, cipher);
  const scheduler = new CronScheduler(
    storage,
    orchestrator,
    Number.parseInt(env.CRON_POLL_INTERVAL_MS ?? '15000', 10) || 15000
  );

  // Start worker pool & cron scheduler in 'all' or 'worker' role
  if (role === 'all' || role === 'worker') {
    await orchestrator.start();
    scheduler.start();
  }

  const app = createApiApp({
    storage,
    queue,
    eventBus,
    orchestrator,
    cipher,
    scheduler,
    jwtSecret,
    role,
    authMode: (env.AUTH_MODE as 'dev' | 'prod') || 'dev',
  });

  // Self-hosted single-server mode: serve built frontend from apps/web/dist when present (api/all roles)
  if (role === 'all' || role === 'api') {
    const webDistDir = resolve(__dirname, '../../web/dist');
    if (existsSync(join(webDistDir, 'index.html'))) {
      app.use('/assets/*', serveStatic({ root: webDistDir }));
      app.get('*', (c) => {
        if (c.req.path.startsWith('/api/')) {
          return c.json({ code: 'not_found', message: 'API endpoint not found.' }, 404);
        }
        const html = readFileSync(join(webDistDir, 'index.html'), 'utf8');
        return c.html(html);
      });
    }
  }

  const host = overrides.host ?? env.HOST ?? '0.0.0.0';
  const port = overrides.port ?? (Number.parseInt(env.PORT ?? '4000', 10) || 4000);

  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(
      `[SagaFlow] Listening on http://${info.address}:${info.port} | role=${role} | storage=${storageConfig.driver}(${storageConfig.isolation}) | queue=${storageConfig.queueDriver} | encryption=AES-256-GCM | path=${storageConfig.storagePath}`
    );
  });

  const shutdown = async () => {
    console.log('\n[SagaFlow] Shutting down gracefully...');
    scheduler.stop();
    server.close();
    await orchestrator.stop();
    await storage.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// Auto-start when invoked directly via `node dist/server.js`
const isDirectMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectMain) {
  startSagaFlowServer().catch((err) => {
    console.error('[SagaFlow] Fatal startup error:', err);
    process.exit(1);
  });
}
