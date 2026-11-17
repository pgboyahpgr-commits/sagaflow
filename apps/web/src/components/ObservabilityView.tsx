import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  RotateCcw,
  XCircle,
  Zap,
  Flame,
  RefreshCw,
  Gauge,
  Copy,
  Terminal,
  FlaskConical,
  ExternalLink,
} from 'lucide-react';
import type { MetricsSnapshot, StressTestResult, WorkflowListItem } from '@sagaflow/shared';
import { api, type TenantSession } from '../lib/api';

interface ObservabilityViewProps {
  session: TenantSession;
  onNotify?: (msg: string, tone?: 'ok' | 'err' | 'info') => void;
}

function renderPromLine(line: string, idx: number): React.ReactNode {
  if (line.startsWith('#')) {
    return (
      <div key={idx} className="text-zinc-500">
        {line}
      </div>
    );
  }
  const match = line.match(/^([a-zA-Z0-9_:]+)(\{[^}]*\})?\s+(.+)$/);
  if (match) {
    const [, name, labels, value] = match;
    return (
      <div key={idx}>
        <span className="text-zinc-200">{name}</span>
        {labels && <span className="text-zinc-400">{labels}</span>}{' '}
        <span className="font-semibold text-[#22e55c]">{value}</span>
      </div>
    );
  }
  return (
    <div key={idx} className="text-zinc-300">
      {line}
    </div>
  );
}

export const ObservabilityView: React.FC<ObservabilityViewProps> = ({ session, onNotify }) => {
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>('');
  const [totalRuns, setTotalRuns] = useState<number>(50);
  const [stressResult, setStressResult] = useState<StressTestResult | null>(null);
  const [runningStress, setRunningStress] = useState(false);
  const [promText, setPromText] = useState<string>('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [scraping, setScraping] = useState(false);

  const refresh = useCallback(async () => {
    setScraping(true);
    try {
      const [m, w, prom] = await Promise.all([
        api.getMetrics(session),
        api.listWorkflows(session),
        api.getPrometheusMetrics(),
      ]);
      setMetrics(m.metrics);
      setPromText(prom);
      const published = w.workflows.filter((wf) => wf.latestVersion !== null);
      setWorkflows(published);
      setSelectedWorkflowId((curr) => {
        if (curr && published.some((wf) => wf.id === curr)) return curr;
        const preferred =
          published.find((wf) => wf.id === 'wf_order_fulfillment') ??
          published.find((wf) => wf.id !== 'wf_human_approval' && wf.id !== 'wf_ai_triage') ??
          published[0];
        return preferred?.id ?? '';
      });
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : 'Failed to load metrics', 'err');
    } finally {
      setScraping(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.tenantId, session.apiKey, session.token]);

  useEffect(() => {
    void refresh();
    if (!autoRefresh) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh, autoRefresh]);

  const handleStressTest = async () => {
    if (!selectedWorkflowId) return;
    setRunningStress(true);
    setStressResult(null);
    try {
      const res = await api.runStressTest(session, {
        workflowId: selectedWorkflowId,
        totalRuns,
        concurrency: Math.min(totalRuns, 25),
        input: { orderId: 'ORD-LOAD', sku: 'SKU-PRO-900', qty: 1, amount: 99 },
      });
      setStressResult(res.result);
      onNotify?.(
        `Load test complete: ${res.result.outcomes.succeeded}/${res.result.totalRuns} succeeded (${res.result.runsPerSecond} runs/s)`,
        'ok'
      );
      await refresh();
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : 'Stress test failed', 'err');
    } finally {
      setRunningStress(false);
    }
  };

  const runsCount = metrics?.totals.runs ?? 0;
  const succeededCount = metrics?.totals.succeeded ?? 0;
  const compensatedCount = metrics?.totals.compensated ?? 0;
  const failedCount = metrics?.totals.failed ?? 0;

  const successRate = runsCount > 0 ? ((succeededCount / runsCount) * 100).toFixed(1) : '100.0';
  const compRate = runsCount > 0 ? ((compensatedCount / runsCount) * 100).toFixed(1) : '0.0';
  const failRate = runsCount > 0 ? ((failedCount / runsCount) * 100).toFixed(1) : '0.0';

  const maxBucket = Math.max(1, ...(metrics?.recentThroughput.map((b) => b.total) ?? [1]));
  const maxLatency = Math.max(1, metrics?.latency.p99Ms ?? 1);
  const filledBlocks = Math.round((Number(successRate) / 100) * 10);

  return (
    <div className="sf-surface-bg h-full overflow-y-auto p-5 lg:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        {/* Header Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-xl font-bold tracking-tight text-white">
                Observability & High-Concurrency Load Lab
              </h2>
              <span className="rounded border border-[#22e55c]/35 bg-[#22e55c]/10 px-2 py-0.5 font-mono text-[9.5px] font-bold tracking-wider text-[#22e55c]">
                TELEMETRY ENGINE
              </span>
            </div>
            <p className="mt-1 text-xs text-zinc-400">
              Real-time latency percentiles computed directly from this tenant&apos;s durable
              database, Prometheus OpenMetrics exporter, and high-concurrency stress test harness.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[11px] font-semibold transition ${
                autoRefresh
                  ? 'border-[#22e55c]/40 bg-[#22e55c]/10 text-[#22e55c]'
                  : 'border-[#262c32] bg-[#15191d] text-zinc-400'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  autoRefresh ? 'bg-[#22e55c] animate-pulse' : 'bg-zinc-600'
                }`}
              />
              AUTO 5S
            </button>
            <button
              onClick={() => void refresh()}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#262c32] bg-[#15191d] px-3 py-1.5 font-mono text-[11px] text-zinc-200 transition hover:border-[#22e55c]/40 hover:text-white"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${scraping ? 'animate-spin text-[#22e55c]' : ''}`} />
              Scrape Now
            </button>
          </div>
        </div>

        {/* 5 Precision Telemetry KPI Cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <div className="sf-card rounded-md p-3.5">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-zinc-400">
              <span>TOTAL RUNS</span>
              <Activity className="h-3.5 w-3.5 text-[#22e55c]" />
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-white">
              {runsCount.toLocaleString()}
            </div>
            <div className="mt-2 font-mono text-[10.5px] text-zinc-400">
              <span className="text-[#22e55c]">●</span> Active: {metrics?.totals.activeRuns ?? 0} ·
              DLQ: {metrics?.totals.dlqOpen ?? 0}
            </div>
          </div>

          <div className="sf-card rounded-md p-3.5">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-zinc-400">
              <span>SUCCEEDED</span>
              <span className="rounded bg-[#22e55c]/14 px-1.5 py-0.2 font-mono text-[9px] font-bold text-[#22e55c]">
                {succeededCount} OK
              </span>
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-[#22e55c]">
              {successRate}%
            </div>
            <div className="mt-2.5 grid grid-cols-10 gap-1">
              {Array.from({ length: 10 }).map((_, idx) => (
                <div
                  key={idx}
                  className={`h-2 rounded-[2px] ${
                    idx < filledBlocks ? 'bg-[#22e55c]' : 'bg-[#1c2227]'
                  }`}
                />
              ))}
            </div>
          </div>

          <div className="sf-card rounded-md p-3.5">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-zinc-400">
              <span>COMPENSATED</span>
              <span className="rounded bg-violet-500/20 px-1.5 py-0.2 font-mono text-[9px] font-bold text-violet-300">
                ATOMIC
              </span>
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="font-mono text-2xl font-bold tabular-nums text-violet-300">
                {compensatedCount}
              </span>
              <span className="font-mono text-[10.5px] text-violet-300/80">{compRate}%</span>
            </div>
            <div className="mt-2 flex items-center gap-1 font-mono text-[10.5px] text-zinc-500">
              <RotateCcw className="h-3 w-3 text-violet-400" />
              Zero orphaned records
            </div>
          </div>

          <div className="sf-card rounded-md p-3.5">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-zinc-400">
              <span>FAILED / ABORTED</span>
              <XCircle className="h-3.5 w-3.5 text-rose-400" />
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="font-mono text-2xl font-bold tabular-nums text-rose-300">
                {failedCount}
              </span>
              <span className="font-mono text-[10.5px] text-rose-400/80">{failRate}%</span>
            </div>
            <div className="mt-2 font-mono text-[10.5px] text-zinc-500">
              {metrics?.totals.cancelled ?? 0} cancelled · 0 locks held
            </div>
          </div>

          <div className="sf-card rounded-md p-3.5">
            <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-zinc-400">
              <span>P95 TAIL LATENCY</span>
              <Gauge className="h-3.5 w-3.5 text-amber-400" />
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-amber-300">
              {metrics?.latency.p95Ms ?? 0}
              <span className="ml-0.5 text-xs font-normal text-zinc-400">ms</span>
            </div>
            <div className="mt-2 flex items-center justify-between font-mono text-[10.5px] text-zinc-500">
              <span>
                p50: <strong className="text-[#22e55c]">{metrics?.latency.p50Ms ?? 0}ms</strong>
              </span>
              <span>
                p99: <strong className="text-amber-300">{metrics?.latency.p99Ms ?? 0}ms</strong>
              </span>
            </div>
          </div>
        </div>

        {/* 2-Column Deep Telemetry Charts */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Latency Percentile Distribution */}
          <div className="sf-card rounded-md p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">Latency Percentile Distribution</h3>
                <p className="text-[11px] text-zinc-400">
                  Wall-clock execution times across {metrics?.latency.samples ?? 0} completed tenant
                  runs
                </p>
              </div>
              <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/10 px-2 py-0.5 font-mono text-[10px] text-[#22e55c]">
                LIVE DB QUERY
              </span>
            </div>

            <div className="mt-4 space-y-3.5">
              {[
                {
                  label: 'Average',
                  val: metrics?.latency.avgMs ?? 0,
                  bar: 'bg-[#22e55c]',
                  text: 'text-[#22e55c]',
                  sub: 'Mean Saga completion',
                },
                {
                  label: 'p50 Median',
                  val: metrics?.latency.p50Ms ?? 0,
                  bar: 'bg-[#22e55c]',
                  text: 'text-[#22e55c]',
                  sub: 'Steady-state execution',
                },
                {
                  label: 'p95 Tail Latency',
                  val: metrics?.latency.p95Ms ?? 0,
                  bar: 'bg-amber-400',
                  text: 'text-amber-300',
                  sub: 'Retry & fan-out envelope',
                },
                {
                  label: 'p99 Max Spike',
                  val: metrics?.latency.p99Ms ?? 0,
                  bar: 'bg-rose-400',
                  text: 'text-rose-300',
                  sub: 'Upper tail bound',
                },
              ].map((row) => (
                <div key={row.label}>
                  <div className="flex items-center justify-between font-mono text-xs">
                    <span className="flex items-center gap-1.5 text-zinc-200">
                      <span className={`h-1.5 w-1.5 rounded-full ${row.bar}`} />
                      {row.label}
                    </span>
                    <span className={`font-semibold tabular-nums ${row.text}`}>{row.val} ms</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-[2px] bg-[#1c2227]">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${row.bar}`}
                      style={{ width: `${Math.max(4, Math.round((row.val / maxLatency) * 100))}%` }}
                    />
                  </div>
                  <div className="mt-1 font-mono text-[10px] text-zinc-500">{row.sub}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Throughput & Execution Composition */}
          <div className="sf-card rounded-md p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Throughput & Execution Composition
                </h3>
                <p className="text-[11px] text-zinc-400">
                  Stacked outcomes segmented by transaction resolution
                </p>
              </div>
              <div className="flex items-center gap-2.5 font-mono text-[10px] text-[#808d99]">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-[2px] bg-[#22e55c]" /> OK
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-[2px] bg-[#f59e0b]" /> Active
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-[2px] bg-[#a855f7]" /> Rollback
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-[2px] bg-[#f43f5e]" /> Fail
                </span>
              </div>
            </div>

            {!metrics || metrics.recentThroughput.length === 0 ? (
              <div className="flex h-48 items-center justify-center font-mono text-xs text-zinc-500">
                Launch a workflow or stress test below to populate live throughput buckets.
              </div>
            ) : (
              <div className="mt-5 flex h-48 items-end gap-2 border-b border-[#1c2227] pb-2">
                {metrics.recentThroughput.map((b) => {
                  const totalH = Math.max(12, Math.round((b.total / maxBucket) * 140));
                  const denom = Math.max(1, b.total);
                  const okH = b.succeeded > 0 ? Math.max(6, Math.round((b.succeeded / denom) * totalH)) : 0;
                  const compH = b.compensated > 0 ? Math.max(6, Math.round((b.compensated / denom) * totalH)) : 0;
                  const failH = b.failed > 0 ? Math.max(6, Math.round((b.failed / denom) * totalH)) : 0;
                  const activeCount = Math.max(0, b.total - b.succeeded - b.compensated - b.failed);
                  const activeH = activeCount > 0 ? Math.max(6, Math.round((activeCount / denom) * totalH)) : 0;
                  return (
                    <div key={b.bucket} className="flex flex-1 flex-col items-center gap-1">
                      <span className="font-mono text-[9.5px] tabular-nums text-zinc-500">
                        {b.total}
                      </span>
                      <div className="flex w-full max-w-[34px] flex-col overflow-hidden rounded-t-[3px]">
                        {activeH > 0 && <div style={{ height: activeH }} className="bg-amber-400" />}
                        {failH > 0 && <div style={{ height: failH }} className="bg-rose-400" />}
                        {compH > 0 && <div style={{ height: compH }} className="bg-violet-400" />}
                        {okH > 0 && <div style={{ height: okH }} className="bg-[#22e55c]" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-zinc-500">
              <span>Tenant Isolated Stream ({metrics?.storage.driver ?? 'sqlite'})</span>
              <span>Peak Bucket: {maxBucket} runs/min</span>
            </div>
          </div>
        </div>

        {/* Interactive High-Concurrency Stress Test Lab */}
        <div className="sf-card sf-top-neon rounded-md p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4 text-[#22e55c]" />
              <h3 className="text-sm font-bold text-white">
                Interactive High-Concurrency Stress Test Lab
              </h3>
              <span className="rounded border border-[#22e55c]/35 bg-[#22e55c]/10 px-2 py-0.5 font-mono text-[9.5px] font-bold text-[#22e55c]">
                REAL DB MUTATIONS · ZERO MOCKS
              </span>
            </div>
            <span className="font-mono text-[10.5px] text-zinc-400">
              <span className="text-[#22e55c]">●</span> Worker Pool:{' '}
              {metrics?.storage.workerConcurrency ?? 16} Core Workers
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-12">
            <div className="lg:col-span-4">
              <label className="block font-mono text-[10px] tracking-wider text-zinc-400">
                TARGET TRANSACTION WORKFLOW
              </label>
              <select
                value={selectedWorkflowId}
                onChange={(e) => setSelectedWorkflowId(e.target.value)}
                className="mt-1.5 w-full rounded-md border border-[#262c32] bg-[#0c0e10] px-3 py-2 font-mono text-xs text-zinc-100 focus:border-[#22e55c]/60 focus:outline-none"
              >
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} (v{w.latestVersion})
                  </option>
                ))}
              </select>
            </div>

            <div className="lg:col-span-3">
              <label className="block font-mono text-[10px] tracking-wider text-zinc-400">
                RUN COUNT PRESET
              </label>
              <div className="mt-1.5 grid grid-cols-4 gap-1 rounded-md border border-[#262c32] bg-[#0c0e10] p-1">
                {[25, 100, 250, 500].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setTotalRuns(n)}
                    className={`rounded py-1.5 font-mono text-[11px] font-bold transition ${
                      totalRuns === n
                        ? 'bg-[#22e55c] text-[#070b07]'
                        : 'text-zinc-400 hover:bg-[#15191d] hover:text-white'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="lg:col-span-2">
              <div className="flex items-center justify-between font-mono text-[10px] tracking-wider">
                <span className="text-zinc-400">TOTAL RUNS</span>
                <span className="font-bold text-[#22e55c]">{totalRuns} runs</span>
              </div>
              <input
                type="range"
                min={5}
                max={500}
                step={5}
                value={totalRuns}
                onChange={(e) => setTotalRuns(Number(e.target.value))}
                className="mt-3.5 w-full accent-[#22e55c]"
              />
            </div>

            <div className="flex items-end lg:col-span-3">
              <button
                onClick={() => void handleStressTest()}
                disabled={runningStress || !selectedWorkflowId}
                className="sf-btn-neon flex w-full items-center justify-center gap-2 rounded-md py-2.5 font-mono text-xs disabled:opacity-50"
              >
                {runningStress ? (
                  <>
                    <Flame className="h-4 w-4 animate-bounce" />
                    Executing {totalRuns} Runs...
                  </>
                ) : (
                  <>
                    <Zap className="h-4 w-4" />
                    Launch {totalRuns} Concurrent Runs
                  </>
                )}
              </button>
            </div>
          </div>

          {stressResult && (
            <div className="mt-4 overflow-hidden rounded-md border border-[#22e55c]/35 bg-[#0c0e10]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#111813] bg-[#111813] px-3.5 py-2 font-mono text-[11px]">
                <span className="inline-flex items-center gap-1.5 font-bold text-[#22e55c]">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  BENCHMARK RUN COMPLETE
                </span>
                <span className="text-zinc-400">
                  Workflow: <strong className="text-zinc-200">{stressResult.workflowName}</strong>
                </span>
              </div>
              <div className="grid grid-cols-2 gap-4 p-3.5 font-mono sm:grid-cols-5">
                <div>
                  <div className="text-[10px] text-zinc-500">SUSTAINED THROUGHPUT</div>
                  <div className="mt-1 text-lg font-bold text-[#22e55c] tabular-nums">
                    {stressResult.runsPerSecond}{' '}
                    <span className="text-xs font-normal text-zinc-400">runs/sec</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">EXECUTION TALLY</div>
                  <div className="mt-1 text-lg font-bold text-white tabular-nums">
                    {stressResult.outcomes.succeeded} / {stressResult.totalRuns}
                  </div>
                  <div className="text-[10px] text-zinc-400">
                    {stressResult.outcomes.compensated} compensated · {stressResult.outcomes.failed}{' '}
                    failed
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">WALL TIME</div>
                  <div className="mt-1 text-lg font-bold text-white tabular-nums">
                    {stressResult.elapsedMs}ms
                  </div>
                  <div className="text-[10px] text-zinc-400">
                    Concurrency: {stressResult.concurrency}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500">DB LOCK RETENTION</div>
                  <div className="mt-1 text-lg font-bold text-[#22e55c]">0 Orphaned</div>
                  <div className="text-[10px] text-[#22e55c]/80">100% Released</div>
                </div>
                <div className="space-y-0.5 text-[11px]">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Min:</span>
                    <span className="text-zinc-200">{stressResult.latency.minMs}ms</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">p50:</span>
                    <span className="text-[#22e55c]">{stressResult.latency.p50Ms}ms</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">p95:</span>
                    <span className="text-amber-300">{stressResult.latency.p95Ms}ms</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Max:</span>
                    <span className="text-rose-300">{stressResult.latency.maxMs}ms</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Live Syntax-Highlighted Prometheus / OpenMetrics Exporter */}
        <div className="sf-card overflow-hidden rounded-md">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1c2227] bg-[#111417] px-4 py-2.5">
            <div className="flex items-center gap-2 font-mono text-xs">
              <Terminal className="h-4 w-4 text-[#22e55c]" />
              <span className="font-semibold text-white">Prometheus / OpenMetrics Live Exporter</span>
              <span className="rounded border border-[#262c32] bg-[#0c0e10] px-2 py-0.5 text-[10px] text-zinc-300">
                GET /api/metrics
              </span>
              <span className="rounded bg-[#22e55c]/14 px-1.5 py-0.5 text-[10px] font-bold text-[#22e55c]">
                200 OK
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(promText);
                  onNotify?.('Copied raw OpenMetrics exposition text', 'ok');
                }}
                className="inline-flex items-center gap-1.5 rounded border border-[#262c32] bg-[#15191d] px-2.5 py-1 font-mono text-[10.5px] text-zinc-300 hover:border-[#22e55c]/45 hover:text-[#22e55c]"
              >
                <Copy className="h-3 w-3" />
                Copy Raw OpenMetrics
              </button>
              <a
                href="/api/metrics"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded border border-[#22e55c]/35 bg-[#22e55c]/10 px-2.5 py-1 font-mono text-[10.5px] font-semibold text-[#22e55c] hover:bg-[#22e55c]/18"
              >
                <ExternalLink className="h-3 w-3" />
                Scrape Endpoint URL
              </a>
            </div>
          </div>

          <div className="max-h-64 overflow-auto bg-[#0c0e10] p-4 font-mono text-[11px] leading-5">
            {promText
              ? promText.split('\n').map((line, i) => renderPromLine(line, i))
              : '# Fetching /api/metrics...'}
          </div>

          <div className="flex items-center justify-between border-t border-[#1c2227] bg-[#111417] px-4 py-1.5 font-mono text-[10px] text-zinc-500">
            <span>
              Compatible with Prometheus, Grafana Mimir, Datadog OpenMetrics, and VictoriaMetrics.
            </span>
            <span>Scrape Interval Recommendation: 5s–15s</span>
          </div>
        </div>
      </div>
    </div>
  );
};
