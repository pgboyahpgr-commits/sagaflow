#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WorkflowDefinitionSchema, validateWorkflowGraph } from '@sagaflow/shared';
import {
  LocalDurableQueue,
  RunEventBus,
  SagaOrchestrator,
  SecretCipher,
  createStorageAdapter,
  makeId,
} from '@sagaflow/engine';
import { startSagaFlowServer } from './server.js';

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printHelp() {
  console.log(`SagaFlow CLI — Multi-Tenant Distributed Workflow & Saga Engine

Usage:
  sagaflow start [options]
    --port <number>                 HTTP port (default: 4000)
    --host <addr>                   Bind host (default: 0.0.0.0)
    --role <all|api|worker>         Execution role (default: all)
    --storage <sqlite|json|postgres> Storage backend (default: sqlite)
    --data <dir>                    Storage folder path (default: ./data)

  sagaflow validate <workflow.json>
    Validates a workflow DAG JSON file (cycles, reachability, dangling edges)

  sagaflow benchmark [options]
    --runs <number>                 Total concurrent runs (default: 1000)
    --concurrency <number>          Worker concurrency (default: 50)
    --storage <sqlite|json>         Storage driver to benchmark (default: sqlite)
    --json <output.json>            Optional path to save machine-readable metrics
`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function runValidate(filePath?: string) {
  if (!filePath) {
    console.error('Usage: sagaflow validate <workflow.json>');
    process.exit(1);
  }
  const abs = resolve(filePath);
  const raw = JSON.parse(readFileSync(abs, 'utf8'));
  const candidate = raw && typeof raw === 'object' && 'workflow' in raw ? raw.workflow : raw;
  const parsed = WorkflowDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    console.error('❌ Schema validation failed:');
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join('.') || 'root'}: ${issue.message}`);
    }
    process.exit(1);
  }
  const res = validateWorkflowGraph(parsed.data.nodes, parsed.data.edges);
  if (!res.valid) {
    console.error(`❌ Graph validation failed with ${res.issues.length} issue(s):`);
    for (const i of res.issues) {
      console.error(`  - [${i.code}] ${i.path}: ${i.message}`);
    }
    process.exit(1);
  }
  console.log(
    `✅ Valid DAG (${res.nodeCount} nodes, ${res.edgeCount} edges) | Topological order: ${res.topologicalOrder.join(' -> ')}`
  );
}

async function runBenchmark(flags: Record<string, string>) {
  const totalRuns = Math.max(10, Number.parseInt(flags.runs ?? '1000', 10) || 1000);
  const concurrency = Math.max(1, Number.parseInt(flags.concurrency ?? '50', 10) || 50);
  const driver = flags.storage === 'json' ? 'json' : 'sqlite';
  const tempDir = mkdtempSync(join(tmpdir(), `sagaflow-bench-${driver}-`));

  try {
    console.log(
      `\n🚀 SagaFlow High-Concurrency Benchmark | runs=${totalRuns} | workers=${concurrency} | storage=${driver} (DB-per-tenant)`
    );
    const storage = createStorageAdapter({
      driver,
      isolation: 'db-per-tenant',
      storagePath: tempDir,
      queueDriver: 'local',
      workerConcurrency: concurrency,
    });
    await storage.init();

    const cipher = new SecretCipher({ storagePath: tempDir });
    const tenant = await storage.createTenant({
      id: 'ten_bench',
      name: 'Benchmark Tenant',
      slug: 'benchmark-tenant',
      maxConcurrentRuns: totalRuns,
      rateLimitPerMin: 100_000,
    });
    await storage.upsertSecret(tenant.id, {
      name: 'BENCH_TOKEN',
      encryptedValue: cipher.encrypt('secret_bench_token_12345'),
    });
    await storage.mutateInventory(tenant.id, {
      sku: 'SKU-PRO-900',
      name: 'Benchmark SKU',
      warehouse: 'ap-south-1',
      deltaAvailable: totalRuns * 10,
    });

    // Realistic 4-node DAG: trigger -> QuickJS-WASM compute -> parallel branch (custom_task + template http_request)
    const wf = await storage.createWorkflow(
      tenant.id,
      {
        name: '1000-Run Benchmark Workflow',
        description: 'Trigger -> WASM Transform -> Parallel Reserve + HTTP Mock',
        nodes: [
          {
            id: 'trigger',
            type: 'trigger',
            label: 'Start',
            position: { x: 0, y: 0 },
            config: { simulatedLatencyMs: 0 },
          },
          {
            id: 'wasm',
            type: 'script',
            label: 'WASM Transform',
            position: { x: 200, y: 0 },
            config: {
              code: 'return { orderId: input.orderId, total: Number(input.amount) * 1.08 };',
              timeoutMs: 1000,
              memoryLimitMb: 8,
            },
          },
          {
            id: 'reserve',
            type: 'custom_task',
            label: 'Reserve Stock',
            position: { x: 400, y: -60 },
            config: {
              handler: 'reserve_inventory',
              compensationHandler: 'release_inventory',
              simulatedLatencyMs: 5,
            },
          },
          {
            id: 'notify',
            type: 'http_request',
            label: 'Notify Partner (Live Sink)',
            position: { x: 400, y: 60 },
            config: {
              method: 'POST',
              url: '/api/sink/benchmark-tenant/orders',
              headers: { Authorization: 'Bearer {{secrets.BENCH_TOKEN}}' },
              body: { orderId: '{{steps.wasm.orderId}}', total: '{{steps.wasm.total}}' },
            },
          },
        ],
        edges: [
          { id: 'e1', from: 'trigger', to: 'wasm' },
          { id: 'e2', from: 'wasm', to: 'reserve' },
          { id: 'e3', from: 'wasm', to: 'notify' },
        ],
      },
      'wf_bench'
    );
    const pub = await storage.publishWorkflow(tenant.id, wf.id);
    if (!pub) throw new Error('Failed to publish benchmark workflow');

    const eventBus = new RunEventBus(storage);
    const queue = new LocalDurableQueue(storage, concurrency);
    const orchestrator = new SagaOrchestrator(storage, queue, eventBus, cipher);
    await orchestrator.start();

    const startWall = Date.now();
    const batchId = makeId('b');
    const latencies: number[] = [];
    let succeeded = 0;
    let failed = 0;
    let completedCount = 0;

    // Event-driven completion tracker (O(1), zero polling overhead!)
    let resolveDone!: () => void;
    const allDone = new Promise<void>((res) => {
      resolveDone = res;
    });

    const unsubs: Array<() => void> = [];
    const trackedIds = new Set<string>();

    const enqueueStart = Date.now();
    for (let i = 0; i < totalRuns; i++) {
      const { run } = await storage.createRunIdempotent(tenant.id, {
        id: makeId('run'),
        workflowId: wf.id,
        workflowName: wf.name,
        versionNumber: pub.version.versionNumber,
        idempotencyKey: `bench_${batchId}_${i}`,
        input: { orderId: `ORD-${i}`, amount: 50 + (i % 200) },
      });
      trackedIds.add(run.id);
      const unsub = eventBus.subscribe(tenant.id, run.id, (evt) => {
        if (evt.type === 'run.completed') {
          unsub();
          if (evt.payload.status === 'succeeded') succeeded++;
          else failed++;
          const d = Number(evt.payload.durationMs ?? 0);
          latencies.push(d);
          completedCount++;
          if (completedCount === totalRuns) {
            resolveDone();
          }
        }
      });
      unsubs.push(unsub);
      await orchestrator.enqueueRun(tenant.id, run.id);
    }
    const enqueueMs = Date.now() - enqueueStart;

    // Fallback safety check in case any run completed synchronously before subscribe
    if (completedCount < totalRuns) {
      await allDone;
    }
    for (const u of unsubs) u();

    const totalWallMs = Date.now() - startWall;
    latencies.sort((a, b) => a - b);
    const throughput = Number(((totalRuns / totalWallMs) * 1000).toFixed(2));
    const avgMs =
      latencies.length > 0
        ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length)
        : 0;

    let tenantFileBytes = 0;
    try {
      const fp =
        driver === 'sqlite'
          ? join(tempDir, 'tenants', 'ten_bench.db')
          : join(tempDir, 'tenants', 'ten_bench.json');
      tenantFileBytes = statSync(fp).size;
    } catch {
      // ignore
    }

    const summary = {
      timestamp: new Date().toISOString(),
      driver,
      isolation: 'db-per-tenant',
      totalRuns,
      nodesPerRun: 4,
      totalStepsExecuted: totalRuns * 4,
      workerConcurrency: concurrency,
      enqueueTimeMs: enqueueMs,
      totalWallTimeMs: totalWallMs,
      throughputRunsPerSec: throughput,
      stepThroughputPerSec: Number((((totalRuns * 4) / totalWallMs) * 1000).toFixed(2)),
      succeeded,
      failed,
      successRatePct: Number(((succeeded / totalRuns) * 100).toFixed(2)),
      latencyMs: {
        min: latencies[0] ?? 0,
        avg: avgMs,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: latencies[latencies.length - 1] ?? 0,
      },
      tenantDbSizeKb: Number((tenantFileBytes / 1024).toFixed(1)),
      memoryRssMb: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)),
    };

    console.log('\n📊 Benchmark Results:');
    console.table({
      'Total Runs': `${summary.totalRuns} (${summary.totalStepsExecuted} DAG steps, incl. QuickJS-WASM)`,
      'Success Rate': `${summary.succeeded}/${summary.totalRuns} (${summary.successRatePct}%)`,
      'Total Wall Time': `${(summary.totalWallTimeMs / 1000).toFixed(2)}s (enqueue ${(summary.enqueueTimeMs / 1000).toFixed(2)}s)`,
      'Throughput': `${summary.throughputRunsPerSec} runs/sec (${summary.stepThroughputPerSec} steps/sec)`,
      'Run Latency p50/p95/p99': `${summary.latencyMs.p50}ms / ${summary.latencyMs.p95}ms / ${summary.latencyMs.p99}ms (avg ${summary.latencyMs.avg}ms)`,
      'Tenant DB Size': `${summary.tenantDbSizeKb} KB`,
      'Peak Process RSS': `${summary.memoryRssMb} MB`,
    });

    if (flags.json) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(resolve(flags.json), JSON.stringify(summary, null, 2), 'utf8');
      console.log(`💾 Saved JSON benchmark report to ${resolve(flags.json)}`);
    }

    await orchestrator.stop();
    await storage.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] ?? 'start';

  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.help) {
    printHelp();
    return;
  }

  if (cmd === 'validate') {
    await runValidate(positional[1]);
    return;
  }

  if (cmd === 'benchmark') {
    await runBenchmark(flags);
    return;
  }

  if (cmd === 'start') {
    await startSagaFlowServer({
      port: flags.port ? Number.parseInt(flags.port, 10) : undefined,
      host: flags.host,
      role: flags.role as 'all' | 'api' | 'worker' | undefined,
      storageDriver: flags.storage as 'sqlite' | 'json' | 'postgres' | undefined,
      storagePath: flags.data,
    });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error('[SagaFlow CLI Error]', err);
  process.exit(1);
});
