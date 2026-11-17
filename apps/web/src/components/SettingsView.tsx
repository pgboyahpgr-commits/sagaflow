import { useCallback, useEffect, useState } from 'react';
import type {
  AiProviderConfig,
  ApiKeyInfo,
  RbacRole,
  SignedAuditBundle,
  StorageStatus,
  Tenant,
  TenantMember,
} from '@sagaflow/shared';
import {
  ArrowRight,
  BookOpen,
  Bot,
  Building2,
  Check,
  CheckCircle2,
  Code2,
  Compass,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileCheck2,
  KeyRound,
  Play,
  Plus,
  RotateCcw,
  Shield,
  ShieldCheck,
  Sliders,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
import { api, type TenantSession } from '../lib/api.js';
import type { AppTab } from './GuideOverlay';

const ROLE_DESCRIPTIONS: Record<RbacRole, string> = {
  admin: 'Full tenant control (secrets, API keys, RBAC, workflows, approvals)',
  operator: 'Design, publish, run workflows, schedules, state & DLQ replay',
  approver: 'Read-only workspace + Approve/Reject HITL Approval Gates',
  viewer: 'Strictly read-only access (HTTP 403 enforced on all writes)',
};

export function SettingsView({
  session,
  tenants,
  storageStatus,
  guideMode,
  onToggleGuideMode,
  onStartTour,
  onResetDismissedGuides,
  aiConfig,
  onNavigate,
  onTenantCreated,
  onSelectTenant,
  onSwitchUser,
  onNotify,
}: {
  session: TenantSession;
  tenants: Tenant[];
  storageStatus: StorageStatus | null;
  guideMode: boolean;
  onToggleGuideMode: (next: boolean) => void;
  onStartTour: () => void;
  onResetDismissedGuides: () => void;
  aiConfig: AiProviderConfig | null;
  onNavigate: (tab: AppTab) => void;
  onTenantCreated: () => Promise<void>;
  onSelectTenant: (tenantId: string) => void;
  onSwitchUser?: (userId: string) => void;
  onNotify?: (msg: string, tone?: 'ok' | 'err' | 'info') => void;
}) {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [newKeyName, setNewKeyName] = useState('CI / Production Worker');
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const [tenantName, setTenantName] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // v5 RBAC state
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [currentRole, setCurrentRole] = useState<RbacRole>('admin');
  const [newMemberId, setNewMemberId] = useState('');
  const [newMemberRole, setNewMemberRole] = useState<RbacRole>('operator');

  // v5 Signed Compliance Audit Bundle state
  const [auditBundle, setAuditBundle] = useState<SignedAuditBundle | null>(null);
  const [auditVerifyResult, setAuditVerifyResult] = useState<{
    valid: boolean;
    reason: string;
  } | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [copiedSdk, setCopiedSdk] = useState(false);

  const loadSettingsData = useCallback(async () => {
    try {
      const [keyRes, rbacRes] = await Promise.all([
        api.listApiKeys(session),
        api.listRbacMembers(session),
      ]);
      setKeys(keyRes.apiKeys);
      setMembers(rbacRes.members);
      setCurrentRole(rbacRes.currentRole);
    } catch {
      setKeys([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.tenantId, session.userId, session.token, session.apiKey]);

  useEffect(() => {
    void loadSettingsData();
  }, [loadSettingsData]);

  const handleCreateTenant = async () => {
    if (!tenantName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const slug =
        tenantSlug.trim() ||
        tenantName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
      const { tenant } = await api.createTenant({
        name: tenantName.trim(),
        slug,
        maxConcurrentRuns: 100,
        rateLimitPerMin: 300,
      });
      setTenantName('');
      setTenantSlug('');
      await onTenantCreated();
      onSelectTenant(tenant.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tenant');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { rawKey } = await api.createApiKey(session, newKeyName.trim());
      setFreshSecret(rawKey);
      setCopiedKey(false);
      await loadSettingsData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mint API key');
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.revokeApiKey(session, keyId);
      await loadSettingsData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke key');
    } finally {
      setBusy(false);
    }
  };

  const handleSetMemberRole = async (userId: string, role: RbacRole) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.setRbacMemberRole(session, userId, role);
      setMembers(res.members);
      onNotify?.(`Assigned role "${role}" to ${userId}`, 'ok');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update RBAC role';
      setError(msg);
      onNotify?.(msg, 'err');
    } finally {
      setBusy(false);
    }
  };

  const handleExportAudit = async () => {
    setAuditBusy(true);
    setAuditVerifyResult(null);
    setError(null);
    try {
      const { bundle } = await api.exportSignedAudit(session);
      setAuditBundle(bundle);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sagaflow-audit-${bundle.tenant.slug}-${Date.now()}.signed.json`;
      a.click();
      URL.revokeObjectURL(url);
      onNotify?.('Exported HMAC-SHA256 signed compliance audit bundle', 'ok');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export audit bundle');
    } finally {
      setAuditBusy(false);
    }
  };

  const handleVerifyAudit = async () => {
    if (!auditBundle) return;
    setAuditBusy(true);
    try {
      const res = await api.verifySignedAudit(session, auditBundle);
      setAuditVerifyResult({ valid: res.valid, reason: res.reason });
      onNotify?.(res.valid ? 'HMAC-SHA256 audit signature verified!' : 'Signature invalid', res.valid ? 'ok' : 'err');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setAuditBusy(false);
    }
  };

  const copySecret = () => {
    if (!freshSecret) return;
    void navigator.clipboard.writeText(freshSecret);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 1800);
  };

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000';
  const sdkSnippet = `import { SagaFlowClient } from '@sagaflow/sdk';

const client = new SagaFlowClient({
  baseUrl: '${origin}',
  tenantId: '${session.tenantId}',
  apiKey: process.env.SAGAFLOW_API_KEY,
});

const { run } = await client.triggerRun('wf_nested_pipeline', {
  idempotencyKey: 'ord-' + Date.now(),
  input: { orderId: 'ORD-5001', sku: 'SKU-PRO-900', qty: 1, amount: 1500 },
});
const finalRun = await client.waitForRun(run.id);
console.log(finalRun.status, finalRun.steps);`;

  return (
    <div className="sf-surface-bg h-full overflow-y-auto p-5 lg:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        {/* Breadcrumb */}
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
          <span className="tracking-[0.12em] text-[#808d99]">
            PLATFORM / SETTINGS / <span className="text-[#22e55c]">SECURITY_RBAC_SDK</span>
          </span>
          <span className="rounded border border-[#262c32] bg-[#111417] px-2 py-0.5 text-[#808d99]">
            ACTIVE ROLE:{' '}
            <strong className="uppercase text-[#22e55c]">{currentRole}</strong> ·{' '}
            <span className="text-[#c7d1db]">{session.userId}</span>
          </span>
        </div>

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded border border-[#22e55c]/35 bg-[#22e55c]/[0.08] text-[#22e55c]">
              <Sliders className="h-4.5 w-4.5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-[#f1f5f9]">
                Settings, RBAC Governance &amp; Developer SDK
              </h1>
              <p className="mt-1 text-xs text-[#808d99]">
                Configure Guide Mode, enforce per-tenant RBAC roles, export HMAC-SHA256 signed
                compliance bundles, inspect OpenAPI 3.1 docs, and provision isolated tenant DBs.
              </p>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded border border-[#f43f5e]/40 bg-[#f43f5e]/10 px-4 py-2.5 font-mono text-xs text-[#ffb4ab]">
            {error}
          </div>
        )}

        {/* INTERACTIVE GUIDE MODE CONTROL CENTER */}
        <div className="sf-card-neon p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-[#22e55c]/40 bg-[#22e55c]/10 text-[#22e55c]">
                <Compass className="h-4.5 w-4.5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-[#f1f5f9]">Interactive Guide Mode</h2>
                <p className="mt-0.5 text-xs text-[#808d99]">
                  Contextual tips on every tab plus a non-blocking 7-step interactive walkthrough
                  across Studio, AI Agent, Approvals, and Saga Ledger.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span
                className={`font-mono text-[11px] font-semibold uppercase tracking-wider ${
                  guideMode ? 'text-[#22e55c]' : 'text-[#808d99]'
                }`}
              >
                {guideMode ? 'GUIDE ON' : 'GUIDE OFF'}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={guideMode}
                aria-label="Toggle Interactive Guide Mode"
                onClick={() => onToggleGuideMode(!guideMode)}
                className={`relative h-6 w-11 rounded border transition ${
                  guideMode ? 'border-[#22e55c] bg-[#22e55c]' : 'border-[#262c32] bg-[#111417]'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4.5 w-4.5 rounded-[2px] transition-all ${
                    guideMode ? 'left-5.5 bg-[#070b07]' : 'left-0.5 bg-[#808d99]'
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded border border-[#262c32] bg-[#111417] p-3.5">
              <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-[#f1f5f9]">
                <BookOpen className="h-3.5 w-3.5 text-[#22e55c]" />
                7-Step Interactive Tour
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-[#808d99]">
                Walk through every SagaFlow module step-by-step with a floating command guide card.
              </p>
              <button
                type="button"
                onClick={onStartTour}
                className="sf-btn-primary mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider"
              >
                <Play className="h-3 w-3" />
                Launch Interactive Tour
              </button>
            </div>

            <div className="rounded border border-[#262c32] bg-[#111417] p-3.5">
              <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-[#f1f5f9]">
                <Sparkles className="h-3.5 w-3.5 text-[#22e55c]" />
                Contextual Tab Banners
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-[#808d99]">
                Shows concise action strips at the top of each workspace screen. Restore dismissed
                tips anytime.
              </p>
              <button
                type="button"
                onClick={onResetDismissedGuides}
                className="sf-btn-secondary mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px]"
              >
                <RotateCcw className="h-3 w-3" />
                Restore All Tab Tips
              </button>
            </div>

            <div className="rounded border border-[#262c32] bg-[#111417] p-3.5">
              <div className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-[#f1f5f9]">
                <Bot className="h-3.5 w-3.5 text-[#22e55c]" />
                AI Automation Agent
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-[#808d99]">
                Active Provider:{' '}
                <span className="font-mono font-semibold text-[#22e55c]">
                  {aiConfig?.provider === 'google_ai_studio'
                    ? `Google AI Studio (${aiConfig.googleModel})`
                    : `LM Studio (${aiConfig?.lmStudioModel || 'local'})`}
                </span>
                . Encrypted at rest via AES-256-GCM.
              </p>
              <button
                type="button"
                onClick={() => onNavigate('ai')}
                className="mt-3 inline-flex items-center gap-1.5 rounded border border-[#22e55c]/35 bg-[#22e55c]/[0.08] px-3 py-1.5 font-mono text-[11px] font-semibold text-[#22e55c] transition hover:bg-[#22e55c]/15"
              >
                Configure LM Studio / Gemini
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          </div>
        </div>

        {/* v5 ENTERPRISE RBAC & COMPLIANCE AUDIT ROW */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* RBAC Role Management */}
          <div className="sf-card sf-top-violet overflow-hidden">
            <div className="p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-[#f1f5f9]">
                  <Users className="h-4 w-4 text-[#c084fc]" />
                  Role-Based Access Control (RBAC)
                </h2>
                <span className="rounded border border-[#a855f7]/35 bg-[#a855f7]/[0.10] px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-[#c084fc]">
                  YOUR ROLE: {currentRole}
                </span>
              </div>
              <p className="mt-1 text-xs text-[#808d99]">
                Real server-side enforcement across every API mutation. Switch personas below to
                verify live HTTP 403 protection.
              </p>

              <div className="mt-3 space-y-2">
                {members.map((m) => {
                  const isCurrent = m.userId === session.userId;
                  return (
                    <div
                      key={m.userId}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 font-mono text-xs ${
                        isCurrent
                          ? 'border-[#22e55c]/40 bg-[#111813]'
                          : 'border-[#262c32] bg-[#111417]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 font-semibold text-[#f1f5f9]">
                          <span>{m.userId}</span>
                          {isCurrent && (
                            <span className="rounded border border-[#22e55c]/35 bg-[#22e55c]/10 px-1 py-0.2 text-[9px] text-[#22e55c]">
                              ACTIVE
                            </span>
                          )}
                        </div>
                        <div className="font-sans text-[10.5px] text-[#808d99]">
                          {ROLE_DESCRIPTIONS[m.role]}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <select
                          value={m.role}
                          disabled={busy || currentRole !== 'admin'}
                          onChange={(e) =>
                            void handleSetMemberRole(m.userId, e.target.value as RbacRole)
                          }
                          className="sf-input px-2 py-1 text-[10.5px] uppercase disabled:opacity-50"
                        >
                          <option value="admin">admin</option>
                          <option value="operator">operator</option>
                          <option value="approver">approver</option>
                          <option value="viewer">viewer</option>
                        </select>
                        {onSwitchUser && !isCurrent && !session.token && (
                          <button
                            type="button"
                            onClick={() => onSwitchUser(m.userId)}
                            className="sf-btn-secondary px-2 py-1 text-[10px]"
                            title={`Test workspace as ${m.userId} (${m.role})`}
                          >
                            Use
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {currentRole === 'admin' && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-[#262c32] pt-3">
                  <input
                    value={newMemberId}
                    onChange={(e) => setNewMemberId(e.target.value)}
                    placeholder="user_id (e.g. usr_auditor_1)"
                    className="sf-input flex-1 px-2.5 py-1.5"
                  />
                  <select
                    value={newMemberRole}
                    onChange={(e) => setNewMemberRole(e.target.value as RbacRole)}
                    className="sf-input px-2 py-1.5 uppercase"
                  >
                    <option value="admin">admin</option>
                    <option value="operator">operator</option>
                    <option value="approver">approver</option>
                    <option value="viewer">viewer</option>
                  </select>
                  <button
                    type="button"
                    disabled={busy || !newMemberId.trim()}
                    onClick={async () => {
                      await handleSetMemberRole(newMemberId.trim(), newMemberRole);
                      setNewMemberId('');
                    }}
                    className="sf-btn-primary px-3 py-1.5 font-mono text-[10.5px] uppercase disabled:opacity-40"
                  >
                    Assign
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Cryptographically Signed Compliance Audit Export */}
          <div className="sf-card sf-top-neon flex flex-col justify-between p-5">
            <div>
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-[#f1f5f9]">
                  <ShieldCheck className="h-4 w-4 text-[#22e55c]" />
                  Signed Compliance Audit Export
                </h2>
                <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/[0.08] px-2 py-0.5 font-mono text-[10px] text-[#22e55c]">
                  HMAC-SHA256
                </span>
              </div>
              <p className="mt-1 text-xs text-[#808d99]">
                Exports tenant workflows, runs, HITL approval decisions, Saga Ledger rollback
                proofs, and DLQ records sealed with a tamper-evident HMAC-SHA256 signature.
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={auditBusy}
                  onClick={() => void handleExportAudit()}
                  className="sf-btn-primary inline-flex items-center gap-1.5 px-3.5 py-2 font-mono text-[11px] uppercase tracking-wider disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  {auditBusy ? 'Signing...' : 'Export & Sign Audit Bundle'}
                </button>
                <button
                  type="button"
                  disabled={auditBusy || !auditBundle}
                  onClick={() => void handleVerifyAudit()}
                  className="sf-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 font-mono text-[11px] disabled:opacity-40"
                >
                  <FileCheck2 className="h-3.5 w-3.5 text-[#22e55c]" />
                  Verify Signature
                </button>
              </div>

              {auditBundle && (
                <div className="mt-4 space-y-2 rounded border border-[#262c32] bg-[#111417] p-3 font-mono text-[11px]">
                  <div className="flex items-center justify-between text-[#808d99]">
                    <span>KEY FINGERPRINT: {auditBundle.signature.keyFingerprint}</span>
                    <span className="text-[#22e55c]">{auditBundle.signature.algorithm}</span>
                  </div>
                  <div className="truncate text-[10px] text-[#73ff86]">
                    DIGEST: {auditBundle.signature.digest}
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-1 text-[10.5px] text-[#c7d1db]">
                    <span>Workflows: {auditBundle.summary.workflows}</span>
                    <span>Runs: {auditBundle.summary.runs}</span>
                    <span>Ledger: {auditBundle.summary.ledgerEntries}</span>
                  </div>
                </div>
              )}

              {auditVerifyResult && (
                <div
                  className={`mt-3 flex items-center gap-2 rounded border px-3 py-2 font-mono text-[11px] ${
                    auditVerifyResult.valid
                      ? 'border-[#22e55c]/40 bg-[#22e55c]/[0.08] text-[#73ff86]'
                      : 'border-[#f43f5e]/40 bg-[#f43f5e]/[0.08] text-[#ffb4ab]'
                  }`}
                >
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span>{auditVerifyResult.reason}</span>
                </div>
              )}
            </div>

            {/* OpenAPI 3.1 & TypeScript SDK Quick Bar */}
            <div className="mt-5 border-t border-[#262c32] pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-[#f1f5f9]">
                  <Code2 className="h-3.5 w-3.5 text-[#22e55c]" />
                  OpenAPI 3.1 &amp; @sagaflow/sdk
                </span>
                <div className="flex items-center gap-2">
                  <a
                    href="/api/docs"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded border border-[#22e55c]/35 bg-[#22e55c]/[0.08] px-2.5 py-1 font-mono text-[10.5px] font-semibold text-[#22e55c] hover:bg-[#22e55c]/15"
                  >
                    Open /api/docs
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(sdkSnippet);
                      setCopiedSdk(true);
                      setTimeout(() => setCopiedSdk(false), 1800);
                    }}
                    className="sf-btn-secondary inline-flex items-center gap-1 px-2.5 py-1 font-mono text-[10.5px]"
                  >
                    {copiedSdk ? (
                      <Check className="h-3 w-3 text-[#22e55c]" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {copiedSdk ? 'Copied SDK' : 'Copy TS SDK'}
                  </button>
                </div>
              </div>
              <pre className="mt-2.5 max-h-40 overflow-auto rounded border border-[#262c32] bg-[#111417] p-2.5 font-mono text-[10.5px] text-[#73ff86]">
                {sdkSnippet}
              </pre>
            </div>
          </div>
        </div>

        {/* MULTI-TENANT WORKSPACES */}
        <div className="sf-card p-5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-[#f1f5f9]">
                <Building2 className="h-4 w-4 text-[#22e55c]" />
                Multi-Tenant Workspaces (Physical DB-per-Tenant Isolation)
              </h2>
              <p className="mt-0.5 text-xs text-[#808d99]">
                Each tenant gets its own isolated database file in SQLite/JSON mode (or Postgres RLS
                boundary). Cross-tenant IDs always return HTTP 404.
              </p>
            </div>
            <span className="sf-label-sm rounded border border-[#262c32] bg-[#111417] px-2 py-1 text-[#808d99]">
              {tenants.length} PROVISIONED
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
            {tenants.map((t) => {
              const active = t.id === session.tenantId;
              return (
                <button
                  key={t.id}
                  onClick={() => onSelectTenant(t.id)}
                  className={`rounded border p-3.5 text-left transition ${
                    active
                      ? 'sf-top-neon border-[#22e55c]/45 bg-[#111813]'
                      : 'border-[#262c32] bg-[#111417] hover:border-[#2f373f] hover:bg-[#1c2227]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-[#f1f5f9]">{t.name}</span>
                    {active && (
                      <span className="rounded border border-[#22e55c]/35 bg-[#22e55c]/[0.10] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wider text-[#22e55c]">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 font-mono text-[11px] text-[#808d99]">{t.id}</div>
                  <div className="mt-2 font-mono text-[10px] text-[#808d99]">
                    Quota: {t.maxConcurrentRuns} runs · {t.rateLimitPerMin} req/min
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-2.5 border-t border-[#262c32] pt-4">
            <div className="min-w-[200px] flex-1">
              <label className="sf-label-sm block text-[#808d99]">NEW TENANT NAME</label>
              <input
                value={tenantName}
                onChange={(e) => setTenantName(e.target.value)}
                placeholder="e.g. Stark Payments"
                className="sf-input mt-1 w-full px-3 py-2"
              />
            </div>
            <div className="w-48">
              <label className="sf-label-sm block text-[#808d99]">SLUG</label>
              <input
                value={tenantSlug}
                onChange={(e) => setTenantSlug(e.target.value)}
                placeholder="stark-payments"
                className="sf-input mt-1 w-full px-3 py-2"
              />
            </div>
            <button
              onClick={() => void handleCreateTenant()}
              disabled={busy || !tenantName.trim()}
              className="sf-btn-primary inline-flex items-center gap-1.5 px-4 py-2 font-mono text-[11px] uppercase tracking-wider disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              Provision Tenant DB
            </button>
          </div>
        </div>

        {/* CRYPTOGRAPHIC API KEYS */}
        <div className="sf-card overflow-hidden">
          <div className="p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[#f1f5f9]">
              <KeyRound className="h-4 w-4 text-[#22e55c]" />
              Cryptographic API Keys (SHA-256 Hashed at Rest)
            </h2>
            <p className="mt-0.5 text-xs text-[#808d99]">
              Raw keys are generated with 192 bits of entropy, displayed once, and stored strictly
              as SHA-256 hashes. Admin role required to mint or revoke keys.
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key label (e.g. GitHub Actions Deploy)"
                className="sf-input min-w-[240px] flex-1 px-3 py-2"
              />
              <button
                onClick={() => void handleCreateKey()}
                disabled={busy || !newKeyName.trim()}
                className="sf-btn-primary inline-flex items-center gap-1.5 px-4 py-2 font-mono text-[11px] uppercase tracking-wider disabled:opacity-40"
              >
                <Shield className="h-3.5 w-3.5" />
                Generate Key
              </button>
            </div>

            {freshSecret && (
              <div className="mt-3 rounded border border-[#22e55c]/45 bg-[#22e55c]/[0.08] p-3">
                <div className="sf-label-sm text-[#22e55c]">
                  COPY THIS API KEY NOW — IT WILL NEVER BE SHOWN AGAIN
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="flex-1 break-all rounded border border-[#262c32] bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-[#73ff86]">
                    {freshSecret}
                  </code>
                  <button
                    onClick={copySecret}
                    className="sf-btn-secondary inline-flex items-center gap-1 px-3 py-1.5 font-mono text-[11px]"
                  >
                    {copiedKey ? (
                      <Check className="h-3.5 w-3.5 text-[#22e55c]" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copiedKey ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Compact 32px Data Table */}
          <div className="border-t border-[#262c32]">
            {keys.length === 0 ? (
              <div className="bg-[#111417] py-6 text-center font-mono text-xs text-[#808d99]">
                No API keys minted for this tenant yet.
              </div>
            ) : (
              <table className="w-full text-left font-mono text-xs">
                <thead>
                  <tr className="border-b border-[#262c32] bg-[#111417] text-[10px] uppercase tracking-[0.04em] text-[#808d99]">
                    <th className="px-4 py-2 font-semibold">Name</th>
                    <th className="px-4 py-2 font-semibold">Prefix</th>
                    <th className="px-4 py-2 font-semibold">Created</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="px-4 py-2 text-right font-semibold">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#262c32]/70">
                  {keys.map((k) => (
                    <tr key={k.id} className="hover:bg-[#181e23]">
                      <td className="px-4 py-2 font-sans text-xs font-medium text-[#f1f5f9]">
                        {k.name}
                      </td>
                      <td className="px-4 py-2 text-[#22e55c]">{k.prefix}••••</td>
                      <td className="px-4 py-2 text-[11px] text-[#808d99]">
                        {new Date(k.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2">
                        {k.revokedAt ? (
                          <span className="rounded border border-[#f43f5e]/30 bg-[#f43f5e]/[0.08] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase text-[#fb7185]">
                            REVOKED
                          </span>
                        ) : (
                          <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/[0.08] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase text-[#22e55c]">
                            ACTIVE
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {!k.revokedAt && (
                          <button
                            onClick={() => void handleRevoke(k.id)}
                            disabled={busy}
                            className="sf-btn-danger inline-flex items-center gap-1 px-2 py-1 text-[10px] uppercase"
                          >
                            <Trash2 className="h-3 w-3" />
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* RUNTIME STORAGE ENGINE */}
        {storageStatus && (
          <div className="sf-card p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[#f1f5f9]">
              <Database className="h-4 w-4 text-[#22e55c]" />
              Storage &amp; Queue Runtime (&quot;Store Anything Anywhere&quot;)
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-3 font-mono text-xs md:grid-cols-4">
              <div className="rounded border border-[#262c32] bg-[#111417] p-3">
                <div className="sf-label-sm text-[#808d99]">STORAGE DRIVER</div>
                <div className="mt-1.5 font-semibold text-[#22e55c]">{storageStatus.driver}</div>
              </div>
              <div className="rounded border border-[#262c32] bg-[#111417] p-3">
                <div className="sf-label-sm text-[#808d99]">ISOLATION MODEL</div>
                <div className="mt-1.5 font-semibold text-[#f1f5f9]">{storageStatus.isolation}</div>
              </div>
              <div className="rounded border border-[#262c32] bg-[#111417] p-3">
                <div className="sf-label-sm text-[#808d99]">QUEUE / WORKERS</div>
                <div className="mt-1.5 font-semibold text-[#f1f5f9]">
                  {storageStatus.queueDriver} ({storageStatus.workerConcurrency} workers)
                </div>
              </div>
              <div className="rounded border border-[#262c32] bg-[#111417] p-3">
                <div className="sf-label-sm text-[#808d99]">DATA LOCATION</div>
                <div className="mt-1.5 truncate text-[#f1f5f9]" title={storageStatus.location}>
                  {storageStatus.location}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
