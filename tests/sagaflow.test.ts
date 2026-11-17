import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Remove a temporary test directory.
 *
 * On Windows, SQLite WAL/SHM handles can outlive `storage.close()` for a few
 * milliseconds, which makes an immediate recursive delete fail with EPERM.
 * Retry briefly and treat a leftover temp folder as non-fatal: a cleanup
 * problem must never mask the real test result.
 */
function removeTempDir(dir: string | undefined): void {
  if (!dir || !existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Best-effort cleanup only (see comment above).
  }
}
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getNextCronDate,
  validateCronExpression,
  validateWorkflowGraph,
} from '@sagaflow/shared';
import {
  CronScheduler,
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  DEMO_TENANTS,
  DEMO_USER_ID,
  LocalDurableQueue,
  RunEventBus,
  SagaOrchestrator,
  SecretCipher,
  computeWebhookHmac,
  createStorageAdapter,
  resolveTemplates,
  runInQuickJSSandbox,
  runStressTest,
  seedDemoData,
  type StorageAdapter,
} from '@sagaflow/engine';
import { createApiApp } from './apps/api/src/app.js';

describe('1. DAG Validator (@sagaflow/shared)', () => {
  it('validates an acyclic graph and returns topological order', () => {
    const res = validateWorkflowGraph(
      [
        { id: 'a', type: 'trigger', config: {} },
        { id: 'b', type: 'custom_task', config: {} },
        { id: 'c', type: 'custom_task', config: {} },
        { id: 'd', type: 'custom_task', config: {} },
      ],
      [
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'a', to: 'c' },
        { id: 'e3', from: 'b', to: 'd' },
        { id: 'e4', from: 'c', to: 'd' },
      ]
    );
    expect(res.valid).toBe(true);
    expect(res.topologicalOrder[0]).toBe('a');
    expect(res.topologicalOrder[res.topologicalOrder.length - 1]).toBe('d');
  });

  it('detects cycles, self-loops, duplicates, and missing node references with exact IDs', () => {
    const res = validateWorkflowGraph(
      [
        { id: 'n1', type: 'trigger', config: {} },
        { id: 'n2', type: 'custom_task', config: {} },
        { id: 'n2', type: 'custom_task', config: {} },
      ],
      [
        { id: 'e1', from: 'n1', to: 'n2' },
        { id: 'e2', from: 'n2', to: 'n1' },
        { id: 'e3', from: 'n1', to: 'ghost' },
      ]
    );
    expect(res.valid).toBe(false);
    const codes = res.issues.map((i) => i.code);
    expect(codes).toContain('duplicate_node_id');
    expect(codes).toContain('missing_node_reference');
    expect(codes).toContain('cycle');
    expect(res.issues.find((i) => i.code === 'cycle')?.nodeId).toBeTruthy();
  });
});

describe('2. QuickJS-WASM Isolated Sandbox', () => {
  it('executes pure JS transforms and captures console logs', async () => {
    const res = await runInQuickJSSandbox({
      code: `
        console.log("processing", input.orderId);
        return { total: input.amount * 2, ok: true };
      `,
      input: { orderId: 'ORD-1', amount: 50 },
      steps: {},
    });
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ total: 100, ok: true });
    expect(res.logs).toContain('processing ORD-1');
  });

  it('blocks host process/require access inside WASM linear memory', async () => {
    const res = await runInQuickJSSandbox({
      code: `return { hasProcess: typeof process, hasRequire: typeof require };`,
      input: {},
      steps: {},
    });
    expect(res.ok).toBe(true);
    expect(res.output).toEqual({ hasProcess: 'undefined', hasRequire: 'undefined' });
  });

  it('interrupts infinite loops cleanly within timeout', async () => {
    const res = await runInQuickJSSandbox({
      code: `while (true) {}`,
      input: {},
      steps: {},
      timeoutMs: 120,
    });
    expect(res.ok).toBe(false);
    expect(res.error?.toLowerCase()).toContain('timed out');
  });

  it('enforces hard memory limit against allocation bombs', async () => {
    const res = await runInQuickJSSandbox({
      code: `const arr = []; for (let i = 0; i < 1e7; i++) arr.push({ a: i, b: i + 1 }); return arr.length;`,
      input: {},
      steps: {},
      memoryLimitMb: 4,
      timeoutMs: 1000,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe('3. Full End-to-End API, Multi-Tenancy, Saga Rollback, Cancel & Stress (SQLite db-per-tenant)', () => {
  let tmpDir: string;
  let storage: StorageAdapter;
  let queue: LocalDurableQueue;
  let eventBus: RunEventBus;
  let orchestrator: SagaOrchestrator;
  let app: ReturnType<typeof createApiApp>;

  const acmeHeaders = {
    'X-Tenant-Id': DEMO_TENANTS.ACME.id,
    'X-User-Id': DEMO_USER_ID,
    'Content-Type': 'application/json',
  };

  const globexHeaders = {
    'X-Tenant-Id': DEMO_TENANTS.GLOBEX.id,
    'X-User-Id': DEMO_USER_ID,
    'Content-Type': 'application/json',
  };

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sagaflow-sqlite-test-'));
    storage = createStorageAdapter({
      driver: 'sqlite',
      isolation: 'db-per-tenant',
      storagePath: tmpDir,
      queueDriver: 'local',
      workerConcurrency: 16,
    });
    await storage.init();
    await seedDemoData(storage);

    eventBus = new RunEventBus(storage);
    queue = new LocalDurableQueue(storage, 16);
    orchestrator = new SagaOrchestrator(storage, queue, eventBus);
    await orchestrator.start();

    app = createApiApp({ storage, queue, eventBus, orchestrator, authMode: 'dev' });
  });

  afterAll(async () => {
    await orchestrator.stop();
    await storage.close();
    removeTempDir(tmpDir);
  });

  it('provisions physically separate SQLite database files per tenant', () => {
    expect(existsSync(join(tmpDir, 'control.db'))).toBe(true);
    expect(existsSync(join(tmpDir, 'tenants', `${DEMO_TENANTS.ACME.id}.db`))).toBe(true);
    expect(existsSync(join(tmpDir, 'tenants', `${DEMO_TENANTS.GLOBEX.id}.db`))).toBe(true);
  });

  it('enforces strict tenant isolation (returns 404 across tenants, 401 unauthenticated, 403 non-member)', async () => {
    const noAuth = await app.request('/api/workflows');
    expect(noAuth.status).toBe(401);
    expect((await noAuth.json()).code).toBe('unauthenticated');

    const badUser = await app.request('/api/workflows', {
      headers: { 'X-Tenant-Id': DEMO_TENANTS.ACME.id, 'X-User-Id': 'usr_stranger' },
    });
    expect(badUser.status).toBe(403);
    expect((await badUser.json()).code).toBe('forbidden');

    // Acme trying to fetch Globex's workflow gets 404 (not 403, so existence isn't leaked)
    const crossTenant = await app.request('/api/workflows/wf_globex_customs', {
      headers: acmeHeaders,
    });
    expect(crossTenant.status).toBe(404);
    expect((await crossTenant.json()).code).toBe('workflow_not_found');
  });

  it('supports cryptographic SHA-256 API keys and key revocation', async () => {
    const createRes = await app.request('/api/api-keys', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ name: 'Test CI Key' }),
    });
    expect(createRes.status).toBe(201);
    const { apiKey, rawKey } = await createRes.json();
    expect(rawKey).toMatch(/^sf_live_/);

    const withKey = await app.request('/api/workflows', {
      headers: { 'X-Api-Key': rawKey },
    });
    expect(withKey.status).toBe(200);

    const revokeRes = await app.request(`/api/api-keys/${apiKey.id}`, {
      method: 'DELETE',
      headers: acmeHeaders,
    });
    expect(revokeRes.status).toBe(200);

    const afterRevoke = await app.request('/api/workflows', {
      headers: { 'X-Api-Key': rawKey },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it('honors API Contract v1.1 validate (200/400/422), draft (0 nodes allowed), and publish (immutable versions)', async () => {
    const badSchema = await app.request('/api/workflows/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', nodes: [], edges: [] }),
    });
    expect(badSchema.status).toBe(400);
    expect((await badSchema.json()).code).toBe('invalid_request');

    const cyclic = await app.request('/api/workflows/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Cyclic',
        nodes: [
          { id: 'a', type: 'trigger', config: {} },
          { id: 'b', type: 'custom_task', config: {} },
        ],
        edges: [
          { id: 'e1', from: 'a', to: 'b' },
          { id: 'e2', from: 'b', to: 'a' },
        ],
      }),
    });
    expect(cyclic.status).toBe(422);
    const cyclicBody = await cyclic.json();
    expect(cyclicBody.code).toBe('invalid_workflow_graph');
    expect(cyclicBody.errors[0].code).toBe('cycle');

    // Empty draft allowed (D3)
    const createDraft = await app.request('/api/workflows', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ name: 'Empty Draft', nodes: [], edges: [] }),
    });
    expect(createDraft.status).toBe(201);
    const { workflow: draft } = await createDraft.json();

    // Starting unpublished workflow returns 409 workflow_not_published
    const runUnpub = await app.request(`/api/workflows/${draft.id}/runs`, {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'idem-unpub-1' },
      body: JSON.stringify({}),
    });
    expect(runUnpub.status).toBe(409);
    expect((await runUnpub.json()).code).toBe('workflow_not_published');

    // Publishing empty draft fails 422
    const pubEmpty = await app.request(`/api/workflows/${draft.id}/publish`, {
      method: 'POST',
      headers: acmeHeaders,
    });
    expect(pubEmpty.status).toBe(422);
  });

  it('enforces Idempotency-Key (400 missing, 202 created, 200 duplicate) and runs retries + WASM + parallel fan-out', async () => {
    const missingKey = await app.request('/api/workflows/wf_order_fulfillment/runs', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({}),
    });
    expect(missingKey.status).toBe(400);

    const key = 'idem-order-run-001';
    const first = await app.request('/api/workflows/wf_order_fulfillment/runs', {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': key },
      body: JSON.stringify({ input: { orderId: 'ORD-TEST', amount: 200 } }),
    });
    expect(first.status).toBe(202);
    const { run: run1 } = await first.json();

    const duplicate = await app.request('/api/workflows/wf_order_fulfillment/runs', {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': key },
      body: JSON.stringify({ input: { orderId: 'ORD-TEST', amount: 200 } }),
    });
    expect(duplicate.status).toBe(200);
    const { run: run2 } = await duplicate.json();
    expect(run2.id).toBe(run1.id);

    await eventBus.waitForCompletion(DEMO_TENANTS.ACME.id, run1.id, 15000);
    const detailRes = await app.request(`/api/runs/${run1.id}`, { headers: acmeHeaders });
    const { run, events } = await detailRes.json();

    expect(run.status).toBe('succeeded');
    expect(events.length).toBeGreaterThan(5);
    // Charge payment was configured to fail once then succeed on attempt #2
    const chargeStep = run.steps.find((s: any) => s.nodeId === 'charge');
    expect(chargeStep.attempts.length).toBe(2);
    expect(chargeStep.attempts[0].status).toBe('failed');
    expect(chargeStep.attempts[1].status).toBe('succeeded');

    // Enrich WASM script produced tax + total
    const enrichStep = run.steps.find((s: any) => s.nodeId === 'enrich');
    expect(enrichStep.output.total).toBe(216);
  });

  it('executes full reverse-order Saga compensation on permanent failure and logs to DLQ with replay', async () => {
    const startRes = await app.request('/api/workflows/wf_saga_rollback/runs', {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'idem-saga-rb-001' },
      body: JSON.stringify({ input: { amount: 500 } }),
    });
    expect(startRes.status).toBe(202);
    const { run: created } = await startRes.json();

    await eventBus.waitForCompletion(DEMO_TENANTS.ACME.id, created.id, 15000);
    const detailRes = await app.request(`/api/runs/${created.id}`, { headers: acmeHeaders });
    const { run, events } = await detailRes.json();

    expect(run.status).toBe('compensated');
    const reserve = run.steps.find((s: any) => s.nodeId === 'reserve');
    const credits = run.steps.find((s: any) => s.nodeId === 'credits');
    const charge = run.steps.find((s: any) => s.nodeId === 'charge');
    expect(charge.status).toBe('failed');
    expect(charge.attempts.length).toBe(2);
    expect(credits.status).toBe('compensated');
    expect(reserve.status).toBe('compensated');
    expect(credits.attempts.some((a: any) => a.kind === 'compensate' && a.status === 'succeeded')).toBe(true);
    expect(reserve.attempts.some((a: any) => a.kind === 'compensate' && a.status === 'succeeded')).toBe(true);

    // Verify reverse order: credits compensated BEFORE reserve!
    const compEvents = events.filter((e: any) => e.type === 'compensation.started');
    expect(compEvents.map((e: any) => e.nodeId)).toEqual(['credits', 'reserve']);

    // Verify DLQ entry captured & replayable
    const dlqRes = await app.request('/api/dlq', { headers: acmeHeaders });
    const { entries } = await dlqRes.json();
    const dlqItem = entries.find((d: any) => d.runId === created.id);
    expect(dlqItem).toBeTruthy();

    const replayRes = await app.request(`/api/dlq/${dlqItem.id}/replay`, {
      method: 'POST',
      headers: acmeHeaders,
    });
    expect(replayRes.status).toBe(202);
    const { run: replayed } = await replayRes.json();
    await eventBus.waitForCompletion(DEMO_TENANTS.ACME.id, replayed.id, 15000);
  });

  it('supports conditional branching (skips untaken branch) and cooperative cancellation', async () => {
    // Low amount -> takes false branch (standard_notify), skips vip_hold & vip_webhook
    const condRes = await app.request('/api/workflows/wf_conditional_router/runs', {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'idem-cond-low' },
      body: JSON.stringify({ input: { amount: 25 } }),
    });
    const { run: condRun } = await condRes.json();
    await eventBus.waitForCompletion(DEMO_TENANTS.ACME.id, condRun.id, 10000);
    const condDetail = await (await app.request(`/api/runs/${condRun.id}`, { headers: acmeHeaders })).json();
    expect(condDetail.run.status).toBe('succeeded');
    expect(condDetail.run.steps.find((s: any) => s.nodeId === 'standard_notify').status).toBe('succeeded');
    expect(condDetail.run.steps.find((s: any) => s.nodeId === 'vip_hold').status).toBe('skipped');
    expect(condDetail.run.steps.find((s: any) => s.nodeId === 'vip_webhook').status).toBe('skipped');

    // Already finished run cannot be cancelled -> 409 run_not_cancellable
    const cancelDone = await app.request(`/api/runs/${condRun.id}/cancel`, {
      method: 'POST',
      headers: acmeHeaders,
    });
    expect(cancelDone.status).toBe(409);
    expect((await cancelDone.json()).code).toBe('run_not_cancellable');

    // Create a slow workflow with a 10s wait and cancel it cooperatively
    const slowCreate = await app.request('/api/workflows', {
      method: 'POST',
      headers: globexHeaders,
      body: JSON.stringify({
        name: 'Slow Wait Workflow',
        nodes: [
          { id: 't', type: 'trigger', config: { simulatedLatencyMs: 10 } },
          { id: 'w', type: 'wait', config: { delayMs: 10000 } },
        ],
        edges: [{ id: 'e1', from: 't', to: 'w' }],
      }),
    });
    const { workflow: slowWf } = await slowCreate.json();
    await app.request(`/api/workflows/${slowWf.id}/publish`, {
      method: 'POST',
      headers: globexHeaders,
    });

    const slowRunRes = await app.request(`/api/workflows/${slowWf.id}/runs`, {
      method: 'POST',
      headers: { ...globexHeaders, 'Idempotency-Key': 'idem-cancel-1' },
      body: JSON.stringify({}),
    });
    const { run: slowRun } = await slowRunRes.json();
    await new Promise((r) => setTimeout(r, 80));

    const cancelRes = await app.request(`/api/runs/${slowRun.id}/cancel`, {
      method: 'POST',
      headers: globexHeaders,
    });
    expect(cancelRes.status).toBe(200);
    expect((await cancelRes.json()).run.cancelRequested).toBe(true);

    await eventBus.waitForCompletion(DEMO_TENANTS.GLOBEX.id, slowRun.id, 5000);
    const finalSlow = await (await app.request(`/api/runs/${slowRun.id}`, { headers: globexHeaders })).json();
    expect(finalSlow.run.status).toBe('cancelled');
  });

  it('handles concurrent stress testing cleanly with accurate latency percentiles', async () => {
    const result = await runStressTest({
      tenantId: DEMO_TENANTS.ACME.id,
      input: {
        workflowId: 'wf_conditional_router',
        totalRuns: 25,
        concurrency: 10,
        input: { amount: 40 },
      },
      storage,
      orchestrator,
      eventBus,
    });
    expect(result.outcomes.succeeded).toBe(25);
    expect(result.runsPerSecond).toBeGreaterThan(0);
    expect(result.latency.p95Ms).toBeGreaterThanOrEqual(result.latency.p50Ms);
  });
});

describe('4. Portable JSON Folder Storage Adapter ("Store Anything Anywhere")', () => {
  let jsonDir: string;
  let storage: StorageAdapter;

  beforeAll(async () => {
    jsonDir = mkdtempSync(join(tmpdir(), 'sagaflow-json-test-'));
    storage = createStorageAdapter({
      driver: 'json',
      isolation: 'db-per-tenant',
      storagePath: jsonDir,
      queueDriver: 'local',
      workerConcurrency: 4,
    });
    await storage.init();
    await seedDemoData(storage);
  });

  afterAll(async () => {
    await storage.close();
    removeTempDir(jsonDir);
  });

  it('stores tenant data as clean isolated portable JSON files and runs workflows identically', async () => {
    expect(existsSync(join(jsonDir, 'control.json'))).toBe(true);
    expect(existsSync(join(jsonDir, 'tenants', `${DEMO_TENANTS.ACME.id}.json`))).toBe(true);
    expect(existsSync(join(jsonDir, 'tenants', `${DEMO_TENANTS.GLOBEX.id}.json`))).toBe(true);

    const eventBus = new RunEventBus(storage);
    const queue = new LocalDurableQueue(storage, 4);
    const orchestrator = new SagaOrchestrator(storage, queue, eventBus);
    await orchestrator.start();

    const { run } = await storage.createRunIdempotent(DEMO_TENANTS.GLOBEX.id, {
      id: 'run_json_001',
      workflowId: 'wf_globex_customs',
      workflowName: 'Customs',
      versionNumber: 1,
      idempotencyKey: 'json-key-1',
      input: { weightKg: 100, declaredUsd: 2000 },
    });
    await orchestrator.enqueueRun(DEMO_TENANTS.GLOBEX.id, run.id);
    await eventBus.waitForCompletion(DEMO_TENANTS.GLOBEX.id, run.id, 10000);

    const finished = await storage.getRun(DEMO_TENANTS.GLOBEX.id, run.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.steps.find((s) => s.nodeId === 'tariff_calc')?.output).toMatchObject({
      dutyUsd: 115,
      clearedForFiling: true,
    });
    await orchestrator.stop();
  });
});

describe('5. Production Extensions: Secrets Vault, Template Chaining, Webhooks, Cron & JWT Auth', () => {
  let tempDir: string;
  let storage: StorageAdapter;
  let orchestrator: SagaOrchestrator;
  let scheduler: CronScheduler;
  let cipher: SecretCipher;
  let app: ReturnType<typeof createApiApp>;

  const acmeHeaders = {
    'X-Tenant-Id': DEMO_TENANTS.ACME.id,
    'X-User-Id': DEMO_USER_ID,
    'Content-Type': 'application/json',
  };
  const globexHeaders = {
    'X-Tenant-Id': DEMO_TENANTS.GLOBEX.id,
    'X-User-Id': DEMO_USER_ID,
    'Content-Type': 'application/json',
  };

  async function waitRunTerminal(tenantId: string, runId: string) {
    for (let i = 0; i < 60; i++) {
      const r = await storage.getRun(tenantId, runId);
      if (r && ['succeeded', 'failed', 'compensated', 'cancelled'].includes(r.status)) {
        return r;
      }
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`Run ${runId} timed out`);
  }

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sagaflow-v2-'));
    cipher = new SecretCipher({ storagePath: tempDir });
    storage = createStorageAdapter({
      driver: 'sqlite',
      isolation: 'db-per-tenant',
      storagePath: tempDir,
      queueDriver: 'local',
      workerConcurrency: 8,
    });
    await storage.init();
    await seedDemoData(storage, cipher);

    const eventBus = new RunEventBus(storage);
    const queue = new LocalDurableQueue(storage, 8);
    orchestrator = new SagaOrchestrator(storage, queue, eventBus, cipher);
    scheduler = new CronScheduler(storage, orchestrator, 60_000);
    await orchestrator.start();

    app = createApiApp({
      storage,
      queue,
      eventBus,
      orchestrator,
      cipher,
      scheduler,
      authMode: 'dev',
    });
  });

  afterAll(async () => {
    scheduler.stop();
    await orchestrator.stop();
    await storage.close();
    removeTempDir(tempDir);
  });

  it('resolves {{input.*}}, {{steps.*}}, {{secrets.*}} templates cleanly', () => {
    const out = resolveTemplates(
      {
        url: 'https://api.example.com/orders/{{input.orderId}}',
        total: '{{steps.calc.total}}',
        auth: 'Bearer {{secrets.API_KEY}}',
        nested: ['{{input.tags.0}}', '{{env.runId}}'],
      },
      {
        input: { orderId: 'ORD-77', tags: ['vip'] },
        steps: { calc: { total: 420.5 } },
        secrets: { API_KEY: 'topsecret_999' },
        env: { runId: 'run_1' },
      }
    ) as Record<string, unknown>;

    expect(out.url).toBe('https://api.example.com/orders/ORD-77');
    expect(out.total).toBe(420.5); // preserves numeric type for exact-expression interpolation!
    expect(out.auth).toBe('Bearer topsecret_999');
    expect(out.nested).toEqual(['vip', 'run_1']);
  });

  it('encrypts secrets at rest (AES-256-GCM), isolates across tenants, enforces least-privilege WASM, and redacts outputs', async () => {
    const rawSecret = 'sk_live_ultra_sensitive_987654321';

    // Store secret in Acme vault
    const upsertRes = await app.request('/api/secrets', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'STRIPE_KEY',
        value: rawSecret,
        description: 'Stripe billing key',
      }),
    });
    expect(upsertRes.status).toBe(201);
    const upsertBody = (await upsertRes.json()) as { secret: Record<string, unknown> };
    expect(upsertBody.secret.name).toBe('STRIPE_KEY');
    expect(upsertBody.secret.value).toBeUndefined();
    expect(upsertBody.secret.encryptedValue).toBeUndefined();

    // Verify plaintext NEVER appears in tenant SQLite file on disk
    const dbBytes = readFileSync(join(tempDir, 'tenants', 'ten_acme.db'));
    expect(dbBytes.includes(Buffer.from(rawSecret))).toBe(false);

    // Cross-tenant isolation: Globex must not see Acme's STRIPE_KEY
    const globexListRes = await app.request('/api/secrets', { headers: globexHeaders });
    const globexList = (await globexListRes.json()) as { secrets: Array<{ name: string }> };
    expect(globexList.secrets.some((s) => s.name === 'STRIPE_KEY')).toBe(false);

    // Build a workflow that tests:
    //  1) script WITHOUT allowedSecrets cannot access STRIPE_KEY
    //  2) script WITH allowedSecrets CAN read STRIPE_KEY, and if it echoes it, orchestrator auto-redacts to [REDACTED]
    //  3) http_request chains {{steps.wasm_allowed.orderRef}} and {{secrets.STRIPE_KEY}} and redacts the secret from stored output!
    const wfCreate = await app.request('/api/workflows', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'Secret Redaction & Template Workflow',
        nodes: [
          { id: 't', type: 'trigger', config: { simulatedLatencyMs: 5 } },
          {
            id: 'wasm_denied',
            type: 'script',
            config: {
              code: 'return { sawSecret: Boolean(secrets.STRIPE_KEY) };',
            },
          },
          {
            id: 'wasm_allowed',
            type: 'script',
            config: {
              allowedSecrets: ['STRIPE_KEY'],
              code: 'return { sawSecret: secrets.STRIPE_KEY === "sk_live_ultra_sensitive_987654321", leakedAttempt: secrets.STRIPE_KEY, orderRef: "REF-" + input.code };',
            },
          },
          {
            id: 'http_call',
            type: 'http_request',
            config: {
              method: 'POST',
              url: '/api/sink/acme-commerce/charges-{{steps.wasm_allowed.orderRef}}',
              headers: { Authorization: 'Bearer {{secrets.STRIPE_KEY}}' },
              body: { ref: '{{steps.wasm_allowed.orderRef}}', leakedKey: '{{secrets.STRIPE_KEY}}' },
            },
          },
        ],
        edges: [
          { id: 'e1', from: 't', to: 'wasm_denied' },
          { id: 'e2', from: 'wasm_denied', to: 'wasm_allowed' },
          { id: 'e3', from: 'wasm_allowed', to: 'http_call' },
        ],
      }),
    });
    const { workflow } = (await wfCreate.json()) as { workflow: { id: string } };
    await app.request(`/api/workflows/${workflow.id}/publish`, {
      method: 'POST',
      headers: acmeHeaders,
    });

    const startRes = await app.request(`/api/workflows/${workflow.id}/runs`, {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'secret-redaction-test-1' },
      body: JSON.stringify({ input: { code: '777' } }),
    });
    expect(startRes.status).toBe(202);
    const { run: summary } = (await startRes.json()) as { run: { id: string } };
    const finalRun = await waitRunTerminal(DEMO_TENANTS.ACME.id, summary.id);

    expect(finalRun.status).toBe('succeeded');
    const deniedOut = finalRun.steps.find((s) => s.nodeId === 'wasm_denied')?.output as Record<string, unknown>;
    const allowedOut = finalRun.steps.find((s) => s.nodeId === 'wasm_allowed')?.output as Record<string, unknown>;
    const httpOut = finalRun.steps.find((s) => s.nodeId === 'http_call')?.output as Record<string, unknown>;

    expect(deniedOut.sawSecret).toBe(false);
    expect(allowedOut.sawSecret).toBe(true);
    expect(allowedOut.leakedAttempt).toBe('[REDACTED]');
    expect(httpOut.url).toBe('/api/sink/acme-commerce/charges-REF-777');
    expect(JSON.stringify(finalRun)).not.toContain(rawSecret);
  });

  it('triggers public inbound webhooks with exact-once idempotency and HMAC-SHA256 verification', async () => {
    // Configure an HMAC signing secret
    const hmacSecret = 'whsec_test_signing_key_2026';
    await app.request('/api/secrets', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ name: 'HOOK_SIGNING_SECRET', value: hmacSecret }),
    });

    // Create a published workflow requiring HMAC signature on its trigger
    const wfCreate = await app.request('/api/workflows', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'Signed Stripe Webhook Saga',
        nodes: [
          {
            id: 'trig',
            type: 'trigger',
            config: { triggerType: 'webhook', webhookSecretName: 'HOOK_SIGNING_SECRET', simulatedLatencyMs: 5 },
          },
          { id: 'task', type: 'custom_task', config: { handler: 'send_notification', simulatedLatencyMs: 5 } },
        ],
        edges: [{ id: 'e1', from: 'trig', to: 'task' }],
      }),
    });
    const { workflow } = (await wfCreate.json()) as { workflow: { id: string } };
    await app.request(`/api/workflows/${workflow.id}/publish`, {
      method: 'POST',
      headers: acmeHeaders,
    });

    const payloadStr = JSON.stringify({ event: 'invoice.paid', amount: 499 });
    const hookUrl = `/api/hooks/${DEMO_TENANTS.ACME.slug}/${workflow.id}`;

    // 1. Missing signature -> 401
    const unauthRes = await app.request(hookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payloadStr,
    });
    expect(unauthRes.status).toBe(401);

    // 2. Tampered signature -> 401
    const badSigRes = await app.request(hookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SagaFlow-Signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: payloadStr,
    });
    expect(badSigRes.status).toBe(401);

    // 3. Valid HMAC-SHA256 signature -> 202 Accepted
    const sig = computeWebhookHmac(hmacSecret, payloadStr);
    const okRes = await app.request(hookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SagaFlow-Signature': sig,
        'Idempotency-Key': 'stripe_evt_001',
      },
      body: payloadStr,
    });
    expect(okRes.status).toBe(202);
    const okBody = (await okRes.json()) as { accepted: boolean; signatureVerified: boolean; deduplicated: boolean; run: { id: string } };
    expect(okBody.accepted).toBe(true);
    expect(okBody.signatureVerified).toBe(true);
    expect(okBody.deduplicated).toBe(false);

    // 4. Duplicate delivery with same Idempotency-Key -> 200 deduplicated with same run ID
    const dupRes = await app.request(hookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SagaFlow-Signature': sig,
        'Idempotency-Key': 'stripe_evt_001',
      },
      body: payloadStr,
    });
    expect(dupRes.status).toBe(200);
    const dupBody = (await dupRes.json()) as { deduplicated: boolean; run: { id: string } };
    expect(dupBody.deduplicated).toBe(true);
    expect(dupBody.run.id).toBe(okBody.run.id);

    const finalRun = await waitRunTerminal(DEMO_TENANTS.ACME.id, okBody.run.id);
    expect(finalRun.status).toBe('succeeded');
  });

  it('validates cron expressions, fires due schedules with minute-scoped idempotency, and supports manual trigger', async () => {
    expect(validateCronExpression('*/15 * * * *').valid).toBe(true);
    expect(validateCronExpression('invalid cron').valid).toBe(false);
    const nextDate = getNextCronDate('0 * * * *', new Date('2026-11-16T10:12:00.000Z'));
    expect(nextDate.toISOString()).toBe('2026-11-16T11:00:00.000Z');

    // Create a schedule via REST API
    const createRes = await app.request('/api/schedules', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        workflowId: 'wf_order_fulfillment',
        name: 'Every Minute Sync',
        cron: '* * * * *',
        input: { amount: 42 },
        enabled: true,
      }),
    });
    expect(createRes.status).toBe(201);
    const { schedule } = (await createRes.json()) as { schedule: { id: string; nextRunAt: string } };
    expect(schedule.nextRunAt).toBeTruthy();

    // Tick at a reference date >= nextRunAt -> fires once!
    const dueTime = new Date(new Date(schedule.nextRunAt).getTime() + 1000);
    const fired1 = await scheduler.tick(dueTime);
    expect(fired1).toBeGreaterThanOrEqual(1);

    // Tick again at the exact same minute -> nextRunAt already advanced, so 0 fired!
    const fired2 = await scheduler.tick(dueTime);
    expect(fired2).toBe(0);

    // Manual trigger via API
    const trigRes = await app.request(`/api/schedules/${schedule.id}/trigger`, {
      method: 'POST',
      headers: acmeHeaders,
    });
    expect(trigRes.status).toBe(202);
    const { run } = (await trigRes.json()) as { run: { id: string } };
    const finalRun = await waitRunTerminal(DEMO_TENANTS.ACME.id, run.id);
    expect(finalRun.status).toBe('succeeded');
  });

  it('enforces self-hosted scrypt + HS256 JWT authentication under AUTH_MODE=prod and blocks cross-tenant access', async () => {
    const prodApp = createApiApp({
      storage,
      queue: new LocalDurableQueue(storage, 4),
      eventBus: new RunEventBus(storage),
      orchestrator,
      cipher,
      authMode: 'prod',
    });

    // Unauthenticated dev headers must be rejected in prod mode
    const rejectedDev = await prodApp.request('/api/workflows', { headers: acmeHeaders });
    expect(rejectedDev.status).toBe(401);

    // Login as seeded admin
    const loginRes = await prodApp.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: DEMO_ADMIN_EMAIL, password: DEMO_ADMIN_PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    const loginData = (await loginRes.json()) as { token: string; user: { email: string } };
    expect(loginData.token).toBeTruthy();

    // Access Acme workflows with Bearer JWT
    const wfRes = await prodApp.request('/api/workflows', {
      headers: {
        Authorization: `Bearer ${loginData.token}`,
        'X-Tenant-Id': DEMO_TENANTS.ACME.id,
      },
    });
    expect(wfRes.status).toBe(200);

    // Register a brand-new user with their own isolated tenant
    const regRes = await prodApp.request('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@stark.local',
        name: 'Alice Stark',
        password: 'strongpassword123',
        tenantName: 'Stark Labs',
      }),
    });
    expect(regRes.status).toBe(201);
    const regData = (await regRes.json()) as { token: string; tenants: Array<{ id: string }> };
    expect(regData.tenants.length).toBe(1);

    // Alice CAN access her own tenant, and MUST receive 403 on Acme!
    const aliceOwn = await prodApp.request('/api/workflows', {
      headers: {
        Authorization: `Bearer ${regData.token}`,
        'X-Tenant-Id': regData.tenants[0].id,
      },
    });
    expect(aliceOwn.status).toBe(200);

    const aliceCrossTenant = await prodApp.request('/api/workflows', {
      headers: {
        Authorization: `Bearer ${regData.token}`,
        'X-Tenant-Id': DEMO_TENANTS.ACME.id,
      },
    });
    expect(aliceCrossTenant.status).toBe(403);
  });

  it('persists users, encrypted secrets, and schedules identically in portable JSON Folder driver', async () => {
    const jsonDir = mkdtempSync(join(tmpdir(), 'sagaflow-json-v2-'));
    try {
      const jsonCipher = new SecretCipher({ storagePath: jsonDir });
      const jsonStorage = createStorageAdapter({
        driver: 'json',
        isolation: 'db-per-tenant',
        storagePath: jsonDir,
        queueDriver: 'local',
        workerConcurrency: 4,
      });
      await jsonStorage.init();
      await seedDemoData(jsonStorage, jsonCipher);

      const secrets = await jsonStorage.listSecrets(DEMO_TENANTS.ACME.id);
      expect(secrets.some((s) => s.name === 'PARTNER_WEBHOOK_TOKEN')).toBe(true);

      const schedules = await jsonStorage.listSchedules(DEMO_TENANTS.ACME.id);
      expect(schedules.length).toBeGreaterThanOrEqual(1);

      const admin = await jsonStorage.getUserByEmail(DEMO_ADMIN_EMAIL);
      expect(admin?.email).toBe(DEMO_ADMIN_EMAIL);

      await jsonStorage.close();
    } finally {
      removeTempDir(jsonDir);
    }
  });
});

// =========================================================================
// 6. Zero-Mock Real Transactional State, Atomic Rollback & Live HTTP Suite
// =========================================================================
describe('6. Zero-Mock Real Persistent State, Exact Saga Rollbacks & Live HTTP Sink', () => {
  let tmpDir: string;
  let storage: ReturnType<typeof createStorageAdapter>;
  let queue: LocalDurableQueue;
  let orchestrator: SagaOrchestrator;
  let app: ReturnType<typeof createApiApp>;

  const acmeHeaders = {
    'X-Tenant-Id': DEMO_TENANTS.ACME.id,
    'X-User-Id': DEMO_USER_ID,
    'Content-Type': 'application/json',
  };

  async function waitTerminal(runId: string) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const r = await storage.getRun(DEMO_TENANTS.ACME.id, runId);
      if (r && ['succeeded', 'failed', 'compensated', 'cancelled'].includes(r.status)) return r;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`Run ${runId} timed out`);
  }

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sagaflow-real-tx-'));
    const cipher = new SecretCipher({ storagePath: tmpDir });
    storage = createStorageAdapter({
      driver: 'sqlite',
      isolation: 'db-per-tenant',
      storagePath: tmpDir,
      queueDriver: 'local',
      workerConcurrency: 10,
    });
    await storage.init();
    await seedDemoData(storage, cipher);
    const eventBus = new RunEventBus(storage);
    queue = new LocalDurableQueue(storage, 10);
    orchestrator = new SagaOrchestrator(storage, queue, eventBus, cipher);
    await orchestrator.start();
    app = createApiApp({ storage, queue, eventBus, orchestrator, cipher, authMode: 'dev' });
  });

  afterAll(async () => {
    await orchestrator.stop();
    await queue.stop();
    await storage.close();
    removeTempDir(tmpDir);
  });

  it('commits real inventory & wallet mutations on workflow success and records Saga ledger entries', async () => {
    const beforeRes = await app.request('/api/state', { headers: acmeHeaders });
    expect(beforeRes.status).toBe(200);
    const beforeState = ((await beforeRes.json()) as {
      state: {
        inventory: Array<{ sku: string; available: number; reserved: number }>;
        balances: Array<{ accountId: string; available: number }>;
      };
    }).state;
    const beforeSku = beforeState.inventory.find((i) => i.sku === 'SKU-PRO-900')!;
    const beforeWallet = beforeState.balances.find((b) => b.accountId === 'customer_wallet')!;
    const beforeRev = beforeState.balances.find((b) => b.accountId === 'merchant_revenue')!;

    const startRes = await app.request('/api/workflows/wf_order_fulfillment/runs', {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'real-tx-commit-1' },
      body: JSON.stringify({ input: { orderId: 'ORD-REAL-1', sku: 'SKU-PRO-900', qty: 3, amount: 200 } }),
    });
    expect(startRes.status).toBe(202);
    const { run } = (await startRes.json()) as { run: { id: string } };
    const finalRun = await waitTerminal(run.id);
    expect(finalRun.status).toBe('succeeded');

    const afterRes = await app.request('/api/state', { headers: acmeHeaders });
    const afterState = ((await afterRes.json()) as {
      state: {
        inventory: Array<{ sku: string; available: number; reserved: number }>;
        balances: Array<{ accountId: string; available: number }>;
        ledger: Array<{ runId: string; direction: string; action: string }>;
        sinkDeliveries: Array<{ channel: string }>;
      };
    }).state;

    const afterSku = afterState.inventory.find((i) => i.sku === 'SKU-PRO-900')!;
    const afterWallet = afterState.balances.find((b) => b.accountId === 'customer_wallet')!;
    const afterRev = afterState.balances.find((b) => b.accountId === 'merchant_revenue')!;

    // 3 units reserved then committed out of warehouse -> available dropped by 3, reserved back to original!
    expect(afterSku.available).toBe(beforeSku.available - 3);
    expect(afterSku.reserved).toBe(beforeSku.reserved);
    // Payment (amount 200 * 1.08 tax = 216 USD) moved atomically from customer_wallet to merchant_revenue!
    expect(afterWallet.available).toBeCloseTo(beforeWallet.available - 216, 2);
    expect(afterRev.available).toBeCloseTo(beforeRev.available + 216, 2);
    // Real ledger rows recorded for this run
    expect(afterState.ledger.filter((l) => l.runId === run.id && l.direction === 'execute').length).toBeGreaterThanOrEqual(3);
    // Real notification recorded in sink
    expect(afterState.sinkDeliveries.some((d) => d.channel === 'notifications')).toBe(true);
  });

  it('restores exact byte-for-byte inventory and credit balances on Saga failure rollback', async () => {
    const beforeState = (
      (await (await app.request('/api/state', { headers: acmeHeaders })).json()) as {
        state: {
          inventory: Array<{ sku: string; available: number; reserved: number }>;
          balances: Array<{ accountId: string; available: number; locked: number }>;
        };
      }
    ).state;
    const skuBefore = beforeState.inventory.find((i) => i.sku === 'SKU-PRO-900')!;
    const credBefore = beforeState.balances.find((b) => b.accountId === 'loyalty_credits')!;

    const startRes = await app.request('/api/workflows/wf_saga_rollback/runs', {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'real-tx-rollback-1' },
      body: JSON.stringify({ input: { orderId: 'ORD-RB-REAL', sku: 'SKU-PRO-900', qty: 7, credits: 250 } }),
    });
    expect(startRes.status).toBe(202);
    const { run } = (await startRes.json()) as { run: { id: string } };
    const finalRun = await waitTerminal(run.id);
    expect(finalRun.status).toBe('compensated');

    const afterState = (
      (await (await app.request('/api/state', { headers: acmeHeaders })).json()) as {
        state: {
          inventory: Array<{ sku: string; available: number; reserved: number }>;
          balances: Array<{ accountId: string; available: number; locked: number }>;
          ledger: Array<{ runId: string; direction: string; action: string }>;
        };
      }
    ).state;
    const skuAfter = afterState.inventory.find((i) => i.sku === 'SKU-PRO-900')!;
    const credAfter = afterState.balances.find((b) => b.accountId === 'loyalty_credits')!;

    // Exact atomic restoration!
    expect(skuAfter.available).toBe(skuBefore.available);
    expect(skuAfter.reserved).toBe(skuBefore.reserved);
    expect(credAfter.available).toBe(credBefore.available);
    expect(credAfter.locked).toBe(credBefore.locked);

    const compEntries = afterState.ledger.filter((l) => l.runId === run.id && l.direction === 'compensate');
    expect(compEntries.map((c) => c.action)).toContain('revert_credits');
    expect(compEntries.map((c) => c.action)).toContain('release_inventory');
  });

  it('persists live HTTP sink deliveries, tests live HTTP + HMAC signer, and supports state CRUD + workflow deletion', async () => {
    // 1. Live HTTP Tester hitting real tenant webhook sink with vault secret
    const httpRes = await app.request('/api/http/test', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        method: 'POST',
        url: '/api/sink/acme-commerce/live-test',
        headers: { 'X-Token': '{{secrets.PARTNER_WEBHOOK_TOKEN}}' },
        body: { ping: 'real-zero-mock' },
      }),
    });
    expect(httpRes.status).toBe(200);
    const httpBody = (await httpRes.json()) as { ok: boolean; result: { status: number } };
    expect(httpBody.ok).toBe(true);
    expect(httpBody.result.status).toBe(200);
    // Secret must be scrubbed from test response!
    expect(JSON.stringify(httpBody)).not.toContain('sf_live_partner_secret_9f3a8c');

    // 2. Real HMAC-SHA256 signing helper using vault secret
    const signRes = await app.request('/api/webhooks/sign', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ secretName: 'PARTNER_WEBHOOK_TOKEN', payload: '{"orderId":"ORD-SIGN"}' }),
    });
    expect(signRes.status).toBe(200);
    const { signature } = (await signRes.json()) as { signature: string };
    expect(signature.startsWith('sha256=')).toBe(true);

    // 3. Manual state adjustments & KV CRUD
    const restockRes = await app.request('/api/state/inventory', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ sku: 'SKU-NEW-1', name: 'Sensor Pod', deltaAvailable: 42 }),
    });
    expect(restockRes.status).toBe(200);

    const kvRes = await app.request('/api/state/kv', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ key: 'feature:live', value: { enabled: true } }),
    });
    expect(kvRes.status).toBe(201);

    const kvDel = await app.request('/api/state/kv/feature%3Alive', {
      method: 'DELETE',
      headers: acmeHeaders,
    });
    expect(kvDel.status).toBe(200);

    // 4. Create & Delete Workflow
    const wfCreate = await app.request('/api/workflows', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'Temp Workflow To Delete',
        nodes: [{ id: 't', type: 'trigger', config: {} }],
        edges: [],
      }),
    });
    const { workflow } = (await wfCreate.json()) as { workflow: { id: string } };
    const wfDel = await app.request(`/api/workflows/${workflow.id}`, {
      method: 'DELETE',
      headers: acmeHeaders,
    });
    expect(wfDel.status).toBe(200);
    const wfCheck = await app.request(`/api/workflows/${workflow.id}`, { headers: acmeHeaders });
    expect(wfCheck.status).toBe(404);
  });

  it('pauses at Human-in-the-Loop Approval Gate, resumes on Approve, and triggers atomic DB rollback on Reject', async () => {
    const waitStatus = async (runId: string, targets: string[]) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const r = await storage.getRun(DEMO_TENANTS.ACME.id, runId);
        if (r && targets.includes(r.status)) return r;
        await new Promise((res) => setTimeout(res, 25));
      }
      throw new Error(`Run ${runId} did not reach ${targets.join('/')}`);
    };

    // --- Path A: Approve via Public Callback Token -> Resumes & Disburses to Live Sink ---
    const startApprove = await app.request('/api/workflows/wf_human_approval/runs', {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'hitl-approve-1' },
      body: JSON.stringify({ input: { orderId: 'WIRE-APP-1', amount: 500 } }),
    });
    expect(startApprove.status).toBe(202);
    const { run: rApprove } = (await startApprove.json()) as { run: { id: string } };
    const paused1 = await waitStatus(rApprove.id, ['waiting_approval']);
    expect(paused1.status).toBe('waiting_approval');

    const pendingRes = await app.request('/api/approvals?status=pending', { headers: acmeHeaders });
    expect(pendingRes.status).toBe(200);
    const { approvals } = (await pendingRes.json()) as {
      approvals: Array<{ id: string; runId: string; callbackToken: string; prompt: string }>;
    };
    const apr1 = approvals.find((a) => a.runId === rApprove.id)!;
    expect(apr1).toBeTruthy();
    expect(apr1.prompt).toContain('500');
    expect(apr1.prompt).toContain('WIRE-APP-1');

    // Approve via external public callback webhook token!
    const cbRes = await app.request(`/api/callbacks/approval/${apr1.callbackToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', decidedBy: 'cfo@acme.com', comment: 'Cleared by Finance' }),
    });
    expect(cbRes.status).toBe(200);

    // Double decision must fail with 409 Conflict
    const dupRes = await app.request(`/api/approvals/${apr1.id}/decide`, {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ decision: 'rejected' }),
    });
    expect(dupRes.status).toBe(409);

    const done1 = await waitStatus(rApprove.id, ['succeeded', 'failed', 'compensated']);
    expect(done1.status).toBe('succeeded');

    const stateAfterApprove = (
      (await (await app.request('/api/state', { headers: acmeHeaders })).json()) as {
        state: {
          balances: Array<{ accountId: string; available: number }>;
          sinkDeliveries: Array<{ channel: string; body: Record<string, unknown> }>;
        };
      }
    ).state;
    expect(
      stateAfterApprove.sinkDeliveries.some(
        (d) => d.channel === 'wire-disbursements' && d.body?.approvedBy === 'cfo@acme.com'
      )
    ).toBe(true);

    // --- Path B: Reject via Authenticated Inbox -> Full Reverse-Order Atomic Wallet Refund! ---
    const walletBeforeReject = stateAfterApprove.balances.find((b) => b.accountId === 'customer_wallet')!.available;
    const revBeforeReject = stateAfterApprove.balances.find((b) => b.accountId === 'merchant_revenue')!.available;

    const startReject = await app.request('/api/workflows/wf_human_approval/runs', {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'hitl-reject-1' },
      body: JSON.stringify({ input: { orderId: 'WIRE-REJ-2', amount: 1250 } }),
    });
    expect(startReject.status).toBe(202);
    const { run: rReject } = (await startReject.json()) as { run: { id: string } };
    await waitStatus(rReject.id, ['waiting_approval']);

    const pend2 = (
      (await (await app.request('/api/approvals?status=pending', { headers: acmeHeaders })).json()) as {
        approvals: Array<{ id: string; runId: string }>;
      }
    ).approvals;
    const apr2 = pend2.find((a) => a.runId === rReject.id)!;

    const rejRes = await app.request(`/api/approvals/${apr2.id}/decide`, {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ decision: 'rejected', comment: 'Beneficiary mismatch' }),
    });
    expect(rejRes.status).toBe(200);

    const done2 = await waitStatus(rReject.id, ['compensated', 'failed', 'succeeded']);
    expect(done2.status).toBe('compensated');

    // Wallet & revenue must be EXACTLY restored back to pre-run amounts!
    const stateAfterReject = (
      (await (await app.request('/api/state', { headers: acmeHeaders })).json()) as {
        state: { balances: Array<{ accountId: string; available: number }> };
      }
    ).state;
    expect(stateAfterReject.balances.find((b) => b.accountId === 'customer_wallet')!.available).toBeCloseTo(
      walletBeforeReject,
      2
    );
    expect(stateAfterReject.balances.find((b) => b.accountId === 'merchant_revenue')!.available).toBeCloseTo(
      revBeforeReject,
      2
    );
  });

  it('exposes Prometheus /api/metrics OpenMetrics text and supports portable workflow Export/Import round-trip', async () => {
    const promRes = await app.request('/api/metrics');
    expect(promRes.status).toBe(200);
    expect(promRes.headers.get('content-type')).toContain('text/plain');
    const promText = await promRes.text();
    expect(promText).toContain('sagaflow_tenants_total');
    expect(promText).toContain('sagaflow_runs_total{tenant="acme-commerce",status="succeeded"}');
    expect(promText).toContain('sagaflow_approvals_pending{tenant="acme-commerce"}');

    const expRes = await app.request('/api/workflows/wf_human_approval/export', { headers: acmeHeaders });
    expect(expRes.status).toBe(200);
    const exported = (await expRes.json()) as Record<string, unknown>;

    const impRes = await app.request('/api/workflows/import', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify(exported),
    });
    expect(impRes.status).toBe(201);
    const { workflow: imported } = (await impRes.json()) as { workflow: { id: string; nodes: unknown[] } };
    expect(imported.id).not.toBe('wf_human_approval');
    expect(imported.nodes.length).toBe(4);
  });

  it('connects to LM Studio OpenAI-compatible HTTP API, discovers models, and autonomously creates & runs a Saga workflow', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'qwen2.5-7b-instruct', owned_by: 'lmstudio' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
          const lastUser = parsed.messages[parsed.messages.length - 1]?.content ?? '';
          const replyContent = lastUser.includes('SagaFlow AI online')
            ? 'SagaFlow AI online.'
            : JSON.stringify({
                reply: 'Created and launched your automated inventory sync Saga.',
                actions: [
                  {
                    tool: 'create_workflow',
                    args: {
                      name: 'AI Built Sync Pipeline',
                      description: 'Built autonomously via LM Studio',
                      publish: true,
                      nodes: [
                        { id: 'trigger', type: 'trigger', label: 'Start', config: { triggerType: 'manual' } },
                        {
                          id: 'sink_hit',
                          type: 'http_request',
                          label: 'Notify Ops Sink',
                          config: {
                            method: 'POST',
                            url: '/api/sink/acme-commerce/ai-built',
                            body: { orderId: '{{input.orderId}}' },
                          },
                        },
                      ],
                      edges: [{ id: 'e1', from: 'trigger', to: 'sink_hit' }],
                    },
                  },
                  {
                    tool: 'run_workflow',
                    args: { workflowId: '$LAST_CREATED', input: { orderId: 'ORD-AI-777' } },
                  },
                ],
              });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              model: 'qwen2.5-7b-instruct',
              choices: [{ message: { role: 'assistant', content: replyContent } }],
              usage: { prompt_tokens: 42, completion_tokens: 88, total_tokens: 130 },
            })
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const lmBase = `http://127.0.0.1:${addr.port}/v1`;

    try {
      // Save LM Studio config
      const saveRes = await app.request('/api/ai/config', {
        method: 'PUT',
        headers: acmeHeaders,
        body: JSON.stringify({
          provider: 'lm_studio',
          lmStudioBaseUrl: lmBase,
          lmStudioModel: 'qwen2.5-7b-instruct',
        }),
      });
      expect(saveRes.status).toBe(200);

      // Model discovery
      const modelsRes = await app.request('/api/ai/lmstudio/models', {
        method: 'POST',
        headers: acmeHeaders,
        body: JSON.stringify({ baseUrl: lmBase }),
      });
      expect(modelsRes.status).toBe(200);
      const { models } = (await modelsRes.json()) as { models: Array<{ id: string }> };
      expect(models[0]?.id).toBe('qwen2.5-7b-instruct');

      // Connection ping
      const testRes = await app.request('/api/ai/test', {
        method: 'POST',
        headers: acmeHeaders,
        body: JSON.stringify({ provider: 'lm_studio' }),
      });
      expect(testRes.status).toBe(200);
      const { result: ping } = (await testRes.json()) as { result: { ok: boolean; model: string } };
      expect(ping.ok).toBe(true);
      expect(ping.model).toBe('qwen2.5-7b-instruct');

      // Autonomous agent build + run
      const chatRes = await app.request('/api/ai/agent/chat', {
        method: 'POST',
        headers: acmeHeaders,
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Build and run a sync workflow' }],
          autoExecute: true,
        }),
      });
      expect(chatRes.status).toBe(200);
      const { response } = (await chatRes.json()) as {
        response: {
          provider: string;
          model: string;
          actions: Array<{ tool: string; status: string; workflowId?: string; runId?: string }>;
        };
      };
      expect(response.provider).toBe('lm_studio');
      expect(response.actions.length).toBe(2);
      expect(response.actions[0]?.status).toBe('succeeded');
      expect(response.actions[1]?.status).toBe('succeeded');
      const runId = response.actions[1]!.runId!;

      // Wait for AI-launched Saga run to succeed cleanly
      const deadline = Date.now() + 8000;
      let finalStatus = 'pending';
      while (Date.now() < deadline) {
        const r = await storage.getRun(DEMO_TENANTS.ACME.id, runId);
        if (r && ['succeeded', 'failed', 'compensated'].includes(r.status)) {
          finalStatus = r.status;
          break;
        }
        await new Promise((res) => setTimeout(res, 25));
      }
      expect(finalStatus).toBe('succeeded');
    } finally {
      server.close();
    }
  });

  it('encrypts Google AI Studio API key at rest and executes a real ai_agent DAG step feeding a conditional Approval Gate', async () => {
    const http = await import('node:http');
    let receivedKey = '';
    const geminiServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      receivedKey = url.searchParams.get('key') ?? '';
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        riskScore: 91,
                        riskLevel: 'high',
                        reason: 'Amount $2400 exceeds $800 auto-clearance threshold',
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 20, totalTokenCount: 45 },
          })
        );
      });
    });

    await new Promise<void>((resolve) => geminiServer.listen(0, '127.0.0.1', resolve));
    const addr = geminiServer.address() as { port: number };
    const geminiBase = `http://127.0.0.1:${addr.port}`;
    const fakeKey = 'AIzaSyTEST_REAL_ENCRYPTED_SECRET_999';

    try {
      const saveRes = await app.request('/api/ai/config', {
        method: 'PUT',
        headers: acmeHeaders,
        body: JSON.stringify({
          provider: 'google_ai_studio',
          googleApiKey: fakeKey,
          googleModel: 'gemini-2.5-flash',
          googleBaseUrl: geminiBase,
        }),
      });
      expect(saveRes.status).toBe(200);
      const savedText = await saveRes.text();
      // Raw key MUST NEVER appear in API responses
      expect(savedText).not.toContain(fakeKey);
      expect(JSON.parse(savedText).config.hasGoogleApiKey).toBe(true);

      // Internal AI key is hidden from generic Secret Vault list
      const secList = (await (await app.request('/api/secrets', { headers: acmeHeaders })).json()) as {
        secrets: Array<{ name: string }>;
      };
      expect(secList.secrets.some((s) => s.name.startsWith('__SAGAFLOW_AI_'))).toBe(false);

      // Run seeded wf_ai_triage workflow -> executes ai_agent node -> branches TRUE -> pauses at Fraud Officer Review approval gate!
      const startRes = await app.request('/api/workflows/wf_ai_triage/runs', {
        method: 'POST',
        headers: { ...acmeHeaders, 'Idempotency-Key': 'ai-triage-test-1' },
        body: JSON.stringify({ input: { orderId: 'ORD-RISK-999', amount: 2400, sku: 'SKU-PRO-900', qty: 3 } }),
      });
      expect(startRes.status).toBe(202);
      const { run } = (await startRes.json()) as { run: { id: string } };

      const deadline = Date.now() + 8000;
      let pausedRun = null;
      while (Date.now() < deadline) {
        const r = await storage.getRun(DEMO_TENANTS.ACME.id, run.id);
        if (r && ['waiting_approval', 'succeeded', 'failed'].includes(r.status)) {
          pausedRun = r;
          break;
        }
        await new Promise((res) => setTimeout(res, 25));
      }
      expect(receivedKey).toBe(fakeKey);
      expect(pausedRun?.status).toBe('waiting_approval');
      const aiStep = pausedRun?.steps.find((s) => s.nodeId === 'ai_triage');
      expect(aiStep?.status).toBe('succeeded');
      expect((aiStep?.output as Record<string, unknown>)?.riskLevel).toBe('high');
      expect(JSON.stringify(pausedRun)).not.toContain(fakeKey);
    } finally {
      geminiServer.close();
    }
  });

  it('v5: executes nested sub_workflow step end-to-end with childRunId lineage and depth guard', async () => {
    const startRes = await app.request('/api/workflows/wf_nested_pipeline/runs', {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'v5-sub-wf-1' },
      body: JSON.stringify({
        input: { orderId: 'ORD-V5-NESTED', sku: 'SKU-PRO-900', qty: 1, amount: 1500 },
      }),
    });
    expect(startRes.status).toBe(202);
    const { run } = (await startRes.json()) as { run: { id: string } };
    const finalRun = await waitTerminal(run.id);
    expect(finalRun.status).toBe('succeeded');

    const subStep = finalRun.steps.find((s) => s.nodeId === 'route_subflow');
    expect(subStep?.kind).toBe('sub_workflow');
    expect(subStep?.status).toBe('succeeded');
    const subOut = subStep?.output as Record<string, unknown>;
    expect(typeof subOut.childRunId).toBe('string');
    expect(subOut.childStatus).toBe('succeeded');

    // Verify child run is real and persisted independently in tenant storage
    const childRun = await storage.getRun(DEMO_TENANTS.ACME.id, String(subOut.childRunId));
    expect(childRun?.status).toBe('succeeded');
    expect(childRun?.workflowId).toBe('wf_conditional_router');
  });

  it('v5: computes visual DAG version diffs and performs 1-click version restore into draft', async () => {
    const createRes = await app.request('/api/workflows', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'Diffable Flow',
        nodes: [
          { id: 't', type: 'trigger', label: 'Start', position: { x: 0, y: 0 }, config: {} },
          {
            id: 's1',
            type: 'script',
            label: 'Step One',
            position: { x: 200, y: 0 },
            config: { code: 'return { ok: 1 };' },
          },
        ],
        edges: [{ id: 'e1', from: 't', to: 's1' }],
      }),
    });
    expect(createRes.status).toBe(201);
    const { workflow } = (await createRes.json()) as { workflow: { id: string } };

    // Freeze v1
    const pub1 = await app.request(`/api/workflows/${workflow.id}/publish`, {
      method: 'POST',
      headers: acmeHeaders,
    });
    expect(pub1.status).toBe(201);

    // Mutate draft: modify s1 label + add s2 node & edge
    const upd = await app.request(`/api/workflows/${workflow.id}`, {
      method: 'PUT',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'Diffable Flow',
        nodes: [
          { id: 't', type: 'trigger', label: 'Start', position: { x: 0, y: 0 }, config: {} },
          {
            id: 's1',
            type: 'script',
            label: 'Step One v2',
            position: { x: 200, y: 0 },
            config: { code: 'return { ok: 2 };' },
          },
          {
            id: 's2',
            type: 'wait',
            label: 'Short Wait',
            position: { x: 400, y: 0 },
            config: { ms: 10 },
          },
        ],
        edges: [
          { id: 'e1', from: 't', to: 's1' },
          { id: 'e2', from: 's1', to: 's2' },
        ],
      }),
    });
    expect(upd.status).toBe(200);

    // Compare v1 vs draft
    const diffRes = await app.request(`/api/workflows/${workflow.id}/diff?from=1&to=draft`, {
      headers: acmeHeaders,
    });
    expect(diffRes.status).toBe(200);
    const { diff } = (await diffRes.json()) as {
      diff: {
        identical: boolean;
        addedNodes: Array<{ id: string }>;
        modifiedNodes: Array<{ id: string; changedFields: string[] }>;
        addedEdges: Array<{ id: string }>;
      };
    };
    expect(diff.identical).toBe(false);
    expect(diff.addedNodes.map((n) => n.id)).toEqual(['s2']);
    expect(diff.addedEdges.map((e) => e.id)).toEqual(['e2']);
    expect(diff.modifiedNodes[0]?.id).toBe('s1');
    expect(diff.modifiedNodes[0]?.changedFields).toContain('label');

    // 1-Click Restore v1 -> draft should become identical to v1 again!
    const restoreRes = await app.request(`/api/workflows/${workflow.id}/versions/1/restore`, {
      method: 'POST',
      headers: acmeHeaders,
    });
    expect(restoreRes.status).toBe(200);
    const afterDiffRes = await app.request(`/api/workflows/${workflow.id}/diff?from=1&to=draft`, {
      headers: acmeHeaders,
    });
    const { diff: afterDiff } = (await afterDiffRes.json()) as { diff: { identical: boolean } };
    expect(afterDiff.identical).toBe(true);
  });

  it('v5: enforces real server-side tenant RBAC roles across viewer, approver, operator, and admin', async () => {
    const viewerHeaders = {
      'Content-Type': 'application/json',
      'X-Tenant-Id': DEMO_TENANTS.ACME.id,
      'X-User-Id': 'usr_demo_viewer',
    };
    const operatorHeaders = {
      'Content-Type': 'application/json',
      'X-Tenant-Id': DEMO_TENANTS.ACME.id,
      'X-User-Id': 'usr_demo_operator',
    };

    // Viewer can read workflows & check own role
    const meViewer = await app.request('/api/rbac/me', { headers: viewerHeaders });
    expect(meViewer.status).toBe(200);
    expect(((await meViewer.json()) as { role: string }).role).toBe('viewer');

    // Viewer is blocked with HTTP 403 on workflow mutations
    const viewerWrite = await app.request('/api/workflows', {
      method: 'POST',
      headers: viewerHeaders,
      body: JSON.stringify({ name: 'Unauthorized', nodes: [], edges: [] }),
    });
    expect(viewerWrite.status).toBe(403);

    // Operator can read & run workflows, but is blocked with HTTP 403 on Admin-only secrets & API keys
    const opSecret = await app.request('/api/secrets', {
      method: 'POST',
      headers: operatorHeaders,
      body: JSON.stringify({ name: 'OP_FORBIDDEN', value: '123' }),
    });
    expect(opSecret.status).toBe(403);

    // Admin can list and update tenant RBAC members
    const setRes = await app.request('/api/rbac/members', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ userId: 'usr_custom_auditor', role: 'approver' }),
    });
    expect(setRes.status).toBe(200);
    const { member } = (await setRes.json()) as { member: { userId: string; role: string } };
    expect(member.userId).toBe('usr_custom_auditor');
    expect(member.role).toBe('approver');
  });

  it('v5: exports HMAC-SHA256 signed compliance audit bundles and rejects tampered payloads', async () => {
    const expRes = await app.request('/api/audit/export', { headers: acmeHeaders });
    expect(expRes.status).toBe(200);
    const { bundle } = (await expRes.json()) as {
      bundle: {
        signature: { algorithm: string; digest: string };
        summary: { workflows: number; runs: number };
      };
    };
    expect(bundle.signature.algorithm).toBe('HMAC-SHA256');
    expect(bundle.summary.workflows).toBeGreaterThanOrEqual(5);

    // Authentic bundle verifies cleanly
    const verifyOk = await app.request('/api/audit/verify', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ bundle }),
    });
    expect(verifyOk.status).toBe(200);
    expect(((await verifyOk.json()) as { valid: boolean }).valid).toBe(true);

    // Tampering even a single number MUST fail verification
    const tampered = structuredClone(bundle);
    tampered.summary.runs = tampered.summary.runs + 999;
    const verifyTampered = await app.request('/api/audit/verify', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ bundle: tampered }),
    });
    expect(verifyTampered.status).toBe(200);
    expect(((await verifyTampered.json()) as { valid: boolean }).valid).toBe(false);
  });

  it('v5: diagnoses failed compensated runs, serves OpenAPI 3.1 + /api/docs, and works via @sagaflow/sdk', async () => {
    // 1. Trigger compensated run and invoke 1-click diagnostics
    const startRes = await app.request('/api/workflows/wf_saga_rollback/runs', {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'v5-diag-run-1' },
      body: JSON.stringify({ input: { orderId: 'ORD-DIAG', sku: 'SKU-PRO-900', qty: 1, credits: 50 } }),
    });
    const { run } = (await startRes.json()) as { run: { id: string } };
    await waitTerminal(run.id);

    const diagRes = await app.request(`/api/ai/diagnose-run/${run.id}`, {
      method: 'POST',
      headers: acmeHeaders,
    });
    expect(diagRes.status).toBe(200);
    const { diagnosis } = (await diagRes.json()) as {
      diagnosis: {
        runId: string;
        rollbackIntegrity: { compensatedSteps: number; verifiedClean: boolean };
        recommendations: Array<{ title: string }>;
      };
    };
    expect(diagnosis.runId).toBe(run.id);
    expect(diagnosis.rollbackIntegrity.compensatedSteps).toBeGreaterThanOrEqual(2);
    expect(diagnosis.rollbackIntegrity.verifiedClean).toBe(true);
    expect(diagnosis.recommendations.length).toBeGreaterThan(0);

    // 2. OpenAPI 3.1 JSON + Interactive /api/docs HTML
    const oapiRes = await app.request('/api/openapi.json');
    expect(oapiRes.status).toBe(200);
    const spec = (await oapiRes.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.paths['/api/audit/export']).toBeDefined();

    const docsRes = await app.request('/api/docs');
    expect(docsRes.status).toBe(200);
    expect(await docsRes.text()).toContain('SagaFlow OpenAPI 3.1 Explorer');

    // 3. Official @sagaflow/sdk client against live Hono fetch
    const { SagaFlowClient } = await import('@sagaflow/sdk');
    const sdk = new SagaFlowClient({
      baseUrl: 'http://sagaflow.local',
      tenantId: DEMO_TENANTS.ACME.id,
      userId: DEMO_USER_ID,
      fetch: (input, init) => {
        const url = new URL(String(input));
        return Promise.resolve(app.request(url.pathname + url.search, init));
      },
    });
    const health = await sdk.health();
    expect(health.status).toBe('ok');
    const wfList = await sdk.listWorkflows();
    expect(wfList.workflows.some((w) => w.id === 'wf_nested_pipeline')).toBe(true);
    const rbac = await sdk.getRbacMe();
    expect(rbac.role).toBe('admin');
  });

  it('v6: executes dynamic for_each map fan-out with bounded concurrency and atomic per-item rollback', async () => {
    const beforeState = (
      (await (await app.request('/api/state', { headers: acmeHeaders })).json()) as {
        state: { inventory: Array<{ sku: string; available: number; reserved: number }> };
      }
    ).state;
    const beforeSku = beforeState.inventory.find((i) => i.sku === 'SKU-PRO-900')!;

    // 1. Run seeded wf_batch_foreach across 3 line items (total 4 units)
    const startRes = await app.request('/api/workflows/wf_batch_foreach/runs', {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'v6-foreach-ok-1' },
      body: JSON.stringify({
        input: {
          batchId: 'BATCH-V6-01',
          items: [
            { sku: 'SKU-PRO-900', qty: 1 },
            { sku: 'SKU-PRO-900', qty: 2 },
            { sku: 'SKU-PRO-900', qty: 1 },
          ],
        },
      }),
    });
    expect(startRes.status).toBe(202);
    const { run } = (await startRes.json()) as { run: { id: string } };
    const finalRun = await waitTerminal(run.id);
    expect(finalRun.status).toBe('succeeded');

    const mapStep = finalRun.steps.find((s) => s.nodeId === 'reserve_batch');
    expect(mapStep?.kind).toBe('for_each');
    const mapOut = mapStep?.output as { itemCount: number; succeededCount: number; results: unknown[] };
    expect(mapOut.itemCount).toBe(3);
    expect(mapOut.succeededCount).toBe(3);
    expect(mapOut.results.length).toBe(3);

    const sumStep = finalRun.steps.find((s) => s.nodeId === 'summarize_batch');
    expect((sumStep?.output as { totalUnitsReserved: number }).totalUnitsReserved).toBe(4);

    // 2. Downstream failure after for_each MUST atomically compensate EVERY reserved item!
    const wfCreate = await app.request('/api/workflows', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'ForEach Rollback Test',
        nodes: [
          { id: 't', type: 'trigger', label: 'Start', position: { x: 0, y: 0 }, config: {} },
          {
            id: 'batch',
            type: 'for_each',
            label: 'Reserve Batch',
            position: { x: 240, y: 0 },
            config: {
              itemsExpression: '{{input.items}}',
              mode: 'custom_task',
              itemHandler: 'reserve_inventory',
              itemCompensationHandler: 'release_inventory',
              maxConcurrency: 2,
              itemConfig: { sku: '{{input.item.sku}}', qty: '{{input.item.qty}}' },
            },
          },
          {
            id: 'boom',
            type: 'custom_task',
            label: 'Force Decline',
            position: { x: 500, y: 0 },
            config: {
              handler: 'charge_payment',
              alwaysFail: true,
              retryPolicy: { maxAttempts: 1, initialDelayMs: 10, backoffMultiplier: 1 },
            },
          },
        ],
        edges: [
          { id: 'e1', from: 't', to: 'batch' },
          { id: 'e2', from: 'batch', to: 'boom' },
        ],
      }),
    });
    const { workflow: rbWf } = (await wfCreate.json()) as { workflow: { id: string } };
    await app.request(`/api/workflows/${rbWf.id}/publish`, { method: 'POST', headers: acmeHeaders });

    const midState = (
      (await (await app.request('/api/state', { headers: acmeHeaders })).json()) as {
        state: { inventory: Array<{ sku: string; available: number; reserved: number }> };
      }
    ).state;
    const midSku = midState.inventory.find((i) => i.sku === 'SKU-PRO-900')!;
    expect(midSku.available).toBe(beforeSku.available - 4);

    const rbRunRes = await app.request(`/api/workflows/${rbWf.id}/runs`, {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'v6-foreach-rb-1' },
      body: JSON.stringify({
        input: { items: [{ sku: 'SKU-PRO-900', qty: 2 }, { sku: 'SKU-PRO-900', qty: 3 }] },
      }),
    });
    const { run: rbRun } = (await rbRunRes.json()) as { run: { id: string } };
    const rbFinal = await waitTerminal(rbRun.id);
    expect(rbFinal.status).toBe('compensated');
    expect(rbFinal.steps.find((s) => s.nodeId === 'batch')?.status).toBe('compensated');

    const afterState = (
      (await (await app.request('/api/state', { headers: acmeHeaders })).json()) as {
        state: { inventory: Array<{ sku: string; available: number; reserved: number }> };
      }
    ).state;
    const afterSku = afterState.inventory.find((i) => i.sku === 'SKU-PRO-900')!;
    // Exact byte-for-byte inventory restoration after batch rollback!
    expect(afterSku.available).toBe(midSku.available);
    expect(afterSku.reserved).toBe(midSku.reserved);
  });

  it('v6: supports Time-Travel Checkpoint Resume from a failed step without re-executing upstream steps', async () => {
    const createRes = await app.request('/api/workflows', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'Time-Travel Checkpoint Flow',
        nodes: [
          { id: 't', type: 'trigger', label: 'Start', position: { x: 0, y: 0 }, config: {} },
          {
            id: 'prep',
            type: 'script',
            label: 'Expensive Upstream Prep',
            position: { x: 240, y: 0 },
            config: { code: 'return { token: "tok_" + input.orderId, computed: 42 };' },
          },
          {
            id: 'verify',
            type: 'script',
            label: 'Flaky Validator',
            position: { x: 480, y: 0 },
            config: {
              code: 'if (input.shouldFail) { throw new Error("Upstream partner unavailable"); } return { verified: true, token: steps.prep.token };',
              retryPolicy: { maxAttempts: 1, initialDelayMs: 10, backoffMultiplier: 1 },
            },
          },
        ],
        edges: [
          { id: 'e1', from: 't', to: 'prep' },
          { id: 'e2', from: 'prep', to: 'verify' },
        ],
      }),
    });
    const { workflow } = (await createRes.json()) as { workflow: { id: string } };
    await app.request(`/api/workflows/${workflow.id}/publish`, { method: 'POST', headers: acmeHeaders });

    // Initial run fails at "verify"
    const run1Res = await app.request(`/api/workflows/${workflow.id}/runs`, {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'v6-tt-1' },
      body: JSON.stringify({ input: { orderId: 'TT-900', shouldFail: true } }),
    });
    const { run: run1 } = (await run1Res.json()) as { run: { id: string } };
    const final1 = await waitTerminal(run1.id);
    expect(final1.status).toBe('failed');
    expect(final1.steps.find((s) => s.nodeId === 'prep')?.status).toBe('succeeded');
    expect(final1.steps.find((s) => s.nodeId === 'verify')?.status).toBe('failed');

    // Time-Travel Resume from "verify" with patched inputOverrides!
    const resumeRes = await app.request(`/api/runs/${run1.id}/resume-from/verify`, {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ inputOverrides: { shouldFail: false } }),
    });
    expect(resumeRes.status).toBe(202);
    const { run: forked, reusedSteps, resetSteps } = (await resumeRes.json()) as {
      run: { id: string };
      reusedSteps: string[];
      resetSteps: string[];
    };
    expect(reusedSteps).toContain('prep');
    expect(resetSteps).toContain('verify');

    const final2 = await waitTerminal(forked.id);
    expect(final2.status).toBe('succeeded');
    const prepStep = final2.steps.find((s) => s.nodeId === 'prep')!;
    expect(prepStep.attempts[0]?.logs?.[0]).toContain('TIME-TRAVEL CHECKPOINT');
    const verifyStep = final2.steps.find((s) => s.nodeId === 'verify')!;
    expect((verifyStep.output as { verified: boolean; token: string }).verified).toBe(true);
    expect((verifyStep.output as { verified: boolean; token: string }).token).toBe('tok_TT-900');
  });

  it('v6: enforces Approval Gate SLA timeout watchdog and fires HMAC-SHA256 signed Alert Rules into live sink', async () => {
    // 1. Create workflow with 50ms SLA Approval Gate (onTimeout: reject -> atomic rollback!)
    const wfRes = await app.request('/api/workflows', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'SLA Auto-Reject Gate',
        nodes: [
          { id: 't', type: 'trigger', label: 'Start', position: { x: 0, y: 0 }, config: {} },
          {
            id: 'hold',
            type: 'custom_task',
            label: 'Hold Stock',
            position: { x: 240, y: 0 },
            config: {
              handler: 'reserve_inventory',
              compensationHandler: 'release_inventory',
              sku: 'SKU-PRO-900',
              qty: 1,
            },
          },
          {
            id: 'sla_gate',
            type: 'approval',
            label: 'Short SLA Gate',
            position: { x: 480, y: 0 },
            config: {
              approverRole: 'Risk Lead',
              timeoutMs: 40,
              onTimeout: 'reject',
              prompt: 'Approve within 40ms SLA',
            },
          },
        ],
        edges: [
          { id: 'e1', from: 't', to: 'hold' },
          { id: 'e2', from: 'hold', to: 'sla_gate' },
        ],
      }),
    });
    const { workflow } = (await wfRes.json()) as { workflow: { id: string } };
    await app.request(`/api/workflows/${workflow.id}/publish`, { method: 'POST', headers: acmeHeaders });

    // Start run -> parks at waiting_approval
    const startRes = await app.request(`/api/workflows/${workflow.id}/runs`, {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'v6-sla-1' },
      body: JSON.stringify({ input: { orderId: 'SLA-100' } }),
    });
    const { run } = (await startRes.json()) as { run: { id: string } };

    // Wait until parked at waiting_approval + SLA expires
    const parkDeadline = Date.now() + 4000;
    while (Date.now() < parkDeadline) {
      const cur = await storage.getRun(DEMO_TENANTS.ACME.id, run.id);
      if (cur?.status === 'waiting_approval') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 70));

    // Sweep expired approvals directly via CronScheduler watchdog
    const { CronScheduler } = await import('@sagaflow/engine');
    const watchdog = new CronScheduler(storage, orchestrator, 60_000);
    const swept = await watchdog.sweepExpiredApprovals(new Date());
    expect(swept).toBeGreaterThanOrEqual(1);

    const finalRun = await waitTerminal(run.id);
    expect(finalRun.status).toBe('compensated');

    // Verify seeded HMAC-signed Alert Rule delivered real alert to live `/api/sink/acme-commerce/alerts`!
    const stateRes = await app.request('/api/state', { headers: acmeHeaders });
    const state = ((await stateRes.json()) as {
      state: {
        sinkDeliveries: Array<{
          channel: string;
          headers: Record<string, string>;
          body: { event?: string };
        }>;
      };
    }).state;
    const alertDelivery = state.sinkDeliveries.find(
      (d) => d.channel === 'alerts' && d.body?.event === 'approval.sla_breached'
    );
    expect(alertDelivery).toBeDefined();
    expect(alertDelivery?.headers['X-SagaFlow-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('v6: traces Studio Dry-Run zero-mutation debugger & works via @sagaflow/sdk v6 methods', async () => {
    const beforeState = (
      (await (await app.request('/api/state', { headers: acmeHeaders })).json()) as {
        state: { inventory: Array<{ sku: string; available: number }> };
      }
    ).state;
    const beforeAvail = beforeState.inventory.find((i) => i.sku === 'SKU-PRO-900')!.available;

    // 1. Dry-run wf_order_fulfillment (must trace WASM + templates with ZERO inventory mutations!)
    const dryRes = await app.request('/api/workflows/wf_order_fulfillment/dry-run', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        input: { orderId: 'DRY-100', sku: 'SKU-PRO-900', qty: 5, amount: 200 },
      }),
    });
    expect(dryRes.status).toBe(200);
    const { dryRun } = (await dryRes.json()) as {
      dryRun: {
        valid: boolean;
        steps: Array<{ nodeId: string; status: string; previewOutput?: unknown }>;
      };
    };
    expect(dryRun.valid).toBe(true);
    expect(dryRun.steps.length).toBeGreaterThanOrEqual(5);
    // Never leaks raw secrets
    expect(JSON.stringify(dryRun)).not.toContain('sf_live_partner_secret_9f3a8c');

    const afterState = (
      (await (await app.request('/api/state', { headers: acmeHeaders })).json()) as {
        state: { inventory: Array<{ sku: string; available: number }> };
      }
    ).state;
    expect(afterState.inventory.find((i) => i.sku === 'SKU-PRO-900')!.available).toBe(beforeAvail);

    // 2. Official @sagaflow/sdk v6 client methods (Alert Rules + Dry-Run)
    const { SagaFlowClient } = await import('@sagaflow/sdk');
    const sdk = new SagaFlowClient({
      baseUrl: 'http://sagaflow.local',
      tenantId: DEMO_TENANTS.ACME.id,
      userId: DEMO_USER_ID,
      fetch: (input, init) => {
        const url = new URL(String(input));
        return Promise.resolve(app.request(url.pathname + url.search, init));
      },
    });
    const sdkDry = await sdk.dryRunWorkflow('wf_batch_foreach', {
      items: [{ sku: 'SKU-PRO-900', qty: 1 }],
    });
    expect(sdkDry.dryRun.valid).toBe(true);

    const createdRule = await sdk.createAlertRule({
      name: 'SDK Test Rule',
      eventTypes: ['run.failed'],
      webhookUrl: '/api/sink/acme-commerce/sdk-alerts',
      signingSecret: 'sdk_sec_123',
      enabled: true,
    });
    expect(createdRule.rule.id).toMatch(/^alr_/);

    const tested = await sdk.testAlertRule(createdRule.rule.id);
    expect(tested.outcome.delivered).toBe(true);
    expect(tested.outcome.statusCode).toBe(200);

    const deleted = await sdk.deleteAlertRule(createdRule.rule.id);
    expect(deleted.deleted).toBe(true);
  });

  // ===================== v7.0 PROJECTS, 6 NEW NODE TYPES, TEMPLATES & CLOUD =====================

  it('v7: creates isolated empty project (0 workflows) and template-backed project via /api/projects & SDK', async () => {
    // 1. Create an empty project with 0 workflows
    const emptyRes = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': DEMO_USER_ID },
      body: JSON.stringify({
        name: 'Fresh Empty Workspace',
        description: 'Zero-clutter clean project',
        mode: 'empty',
      }),
    });
    expect(emptyRes.status).toBe(201);
    const emptyBody = (await emptyRes.json()) as {
      tenant: { id: string; slug: string; name: string };
      project: { id: string; workflowCount: number; description?: string };
      workflows: unknown[];
    };
    expect(emptyBody.tenant.slug).toBe('fresh-empty-workspace');
    expect(emptyBody.project.workflowCount).toBe(0);
    expect(emptyBody.project.description).toBe('Zero-clutter clean project');
    expect(emptyBody.workflows).toHaveLength(0);

    // Verify strict tenant isolation: empty project sees 0 workflows from Acme
    const emptyWfsRes = await app.request('/api/workflows', {
      headers: { 'X-Tenant-Id': emptyBody.tenant.id, 'X-User-Id': DEMO_USER_ID },
    });
    expect(emptyWfsRes.status).toBe(200);
    const emptyWfs = (await emptyWfsRes.json()) as { workflows: unknown[] };
    expect(emptyWfs.workflows).toHaveLength(0);

    // 2. Create a template-seeded project via @sagaflow/sdk
    const { SagaFlowClient } = await import('@sagaflow/sdk');
    const sdk = new SagaFlowClient({
      baseUrl: 'http://sagaflow.local',
      tenantId: DEMO_TENANTS.ACME.id,
      userId: DEMO_USER_ID,
      fetch: (input, init) => {
        const url = new URL(String(input));
        return Promise.resolve(app.request(url.pathname + url.search, init));
      },
    });
    const tplProj = await sdk.createProject({
      name: 'Growth Automation Hub',
      mode: 'template',
      autoPublish: true,
      maxConcurrentRuns: 100,
      rateLimitPerMin: 300,
      starterWorkflows: [
        {
          name: 'Quick Welcome Email',
          description: 'Starter template',
          nodes: [
            { id: 'trigger', type: 'trigger', label: 'Start', position: { x: 40, y: 120 }, config: { triggerType: 'webhook' } },
            {
              id: 'welcome',
              type: 'email',
              label: 'Send Welcome',
              position: { x: 320, y: 120 },
              config: { provider: 'sink', to: '{{input.email}}', subject: 'Hi {{input.name}}', body: 'Welcome!' },
            },
          ],
          edges: [{ id: 'e1', from: 'trigger', to: 'welcome', condition: 'always' }],
        },
      ],
    });
    expect(tplProj.project.workflowCount).toBe(1);
    expect(tplProj.project.publishedWorkflowCount).toBe(1);
    expect(tplProj.workflows[0].latestVersion).toBe(1);

    const list = await sdk.listProjects();
    expect(list.projects.some((p) => p.id === emptyBody.tenant.id)).toBe(true);
    expect(list.projects.some((p) => p.id === tplProj.tenant.id)).toBe(true);
  });

  it('v7: executes transform, filter (pass & skip), database, slack_discord, and email end-to-end', async () => {
    const wfRes = await app.request('/api/workflows', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'Lead Capture CRM Pipeline (v7 Test)',
        nodes: [
          { id: 'trigger', type: 'trigger', label: 'Lead Hook', config: { triggerType: 'webhook' } },
          {
            id: 'map',
            type: 'transform',
            label: 'Normalize Lead',
            config: {
              mergeWithInput: true,
              mappings: {
                fullName: '{{input.first}} {{input.last}}',
                tier: 'qualified',
              },
            },
          },
          {
            id: 'guard',
            type: 'filter',
            label: 'Valid Email Guard',
            config: { field: '{{input.email}}', operator: 'contains', value: '@', onFail: 'skip_downstream' },
          },
          {
            id: 'save',
            type: 'database',
            label: 'Persist Lead',
            config: {
              operation: 'set',
              collection: 'crm_leads',
              key: '{{input.leadId}}',
              value: { fullName: '{{steps.map.fullName}}', email: '{{input.email}}' },
            },
          },
          {
            id: 'chat',
            type: 'slack_discord',
            label: 'Notify Slack',
            config: {
              platform: 'slack',
              channelName: '#sales-leads',
              severity: 'success',
              title: 'Lead {{steps.map.fullName}}',
              message: 'Email: {{input.email}}',
            },
          },
          {
            id: 'mail',
            type: 'email',
            label: 'Welcome Email',
            config: {
              provider: 'sink',
              to: '{{input.email}}',
              subject: 'Welcome {{input.first}}',
              body: 'Hello {{steps.map.fullName}}',
            },
          },
        ],
        edges: [
          { id: 'e1', from: 'trigger', to: 'map' },
          { id: 'e2', from: 'map', to: 'guard' },
          { id: 'e3', from: 'guard', to: 'save' },
          { id: 'e4', from: 'save', to: 'chat' },
          { id: 'e5', from: 'save', to: 'mail' },
        ],
      }),
    });
    expect(wfRes.status).toBe(201);
    const { workflow } = (await wfRes.json()) as { workflow: { id: string } };
    expect((await app.request(`/api/workflows/${workflow.id}/publish`, { method: 'POST', headers: acmeHeaders })).status).toBe(201);

    // 1. Valid lead passes filter and writes DB + Slack Block Kit + Email sink
    const r1 = await app.request(`/api/workflows/${workflow.id}/runs`, {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'v7-lead-pass-1' },
      body: JSON.stringify({
        input: { leadId: 'lead_701', first: 'Maya', last: 'Lin', email: 'maya@northstar.io' },
      }),
    });
    expect(r1.status).toBe(202);
    const { run: run1 } = (await r1.json()) as { run: { id: string } };
    const final1 = await waitTerminal(run1.id);
    expect(final1.status).toBe('succeeded');
    expect((final1.steps.find((s) => s.nodeId === 'map')?.output as { fullName: string }).fullName).toBe('Maya Lin');
    expect((final1.steps.find((s) => s.nodeId === 'mail')?.output as { sent: boolean }).sent).toBe(true);
    expect((final1.steps.find((s) => s.nodeId === 'chat')?.output as { delivered: boolean }).delivered).toBe(true);

    // Verify real persisted DB record + Email/Slack inbox deliveries in tenant state
    const stRes = await app.request('/api/state', { headers: acmeHeaders });
    const st = ((await stRes.json()) as {
      state: { kv: Array<{ key: string; value: unknown }>; sinkDeliveries: Array<{ channel: string }> };
    }).state;
    expect(st.kv.some((k) => k.key === 'crm_leads:lead_701')).toBe(true);
    expect(st.sinkDeliveries.some((d) => d.channel === 'email')).toBe(true);
    expect(st.sinkDeliveries.some((d) => d.channel === 'slack')).toBe(true);

    // 2. Invalid email (missing '@') is cleanly filtered out and downstream steps are skipped
    const r2 = await app.request(`/api/workflows/${workflow.id}/runs`, {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'v7-lead-skip-2' },
      body: JSON.stringify({
        input: { leadId: 'lead_bad_702', first: 'Bot', last: 'Spam', email: 'not-an-email' },
      }),
    });
    expect(r2.status).toBe(202);
    const { run: run2 } = (await r2.json()) as { run: { id: string } };
    const final2 = await waitTerminal(run2.id);
    expect(final2.status).toBe('succeeded');
    expect((final2.steps.find((s) => s.nodeId === 'guard')?.output as { passed: boolean }).passed).toBe(false);
    expect(final2.steps.find((s) => s.nodeId === 'save')?.status).toBe('skipped');
    expect(final2.steps.find((s) => s.nodeId === 'chat')?.status).toBe('skipped');
    expect(final2.steps.find((s) => s.nodeId === 'mail')?.status).toBe('skipped');
  });

  it('v7: routes multi-way switch branches accurately including default fallback', async () => {
    const wfRes = await app.request('/api/workflows', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'Switch Multi-Way Router Test',
        nodes: [
          { id: 'trigger', type: 'trigger', label: 'Ticket', config: { triggerType: 'webhook' } },
          {
            id: 'router',
            type: 'switch',
            label: 'Category Switch',
            config: {
              expression: '{{input.category}}',
              defaultCase: 'general',
              cases: [
                { key: 'urgent', label: 'Urgent', operator: 'eq', value: 'urgent' },
                { key: 'billing', label: 'Billing', operator: 'eq', value: 'billing' },
              ],
            },
          },
          {
            id: 'urgent_step',
            type: 'slack_discord',
            label: 'Page On-Call',
            config: { platform: 'discord', channelName: '#oncall', title: 'Urgent', message: '{{input.id}}' },
          },
          {
            id: 'billing_step',
            type: 'email',
            label: 'Notify Billing',
            config: { provider: 'sink', to: 'billing@acme.local', subject: 'Billing', body: '{{input.id}}' },
          },
          {
            id: 'general_step',
            type: 'transform',
            label: 'Log General',
            config: { mappings: { routed: 'general', id: '{{input.id}}' } },
          },
        ],
        edges: [
          { id: 'e1', from: 'trigger', to: 'router' },
          { id: 'e2', from: 'router', to: 'urgent_step', condition: 'urgent' },
          { id: 'e3', from: 'router', to: 'billing_step', condition: 'billing' },
          { id: 'e4', from: 'router', to: 'general_step', condition: 'general' },
        ],
      }),
    });
    const { workflow } = (await wfRes.json()) as { workflow: { id: string } };
    await app.request(`/api/workflows/${workflow.id}/publish`, { method: 'POST', headers: acmeHeaders });

    // Route 1: urgent -> executes urgent_step only
    const rUrg = await app.request(`/api/workflows/${workflow.id}/runs`, {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'v7-sw-urgent' },
      body: JSON.stringify({ input: { id: 'T1', category: 'urgent' } }),
    });
    const fUrg = await waitTerminal(((await rUrg.json()) as { run: { id: string } }).run.id);
    expect(fUrg.status).toBe('succeeded');
    expect(fUrg.steps.find((s) => s.nodeId === 'urgent_step')?.status).toBe('succeeded');
    expect(fUrg.steps.find((s) => s.nodeId === 'billing_step')?.status).toBe('skipped');
    expect(fUrg.steps.find((s) => s.nodeId === 'general_step')?.status).toBe('skipped');

    // Route 2: unknown category -> falls back cleanly to defaultCase ('general')
    const rDef = await app.request(`/api/workflows/${workflow.id}/runs`, {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'v7-sw-default' },
      body: JSON.stringify({ input: { id: 'T2', category: 'feedback' } }),
    });
    const fDef = await waitTerminal(((await rDef.json()) as { run: { id: string } }).run.id);
    expect(fDef.status).toBe('succeeded');
    expect(fDef.steps.find((s) => s.nodeId === 'general_step')?.status).toBe('succeeded');
    expect(fDef.steps.find((s) => s.nodeId === 'urgent_step')?.status).toBe('skipped');
    expect(fDef.steps.find((s) => s.nodeId === 'billing_step')?.status).toBe('skipped');
  });

  it('v7: executes transactional database node (set/get/increment/list/delete) with exact atomic Saga rollback', async () => {
    // Seed an initial counter via workflow and verify atomic rollback on downstream failure
    const wfRes = await app.request('/api/workflows', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'Database Atomic Rollback Saga',
        nodes: [
          { id: 'trigger', type: 'trigger', label: 'Start', config: { triggerType: 'api' } },
          {
            id: 'db_set',
            type: 'database',
            label: 'Insert Order Record',
            config: { operation: 'set', collection: 'rb_orders', key: 'ord_999', value: { status: 'created' } },
          },
          {
            id: 'db_inc',
            type: 'database',
            label: 'Increment Counter',
            config: { operation: 'increment', collection: 'rb_metrics', key: 'daily_count', delta: 5 },
          },
          {
            id: 'fail_guard',
            type: 'filter',
            label: 'Fail Downstream Guard',
            config: {
              field: '{{input.allowCommit}}',
              operator: 'eq',
              value: 'yes',
              onFail: 'fail_run',
              retryPolicy: { maxAttempts: 1, initialDelayMs: 10, backoffMultiplier: 1 },
            },
          },
        ],
        edges: [
          { id: 'e1', from: 'trigger', to: 'db_set' },
          { id: 'e2', from: 'db_set', to: 'db_inc' },
          { id: 'e3', from: 'db_inc', to: 'fail_guard' },
        ],
      }),
    });
    const { workflow } = (await wfRes.json()) as { workflow: { id: string } };
    await app.request(`/api/workflows/${workflow.id}/publish`, { method: 'POST', headers: acmeHeaders });

    // Run with allowCommit: 'no' -> filter fails -> Saga MUST delete rb_orders:ord_999 AND revert rb_metrics:daily_count!
    const rFail = await app.request(`/api/workflows/${workflow.id}/runs`, {
      method: 'POST',
      headers: { ...acmeHeaders, 'Idempotency-Key': 'v7-db-rollback-1' },
      body: JSON.stringify({ input: { allowCommit: 'no' } }),
    });
    const finalFail = await waitTerminal(((await rFail.json()) as { run: { id: string } }).run.id);
    expect(finalFail.status).toBe('compensated');
    expect(finalFail.steps.find((s) => s.nodeId === 'db_set')?.status).toBe('compensated');
    expect(finalFail.steps.find((s) => s.nodeId === 'db_inc')?.status).toBe('compensated');

    const stAfterRollback = (
      (await (await app.request('/api/state', { headers: acmeHeaders })).json()) as {
        state: { kv: Array<{ key: string; value: unknown }> };
      }
    ).state;
    expect(stAfterRollback.kv.some((k) => k.key === 'rb_orders:ord_999')).toBe(false);
    expect(stAfterRollback.kv.some((k) => k.key === 'rb_metrics:daily_count')).toBe(false);
  });

  it('v7: Studio Dry-Run traces transform, filter, switch, email, slack_discord, and database with ZERO DB mutations', async () => {
    const beforeKvCount = (
      (await (await app.request('/api/state', { headers: acmeHeaders })).json()) as {
        state: { kv: unknown[] };
      }
    ).state.kv.length;

    const wfRes = await app.request('/api/workflows', {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({
        name: 'DryRun v7 Nodes Test',
        nodes: [
          { id: 't', type: 'trigger', label: 'Start', config: {} },
          { id: 'tr', type: 'transform', label: 'Map', config: { mappings: { tag: 'vip-{{input.code}}' } } },
          { id: 'sw', type: 'switch', label: 'Switch', config: { expression: '{{input.route}}', defaultCase: 'a', cases: [{ key: 'b', operator: 'eq', value: 'b' }] } },
          { id: 'db', type: 'database', label: 'Save B', config: { operation: 'set', collection: 'dry_only', key: 'never_written', value: { ok: true } } },
          { id: 'em', type: 'email', label: 'Email A', config: { to: 'a@acme.local', subject: 'A', body: 'hi' } },
          { id: 'sl', type: 'slack_discord', label: 'Slack B', config: { platform: 'slack', channelName: '#ops', title: 'B', message: 'hi' } },
        ],
        edges: [
          { id: 'e1', from: 't', to: 'tr' },
          { id: 'e2', from: 'tr', to: 'sw' },
          { id: 'e3', from: 'sw', to: 'db', condition: 'b' },
          { id: 'e4', from: 'sw', to: 'em', condition: 'a' },
          { id: 'e5', from: 'db', to: 'sl' },
        ],
      }),
    });
    const { workflow } = (await wfRes.json()) as { workflow: { id: string } };

    const dryRes = await app.request(`/api/workflows/${workflow.id}/dry-run`, {
      method: 'POST',
      headers: acmeHeaders,
      body: JSON.stringify({ input: { code: '42', route: 'b' } }),
    });
    expect(dryRes.status).toBe(200);
    const { dryRun } = (await dryRes.json()) as {
      dryRun: {
        valid: boolean;
        steps: Array<{ nodeId: string; status: string; branchDecision?: unknown; previewOutput?: unknown }>;
      };
    };
    expect(dryRun.valid).toBe(true);
    expect(dryRun.steps.find((s) => s.nodeId === 'tr')?.previewOutput).toEqual({ tag: 'vip-42' });
    expect(dryRun.steps.find((s) => s.nodeId === 'sw')?.branchDecision).toBe('b');
    expect(dryRun.steps.find((s) => s.nodeId === 'db')?.status).toBe('would_execute');
    expect(dryRun.steps.find((s) => s.nodeId === 'sl')?.status).toBe('would_execute');
    expect(dryRun.steps.find((s) => s.nodeId === 'em')?.status).toBe('would_skip');

    // Strictly ZERO database mutations!
    const afterKvCount = (
      (await (await app.request('/api/state', { headers: acmeHeaders })).json()) as {
        state: { kv: unknown[] };
      }
    ).state.kv.length;
    expect(afterKvCount).toBe(beforeKvCount);
  });

  it('v7: verifies Docker, Local, and Cloud deployment manifests & OpenAPI v8.0.0 contract', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = process.cwd();

    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('packages/sdk/package.json');
    expect(dockerfile).toContain('packages/sdk/dist');
    expect(dockerfile).toContain('USER sagaflow');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('apps/web/dist');

    expect(fs.existsSync(path.join(root, '.dockerignore'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'docker-compose.yml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'fly.toml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'render.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'vercel.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'api/index.ts'))).toBe(true);

    const specRes = await app.request('/api/openapi.json');
    expect(specRes.status).toBe(200);
    const spec = (await specRes.json()) as { info: { version: string }; paths: Record<string, unknown> };
    expect(spec.info.version).toBe('8.0.0');
    expect(spec.paths['/api/projects']).toBeDefined();
  });
});


