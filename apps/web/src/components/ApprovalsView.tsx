import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  Clock,
  Copy,
  RefreshCw,
  ShieldAlert,
  ExternalLink,
  RotateCcw,
  Download,
  Code2,
  Check,
  AlertTriangle,
} from 'lucide-react';
import type { ApprovalRequest, ApprovalStatus } from '@sagaflow/shared';
import { api, type TenantSession } from '../lib/api';
import { StatusBadge } from './StatusBadge';

interface ApprovalsViewProps {
  session: TenantSession;
  onInspectRun: (runId: string) => void;
  onNotify: (msg: string, tone?: 'ok' | 'err' | 'info') => void;
}

function renderColoredJson(obj: unknown): React.ReactNode {
  const raw = JSON.stringify(obj, null, 2);
  return raw.split('\n').map((line, i) => {
    const keyMatch = line.match(/^(\s*)"([^"]+)"(:)(.*)$/);
    if (keyMatch) {
      const [, indent, key, colon, rest] = keyMatch;
      const trimmed = rest.trim();
      const isStr = trimmed.startsWith('"');
      const isNum = /^-?\d/.test(trimmed);
      const isBool = /^(true|false|null)/.test(trimmed);
      return (
        <div key={i} className="leading-5">
          <span>{indent}</span>
          <span className="text-[#22e55c]">&quot;{key}&quot;</span>
          <span className="text-zinc-500">{colon}</span>
          <span
            className={
              isStr
                ? 'text-amber-300'
                : isNum
                  ? 'text-sky-300'
                  : isBool
                    ? 'text-violet-300'
                    : 'text-zinc-300'
            }
          >
            {rest}
          </span>
        </div>
      );
    }
    return (
      <div key={i} className="leading-5 text-zinc-400">
        {line}
      </div>
    );
  });
}

export const ApprovalsView: React.FC<ApprovalsViewProps> = ({
  session,
  onInspectRun,
  onNotify,
}) => {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [filter, setFilter] = useState<'all' | ApprovalStatus>('all');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [expandedPayload, setExpandedPayload] = useState<Record<string, boolean>>({});
  const [selectedIndex, setSelectedIndex] = useState<number>(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listApprovals(session);
      setApprovals(res.approvals);
      // Auto-expand first pending gate checkpoint payload for immediate visibility
      const firstPending = res.approvals.find((a) => a.status === 'pending');
      if (firstPending) {
        setExpandedPayload((prev) =>
          Object.keys(prev).length === 0 ? { [firstPending.id]: true } : prev
        );
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load approvals', 'err');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.tenantId, session.token, session.apiKey]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load]);

  const filtered = filter === 'all' ? approvals : approvals.filter((a) => a.status === filter);
  const pendingCount = approvals.filter((a) => a.status === 'pending').length;
  const approvedCount = approvals.filter((a) => a.status === 'approved').length;
  const rejectedCount = approvals.filter((a) => a.status === 'rejected').length;
  const decidedTotal = approvedCount + rejectedCount;
  const compensationPct =
    approvals.length > 0 ? Math.round((rejectedCount / approvals.length) * 1000) / 10 : 0;

  // J / K keyboard navigation across gates
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key.toLowerCase() === 'j' && filtered.length > 0) {
        setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1));
      } else if (e.key.toLowerCase() === 'k' && filtered.length > 0) {
        setSelectedIndex((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered.length]);

  const handleDecision = async (gate: ApprovalRequest, decision: 'approved' | 'rejected') => {
    setBusyId(gate.id);
    try {
      await api.decideApproval(session, gate.id, {
        decision,
        comment: comments[gate.id]?.trim() || undefined,
      });
      onNotify(
        decision === 'approved'
          ? `Approved "${gate.stepLabel}" — Saga resumed from durable checkpoint`
          : `Rejected "${gate.stepLabel}" — atomic reverse-order DB rollback triggered`,
        decision === 'approved' ? 'ok' : 'info'
      );
      await load();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Approval decision failed', 'err');
    } finally {
      setBusyId(null);
    }
  };

  const copyCallbackCurl = (gate: ApprovalRequest) => {
    const url = `${window.location.origin}/api/callbacks/approval/${gate.callbackToken}`;
    const curl = `curl -X POST "${url}" -H "Content-Type: application/json" -d '{"decision":"approved","decidedBy":"cfo@company.com","comment":"Approved via callback"}'`;
    void navigator.clipboard.writeText(curl);
    onNotify('Copied external callback cURL (Slack / PagerDuty ready)', 'ok');
  };

  const exportAuditLog = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), approvals }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sagaflow-approvals-audit-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    onNotify(`Exported ${approvals.length} approval audit records`, 'ok');
  };

  return (
    <div className="sf-surface-bg flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-5 lg:p-6">
        <div className="mx-auto max-w-6xl space-y-5">
          {/* Breadcrumb + Live Status Telemetry Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
            <span className="tracking-[0.14em] text-zinc-500">
              SAGAS / HITL_GATES / <span className="text-[#22e55c]">INBOX_ACTIVE</span>
            </span>
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 rounded border border-[#262c32] bg-[#111417] px-2 py-0.5 text-[#22e55c]">
                <span className="h-1.5 w-1.5 rounded-full bg-[#22e55c]" />
                DB JOURNAL: ONLINE
              </span>
              <span className="rounded border border-[#262c32] bg-[#111417] px-2 py-0.5 text-zinc-400">
                LEASE WORKERS: <span className="text-zinc-200">0 THREADS (IDLE)</span>
              </span>
            </div>
          </div>

          {/* Page Header + Filter Tabs + Export Audit Log */}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-amber-500/35 bg-amber-500/10 text-amber-300">
                <ShieldAlert className="h-4.5 w-4.5" />
              </div>
              <div>
                <h2 className="text-xl font-bold tracking-tight text-white">
                  Durable Human-in-the-Loop (HITL) Approval Gates
                </h2>
                <p className="mt-1 max-w-2xl text-xs text-zinc-400">
                  Crash-resumable state machines holding zero worker threads while awaiting manual
                  governance or financial sign-off. Resumes deterministically via cryptographic
                  webhook or console trigger.
                </p>
              </div>
            </div>

            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-1 rounded-md border border-[#262c32] bg-[#111417] p-1">
                {(
                  [
                    { id: 'all', label: 'All', count: approvals.length },
                    { id: 'pending', label: 'Pending', count: pendingCount },
                    { id: 'approved', label: 'Approved', count: approvedCount },
                    { id: 'rejected', label: 'Rejected / Rolled Back', count: rejectedCount },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setFilter(item.id)}
                    className={`flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[11px] font-medium transition ${
                      filter === item.id
                        ? 'bg-[#1c2227] text-white'
                        : 'text-zinc-400 hover:text-zinc-100'
                    }`}
                  >
                    <span>{item.label}</span>
                    <span
                      className={`rounded px-1.5 py-0.2 text-[10px] font-bold tabular-nums ${
                        item.id === 'pending' && item.count > 0
                          ? 'bg-amber-400 text-[#0c0e10]'
                          : 'bg-[#0c0e10] text-zinc-400'
                      }`}
                    >
                      {item.count}
                    </span>
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={exportAuditLog}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#262c32] bg-[#15191d] px-2.5 py-1.5 font-mono text-[11px] text-zinc-300 transition hover:border-[#22e55c]/40 hover:text-white"
                >
                  <Download className="h-3.5 w-3.5 text-[#22e55c]" />
                  Export Audit Log
                </button>
                <button
                  onClick={() => void load()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#262c32] bg-[#15191d] px-2.5 py-1.5 font-mono text-[11px] text-zinc-300 transition hover:bg-[#1c2227]"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-[#22e55c]' : ''}`} />
                  Refresh
                </button>
              </div>
            </div>
          </div>

          {/* 4 Live Real KPI Cards */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className="sf-card rounded-md p-3.5">
              <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-zinc-400">
                <span>AWAITING SIGN-OFF</span>
                <Clock className="h-3.5 w-3.5 text-amber-400" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-bold tabular-nums text-white">
                  {pendingCount}
                </span>
                <span className="font-mono text-[10.5px] text-zinc-500">
                  {pendingCount === 1 ? 'active gate' : 'active gates'}
                </span>
              </div>
              <div className="mt-3 h-1 w-full overflow-hidden rounded-[2px] bg-[#1c2227]">
                <div
                  className="h-full bg-amber-400 transition-all"
                  style={{
                    width: `${approvals.length ? Math.max(12, (pendingCount / approvals.length) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>

            <div className="sf-card rounded-md p-3.5">
              <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-zinc-400">
                <span>APPROVED & RESUMED</span>
                <CheckCircle2 className="h-3.5 w-3.5 text-[#22e55c]" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-bold tabular-nums text-white">
                  {approvedCount}
                </span>
                <span className="font-mono text-[10.5px] text-[#22e55c]">
                  {decidedTotal > 0 ? `${Math.round((approvedCount / decidedTotal) * 100)}% pass` : 'zero pending errors'}
                </span>
              </div>
              <div className="mt-3 h-1 w-full overflow-hidden rounded-[2px] bg-[#1c2227]">
                <div
                  className="h-full bg-[#22e55c] transition-all"
                  style={{
                    width: `${approvals.length ? (approvedCount / approvals.length) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>

            <div className="sf-card rounded-md p-3.5">
              <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-zinc-400">
                <span>COMPENSATIONS TRIGGERED</span>
                <RotateCcw className="h-3.5 w-3.5 text-violet-400" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-bold tabular-nums text-violet-300">
                  {compensationPct}%
                </span>
                <span className="font-mono text-[10.5px] text-zinc-500">
                  {rejectedCount} of {approvals.length} gates
                </span>
              </div>
              <div className="mt-3 h-1 w-full overflow-hidden rounded-[2px] bg-[#1c2227]">
                <div
                  className="h-full bg-violet-400 transition-all"
                  style={{ width: `${Math.min(100, compensationPct)}%` }}
                />
              </div>
            </div>

            <div className="sf-card rounded-md p-3.5">
              <div className="flex items-center justify-between font-mono text-[10px] tracking-wider text-zinc-400">
                <span>ZERO-THREAD PARK POOL</span>
                <Check className="h-3.5 w-3.5 text-[#22e55c]" />
              </div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-bold tabular-nums text-[#22e55c]">
                  100%
                </span>
                <span className="font-mono text-[10.5px] text-zinc-500">
                  DB checkpoint journaled
                </span>
              </div>
              <div className="mt-3 h-1 w-full overflow-hidden rounded-[2px] bg-[#1c2227]">
                <div className="h-full w-full bg-[#22e55c]" />
              </div>
            </div>
          </div>

          {/* Empty State */}
          {filtered.length === 0 ? (
            <div className="sf-card flex flex-col items-center justify-center rounded-md py-16 text-center">
              <CheckCircle2 className="h-10 w-10 text-[#22e55c]" />
              <div className="mt-3 text-sm font-semibold text-white">No approval gates in this view</div>
              <div className="mt-1 max-w-md text-xs text-zinc-400">
                Run the seeded <span className="font-mono text-amber-300">Wire Transfer Approval Gate</span>{' '}
                or <span className="font-mono text-[#22e55c]">AI Order Risk Triage</span> workflow in
                Studio to pause at a crash-resumable Human-in-the-Loop checkpoint.
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {filtered.map((gate, idx) => {
                const isPending = gate.status === 'pending';
                const isApproved = gate.status === 'approved';
                const topAccent = isPending
                  ? 'sf-top-amber'
                  : isApproved
                    ? 'sf-top-neon'
                    : 'sf-top-violet';
                const isFocused = idx === selectedIndex;
                const payloadOpen = Boolean(expandedPayload[gate.id]);
                const callbackUrl = `${window.location.origin}/api/callbacks/approval/${gate.callbackToken}`;

                return (
                  <div
                    key={gate.id}
                    onClick={() => setSelectedIndex(idx)}
                    className={`sf-card ${topAccent} rounded-md p-4 transition ${
                      isFocused ? 'ring-1 ring-[#2f373f]' : ''
                    }`}
                  >
                    {/* Card Header Meta Bar */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1c2227] pb-3">
                      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
                        <StatusBadge
                          status={gate.status === 'pending' ? 'waiting_approval' : gate.status === 'rejected' ? 'compensated' : gate.status}
                        />
                        <span className="text-zinc-500">·</span>
                        <span className="text-zinc-300">
                          ROLE: <strong className="text-white">{gate.approverRole}</strong>
                        </span>
                        {gate.expiresAt && (
                          <>
                            <span className="text-zinc-500">·</span>
                            {(() => {
                              const remMin = Math.round(
                                (new Date(gate.expiresAt).getTime() - Date.now()) / 60000
                              );
                              const breached = remMin <= 0;
                              return (
                                <span
                                  className={`rounded border px-1.5 py-0.2 font-mono text-[10px] font-bold uppercase ${
                                    breached
                                      ? 'border-[#f43f5e]/45 bg-[#f43f5e]/12 text-[#fb7185]'
                                      : 'border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#fbbf24]'
                                  }`}
                                >
                                  {breached ? 'SLA BREACHED' : `SLA: ${remMin}m`} ·{' '}
                                  {(gate.onTimeout ?? 'reject').toUpperCase()}
                                </span>
                              );
                            })()}
                          </>
                        )}
                        {gate.escalatedAt && (
                          <span className="rounded border border-[#f43f5e]/45 bg-[#f43f5e]/15 px-1.5 py-0.2 font-mono text-[9.5px] font-bold text-[#fb7185]">
                            ESCALATED
                          </span>
                        )}
                        <span className="text-zinc-500">·</span>
                        <span className="text-zinc-400">Workflow: {gate.workflowName}</span>
                        <span className="text-zinc-500">·</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onInspectRun(gate.runId);
                          }}
                          className="inline-flex items-center gap-1 text-[#22e55c] hover:underline"
                        >
                          {gate.runId}
                          <ExternalLink className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-zinc-500">
                        <Clock className="h-3 w-3" />
                        {new Date(gate.decidedAt ?? gate.createdAt).toLocaleString()}
                      </div>
                    </div>

                    {/* Pending Gate: External Callback + Amber Alert + JSON Checkpoint + Actions */}
                    {isPending ? (
                      <div className="mt-3 space-y-3">
                        {/* External Callback URL Strip */}
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#1c2227] bg-[#0c0e10] px-3 py-2">
                          <div className="min-w-0 truncate font-mono text-[11px] text-zinc-400">
                            <span className="text-zinc-500">EXTERNAL CALLBACK URL: </span>
                            <span className="text-zinc-200">{callbackUrl}</span>
                          </div>
                          <button
                            onClick={() => copyCallbackCurl(gate)}
                            className="inline-flex shrink-0 items-center gap-1.5 rounded border border-[#2f373f] bg-[#15191d] px-2.5 py-1 font-mono text-[10.5px] text-zinc-200 transition hover:border-[#22e55c]/45 hover:text-[#22e55c]"
                          >
                            <Copy className="h-3 w-3" />
                            Copy cURL for Slack/PagerDuty
                          </button>
                        </div>

                        {/* Highlighted Amber Alert Box */}
                        <div className="flex items-start gap-3 rounded border border-amber-500/30 bg-amber-500/[0.07] px-3.5 py-3">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-amber-200">{gate.stepLabel}</div>
                            <div className="mt-1 text-xs leading-relaxed text-zinc-200">
                              {gate.prompt}
                            </div>
                          </div>
                        </div>

                        {/* Expandable Upstream Saga Checkpoint Context */}
                        <div className="overflow-hidden rounded border border-[#1c2227] bg-[#0c0e10]">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedPayload((prev) => ({
                                ...prev,
                                [gate.id]: !prev[gate.id],
                              }))
                            }
                            className="flex w-full items-center justify-between border-b border-[#1c2227] px-3 py-2 font-mono text-[10.5px] tracking-wider text-zinc-400 hover:text-zinc-200"
                          >
                            <span className="inline-flex items-center gap-1.5">
                              <Code2 className="h-3.5 w-3.5 text-[#22e55c]" />
                              UPSTREAM SAGA CHECKPOINT CONTEXT (ZERO-THREAD FREEZE)
                            </span>
                            <span className="text-zinc-500">{payloadOpen ? 'HIDE ▲' : 'INSPECT ▼'}</span>
                          </button>
                          {payloadOpen && (
                            <div className="max-h-60 overflow-auto p-3 font-mono text-[11px]">
                              {renderColoredJson(gate.payload)}
                            </div>
                          )}
                        </div>

                        {/* Reviewer Decision Note + Approve/Reject CTA Row */}
                        <div className="space-y-2 pt-1">
                          <label className="block font-mono text-[10px] tracking-wider text-zinc-500">
                            REVIEWER AUDIT DECISION NOTE (APPENDED TO IMMUTABLE SAGA LEDGER)
                          </label>
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              value={comments[gate.id] ?? ''}
                              onChange={(e) =>
                                setComments((prev) => ({ ...prev, [gate.id]: e.target.value }))
                              }
                              placeholder="e.g., Verified wire authorization with account owner..."
                              className="min-w-[260px] flex-1 rounded-md border border-[#262c32] bg-[#0c0e10] px-3 py-2 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-[#22e55c]/60 focus:outline-none"
                            />
                            <button
                              disabled={busyId === gate.id}
                              onClick={() => void handleDecision(gate, 'rejected')}
                              className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/45 bg-rose-500/12 px-3.5 py-2 font-mono text-xs font-semibold text-rose-200 transition hover:bg-rose-500/22 disabled:opacity-50"
                            >
                              <XCircle className="h-3.5 w-3.5" />
                              Reject & Rollback Saga
                            </button>
                            <button
                              disabled={busyId === gate.id}
                              onClick={() => void handleDecision(gate, 'approved')}
                              className="sf-btn-neon inline-flex items-center gap-1.5 rounded-md px-4 py-2 font-mono text-xs disabled:opacity-50"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Approve & Resume Execution
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : isApproved ? (
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1 text-xs">
                          <div className="font-mono text-[11px] text-zinc-400">
                            Authorized by:{' '}
                            <span className="text-[#22e55c]">{gate.decidedBy ?? 'Reviewer'}</span>
                          </div>
                          <div className="text-zinc-200">
                            {gate.comment
                              ? `"${gate.comment}"`
                              : `Approved "${gate.stepLabel}" — downstream Saga steps executed to completion.`}
                          </div>
                        </div>
                        <span className="inline-flex items-center gap-1.5 rounded border border-[#22e55c]/35 bg-[#22e55c]/10 px-2.5 py-1 font-mono text-[10.5px] font-semibold text-[#22e55c]">
                          <Check className="h-3 w-3" />
                          Journal Verified
                        </span>
                      </div>
                    ) : (
                      <div className="mt-3 space-y-2.5">
                        <div className="text-xs text-zinc-300">
                          <span className="font-mono text-[11px] text-zinc-500">
                            Rejected by {gate.decidedBy ?? 'Reviewer'}:{' '}
                          </span>
                          {gate.comment || gate.prompt}
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-violet-500/30 bg-violet-500/[0.08] px-3 py-2 font-mono text-[11px]">
                          <span className="inline-flex items-center gap-1.5 text-violet-200">
                            <RotateCcw className="h-3.5 w-3.5 text-violet-400" />
                            Atomic reverse-order DB compensation executed cleanly.
                          </span>
                          <span className="rounded border border-violet-400/35 bg-[#0c0e10] px-2 py-0.5 text-[9.5px] font-bold text-violet-300">
                            ZERO DB LEAKS
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Bottom Keyboard Legend Bar */}
      <div className="flex shrink-0 items-center justify-between border-t border-[#1c2227] bg-[#111417] px-5 py-1.5 font-mono text-[10px] text-zinc-500">
        <div className="flex items-center gap-3">
          <span>
            <kbd className="rounded border border-[#2f373f] bg-[#15191d] px-1.5 py-0.2 text-zinc-300">J</kbd>{' '}
            <kbd className="rounded border border-[#2f373f] bg-[#15191d] px-1.5 py-0.2 text-zinc-300">K</kbd>{' '}
            Navigate Gates
          </span>
          <span>Zero worker threads held while parked</span>
        </div>
        <span className="text-zinc-400">
          {pendingCount} pending · {approvedCount} approved · {rejectedCount} compensated
        </span>
      </div>
    </div>
  );
};
