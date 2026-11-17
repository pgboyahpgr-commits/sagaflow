import type {
  DlqEntry,
  MetricsSnapshot,
  RunDetail,
  StepHeatmapEntry,
  StorageStatus,
  Tenant,
  WorkflowListItem,
} from '@sagaflow/shared';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

export function buildMetricsSnapshot(params: {
  tenant: Tenant;
  storage: StorageStatus;
  workflows: WorkflowListItem[];
  runs: RunDetail[];
  dlqEntries: DlqEntry[];
  rateLimitUsed: number;
}): MetricsSnapshot {
  const { tenant, storage, workflows, runs, dlqEntries, rateLimitUsed } = params;

  let activeRuns = 0;
  let succeeded = 0;
  let compensated = 0;
  let failed = 0;
  let cancelled = 0;

  const durations: number[] = [];
  const stepStats = new Map<
    string,
    {
      nodeId: string;
      label: string;
      kind: string;
      totalAttempts: number;
      failedAttempts: number;
      compensatedAttempts: number;
      totalLatencyMs: number;
      latencySamples: number;
    }
  >();

  const bucketMap = new Map<
    string,
    { bucket: string; total: number; succeeded: number; compensated: number; failed: number }
  >();

  for (const run of runs) {
    if (
      run.status === 'pending' ||
      run.status === 'running' ||
      run.status === 'waiting_approval' ||
      run.status === 'compensating'
    ) {
      activeRuns++;
    } else if (run.status === 'succeeded') {
      succeeded++;
    } else if (run.status === 'compensated') {
      compensated++;
    } else if (run.status === 'failed') {
      failed++;
    } else if (run.status === 'cancelled') {
      cancelled++;
    }

    if (typeof run.durationMs === 'number' && run.durationMs >= 0) {
      durations.push(run.durationMs);
    } else if (run.startedAt && run.finishedAt) {
      const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
      if (ms >= 0) durations.push(ms);
    }

    // Group throughput by minute (ISO slice YYYY-MM-DDTHH:MM)
    const bucketKey = run.createdAt.slice(0, 16);
    if (!bucketMap.has(bucketKey)) {
      bucketMap.set(bucketKey, {
        bucket: bucketKey.slice(11, 16),
        total: 0,
        succeeded: 0,
        compensated: 0,
        failed: 0,
      });
    }
    const b = bucketMap.get(bucketKey)!;
    b.total++;
    if (run.status === 'succeeded') b.succeeded++;
    else if (run.status === 'compensated') b.compensated++;
    else if (run.status === 'failed') b.failed++;

    for (const step of run.steps) {
      const key = `${step.nodeId}::${step.label}`;
      if (!stepStats.has(key)) {
        stepStats.set(key, {
          nodeId: step.nodeId,
          label: step.label,
          kind: step.kind,
          totalAttempts: 0,
          failedAttempts: 0,
          compensatedAttempts: 0,
          totalLatencyMs: 0,
          latencySamples: 0,
        });
      }
      const stat = stepStats.get(key)!;
      for (const att of step.attempts) {
        stat.totalAttempts++;
        if (att.status === 'failed') stat.failedAttempts++;
        if (att.kind === 'compensate') stat.compensatedAttempts++;
        if (typeof att.durationMs === 'number' && att.durationMs >= 0) {
          stat.totalLatencyMs += att.durationMs;
          stat.latencySamples++;
        }
      }
    }
  }

  durations.sort((a, b) => a - b);
  const avgMs =
    durations.length > 0
      ? Math.round(durations.reduce((sum, v) => sum + v, 0) / durations.length)
      : 0;

  const failureHeatmap: StepHeatmapEntry[] = Array.from(stepStats.values())
    .map((s) => ({
      nodeId: s.nodeId,
      label: s.label,
      kind: s.kind,
      totalAttempts: s.totalAttempts,
      failedAttempts: s.failedAttempts,
      compensatedAttempts: s.compensatedAttempts,
      avgLatencyMs: s.latencySamples > 0 ? Math.round(s.totalLatencyMs / s.latencySamples) : 0,
      failureRate:
        s.totalAttempts > 0 ? Number(((s.failedAttempts / s.totalAttempts) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.failureRate - a.failureRate || b.totalAttempts - a.totalAttempts)
    .slice(0, 15);

  const recentThroughput = Array.from(bucketMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([, v]) => v);

  return {
    tenantId: tenant.id,
    storage,
    totals: {
      workflows: workflows.length,
      publishedWorkflows: workflows.filter((w) => w.status === 'published').length,
      runs: runs.length,
      activeRuns,
      succeeded,
      compensated,
      failed,
      cancelled,
      dlqOpen: dlqEntries.filter((d) => !d.replayedRunId).length,
    },
    quotas: {
      maxConcurrentRuns: tenant.maxConcurrentRuns,
      activeRuns,
      rateLimitPerMin: tenant.rateLimitPerMin,
      rateLimitUsed,
    },
    latency: {
      avgMs,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      samples: durations.length,
    },
    failureHeatmap,
    recentThroughput,
  };
}
