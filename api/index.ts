import { handle } from '@hono/node-server/vercel';
import {
  CronScheduler,
  LocalDurableQueue,
  RunEventBus,
  SagaOrchestrator,
  SecretCipher,
  createStorageAdapter,
  seedDemoData,
} from '@sagaflow/engine';
import { createApiApp } from '../apps/api/dist/app.js';

interface ServerlessContext {
  app: ReturnType<typeof createApiApp>;
  queue: LocalDurableQueue;
}

let ctxPromise: Promise<ServerlessContext> | null = null;

function inferStorageDriver(databaseUrl: string | undefined): 'sqlite' | 'json' | 'postgres' {
  if (databaseUrl && /^postgres(ql)?:\/\//i.test(databaseUrl)) return 'postgres';
  if (databaseUrl && /^(libsql|https?):\/\//i.test(databaseUrl)) return 'sqlite';
  return process.env.VERCEL ? 'json' : 'sqlite';
}

async function bootstrapServerlessApp(): Promise<ServerlessContext> {
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  const storageDriver =
    (process.env.STORAGE_DRIVER as 'sqlite' | 'json' | 'postgres' | undefined) ??
    inferStorageDriver(databaseUrl);

  // Vercel functions only get a writable /tmp directory, and it is per-instance.
  // That is fine for a demo, but durable deployments should provide DATABASE_URL
  // (PostgreSQL or remote libSQL/Turso). Surface the distinction in /api/health.
  const storagePath = process.env.STORAGE_PATH ?? '/tmp/sagaflow-data';
  const persistent = storageDriver === 'postgres' || (storageDriver === 'sqlite' && Boolean(databaseUrl));
  process.env.STORAGE_EPHEMERAL = persistent ? 'false' : 'true';

  if (!persistent) {
    console.warn(
      '[SagaFlow] Running on ephemeral function storage. Data resets between instances. ' +
        'Set DATABASE_URL (PostgreSQL or libSQL/Turso) for durable Vercel storage.'
    );
  }

  const storage = createStorageAdapter({
    driver: storageDriver,
    isolation:
      storageDriver === 'postgres'
        ? ((process.env.STORAGE_ISOLATION as 'rls' | 'shared') ?? 'rls')
        : databaseUrl
          ? 'shared'
          : 'db-per-tenant',
    storagePath,
    databaseUrl,
    libsqlAuthToken: process.env.LIBSQL_AUTH_TOKEN,
    queueDriver: 'local',
    workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 16),
  });
  await storage.init();

  if (!process.env.SAGAFLOW_MASTER_KEY) {
    console.warn(
      '[SagaFlow] SAGAFLOW_MASTER_KEY is not set. Set it to a long random value so ' +
        'secrets stay decryptable across function instances and redeploys.'
    );
  }
  const cipher = new SecretCipher({
    masterKey: process.env.SAGAFLOW_MASTER_KEY ?? 'sagaflow-vercel-default-master-key-2026',
    storagePath,
  });

  if (process.env.SEED_DEMO !== 'false') {
    await seedDemoData(storage, cipher);
  }

  const eventBus = new RunEventBus(storage);
  const queue = new LocalDurableQueue(storage, Number(process.env.WORKER_CONCURRENCY ?? 16));
  const orchestrator = new SagaOrchestrator(storage, queue, eventBus, cipher);
  await orchestrator.start();

  const scheduler = new CronScheduler(storage, orchestrator, 60_000);

  const app = createApiApp({
    storage,
    queue,
    eventBus,
    orchestrator,
    cipher,
    scheduler,
    authMode: process.env.AUTH_MODE === 'prod' ? 'prod' : 'dev',
    jwtSecret: process.env.SAGAFLOW_JWT_SECRET,
    role: 'all',
  });

  return { app, queue };
}

function getContext(): Promise<ServerlessContext> {
  if (!ctxPromise) {
    ctxPromise = bootstrapServerlessApp().catch((err) => {
      // Allow the next invocation to retry a transient cold-start failure
      // (for example a database that is still waking up).
      ctxPromise = null;
      throw err;
    });
  }
  return ctxPromise;
}

async function waitForQueueDrain(queue: LocalDurableQueue, maxMs = 15_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  // Give newly enqueued work a tick to register before checking idle.
  await new Promise((r) => setTimeout(r, 25));
  while (Date.now() < deadline) {
    const stats = queue.getStats();
    if (stats.pending === 0 && stats.active === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export default async function handler(req: any, res: any) {
  const { app, queue } = await getContext();
  const result = await handle(app)(req, res);

  // On Vercel serverless, keep the function alive via waitUntil until in-flight Saga steps drain.
  const method = String(req?.method ?? 'GET').toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const rcSymbol = Symbol.for('@vercel/request-context');
    const rc = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } }>)[rcSymbol];
    const waitUntil = rc?.get?.()?.waitUntil;
    if (typeof waitUntil === 'function') {
      waitUntil(waitForQueueDrain(queue, 20_000));
    }
  }

  return result;
}
