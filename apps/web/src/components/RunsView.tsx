import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  MarkerType,
  BackgroundVariant,
} from '@xyflow/react';
import {
  Activity,
  Ban,
  ChevronDown,
  ChevronRight,
  Clock,
  RefreshCw,
  RotateCcw,
  Radio,
  Terminal,
  GitGraph,
  AlignLeft,
  ShieldAlert,
  ArrowRight,
  Download,
  Code2,
  CheckCircle2,
  XCircle,
  Sparkles,
  ExternalLink,
  X,
  History,
  FastForward,
} from 'lucide-react';
import type {
  RunDetail,
  RunDiagnosisResponse,
  RunEvent,
  RunStep,
  RunSummary,
  WorkflowDefinition,
} from '@sagaflow/shared';
import { isTerminalRunStatus } from '@sagaflow/shared';
import { api, openRunEventStream, type TenantSession } from '../lib/api';
import { SagaNode, type SagaNodeData } from './SagaNode';
import { StatusBadge } from './StatusBadge';

interface RunsViewProps {
  session: TenantSession;
  initialRunId?: string | null;
  onOpenApprovals?: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'err' | 'info') => void;
}

const nodeTypes = { saga: SagaNode };

function getStepDurationMs(step?: RunStep): number | undefined {
  if (!step || step.attempts.length === 0) return undefined;
  let total = 0;
  let has = false;
  for (const a of step.attempts) {
    if (typeof a.durationMs === 'number') {
      total += a.durationMs;
      has = true;
    }
  }
  return has ? total : undefined;
}

function getStepErrorMessage(step?: RunStep): string | null {
  if (!step) return null;
  for (let i = step.attempts.length - 1; i >= 0; i--) {
    if (step.attempts[i]?.error?.message) {
      return step.attempts[i]!.error!.message;
    }
  }
  return null;
}

function buildRunGraph(
  run: RunDetail,
  workflow: WorkflowDefinition | null
): { nodes: Node[]; edges: Edge[] } {
  const stepById = new Map(run.steps.map((s) => [s.nodeId, s]));
  const wfNodes =
    workflow?.nodes ??
    run.steps.map((s, idx) => ({
      id: s.nodeId,
      type: s.kind,
      label: s.label,
      config: {} as Record<string, unknown>,
      position: { x: 80 + idx * 300, y: 120 },
    }));

  const nodes: Node[] = wfNodes.map((n, idx) => {
    const step = stepById.get(n.id);
    const cfg = (n.config ?? {}) as Record<string, unknown>;
    const data: SagaNodeData = {
      label: n.label ?? n.id,
      stepType: n.type,
      config: cfg,
      status: step?.status ?? 'pending',
      attempts: step?.attempts.length ?? 0,
      durationMs: getStepDurationMs(step),
      compensationHandler:
        typeof cfg.compensationHandler === 'string' ? cfg.compensationHandler : undefined,
    };
    return {
      id: n.id,
      type: 'saga',
      position: n.position ?? { x: 80 + idx * 300, y: 120 },
      data,
      draggable: false,
      selectable: true,
    };
  });

  const edges: Edge[] = (workflow?.edges ?? []).map((e) => {
    const fromStep = stepById.get(e.from);
    const toStep = stepById.get(e.to);
    const branchLabel = e.condition === 'true' || e.condition === 'false' ? e.condition : e.label;
    let stroke = '#2f373f';
    let animated = false;
    if (toStep?.status === 'running' || fromStep?.status === 'running') {
      stroke = '#22e55c';
      animated = true;
    } else if (toStep?.status === 'waiting_approval') {
      stroke = '#f59e0b';
      animated = true;
    } else if (toStep?.status === 'compensated' || fromStep?.status === 'compensated') {
      stroke = '#a855f7';
    } else if (fromStep?.status === 'succeeded' && toStep?.status !== 'skipped') {
      stroke = '#22e55c';
    }
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      sourceHandle: e.condition === 'true' || e.condition === 'false' ? e.condition : undefined,
      label: branchLabel,
      animated,
      style: { stroke, strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      labelStyle: { fill: '#c7d1db', fontSize: 10, fontWeight: 700, fontFamily: 'monospace' },
      labelBgStyle: { fill: '#0c0e10', fillOpacity: 0.92 },
    };
  });

  return { nodes, edges };
}

export const RunsView: React.FC<RunsViewProps> = ({
  session,
  initialRunId,
  onOpenApprovals,
  onNotify,
}) => {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [activeRunId, setActiveRunId] = useState<string | null>(initialRunId ?? null);
  const [activeRun, setActiveRun] = useState<RunDetail | null>(null);
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowDefinition | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});
  const [diagnosis, setDiagnosis] = useState<RunDiagnosisResponse | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);

  // v6.0 Time-Travel Checkpoint Replay modal state
  const [resumeTargetStep, setResumeTargetStep] = useState<{
    nodeId: string;
    label: string;
  } | null>(null);
  const [resumeOverridesText, setResumeOverridesText] = useState('{\n  "simulateFailure": false\n}');
  const [resumingFromStep, setResumingFromStep] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const [viewMode, setViewMode] = useState<'dag' | 'waterfall'>('dag');
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<Node>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const stepRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const loadRuns = useCallback(async () => {
    try {
      const res = await api.listRuns(session, { limit: 60 });
      setRuns(res.runs);
      setActiveRunId((current) => {
        if (current && res.runs.some((r) => r.id === current)) return current;
        return res.runs[0]?.id ?? null;
      });
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to list runs', 'err');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.tenantId, session.apiKey, session.token]);

  useEffect(() => {
    void loadRuns();
    const timer = setInterval(() => void loadRuns(), 3500);
    return () => clearInterval(timer);
  }, [loadRuns]);

  useEffect(() => {
    if (initialRunId) setActiveRunId(initialRunId);
  }, [initialRunId]);

  useEffect(() => {
    if (!activeRunId) {
      setActiveRun(null);
      setActiveWorkflow(null);
      setEvents([]);
      return;
    }

    let cancelled = false;
    setStreamConnected(false);

    void (async () => {
      try {
        const res = await api.getRun(session, activeRunId);
        if (cancelled) return;
        setActiveRun(res.run);
        setEvents(res.events);
        const wfRes = await api.getWorkflow(session, res.run.workflowId);
        if (!cancelled) setActiveWorkflow(wfRes.workflow);
      } catch {
        // ignore if tenant switched
      }
    })();

    const closeStream = openRunEventStream({
      session,
      runId: activeRunId,
      onSnapshot: (run) => {
        if (cancelled) return;
        setStreamConnected(true);
        setActiveRun(run);
      },
      onEvent: (evt) => {
        if (cancelled) return;
        setStreamConnected(true);
        setEvents((prev) => (prev.some((e) => e.offset === evt.offset) ? prev : [...prev, evt]));
        void api
          .getRun(session, activeRunId)
          .then((res) => {
            if (!cancelled) setActiveRun(res.run);
          })
          .catch(() => {});
      },
      onStatusChange: (connected) => {
        if (!cancelled) setStreamConnected(connected);
      },
    });

    return () => {
      cancelled = true;
      closeStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, session.tenantId, session.apiKey, session.token]);

  useEffect(() => {
    if (!activeRun) {
      setRfNodes([]);
      setRfEdges([]);
      return;
    }
    const g = buildRunGraph(activeRun, activeWorkflow);
    setRfNodes(g.nodes);
    setRfEdges(g.edges);
  }, [activeRun, activeWorkflow, setRfNodes, setRfEdges]);

  const counts = useMemo(() => {
    const c = {
      all: runs.length,
      running: 0,
      waiting_approval: 0,
      succeeded: 0,
      compensated: 0,
      failed: 0,
    };
    for (const r of runs) {
      if (r.status === 'running' || r.status === 'pending') c.running++;
      else if (r.status === 'waiting_approval') c.waiting_approval++;
      else if (r.status === 'succeeded') c.succeeded++;
      else if (r.status === 'compensated' || r.status === 'compensating') c.compensated++;
      else if (r.status === 'failed' || r.status === 'cancelled') c.failed++;
    }
    return c;
  }, [runs]);

  const filteredRuns = useMemo(() => {
    if (statusFilter === 'all') return runs;
    if (statusFilter === 'running')
      return runs.filter((r) => r.status === 'running' || r.status === 'pending');
    if (statusFilter === 'compensated')
      return runs.filter((r) => r.status === 'compensated' || r.status === 'compensating');
    if (statusFilter === 'failed')
      return runs.filter((r) => r.status === 'failed' || r.status === 'cancelled');
    return runs.filter((r) => r.status === statusFilter);
  }, [runs, statusFilter]);

  const handleCancel = async () => {
    if (!activeRun) return;
    try {
      await api.cancelRun(session, activeRun.id);
      const updated = await api.getRun(session, activeRun.id);
      setActiveRun(updated.run);
      onNotify(`Cancellation requested for ${activeRun.id}`, 'info');
      await loadRuns();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to cancel run', 'err');
    }
  };

  const handleRerun = async () => {
    if (!activeRun) return;
    try {
      const res = await api.startRun(
        session,
        activeRun.workflowId,
        activeRun.input,
        `rerun_${Date.now()}`
      );
      setActiveRunId(res.run.id);
      onNotify(`Launched fresh run ${res.run.id}`, 'ok');
      await loadRuns();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to re-run workflow', 'err');
    }
  };

  const exportJsonLines = () => {
    const jsonl = events.map((e) => JSON.stringify(e)).join('\n');
    const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sagaflow-events-${activeRun?.id ?? 'stream'}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
    onNotify(`Exported ${events.length} SSE events as JSONL`, 'ok');
  };

  const jumpToStep = (nodeId: string) => {
    setExpandedSteps((prev) => ({ ...prev, [nodeId]: true }));
    setTimeout(() => {
      stepRefs.current[nodeId]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  };

  const runSpan = useMemo(() => {
    if (!activeRun) return { startMs: 0, totalMs: 1 };
    const startMs = new Date(activeRun.startedAt ?? activeRun.createdAt).getTime();
    const endMs = activeRun.finishedAt ? new Date(activeRun.finishedAt).getTime() : Date.now();
    return { startMs, totalMs: Math.max(10, endMs - startMs) };
  }, [activeRun]);

  const executedCount = activeRun
    ? activeRun.steps.filter((s) => s.status !== 'pending').length
    : 0;

  const handleDiagnoseRun = async () => {
    if (!activeRun) return;
    setDiagnosing(true);
    try {
      const { diagnosis: d } = await api.diagnoseRun(session, activeRun.id);
      setDiagnosis(d);
      onNotify(
        d.source === 'llm'
          ? `AI diagnosis completed via ${d.model}`
          : 'Deterministic Saga forensics completed',
        'ok'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Run diagnosis failed', 'err');
    } finally {
      setDiagnosing(false);
    }
  };

  const handleResumeFromStep = async () => {
    if (!activeRun || !resumeTargetStep) return;
    setResumingFromStep(true);
    try {
      const inputOverrides = resumeOverridesText.trim()
        ? (JSON.parse(resumeOverridesText) as Record<string, unknown>)
        : undefined;
      const res = await api.resumeRunFromStep(session, activeRun.id, resumeTargetStep.nodeId, {
        inputOverrides,
      });
      setResumeTargetStep(null);
      setActiveRunId(res.run.id);
      await loadRuns();
      onNotify(
        `Time-Travel Fork launched (${res.reusedSteps.length} upstream step(s) reused, resuming at "${resumeTargetStep.label}")`,
        'ok'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Time-travel resume failed', 'err');
    } finally {
      setResumingFromStep(false);
    }
  };

  return (
    <div className="flex h-full w-full overflow-hidden bg-[#0c0e10]">
      {/* LEFT EXECUTION MONITOR SIDEBAR */}
      <aside className="flex w-[268px] shrink-0 flex-col border-r border-[#1c2227] bg-[#111417]">
        <div className="border-b border-[#1c2227] p-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] font-bold tracking-[0.12em] text-zinc-400">
              RUNS MONITOR
            </span>
            <button
              onClick={() => void loadRuns()}
              className="rounded p-1 text-zinc-400 hover:bg-[#1c2227] hover:text-[#22e55c]"
              title="Refresh runs"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-2.5 flex flex-wrap gap-1">
            {[
              { id: 'all', label: `ALL (${counts.all})`, active: 'bg-zinc-200 text-[#0c0e10]', idle: 'border-[#262c32] bg-[#15191d] text-zinc-300' },
              { id: 'running', label: `● RUN (${counts.running})`, active: 'bg-[#22e55c] text-[#070b07]', idle: 'border-[#22e55c]/30 bg-[#22e55c]/8 text-[#22e55c]' },
              { id: 'waiting_approval', label: `APPROVAL (${counts.waiting_approval})`, active: 'bg-amber-400 text-[#0c0e10]', idle: 'border-amber-400/35 bg-amber-500/12 text-amber-300' },
              { id: 'succeeded', label: `OK (${counts.succeeded})`, active: 'bg-[#22e55c] text-[#070b07]', idle: 'border-[#22e55c]/30 bg-[#22e55c]/10 text-[#73ff86]' },
              { id: 'compensated', label: `COMP (${counts.compensated})`, active: 'bg-violet-400 text-[#0c0e10]', idle: 'border-violet-400/35 bg-violet-500/12 text-violet-300' },
              { id: 'failed', label: `FAIL (${counts.failed})`, active: 'bg-rose-500 text-white', idle: 'border-rose-500/35 bg-rose-500/12 text-rose-300' },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setStatusFilter(f.id)}
                className={`rounded border px-1.5 py-0.5 font-mono text-[9.5px] font-bold transition ${
                  statusFilter === f.id ? `border-transparent ${f.active}` : f.idle
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 space-y-1.5 overflow-y-auto p-2.5">
          {filteredRuns.length === 0 ? (
            <div className="py-12 text-center font-mono text-xs text-zinc-500">
              No runs match this filter.
            </div>
          ) : (
            filteredRuns.map((r) => {
              const selected = r.id === activeRunId;
              return (
                <button
                  key={r.id}
                  onClick={() => setActiveRunId(r.id)}
                  className={`w-full rounded-md border px-2.5 py-2.5 text-left transition ${
                    selected
                      ? 'border-[#2f373f] bg-[#15191d] shadow-[inset_2px_0_0_#22e55c]'
                      : 'border-[#1c2227] bg-[#111417] hover:border-[#2f373f]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate font-mono text-[11.5px] font-semibold text-white">
                      {r.workflowName ?? r.workflowId}
                    </span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-zinc-500">
                    <span className="truncate">{r.id}</span>
                    <span className="shrink-0 tabular-nums text-zinc-400">
                      {r.durationMs !== undefined && r.durationMs !== null ? `${r.durationMs}ms` : 'live'}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* MAIN LIVE RUN INSPECTOR */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!activeRun ? (
          <div className="flex flex-1 flex-col items-center justify-center text-zinc-500">
            <Activity className="h-9 w-9 text-[#22e55c]" />
            <p className="mt-3 text-sm font-medium text-zinc-300">Select a run to inspect live telemetry</p>
            <p className="mt-1 font-mono text-xs text-zinc-500">
              Launch any workflow from Studio or the AI Agent to watch real-time DAG execution.
            </p>
          </div>
        ) : (
          <>
            {/* Clean Non-Overlapping Telemetry Header */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1c2227] bg-[#111417] px-4 py-2.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-sm font-bold text-white">
                    {activeRun.workflowName ?? activeRun.workflowId}
                  </h2>
                  <StatusBadge status={activeRun.status} />
                  <span className="rounded border border-[#262c32] bg-[#0c0e10] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                    v{activeRun.versionNumber}
                  </span>
                  {typeof activeRun.input?._forkedFromRunId === 'string' && (
                    <span className="inline-flex items-center gap-1 rounded border border-[#a855f7]/40 bg-[#a855f7]/12 px-2 py-0.5 font-mono text-[9.5px] font-bold text-[#c084fc]">
                      <History className="h-3 w-3" />
                      TIME-TRAVEL FORK ({String(activeRun.input._resumedFromNodeId ?? 'checkpoint')})
                    </span>
                  )}
                  {streamConnected && (
                    <span className="inline-flex items-center gap-1 rounded border border-[#22e55c]/35 bg-[#22e55c]/10 px-2 py-0.5 font-mono text-[9.5px] font-bold text-[#22e55c]">
                      <Radio className="h-3 w-3 animate-pulse" />
                      SSE #{events.length}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[10.5px] text-zinc-500">
                  <span>
                    Run: <strong className="text-zinc-300">{activeRun.id}</strong>
                  </span>
                  {activeRun.idempotencyKey && (
                    <span>
                      Idempotency: <strong className="text-zinc-300">{activeRun.idempotencyKey}</strong>
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 text-[#22e55c]">
                    <Clock className="h-3 w-3" />
                    {activeRun.durationMs !== undefined && activeRun.durationMs !== null
                      ? `${activeRun.durationMs}ms`
                      : 'active...'}
                  </span>
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <div className="flex items-center rounded-md border border-[#262c32] bg-[#0c0e10] p-0.5">
                  <button
                    onClick={() => setViewMode('dag')}
                    className={`flex items-center gap-1 rounded px-2.5 py-1 font-mono text-[11px] font-medium transition ${
                      viewMode === 'dag'
                        ? 'bg-[#1c2227] text-[#22e55c]'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <GitGraph className="h-3.5 w-3.5" />
                    Live DAG
                  </button>
                  <button
                    onClick={() => setViewMode('waterfall')}
                    className={`flex items-center gap-1 rounded px-2.5 py-1 font-mono text-[11px] font-medium transition ${
                      viewMode === 'waterfall'
                        ? 'bg-[#1c2227] text-[#22e55c]'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    <AlignLeft className="h-3.5 w-3.5" />
                    Waterfall
                  </button>
                </div>

                {!isTerminalRunStatus(activeRun.status) && (
                  <button
                    onClick={() => void handleCancel()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/45 bg-rose-500/12 px-3 py-1.5 font-mono text-[11px] font-semibold text-rose-200 hover:bg-rose-500/22"
                  >
                    <Ban className="h-3.5 w-3.5" />
                    Cancel Run
                  </button>
                )}
                {(() => {
                  const failedStep = activeRun.steps.find((s) => s.status === 'failed');
                  if (!failedStep) return null;
                  return (
                    <button
                      onClick={() => {
                        setResumeTargetStep({
                          nodeId: failedStep.nodeId,
                          label: failedStep.label,
                        });
                        setResumeOverridesText('{\n  "simulateFailure": false\n}');
                      }}
                      className="inline-flex items-center gap-1.5 rounded border border-[#f59e0b]/45 bg-[#f59e0b]/[0.12] px-3 py-1.5 font-mono text-[11px] font-semibold text-[#fbbf24] hover:bg-[#f59e0b]/20"
                      title="Fork run & resume directly from the failed step without re-running succeeded upstream steps"
                    >
                      <FastForward className="h-3.5 w-3.5" />
                      Resume Failed Step
                    </button>
                  );
                })()}
                <button
                  onClick={() => void handleDiagnoseRun()}
                  disabled={diagnosing}
                  className="sf-btn-compensate inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] disabled:opacity-50"
                  title="Run AI or Deterministic Root-Cause Forensics"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {diagnosing ? 'Diagnosing...' : 'AI Diagnose'}
                </button>
                <button
                  onClick={() => void handleRerun()}
                  className="sf-btn-neon inline-flex items-center gap-1.5 rounded px-3.5 py-1.5 font-mono text-[11px]"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Re-run Payload
                </button>
              </div>
            </div>

            {diagnosis && diagnosis.runId === activeRun.id && (
              <div className="border-b border-[#a855f7]/35 bg-[#15191d] px-4 py-3 text-xs">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
                      <span className="rounded border border-[#a855f7]/35 bg-[#a855f7]/[0.12] px-1.5 py-0.5 font-bold uppercase text-[#c084fc]">
                        {diagnosis.source === 'llm'
                          ? `AI FORENSICS · ${diagnosis.model ?? diagnosis.provider}`
                          : 'DETERMINISTIC ENGINE FORENSICS'}
                      </span>
                      <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/[0.08] px-1.5 py-0.5 font-semibold text-[#22e55c]">
                        {diagnosis.rollbackIntegrity.verifiedClean
                          ? '✓ ROLLBACK INTEGRITY VERIFIED'
                          : 'CHECK STATE'}
                      </span>
                      <span className="text-[#808d99]">{diagnosis.latencyMs}ms</span>
                    </div>
                    <div className="font-semibold text-[#f1f5f9]">{diagnosis.headline}</div>
                    <p className="text-[11.5px] text-[#c7d1db]">{diagnosis.rootCause}</p>
                    <p className="font-mono text-[10.5px] text-[#808d99]">
                      {diagnosis.rollbackIntegrity.summary}
                    </p>
                  </div>
                  <button
                    onClick={() => setDiagnosis(null)}
                    className="rounded p-1 text-[#808d99] hover:bg-[#1c2227] hover:text-[#f1f5f9]"
                    title="Dismiss diagnosis"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {diagnosis.recommendations.length > 0 && (
                  <div className="mt-2.5 grid grid-cols-1 gap-2 md:grid-cols-2">
                    {diagnosis.recommendations.map((rec, i) => (
                      <div
                        key={i}
                        className="rounded border border-[#262c32] bg-[#111417] px-2.5 py-2"
                      >
                        <div className="font-mono text-[10.5px] font-semibold text-[#22e55c]">
                          {i + 1}. {rec.title}
                        </div>
                        <div className="mt-0.5 text-[11px] text-[#808d99]">{rec.detail}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeRun.status === 'waiting_approval' && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/35 bg-amber-500/[0.09] px-4 py-2 font-mono text-[11px] text-amber-200">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400" />
                  <span>
                    <strong className="text-amber-300">Parked at Durable Approval Gate:</strong> Zero
                    worker threads held. Approve to resume, or Reject to trigger atomic DB rollback.
                  </span>
                </div>
                {onOpenApprovals && (
                  <button
                    onClick={onOpenApprovals}
                    className="inline-flex items-center gap-1 rounded bg-amber-400 px-2.5 py-1 text-[10.5px] font-bold text-[#0c0e10] hover:bg-amber-300"
                  >
                    Open Approval Gate
                    <ArrowRight className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}

            {/* Top Pane: Live DAG OR Waterfall Timeline */}
            <div className="h-[44%] min-h-[220px] border-b border-[#1c2227] bg-[#0c0e10]">
              {viewMode === 'dag' ? (
                <ReactFlow
                  nodes={rfNodes}
                  edges={rfEdges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  nodeTypes={nodeTypes}
                  onNodeClick={(_, node) => jumpToStep(node.id)}
                  fitView
                  fitViewOptions={{ padding: 0.25 }}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable
                  proOptions={{ hideAttribution: true }}
                >
                  <Background variant={BackgroundVariant.Dots} gap={22} size={1.1} color="#1c2227" />
                  <Controls showInteractive={false} />
                </ReactFlow>
              ) : (
                <div className="h-full overflow-y-auto p-4">
                  <div className="mb-3 flex items-center justify-between font-mono text-[10.5px] text-zinc-400">
                    <span>EXECUTION WATERFALL TIMELINE (CLICK ANY BAR TO INSPECT TRACE)</span>
                    <span className="text-[#22e55c]">TOTAL SPAN: {runSpan.totalMs}ms</span>
                  </div>
                  <div className="space-y-2">
                    {activeRun.steps.map((step) => {
                      const firstAttempt = step.attempts[0];
                      const st = firstAttempt?.startedAt
                        ? new Date(firstAttempt.startedAt).getTime() - runSpan.startMs
                        : 0;
                      const dur = Math.max(1, getStepDurationMs(step) ?? 8);
                      const leftPct = Math.min(95, Math.max(0, (st / runSpan.totalMs) * 100));
                      const widthPct = Math.max(
                        3,
                        Math.min(100 - leftPct, (dur / runSpan.totalMs) * 100)
                      );
                      const barClass =
                        step.status === 'compensated'
                          ? 'bg-violet-400'
                          : step.status === 'failed'
                            ? 'bg-rose-500'
                            : step.status === 'waiting_approval'
                              ? 'bg-amber-400 animate-pulse'
                              : step.status === 'running'
                                ? 'bg-[#22e55c] animate-pulse'
                                : step.status === 'skipped'
                                  ? 'bg-zinc-700'
                                  : 'bg-[#22e55c]';
                      return (
                        <button
                          key={step.nodeId}
                          onClick={() => jumpToStep(step.nodeId)}
                          className="grid w-full grid-cols-12 items-center gap-3 rounded px-2 py-1.5 text-left hover:bg-[#15191d]"
                        >
                          <div className="col-span-3 truncate font-mono text-xs text-zinc-200">
                            {step.label}
                          </div>
                          <div className="col-span-7 h-5 rounded border border-[#1c2227] bg-[#111417] p-0.5">
                            <div
                              className={`h-full rounded-[2px] ${barClass}`}
                              style={{ marginLeft: `${leftPct}%`, width: `${widthPct}%` }}
                            />
                          </div>
                          <div className="col-span-2 flex items-center justify-end gap-2 font-mono text-[11px] text-zinc-400">
                            <span className="tabular-nums">{getStepDurationMs(step) ?? 0}ms</span>
                            <StatusBadge status={step.status} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Bottom Split Terminal: Step Execution Traces (Left) + Durable SSE Event Stream (Right) */}
            <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-[#1c2227] lg:grid-cols-2 lg:divide-x lg:divide-y-0">
              {/* LEFT: STEP EXECUTION TRACES */}
              <div className="flex min-h-0 flex-col bg-[#0c0e10]">
                <div className="flex shrink-0 items-center justify-between border-b border-[#1c2227] bg-[#111417] px-4 py-2 font-mono text-[10.5px]">
                  <span className="inline-flex items-center gap-1.5 font-bold tracking-wider text-zinc-300">
                    <Code2 className="h-3.5 w-3.5 text-[#22e55c]" />
                    STEP EXECUTION TRACES
                  </span>
                  <span className="text-zinc-500">
                    {executedCount} of {activeRun.steps.length} executed
                  </span>
                </div>

                <div className="flex-1 space-y-2 overflow-y-auto p-3">
                  {activeRun.steps.map((step, idx) => {
                    const isOpen = !!expandedSteps[step.nodeId];
                    const stepDur = getStepDurationMs(step);
                    const stepErr = getStepErrorMessage(step);
                    return (
                      <div
                        key={step.nodeId}
                        ref={(el) => {
                          stepRefs.current[step.nodeId] = el;
                        }}
                        className="overflow-hidden rounded-md border border-[#1c2227] bg-[#111417]"
                      >
                        <button
                          onClick={() =>
                            setExpandedSteps((prev) => ({
                              ...prev,
                              [step.nodeId]: !prev[step.nodeId],
                            }))
                          }
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[#181d22]"
                        >
                          <div className="flex min-w-0 items-center gap-2 font-mono text-xs">
                            {step.status === 'succeeded' ? (
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#22e55c]" />
                            ) : step.status === 'failed' ? (
                              <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                            ) : step.status === 'compensated' ? (
                              <RotateCcw className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                            ) : isOpen ? (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                            )}
                            <span className="truncate font-semibold text-white">
                              {idx + 1}. {step.label}
                            </span>
                            <span className="rounded border border-[#262c32] bg-[#0c0e10] px-1.5 py-0.2 text-[9.5px] uppercase text-zinc-400">
                              {step.kind}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-2 font-mono text-[10.5px]">
                            {stepDur !== undefined && (
                              <span className="tabular-nums text-zinc-400">{stepDur}ms</span>
                            )}
                            <StatusBadge status={step.status} />
                          </div>
                        </button>

                        {isOpen && (
                          <div className="space-y-2.5 border-t border-[#1c2227] bg-[#0c0e10] p-3 font-mono text-[11px]">
                            {stepErr && (
                              <div className="rounded border border-rose-500/40 bg-rose-500/10 p-2 text-rose-300">
                                {stepErr}
                              </div>
                            )}

                            {step.output !== undefined && (
                              <div>
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <span className="text-[9.5px] uppercase tracking-wider text-zinc-500">
                                    OUTPUT PAYLOAD
                                  </span>
                                  {step.kind === 'sub_workflow' &&
                                    typeof (step.output as Record<string, unknown>)?.childRunId ===
                                      'string' && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const cid = String(
                                            (step.output as Record<string, unknown>).childRunId
                                          );
                                          setActiveRunId(cid);
                                          void loadRuns();
                                          onNotify(`Switched to nested child run ${cid}`, 'info');
                                        }}
                                        className="inline-flex items-center gap-1 rounded border border-[#a855f7]/40 bg-[#a855f7]/[0.12] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#c084fc] hover:bg-[#a855f7]/20"
                                      >
                                        Open Child Run (
                                        {String(
                                          (step.output as Record<string, unknown>).childRunId
                                        )}
                                        )
                                        <ExternalLink className="h-2.5 w-2.5" />
                                      </button>
                                    )}
                                </div>
                                <pre className="max-h-44 overflow-auto rounded border border-[#1c2227] bg-[#0c0e10] p-2.5 text-[10.5px] text-[#73ff86]">
                                  {JSON.stringify(step.output, null, 2)}
                                </pre>
                              </div>
                            )}

                            {step.attempts.length > 0 && (
                              <div className="space-y-1.5">
                                <div className="flex items-center justify-between">
                                  <span className="text-[9.5px] uppercase tracking-wider text-zinc-500">
                                    ATTEMPT LOG ({step.attempts.length})
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setResumeTargetStep({
                                        nodeId: step.nodeId,
                                        label: step.label,
                                      });
                                      setResumeOverridesText('{\n  "simulateFailure": false\n}');
                                    }}
                                    className="inline-flex items-center gap-1 rounded border border-[#f59e0b]/35 bg-[#f59e0b]/[0.10] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#fbbf24] hover:bg-[#f59e0b]/20"
                                  >
                                    <FastForward className="h-2.5 w-2.5" />
                                    Time-Travel Resume Here
                                  </button>
                                </div>
                                {step.attempts.map((a) => (
                                  <div
                                    key={`${a.kind}_${a.attempt}`}
                                    className="rounded border border-[#1c2227] bg-[#111417] p-2 text-[10.5px]"
                                  >
                                    <div className="flex items-center justify-between">
                                      <span
                                        className={
                                          a.kind === 'compensate'
                                            ? 'font-semibold text-violet-300'
                                            : 'font-semibold text-zinc-200'
                                        }
                                      >
                                        {a.kind === 'compensate'
                                          ? `↺ Compensation #${a.attempt}`
                                          : `Attempt #${a.attempt}`}
                                      </span>
                                      <div className="flex items-center gap-2">
                                        {a.durationMs !== null && a.durationMs !== undefined && (
                                          <span className="text-zinc-500">{a.durationMs}ms</span>
                                        )}
                                        <StatusBadge status={a.status} />
                                      </div>
                                    </div>
                                    {a.error && (
                                      <div className="mt-1 text-rose-300">
                                        [{a.error.code}] {a.error.message}
                                      </div>
                                    )}
                                    {a.logs && a.logs.length > 0 && (
                                      <div className="mt-1 text-zinc-400">
                                        {a.logs.map((l, li) => (
                                          <div key={li}>› {l}</div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* RIGHT: DURABLE EVENT SSE STREAM TERMINAL */}
              <div className="flex min-h-0 flex-col bg-[#0c0e10]">
                <div className="flex shrink-0 items-center justify-between border-b border-[#1c2227] bg-[#111417] px-4 py-2 font-mono text-[10.5px]">
                  <span className="inline-flex items-center gap-1.5 font-bold tracking-wider text-zinc-300">
                    <Terminal className="h-3.5 w-3.5 text-[#22e55c]" />
                    DURABLE EVENT SSE STREAM
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        streamConnected ? 'bg-[#22e55c]' : 'bg-zinc-600'
                      }`}
                    />
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/10 px-1.5 py-0.2 text-[9.5px] font-bold text-[#22e55c]">
                      OFFSET #{events.length}
                    </span>
                    <button
                      onClick={() => setEvents([])}
                      className="text-[10px] text-zinc-500 hover:text-zinc-200"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="flex-1 space-y-1 overflow-y-auto p-3 font-mono text-[11px]">
                  {events.map((evt) => {
                    const isApprovalEvt = evt.type.includes('approval');
                    const isErrEvt = evt.type.includes('failed');
                    const isCompEvt = evt.type.includes('comp');
                    const isSuccessEvt =
                      evt.type.includes('succeeded') || evt.type.includes('completed');
                    const ts = new Date(evt.timestamp).toISOString().slice(11, 23);

                    return (
                      <div
                        key={evt.offset}
                        className={`rounded px-2 py-1 leading-5 ${
                          isApprovalEvt
                            ? 'border border-amber-400/40 bg-amber-500/12 text-amber-200'
                            : isErrEvt
                              ? 'border border-rose-500/30 bg-rose-500/10 text-rose-200'
                              : isCompEvt
                                ? 'bg-violet-500/10 text-violet-200'
                                : 'hover:bg-[#111417]'
                        }`}
                      >
                        <span className="mr-2 text-zinc-600">#{evt.offset}</span>
                        <span className="mr-2 text-zinc-500">[{ts}]</span>
                        <span
                          className={`mr-2 font-semibold ${
                            isApprovalEvt
                              ? 'text-amber-300'
                              : isErrEvt
                                ? 'text-rose-400'
                                : isCompEvt
                                  ? 'text-violet-300'
                                  : isSuccessEvt
                                    ? 'text-[#22e55c]'
                                    : 'text-zinc-200'
                          }`}
                        >
                          ● {evt.type}
                        </span>
                        <span className="break-all text-[10.5px] text-zinc-400">
                          {JSON.stringify(evt.payload)}
                        </span>
                      </div>
                    );
                  })}
                </div>

                <div className="flex shrink-0 items-center justify-between border-t border-[#1c2227] bg-[#111417] px-3.5 py-1.5 font-mono text-[10px] text-zinc-500">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#22e55c]" />
                    Keepalive · Last-Event-ID resumable
                  </span>
                  <button
                    onClick={exportJsonLines}
                    disabled={events.length === 0}
                    className="inline-flex items-center gap-1 rounded border border-[#262c32] bg-[#15191d] px-2 py-0.5 text-zinc-300 hover:border-[#22e55c]/45 hover:text-[#22e55c] disabled:opacity-40"
                  >
                    <Download className="h-3 w-3" />
                    Export JSON Lines
                  </button>
                </div>
              </div>

      {/* v6.0 TIME-TRAVEL CHECKPOINT RESUME MODAL */}
      {resumeTargetStep && activeRun && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="sf-popover w-full max-w-lg rounded-lg p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-[#fbbf24]">
                  <FastForward className="h-3.5 w-3.5" />
                  TIME-TRAVEL CHECKPOINT FORK
                </div>
                <h3 className="mt-1 text-sm font-semibold text-[#f1f5f9]">
                  Resume from &ldquo;{resumeTargetStep.label}&rdquo; ({resumeTargetStep.nodeId})
                </h3>
                <p className="mt-1 text-xs text-[#808d99]">
                  Preserves all previously succeeded upstream step outputs from{' '}
                  <code className="text-[#c7d1db]">{activeRun.id}</code> (zero duplicate upstream
                  execution) and re-runs only from this node forward.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setResumeTargetStep(null)}
                className="rounded p-1 text-[#808d99] hover:bg-[#1c2227] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4">
              <label className="font-mono text-[10px] font-semibold uppercase tracking-wider text-[#808d99]">
                PATCH INPUT OVERRIDES JSON (OPTIONAL)
              </label>
              <textarea
                rows={4}
                value={resumeOverridesText}
                onChange={(e) => setResumeOverridesText(e.target.value)}
                className="sf-input mt-1.5 w-full p-2.5 font-mono text-xs text-[#73ff86]"
              />
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setResumeTargetStep(null)}
                className="sf-btn-secondary px-3.5 py-2 font-mono text-[11px]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={resumingFromStep}
                onClick={() => void handleResumeFromStep()}
                className="sf-btn-primary inline-flex items-center gap-1.5 px-4 py-2 font-mono text-[11px] uppercase disabled:opacity-50"
              >
                <FastForward className="h-3.5 w-3.5" />
                {resumingFromStep ? 'Forking...' : 'Fork & Resume Run'}
              </button>
            </div>
          </div>
        </div>
      )}
            </div>
          </>
        )}
      </section>
    </div>
  );
};
