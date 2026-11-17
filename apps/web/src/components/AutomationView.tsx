import React, { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  CalendarClock,
  Check,
  Copy,
  KeyRound,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Webhook,
} from 'lucide-react';
import {
  ALERT_EVENT_TYPES,
  describeCron,
  getNextCronDates,
  type AlertEventType,
  type AlertRule,
  type SecretMetadata,
  type WorkflowListItem,
  type WorkflowSchedule,
} from '@sagaflow/shared';
import { api, type TenantSession } from '../lib/api';

interface AutomationViewProps {
  session: TenantSession;
  tenantSlug: string;
  onInspectRun: (runId: string) => void;
  onNotify: (msg: string, tone?: 'ok' | 'err' | 'info') => void;
}

const CRON_PRESETS = [
  { label: 'Every 5m', expr: '*/5 * * * *' },
  { label: 'Hourly', expr: '0 * * * *' },
  { label: 'Daily 09:00 UTC', expr: '0 9 * * *' },
  { label: 'Mon–Fri 08:00', expr: '0 8 * * 1-5' },
];

export const AutomationView: React.FC<AutomationViewProps> = ({
  session,
  tenantSlug,
  onInspectRun,
  onNotify,
}) => {
  const [secrets, setSecrets] = useState<SecretMetadata[]>([]);
  const [schedules, setSchedules] = useState<WorkflowSchedule[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [alertRules, setAlertRules] = useState<AlertRule[]>([]);
  const [alertName, setAlertName] = useState('Ops Failure & SLA Alert');
  const [alertUrl, setAlertUrl] = useState(() => `/api/sink/${tenantSlug}/alerts`);
  const [alertSecret, setAlertSecret] = useState('sf_alert_hmac_secret');
  const [alertEvents, setAlertEvents] = useState<AlertEventType[]>([
    'run.failed',
    'run.compensated',
    'dlq.created',
    'approval.sla_breached',
  ]);
  const [testingAlertId, setTestingAlertId] = useState<string | null>(null);

  // Secret form
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [secretDesc, setSecretDesc] = useState('');

  // Schedule form
  const [schedWfId, setSchedWfId] = useState('');
  const [schedName, setSchedName] = useState('Scheduled Reconciliation');
  const [schedCron, setSchedCron] = useState('*/5 * * * *');
  const [schedInput, setSchedInput] = useState('{"orderId":"ORD-CRON-1","amount":145,"qty":1}');
  const [schedEnabled, setSchedEnabled] = useState(true);

  // Real HMAC-SHA256 Webhook Tester
  const [hookWfId, setHookWfId] = useState('');
  const [hookPayload, setHookPayload] = useState(
    '{\n  "orderId": "ORD-HOOK-LIVE-1",\n  "sku": "SKU-PRO-900",\n  "qty": 1,\n  "amount": 195\n}'
  );
  const [hookDeliveryId, setHookDeliveryId] = useState(() => `evt_${Date.now()}`);
  const [hookSignSecret, setHookSignSecret] = useState('');
  const [hookSignature, setHookSignature] = useState('');
  const [hookResult, setHookResult] = useState<{
    runId: string;
    deduplicated: boolean;
    signatureVerified: boolean;
  } | null>(null);
  const [copiedCurl, setCopiedCurl] = useState(false);

  const loadAll = async () => {
    try {
      const [sRes, scRes, wfRes, alRes] = await Promise.all([
        api.listSecrets(session),
        api.listSchedules(session),
        api.listWorkflows(session),
        api.listAlertRules(session),
      ]);
      setSecrets(sRes.secrets);
      setSchedules(scRes.schedules);
      setAlertRules(alRes.rules);
      const published = wfRes.workflows.filter((w) => w.latestVersion !== null);
      setWorkflows(published);
      if (!schedWfId && published[0]) setSchedWfId(published[0].id);
      if (!hookWfId && published[0]) setHookWfId(published[0].id);
      if (!hookSignSecret && sRes.secrets[0]) setHookSignSecret(sRes.secrets[0].name);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to load automation data', 'err');
    }
  };

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.tenantId, session.apiKey, session.token]);

  const nextCronDates = useMemo(() => {
    try {
      return getNextCronDates(schedCron.trim(), 3);
    } catch {
      return [];
    }
  }, [schedCron]);

  const cronDescription = useMemo(() => {
    try {
      return describeCron(schedCron.trim());
    } catch {
      return 'Invalid 5-field UTC cron expression';
    }
  }, [schedCron]);

  const handleSaveSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secretName.trim() || !secretValue) return;
    try {
      await api.upsertSecret(session, {
        name: secretName.trim().toUpperCase(),
        value: secretValue,
        description: secretDesc.trim(),
      });
      onNotify(`Encrypted secret ${secretName.trim().toUpperCase()} with AES-256-GCM`, 'ok');
      setSecretName('');
      setSecretValue('');
      setSecretDesc('');
      await loadAll();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to store secret', 'err');
    }
  };

  const handleDeleteSecret = async (name: string) => {
    try {
      await api.deleteSecret(session, name);
      onNotify(`Deleted secret ${name}`, 'info');
      await loadAll();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Delete failed', 'err');
    }
  };

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!schedWfId) return;
    try {
      const parsedInput = JSON.parse(schedInput) as Record<string, unknown>;
      await api.createSchedule(session, {
        workflowId: schedWfId,
        name: schedName.trim(),
        cron: schedCron.trim(),
        input: parsedInput,
        enabled: schedEnabled,
      });
      onNotify(`Created durable cron schedule "${schedName}"`, 'ok');
      await loadAll();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Invalid schedule configuration', 'err');
    }
  };

  const handleToggleSchedule = async (sc: WorkflowSchedule) => {
    try {
      await api.updateSchedule(session, sc.id, { enabled: !sc.enabled });
      onNotify(`${sc.name} ${sc.enabled ? 'paused' : 'enabled'}`, 'info');
      await loadAll();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Toggle failed', 'err');
    }
  };

  const handleTriggerScheduleNow = async (sc: WorkflowSchedule) => {
    try {
      const res = await api.triggerSchedule(session, sc.id);
      onNotify(`Triggered ${sc.name} -> ${res.run.id}`, 'ok');
      onInspectRun(res.run.id);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Manual trigger failed', 'err');
    }
  };

  const handleDeleteSchedule = async (id: string) => {
    try {
      await api.deleteSchedule(session, id);
      onNotify('Schedule deleted', 'info');
      await loadAll();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Delete failed', 'err');
    }
  };

  const handleComputeHmac = async () => {
    if (!hookSignSecret) return;
    try {
      const res = await api.signWebhookPayload(session, hookSignSecret, hookPayload);
      setHookSignature(res.signature);
      onNotify(`Signed payload using vault secret "${hookSignSecret}"`, 'ok');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'HMAC signing failed', 'err');
    }
  };

  const handleFireWebhook = async () => {
    if (!hookWfId) return;
    try {
      const parsed = JSON.parse(hookPayload) as Record<string, unknown>;
      const headers: Record<string, string> = {};
      if (hookDeliveryId.trim()) headers['X-Webhook-Id'] = hookDeliveryId.trim();
      if (hookSignature.trim()) headers['X-SagaFlow-Signature'] = hookSignature.trim();
      const res = await api.fireInboundWebhook(tenantSlug, hookWfId, parsed, headers);
      setHookResult({
        runId: res.run.id,
        deduplicated: res.deduplicated,
        signatureVerified: res.signatureVerified,
      });
      onNotify(
        res.deduplicated
          ? `Deduplicated duplicate delivery -> ${res.run.id}`
          : `Webhook accepted -> ${res.run.id}`,
        'ok'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Webhook rejected', 'err');
    }
  };

  const webhookUrl = `${window.location.origin}/api/hooks/${tenantSlug}/${hookWfId || '<workflowId>'}`;
  const curlSnippet = `curl -X POST "${webhookUrl}" \\\n  -H "Content-Type: application/json" \\\n  -H "X-Webhook-Id: ${hookDeliveryId}"${
    hookSignature ? ` \\\n  -H "X-SagaFlow-Signature: ${hookSignature}"` : ''
  } \\\n  -d '${hookPayload.replace(/\s+/g, ' ').trim()}'`;

  return (
    <div className="sf-surface-bg h-full overflow-y-auto p-5 lg:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        {/* Breadcrumb */}
        <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
          <span className="tracking-[0.12em] text-[#808d99]">
            AUTOMATION / SECRETS_CRON_WEBHOOKS / <span className="text-[#22e55c]">AES_256_GCM</span>
          </span>
          <span className="rounded border border-[#262c32] bg-[#111417] px-2 py-0.5 text-[#808d99]">
            VAULT: <strong className="text-[#22e55c]">{secrets.length} KEYS</strong> · SCHEDULES:{' '}
            <strong className="text-[#f1f5f9]">{schedules.length}</strong>
          </span>
        </div>

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded border border-[#22e55c]/35 bg-[#22e55c]/[0.08] text-[#22e55c]">
              <ShieldCheck className="h-4.5 w-4.5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-[#f1f5f9]">
                Automation, Secrets &amp; Inbound Webhooks
              </h1>
              <p className="mt-1 text-xs text-[#808d99]">
                Write-only AES-256-GCM secrets with automatic output redaction, HMAC-SHA256 webhook
                triggers, and durable 5-field UTC cron schedules.
              </p>
            </div>
          </div>
          <button
            onClick={() => void loadAll()}
            className="sf-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[11px]"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>

        {/* ROW 1: ENCRYPTED VAULT + PUBLIC WEBHOOK TESTER */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* AES-256-GCM Secret Vault */}
          <div className="sf-card sf-top-neon space-y-4 p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-[#22e55c]" />
                <h3 className="text-sm font-semibold text-[#f1f5f9]">AES-256-GCM Secret Vault</h3>
              </div>
              <span className="rounded border border-[#22e55c]/25 bg-[#22e55c]/[0.08] px-2 py-0.5 font-mono text-[10px] text-[#22e55c]">
                Write-Only · Auto-Redacted
              </span>
            </div>

            <div className="space-y-2">
              {secrets.map((s) => (
                <div
                  key={s.name}
                  className="flex items-center justify-between rounded border border-[#262c32] bg-[#111417] px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <KeyRound className="h-3.5 w-3.5 text-[#f59e0b]" />
                      <span className="font-mono text-xs font-semibold text-[#fbbf24]">
                        {s.name}
                      </span>
                      <span className="rounded border border-[#262c32] bg-[#15191d] px-1.5 py-0.5 font-mono text-[10px] text-[#808d99]">
                        ••••••••
                      </span>
                    </div>
                    {s.description && (
                      <div className="mt-0.5 text-[11px] text-[#808d99]">{s.description}</div>
                    )}
                  </div>
                  <button
                    onClick={() => void handleDeleteSecret(s.name)}
                    className="sf-btn-danger p-1.5"
                    title="Delete secret"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {secrets.length === 0 && (
                <p className="py-3 font-mono text-xs text-[#808d99]">
                  No tenant secrets stored yet.
                </p>
              )}
            </div>

            <form
              onSubmit={handleSaveSecret}
              className="space-y-2.5 border-t border-[#262c32] pt-3"
            >
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={secretName}
                  onChange={(e) => setSecretName(e.target.value)}
                  placeholder="WEBHOOK_SECRET"
                  className="sf-input px-2.5 py-1.5"
                />
                <input
                  type="password"
                  value={secretValue}
                  onChange={(e) => setSecretValue(e.target.value)}
                  placeholder="Secret plaintext value"
                  className="sf-input px-2.5 py-1.5 font-sans"
                />
              </div>
              <div className="flex gap-2">
                <input
                  value={secretDesc}
                  onChange={(e) => setSecretDesc(e.target.value)}
                  placeholder="Description (optional)"
                  className="sf-input flex-1 px-2.5 py-1.5 font-sans"
                />
                <button
                  type="submit"
                  className="sf-btn-primary inline-flex items-center gap-1 px-3 py-1.5 font-mono text-[11px] uppercase"
                >
                  <Plus className="h-3.5 w-3.5" /> Encrypt
                </button>
              </div>
            </form>
          </div>

          {/* Public Inbound Webhook & HMAC-SHA256 Signer */}
          <div className="sf-card sf-top-amber space-y-3 p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Webhook className="h-4 w-4 text-[#22e55c]" />
                <h3 className="text-sm font-semibold text-[#f1f5f9]">
                  Public Inbound Webhook &amp; HMAC Signer
                </h3>
              </div>
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(curlSnippet);
                  setCopiedCurl(true);
                  setTimeout(() => setCopiedCurl(false), 1800);
                }}
                className="sf-btn-secondary inline-flex items-center gap-1 px-2.5 py-1 font-mono text-[10.5px]"
              >
                {copiedCurl ? (
                  <Check className="h-3 w-3 text-[#22e55c]" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                {copiedCurl ? 'Copied cURL' : 'Copy cURL'}
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <select
                value={hookWfId}
                onChange={(e) => setHookWfId(e.target.value)}
                className="sf-input px-2.5 py-1.5 font-sans"
              >
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <div className="flex gap-1.5">
                <input
                  value={hookDeliveryId}
                  onChange={(e) => setHookDeliveryId(e.target.value)}
                  placeholder="X-Webhook-Id"
                  className="sf-input flex-1 px-2.5 py-1.5"
                />
                <button
                  type="button"
                  onClick={() => setHookDeliveryId(`evt_${Date.now()}`)}
                  className="sf-btn-secondary px-2 font-mono text-[10px]"
                >
                  New ID
                </button>
              </div>
            </div>

            <textarea
              rows={4}
              value={hookPayload}
              onChange={(e) => setHookPayload(e.target.value)}
              className="sf-input w-full p-2.5 text-[11px] text-[#73ff86]"
            />

            {/* Real HMAC-SHA256 Signing */}
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={hookSignSecret}
                onChange={(e) => setHookSignSecret(e.target.value)}
                className="sf-input px-2 py-1.5 text-[11px] text-[#fbbf24]"
              >
                <option value="">No HMAC secret</option>
                {secrets.map((s) => (
                  <option key={s.name} value={s.name}>
                    Sign with {s.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void handleComputeHmac()}
                disabled={!hookSignSecret}
                className="rounded border border-[#f59e0b]/40 bg-[#f59e0b]/[0.08] px-2.5 py-1.5 font-mono text-[11px] font-medium text-[#fbbf24] transition hover:bg-[#f59e0b]/15 disabled:opacity-40"
              >
                Compute HMAC-SHA256
              </button>
              <button
                type="button"
                onClick={() => void handleFireWebhook()}
                className="sf-btn-primary ml-auto inline-flex items-center gap-1.5 px-3.5 py-1.5 font-mono text-[11px] uppercase"
              >
                <Play className="h-3.5 w-3.5 fill-current" /> Fire Live Webhook
              </button>
            </div>

            {hookSignature && (
              <div className="truncate rounded border border-[#262c32] bg-[#111417] px-2.5 py-1.5 font-mono text-[10px] text-[#fbbf24]">
                X-SagaFlow-Signature: {hookSignature}
              </div>
            )}

            {hookResult && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#22e55c]/35 bg-[#22e55c]/[0.08] px-3 py-2 font-mono text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[#73ff86]">{hookResult.runId}</span>
                  {hookResult.signatureVerified && (
                    <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/15 px-1.5 py-0.5 text-[10px] text-[#22e55c]">
                      HMAC VERIFIED
                    </span>
                  )}
                  {hookResult.deduplicated && (
                    <span className="rounded border border-[#f59e0b]/30 bg-[#f59e0b]/15 px-1.5 py-0.5 text-[10px] text-[#fbbf24]">
                      DEDUPLICATED
                    </span>
                  )}
                </div>
                <button
                  onClick={() => onInspectRun(hookResult.runId)}
                  className="font-semibold text-[#22e55c] hover:underline"
                >
                  Inspect Live Trace →
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ROW 2: DURABLE UTC CRON SCHEDULER */}
        <div className="sf-card overflow-hidden">
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-[#22e55c]" />
                <h3 className="text-sm font-semibold text-[#f1f5f9]">
                  Durable 5-Field UTC Cron Schedules
                </h3>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.expr}
                    type="button"
                    onClick={() => setSchedCron(p.expr)}
                    className="sf-btn-secondary px-2 py-1 font-mono text-[10px]"
                  >
                    {p.label} (<span className="text-[#22e55c]">{p.expr}</span>)
                  </button>
                ))}
              </div>
            </div>

            <form onSubmit={handleCreateSchedule} className="grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="md:col-span-3">
                <label className="sf-label-sm block text-[#808d99]">WORKFLOW</label>
                <select
                  value={schedWfId}
                  onChange={(e) => setSchedWfId(e.target.value)}
                  className="sf-input mt-1 w-full px-2.5 py-2 font-sans"
                >
                  {workflows.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="md:col-span-3">
                <label className="sf-label-sm block text-[#808d99]">SCHEDULE NAME</label>
                <input
                  value={schedName}
                  onChange={(e) => setSchedName(e.target.value)}
                  className="sf-input mt-1 w-full px-2.5 py-2 font-sans"
                />
              </div>
              <div className="md:col-span-2">
                <label className="sf-label-sm block text-[#808d99]">CRON (UTC)</label>
                <input
                  value={schedCron}
                  onChange={(e) => setSchedCron(e.target.value)}
                  className="sf-input mt-1 w-full px-2.5 py-2 text-[#73ff86]"
                />
              </div>
              <div className="md:col-span-2">
                <label className="sf-label-sm block text-[#808d99]">JSON INPUT</label>
                <input
                  value={schedInput}
                  onChange={(e) => setSchedInput(e.target.value)}
                  className="sf-input mt-1 w-full px-2.5 py-2"
                />
              </div>
              <div className="flex items-end md:col-span-2">
                <button
                  type="submit"
                  className="sf-btn-primary w-full py-2 font-mono text-[11px] uppercase tracking-wider"
                >
                  Add Schedule
                </button>
              </div>
            </form>

            {/* Live Next 3 UTC Fires Preview */}
            <div className="flex flex-wrap items-center gap-2 rounded border border-[#262c32] bg-[#111417] px-3 py-2 font-mono text-[11px]">
              <span className="font-medium text-[#f1f5f9]">{cronDescription}</span>
              {nextCronDates.length > 0 && (
                <>
                  <span className="text-[#808d99]">· NEXT UTC FIRES:</span>
                  {nextCronDates.map((d) => (
                    <span
                      key={d.toISOString()}
                      className="rounded border border-[#262c32] bg-[#15191d] px-2 py-0.5 text-[10px] text-[#22e55c]"
                    >
                      {d.toISOString().replace('T', ' ').slice(0, 16)}Z
                    </span>
                  ))}
                </>
              )}
              <label className="ml-auto flex cursor-pointer items-center gap-2 font-sans text-xs text-[#c7d1db]">
                <input
                  type="checkbox"
                  checked={schedEnabled}
                  onChange={(e) => setSchedEnabled(e.target.checked)}
                  className="sf-checkbox"
                />
                Start enabled
              </label>
            </div>
          </div>

          {/* Schedules Compact Table */}
          <div className="border-t border-[#262c32]">
            {schedules.length === 0 ? (
              <div className="bg-[#111417] py-6 text-center font-mono text-xs text-[#808d99]">
                No schedules configured yet.
              </div>
            ) : (
              <div className="divide-y divide-[#262c32]/70">
                {schedules.map((sc) => (
                  <div
                    key={sc.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 transition hover:bg-[#181e23]"
                  >
                    <div>
                      <div className="flex items-center gap-2 font-mono">
                        <span className="font-sans text-xs font-semibold text-[#f1f5f9]">
                          {sc.name}
                        </span>
                        <span className="rounded border border-[#262c32] bg-[#111417] px-2 py-0.5 text-[10px] text-[#22e55c]">
                          {sc.cron}
                        </span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider ${
                            sc.enabled
                              ? 'border border-[#22e55c]/30 bg-[#22e55c]/[0.08] text-[#22e55c]'
                              : 'border border-[#262c32] bg-[#111417] text-[#808d99]'
                          }`}
                        >
                          {sc.enabled ? 'ACTIVE' : 'PAUSED'}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-[#808d99]">
                        {sc.workflowName} · Next:{' '}
                        <span className="text-[#c7d1db]">
                          {sc.nextRunAt ? sc.nextRunAt.replace('T', ' ').slice(0, 16) + 'Z' : '—'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void handleToggleSchedule(sc)}
                        className="sf-btn-secondary px-2.5 py-1 font-mono text-[11px]"
                      >
                        {sc.enabled ? 'Pause' : 'Enable'}
                      </button>
                      <button
                        onClick={() => void handleTriggerScheduleNow(sc)}
                        className="inline-flex items-center gap-1 rounded border border-[#22e55c]/35 bg-[#22e55c]/[0.08] px-2.5 py-1 font-mono text-[11px] font-semibold text-[#22e55c] transition hover:bg-[#22e55c]/15"
                      >
                        <Play className="h-3 w-3 fill-current" /> Run Now
                      </button>
                      <button
                        onClick={() => void handleDeleteSchedule(sc.id)}
                        className="sf-btn-danger p-1.5"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* v6.0 REAL HMAC-SIGNED ALERT RULES & SLA ESCALATION WEBHOOKS */}
        <div className="sf-card sf-top-amber overflow-hidden">
          <div className="border-b border-[#262c32] bg-[#111417] px-5 py-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-[#fbbf24]" />
                <h2 className="text-sm font-semibold text-[#f1f5f9]">
                  Alert Rules &amp; SLA Escalation Webhooks
                </h2>
                <span className="rounded border border-[#f59e0b]/35 bg-[#f59e0b]/10 px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-[#fbbf24]">
                  HMAC-SHA256 SIGNED
                </span>
              </div>
              <span className="font-mono text-[10.5px] text-[#808d99]">
                {alertRules.length} RULE{alertRules.length === 1 ? '' : 'S'}
              </span>
            </div>
            <p className="mt-1 text-xs text-[#808d99]">
              Automatically pushes signed JSON alerts to Slack, PagerDuty, Discord, or the live{' '}
              <code className="text-[#73ff86]">/api/sink/{tenantSlug}/alerts</code> inbox on run
              failures, compensations, DLQ entries, and Approval Gate SLA breaches.
            </p>
          </div>

          <div className="space-y-4 p-5">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label className="sf-label-sm block text-[#808d99]">RULE NAME</label>
                <input
                  value={alertName}
                  onChange={(e) => setAlertName(e.target.value)}
                  className="sf-input mt-1 w-full px-3 py-2"
                />
              </div>
              <div>
                <label className="sf-label-sm block text-[#808d99]">DESTINATION WEBHOOK URL</label>
                <input
                  value={alertUrl}
                  onChange={(e) => setAlertUrl(e.target.value)}
                  placeholder="/api/sink/acme-commerce/alerts"
                  className="sf-input mt-1 w-full px-3 py-2 text-[#73ff86]"
                />
              </div>
              <div>
                <label className="sf-label-sm block text-[#808d99]">HMAC SIGNING SECRET</label>
                <input
                  value={alertSecret}
                  onChange={(e) => setAlertSecret(e.target.value)}
                  placeholder="Optional HMAC-SHA256 secret"
                  className="sf-input mt-1 w-full px-3 py-2"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {ALERT_EVENT_TYPES.map((ev) => {
                  const checked = alertEvents.includes(ev);
                  return (
                    <button
                      key={ev}
                      type="button"
                      onClick={() =>
                        setAlertEvents((prev) =>
                          checked
                            ? prev.length > 1
                              ? prev.filter((x) => x !== ev)
                              : prev
                            : [...prev, ev]
                        )
                      }
                      className={`rounded border px-2 py-1 font-mono text-[10.5px] transition ${
                        checked
                          ? 'border-[#22e55c]/45 bg-[#22e55c]/12 text-[#22e55c]'
                          : 'border-[#262c32] bg-[#111417] text-[#808d99] hover:text-[#f1f5f9]'
                      }`}
                    >
                      {checked ? '✓ ' : ''}
                      {ev}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={async () => {
                  if (!alertName.trim() || !alertUrl.trim()) return;
                  try {
                    await api.createAlertRule(session, {
                      name: alertName.trim(),
                      eventTypes: alertEvents,
                      webhookUrl: alertUrl.trim(),
                      signingSecret: alertSecret.trim() || undefined,
                      enabled: true,
                    });
                    onNotify(`Alert rule "${alertName.trim()}" created`, 'ok');
                    await loadAll();
                  } catch (err) {
                    onNotify(err instanceof Error ? err.message : 'Failed to create alert rule', 'err');
                  }
                }}
                className="sf-btn-primary inline-flex items-center gap-1.5 px-3.5 py-2 font-mono text-[11px] uppercase"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Alert Rule
              </button>
            </div>

            {alertRules.length === 0 ? (
              <div className="rounded border border-dashed border-[#262c32] bg-[#111417] py-6 text-center font-mono text-xs text-[#808d99]">
                No alert rules configured yet.
              </div>
            ) : (
              <div className="space-y-2.5">
                {alertRules.map((rule) => (
                  <div
                    key={rule.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded border border-[#262c32] bg-[#111417] px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold text-[#f1f5f9]">{rule.name}</span>
                        <span
                          className={`rounded border px-1.5 py-0.2 font-mono text-[9.5px] font-bold uppercase ${
                            rule.enabled
                              ? 'border-[#22e55c]/35 bg-[#22e55c]/10 text-[#22e55c]'
                              : 'border-[#262c32] bg-[#15191d] text-[#808d99]'
                          }`}
                        >
                          {rule.enabled ? 'ACTIVE' : 'PAUSED'}
                        </span>
                        {rule.lastStatusCode && (
                          <span className="font-mono text-[10px] text-[#73ff86]">
                            HTTP {rule.lastStatusCode} · {rule.triggerCount} sent
                          </span>
                        )}
                      </div>
                      <div className="mt-1 truncate font-mono text-[10.5px] text-[#808d99]">
                        {rule.webhookUrl} · [{rule.eventTypes.join(', ')}]
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={testingAlertId === rule.id}
                        onClick={async () => {
                          setTestingAlertId(rule.id);
                          try {
                            const res = await api.testAlertRule(session, rule.id);
                            onNotify(
                              res.outcome.delivered
                                ? `Signed test alert delivered (HTTP ${res.outcome.statusCode})`
                                : `Alert delivery failed: ${res.outcome.error}`,
                              res.outcome.delivered ? 'ok' : 'err'
                            );
                            await loadAll();
                          } catch (err) {
                            onNotify(err instanceof Error ? err.message : 'Test alert failed', 'err');
                          } finally {
                            setTestingAlertId(null);
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded border border-[#22e55c]/35 bg-[#22e55c]/[0.08] px-2.5 py-1 font-mono text-[10.5px] font-semibold text-[#22e55c] hover:bg-[#22e55c]/15"
                      >
                        <Send className="h-3 w-3" />
                        {testingAlertId === rule.id ? 'Sending...' : 'Test Alert'}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await api.updateAlertRule(session, rule.id, { enabled: !rule.enabled });
                          await loadAll();
                        }}
                        className="sf-btn-secondary px-2.5 py-1 font-mono text-[10.5px]"
                      >
                        {rule.enabled ? 'Pause' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await api.deleteAlertRule(session, rule.id);
                          await loadAll();
                        }}
                        className="sf-btn-danger p-1.5"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
