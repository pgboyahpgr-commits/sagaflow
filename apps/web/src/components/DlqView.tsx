import { useCallback, useEffect, useState } from 'react';
import type { DlqEntry, RunDiagnosisResponse } from '@sagaflow/shared';
import {
  AlertOctagon,
  CheckCircle2,
  Copy,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  ShieldAlert,
} from 'lucide-react';
import { api, type TenantSession } from '../lib/api.js';
import { StatusBadge } from './StatusBadge.js';

export function DlqView({
  session,
  onReplayed,
}: {
  session: TenantSession;
  onReplayed: (runId: string) => void;
}) {
  const [entries, setEntries] = useState<DlqEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [diagnosingId, setDiagnosingId] = useState<string | null>(null);
  const [diagnoses, setDiagnoses] = useState<Record<string, RunDiagnosisResponse>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { entries: list } = await api.listDlq(session);
      setEntries(list);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.tenantId, session.token, session.apiKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleReplay = async (entry: DlqEntry) => {
    setBusyId(entry.id);
    try {
      const { run } = await api.replayDlq(session, entry.id);
      await load();
      onReplayed(run.id);
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (dlqId: string) => {
    setBusyId(dlqId);
    try {
      await api.deleteDlq(session, dlqId);
      setEntries((prev) => prev.filter((e) => e.id !== dlqId));
    } finally {
      setBusyId(null);
    }
  };

  const handleDiagnose = async (entry: DlqEntry) => {
    setDiagnosingId(entry.id);
    try {
      const { diagnosis } = await api.diagnoseRun(session, entry.runId);
      setDiagnoses((prev) => ({ ...prev, [entry.id]: diagnosis }));
    } finally {
      setDiagnosingId(null);
    }
  };

  const compensatedCount = entries.filter((e) => e.runFinalStatus === 'compensated').length;
  const replayedCount = entries.filter((e) => Boolean(e.replayedRunId)).length;

  return (
    <div className="sf-surface-bg h-full overflow-y-auto p-5 lg:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        {/* Breadcrumb + Live Status Strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
          <span className="tracking-[0.12em] text-[#808d99]">
            SAGAS / DEAD_LETTER_QUEUE / <span className="text-[#fb7185]">RECOVERY_CONSOLE</span>
          </span>
          <span className="rounded border border-[#262c32] bg-[#111417] px-2 py-0.5 text-[#808d99]">
            REPLAY POLICY: <strong className="text-[#22e55c]">IDEMPOTENT NEW RUN</strong>
          </span>
        </div>

        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded border border-[#f43f5e]/35 bg-[#f43f5e]/[0.08] text-[#fb7185]">
              <AlertOctagon className="h-4.5 w-4.5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-[#f1f5f9]">
                Dead-Letter Queue (DLQ)
              </h1>
              <p className="mt-1 text-xs text-[#808d99]">
                Permanently failed workflow runs and reverse-order Saga rollback audits captured for
                forensics and 1-click idempotent replay.
              </p>
            </div>
          </div>

          <button
            onClick={() => void load()}
            className="sf-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#22e55c]' : ''}`} />
            Refresh
          </button>
        </div>

        {/* 3 Zero-Shadow Tier-1 KPI Cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="sf-card sf-top-rose p-3.5">
            <div className="sf-label-sm flex items-center justify-between text-[#808d99]">
              <span>OPEN POISON / FAILED RUNS</span>
              <ShieldAlert className="h-3.5 w-3.5 text-[#f43f5e]" />
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-[#fb7185]">
              {entries.length}
            </div>
            <div className="mt-1 font-mono text-[10.5px] text-[#808d99]">
              Captured in isolated tenant DLQ table
            </div>
          </div>

          <div className="sf-card sf-top-violet p-3.5">
            <div className="sf-label-sm flex items-center justify-between text-[#808d99]">
              <span>SAFELY COMPENSATED</span>
              <RotateCcw className="h-3.5 w-3.5 text-[#a855f7]" />
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-[#c084fc]">
              {compensatedCount}
            </div>
            <div className="mt-1 font-mono text-[10.5px] text-[#808d99]">
              Zero leaked inventory or wallet state
            </div>
          </div>

          <div className="sf-card sf-top-neon p-3.5">
            <div className="sf-label-sm flex items-center justify-between text-[#808d99]">
              <span>REPLAYED EXECUTIONS</span>
              <CheckCircle2 className="h-3.5 w-3.5 text-[#22e55c]" />
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-[#22e55c]">
              {replayedCount}
            </div>
            <div className="mt-1 font-mono text-[10.5px] text-[#808d99]">
              Audit trail linked to replacement run ID
            </div>
          </div>
        </div>

        {/* DLQ Entries */}
        {loading ? (
          <div className="sf-card py-14 text-center font-mono text-xs text-[#808d99]">
            Querying tenant DLQ table...
          </div>
        ) : entries.length === 0 ? (
          <div className="sf-card sf-top-neon py-16 text-center">
            <CheckCircle2 className="mx-auto h-9 w-9 text-[#22e55c]" />
            <div className="mt-3 text-sm font-semibold text-[#f1f5f9]">
              Dead-Letter Queue is clean
            </div>
            <p className="mx-auto mt-1 max-w-md text-xs text-[#808d99]">
              Run the{' '}
              <span className="font-mono text-[#c084fc]">
                Payment Decline — Full Saga Compensation Demo
              </span>{' '}
              workflow in Studio to observe an atomic reverse-order DB rollback and DLQ capture.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry) => {
              const isComp = entry.runFinalStatus === 'compensated';
              return (
                <div
                  key={entry.id}
                  className={`sf-card ${isComp ? 'sf-top-violet' : 'sf-top-rose'} p-4`}
                >
                  <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
                    <div className="min-w-0 flex-1 space-y-2.5">
                      {/* Meta Row */}
                      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                        <span className="font-sans text-sm font-semibold text-[#f1f5f9]">
                          {entry.workflowName}
                        </span>
                        <StatusBadge status={entry.runFinalStatus} size="xs" />
                        <span className="rounded border border-[#262c32] bg-[#111417] px-1.5 py-0.5 text-[10px] text-[#808d99]">
                          v{entry.versionNumber}
                        </span>
                        <button
                          onClick={() => {
                            void navigator.clipboard.writeText(entry.runId);
                            setCopiedId(entry.id);
                            setTimeout(() => setCopiedId(null), 1600);
                          }}
                          className="inline-flex items-center gap-1 text-[11px] text-[#808d99] hover:text-[#22e55c]"
                          title="Copy Run ID"
                        >
                          {entry.runId}
                          <Copy className="h-3 w-3" />
                          {copiedId === entry.id && (
                            <span className="text-[9.5px] text-[#22e55c]">copied</span>
                          )}
                        </button>
                        {entry.replayedRunId && (
                          <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/[0.08] px-2 py-0.5 text-[10px] text-[#22e55c]">
                            REPLAYED → {entry.replayedRunId}
                          </span>
                        )}
                      </div>

                      {/* Failure Diagnostic Strip */}
                      <div className="rounded border border-[#f43f5e]/30 bg-[#f43f5e]/[0.07] px-3 py-2 font-mono text-xs text-[#ffb4ab]">
                        <span className="font-semibold text-[#fb7185]">
                          [{entry.error.code}] {entry.failedStepLabel} ({entry.failedNodeId}):
                        </span>{' '}
                        {entry.error.message}
                      </div>

                      {/* Input & Metadata Console */}
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#262c32] bg-[#111417] px-3 py-2 font-mono text-[11px] text-[#808d99]">
                        <span className="truncate">
                          PAYLOAD:{' '}
                          <span className="text-[#f1f5f9]">{JSON.stringify(entry.input)}</span>
                        </span>
                        <span className="shrink-0">
                          {entry.id} · {new Date(entry.createdAt).toLocaleString()}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <button
                        onClick={() => void handleDiagnose(entry)}
                        disabled={diagnosingId === entry.id}
                        className="sf-btn-compensate inline-flex items-center gap-1.5 px-3 py-2 font-mono text-[11px] uppercase tracking-wider disabled:opacity-50"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        {diagnosingId === entry.id ? 'Analyzing...' : 'AI Diagnose'}
                      </button>
                      <button
                        onClick={() => void handleReplay(entry)}
                        disabled={busyId === entry.id}
                        className="sf-btn-primary inline-flex items-center gap-1.5 px-3.5 py-2 font-mono text-[11px] uppercase tracking-wider disabled:opacity-50"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Replay Run
                      </button>
                      <button
                        onClick={() => void handleDelete(entry.id)}
                        disabled={busyId === entry.id}
                        title="Purge DLQ entry"
                        className="sf-btn-danger inline-flex items-center gap-1 px-2.5 py-2 font-mono text-[11px] uppercase tracking-wider disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Purge
                      </button>
                    </div>
                  </div>

                  {diagnoses[entry.id] && (
                    <div className="mt-3 rounded border border-[#a855f7]/35 bg-[#111417] p-3 text-xs">
                      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
                        <span className="rounded border border-[#a855f7]/35 bg-[#a855f7]/[0.12] px-1.5 py-0.5 font-bold uppercase text-[#c084fc]">
                          {diagnoses[entry.id].source === 'llm'
                            ? `AI FORENSICS · ${diagnoses[entry.id].model}`
                            : 'DETERMINISTIC ENGINE FORENSICS'}
                        </span>
                        <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/[0.08] px-1.5 py-0.5 text-[#22e55c]">
                          {diagnoses[entry.id].rollbackIntegrity.verifiedClean
                            ? '✓ ROLLBACK VERIFIED'
                            : 'CHECK STATE'}
                        </span>
                        <span className="text-[#808d99]">{diagnoses[entry.id].latencyMs}ms</span>
                      </div>
                      <div className="mt-1.5 font-semibold text-[#f1f5f9]">
                        {diagnoses[entry.id].headline}
                      </div>
                      <p className="mt-0.5 text-[11.5px] text-[#c7d1db]">
                        {diagnoses[entry.id].rootCause}
                      </p>
                      <p className="mt-1 font-mono text-[10.5px] text-[#808d99]">
                        {diagnoses[entry.id].rollbackIntegrity.summary}
                      </p>
                      {diagnoses[entry.id].recommendations.length > 0 && (
                        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                          {diagnoses[entry.id].recommendations.map((rec, i) => (
                            <div
                              key={i}
                              className="rounded border border-[#262c32] bg-[#15191d] px-2.5 py-1.5"
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
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
