import { isTerminalRunStatus, type StressTestInput, type StressTestResult } from '@sagaflow/shared';
import type { RunEventBus } from '../queue/event-bus.js';
import type { StorageAdapter } from '../storage/interface.js';
import { makeId } from '../utils/id.js';
import type { SagaOrchestrator } from './saga-engine.js';

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

/**
 * Fires N concurrent workflow runs through the real StorageAdapter + Queue + SagaOrchestrator
 * and measures true end-to-end throughput and latency percentiles (p50 / p95 / p99).
 */
export async function runStressTest(params: {
  tenantId: string;
  input: StressTestInput;
  storage: StorageAdapter;
  orchestrator: SagaOrchestrator;
  eventBus: RunEventBus;
}): Promise<StressTestResult> {
  const { tenantId, input, storage, orchestrator, eventBus } = params;
  const wf = await storage.getWorkflow(tenantId, input.workflowId);
  if (!wf || wf.latestVersion === null) {
    throw new Error('Workflow not found or has no published version');
  }

  const totalRuns = Math.min(Math.max(input.totalRuns, 5), 1000);
  const concurrency = Math.min(Math.max(input.concurrency, 1), 100);
  const startedAll = Date.now();

  const latencies: number[] = [];
  const outcomes = { succeeded: 0, compensated: 0, failed: 0, cancelled: 0 };

  let nextIdx = 0;

  const worker = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= totalRuns) return;

      const t0 = Date.now();
      const runId = makeId('run');
      const idempotencyKey = `stress_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 8)}`;

      const { run } = await storage.createRunIdempotent(tenantId, {
        id: runId,
        workflowId: wf.id,
        workflowName: wf.name,
        versionNumber: wf.latestVersion!,
        idempotencyKey,
        input: { ...(input.input ?? { orderId: `ORD-STRESS-${idx}`, amount: 120 }), stressIndex: idx },
      });

      const waitPromise = eventBus.waitForCompletion(tenantId, run.id, 60000);
      await orchestrator.enqueueRun(tenantId, run.id);

      // Guard against already-completed race
      let finalRun = await storage.getRun(tenantId, run.id);
      if (!finalRun || !isTerminalRunStatus(finalRun.status)) {
        await waitPromise;
        finalRun = await storage.getRun(tenantId, run.id);
      }

      latencies.push(Date.now() - t0);
      const status = finalRun?.status ?? 'failed';
      if (status === 'succeeded') outcomes.succeeded++;
      else if (status === 'compensated') outcomes.compensated++;
      else if (status === 'cancelled') outcomes.cancelled++;
      else outcomes.failed++;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, totalRuns) }, () => worker()));

  const elapsedMs = Math.max(1, Date.now() - startedAll);
  latencies.sort((a, b) => a - b);
  const sum = latencies.reduce((acc, v) => acc + v, 0);

  return {
    workflowId: wf.id,
    workflowName: wf.name,
    totalRuns,
    concurrency,
    elapsedMs,
    runsPerSecond: Number(((totalRuns / elapsedMs) * 1000).toFixed(2)),
    outcomes,
    latency: {
      minMs: latencies[0] ?? 0,
      avgMs: latencies.length ? Math.round(sum / latencies.length) : 0,
      p50Ms: pct(latencies, 50),
      p95Ms: pct(latencies, 95),
      p99Ms: pct(latencies, 99),
      maxMs: latencies[latencies.length - 1] ?? 0,
    },
  };
}
