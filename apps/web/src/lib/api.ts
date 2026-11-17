import {
  ApiError,
  type AiAgentChatRequest,
  type AiAgentChatResponse,
  type AiProviderConfig,
  type AiTestConnectionInput,
  type AlertRule,
  type ApiErrorBody,
  type ApiKeyInfo,
  type ApprovalRequest,
  type ApprovalStatus,
  type AuthUser,
  type CreateAlertRuleInput,
  type CreateProjectInput,
  type CreateScheduleInput,
  type CreateTenantInput,
  type DlqEntry,
  type DraftWorkflowInput,
  type DryRunWorkflowResult,
  type MetricsSnapshot,
  type ProjectSummary,
  type RbacRole,
  type ResumeRunFromStepInput,
  type RunDetail,
  type RunDiagnosisResponse,
  type RunEvent,
  type RunSummary,
  type SaveAiConfigInput,
  type SecretMetadata,
  type SignedAuditBundle,
  type StorageStatus,
  type StressTestInput,
  type StressTestResult,
  type Tenant,
  type TenantAccountBalance,
  type TenantInventoryItem,
  type TenantKvRecord,
  type TenantMember,
  type TenantStateSnapshot,
  type UpdateAlertRuleInput,
  type UpdateScheduleInput,
  type UpsertSecretInput,
  type Workflow,
  type WorkflowDiffSummary,
  type WorkflowListItem,
  type WorkflowSchedule,
  type WorkflowVersionSummary,
} from '@sagaflow/shared';

export const DEMO_USER_ID = 'usr_demo_admin';

export interface TenantSession {
  tenantId: string;
  userId: string;
  apiKey?: string;
  token?: string;
}

export interface ScheduleViewItem extends WorkflowSchedule {
  description?: string;
}

export interface HealthResponse {
  status: string;
  version?: string;
  role?: 'all' | 'api' | 'worker';
  authMode: 'dev' | 'prod';
  encryption?: string;
  deployment?: { platform: string; ephemeralStorage: boolean };
  scheduler?: { running: boolean; pollIntervalMs: number; totalFired: number };
  storage: StorageStatus;
  queue: { driver: string; pending: number; active: number; concurrency: number };
  timestamp: string;
}

export interface SandboxTestResponse {
  result: {
    ok: boolean;
    output?: unknown;
    logs: string[];
    durationMs: number;
    error?: string;
  };
}

/**
 * Single fetch wrapper per API Contract Section 7 & 8:
 * - Sends tenant headers (or X-Api-Key)
 * - Parses unified error shape into ApiError
 * - Handles network failures (no JSON body) as `api_unavailable`
 */
async function apiRequest<T>(
  path: string,
  session: TenantSession | null,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (session) {
    if (session.apiKey) {
      headers.set('X-Api-Key', session.apiKey);
    } else if (session.token) {
      headers.set('Authorization', `Bearer ${session.token}`);
      headers.set('X-Tenant-Id', session.tenantId);
    } else {
      headers.set('X-Tenant-Id', session.tenantId);
      headers.set('X-User-Id', session.userId);
    }
  }

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  } catch {
    throw new ApiError(502, 'api_unavailable', 'Unable to reach SagaFlow API server.');
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new ApiError(res.status, 'api_unavailable', text.slice(0, 200));
      }
    }
  }

  if (!res.ok) {
    const errBody = json as Partial<ApiErrorBody> | null;
    throw new ApiError(
      res.status,
      errBody?.code ?? 'internal_error',
      errBody?.message ?? `Request failed with HTTP ${res.status}`,
      errBody?.errors
    );
  }

  return json as T;
}

export const api = {
  health: () => apiRequest<HealthResponse>('/api/health', null),

  listTenants: () => apiRequest<{ tenants: Tenant[] }>('/api/tenants', null),

  createTenant: (input: CreateTenantInput) =>
    apiRequest<{ tenant: Tenant }>('/api/tenants', null, {
      method: 'POST',
      headers: { 'X-User-Id': DEMO_USER_ID },
      body: JSON.stringify(input),
    }),

  validateWorkflow: (def: DraftWorkflowInput) =>
    apiRequest<{ valid: true; nodeCount: number; edgeCount: number; topologicalOrder: string[] }>(
      '/api/workflows/validate',
      null,
      { method: 'POST', body: JSON.stringify(def) }
    ),

  listWorkflows: (session: TenantSession) =>
    apiRequest<{ workflows: WorkflowListItem[] }>('/api/workflows', session),

  getWorkflow: (session: TenantSession, id: string) =>
    apiRequest<{ workflow: Workflow }>(`/api/workflows/${encodeURIComponent(id)}`, session),

  createWorkflow: (session: TenantSession, input: DraftWorkflowInput) =>
    apiRequest<{ workflow: Workflow }>('/api/workflows', session, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  saveWorkflow: (session: TenantSession, id: string, input: DraftWorkflowInput) =>
    apiRequest<{ workflow: Workflow }>(`/api/workflows/${encodeURIComponent(id)}`, session, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  deleteWorkflow: (session: TenantSession, id: string) =>
    apiRequest<{ deleted: boolean }>(`/api/workflows/${encodeURIComponent(id)}`, session, {
      method: 'DELETE',
    }),

  publishWorkflow: (session: TenantSession, id: string) =>
    apiRequest<{ workflow: Workflow; version: WorkflowVersionSummary }>(
      `/api/workflows/${encodeURIComponent(id)}/publish`,
      session,
      { method: 'POST' }
    ),

  listVersions: (session: TenantSession, id: string) =>
    apiRequest<{ versions: WorkflowVersionSummary[] }>(
      `/api/workflows/${encodeURIComponent(id)}/versions`,
      session
    ),

  exportWorkflow: (session: TenantSession, id: string) =>
    apiRequest<Record<string, unknown>>(
      `/api/workflows/${encodeURIComponent(id)}/export`,
      session
    ),

  importWorkflow: (session: TenantSession, payload: unknown) =>
    apiRequest<{ workflow: Workflow }>('/api/workflows/import', session, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  startRun: (
    session: TenantSession,
    workflowId: string,
    body: { versionNumber?: number; input?: Record<string, unknown> } = {},
    idempotencyKey: string = crypto.randomUUID()
  ) =>
    apiRequest<{ run: RunSummary }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/runs`,
      session,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
      }
    ),

  listRuns: (
    session: TenantSession,
    params: { workflowId?: string; status?: string; limit?: number; cursor?: string } = {}
  ) => {
    const qs = new URLSearchParams();
    if (params.workflowId) qs.set('workflowId', params.workflowId);
    if (params.status) qs.set('status', params.status);
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.cursor) qs.set('cursor', params.cursor);
    const q = qs.toString();
    return apiRequest<{ runs: RunSummary[]; nextCursor: string | null }>(
      `/api/runs${q ? `?${q}` : ''}`,
      session
    );
  },

  getRun: (session: TenantSession, runId: string) =>
    apiRequest<{ run: RunDetail; events: RunEvent[] }>(
      `/api/runs/${encodeURIComponent(runId)}`,
      session
    ),

  cancelRun: (session: TenantSession, runId: string) =>
    apiRequest<{ run: RunSummary }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, session, {
      method: 'POST',
    }),

  listDlq: (session: TenantSession) =>
    apiRequest<{ entries: DlqEntry[] }>('/api/dlq', session),

  replayDlq: (session: TenantSession, dlqId: string) =>
    apiRequest<{ run: RunDetail; entry: DlqEntry }>(
      `/api/dlq/${encodeURIComponent(dlqId)}/replay`,
      session,
      { method: 'POST' }
    ),

  deleteDlq: (session: TenantSession, dlqId: string) =>
    apiRequest<{ deleted: boolean }>(`/api/dlq/${encodeURIComponent(dlqId)}`, session, {
      method: 'DELETE',
    }),

  testSandbox: (
    session: TenantSession,
    body: { code: string; input?: Record<string, unknown>; steps?: Record<string, unknown>; timeoutMs?: number; memoryLimitMb?: number }
  ) =>
    apiRequest<SandboxTestResponse>('/api/sandbox/test', session, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listApiKeys: (session: TenantSession) =>
    apiRequest<{ apiKeys: ApiKeyInfo[] }>('/api/api-keys', session),

  createApiKey: (session: TenantSession, name: string) =>
    apiRequest<{ apiKey: ApiKeyInfo; rawKey: string }>('/api/api-keys', session, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  revokeApiKey: (session: TenantSession, keyId: string) =>
    apiRequest<{ revoked: boolean }>(`/api/api-keys/${encodeURIComponent(keyId)}`, session, {
      method: 'DELETE',
    }),

  getMetrics: (session: TenantSession) =>
    apiRequest<{ metrics: MetricsSnapshot }>('/api/admin/metrics', session),

  runStressTest: (session: TenantSession, input: StressTestInput) =>
    apiRequest<{ result: StressTestResult }>('/api/admin/stress-test', session, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // Self-Hosted Auth
  authMe: (token?: string) =>
    apiRequest<{ authenticated: boolean; authMode: 'dev' | 'prod'; user: AuthUser | null; tenants: Tenant[] }>(
      '/api/auth/me',
      null,
      token ? { headers: { Authorization: `Bearer ${token}` } } : {}
    ),

  authLogin: (email: string, password: string) =>
    apiRequest<{ user: AuthUser; token: string; tenants: Tenant[] }>('/api/auth/login', null, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  authRegister: (body: { email: string; name: string; password: string; tenantName?: string }) =>
    apiRequest<{ user: AuthUser; token: string; tenants: Tenant[] }>('/api/auth/register', null, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  authLogout: () =>
    apiRequest<{ loggedOut: boolean }>('/api/auth/logout', null, { method: 'POST' }),

  // Encrypted Secret Vault
  listSecrets: (session: TenantSession) =>
    apiRequest<{ secrets: SecretMetadata[] }>('/api/secrets', session),

  upsertSecret: (session: TenantSession, input: UpsertSecretInput) =>
    apiRequest<{ secret: SecretMetadata }>('/api/secrets', session, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteSecret: (session: TenantSession, name: string) =>
    apiRequest<{ deleted: boolean }>(`/api/secrets/${encodeURIComponent(name)}`, session, {
      method: 'DELETE',
    }),

  // Durable Cron Schedules
  listSchedules: (session: TenantSession) =>
    apiRequest<{ schedules: ScheduleViewItem[] }>('/api/schedules', session),

  createSchedule: (session: TenantSession, input: CreateScheduleInput) =>
    apiRequest<{ schedule: ScheduleViewItem }>('/api/schedules', session, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateSchedule: (session: TenantSession, id: string, patch: UpdateScheduleInput) =>
    apiRequest<{ schedule: ScheduleViewItem }>(`/api/schedules/${encodeURIComponent(id)}`, session, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteSchedule: (session: TenantSession, id: string) =>
    apiRequest<{ deleted: boolean }>(`/api/schedules/${encodeURIComponent(id)}`, session, {
      method: 'DELETE',
    }),

  triggerSchedule: (session: TenantSession, id: string) =>
    apiRequest<{ run: RunDetail; schedule: ScheduleViewItem }>(
      `/api/schedules/${encodeURIComponent(id)}/trigger`,
      session,
      { method: 'POST' }
    ),

  // Public Inbound Webhook Trigger
  fireInboundWebhook: (
    tenantSlug: string,
    workflowId: string,
    payload: Record<string, unknown>,
    headers: Record<string, string> = {}
  ) =>
    apiRequest<{
      accepted: boolean;
      deduplicated: boolean;
      signatureVerified: boolean;
      run: { id: string; workflowId: string; versionNumber: number; status: string; createdAt: string };
    }>(`/api/hooks/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(workflowId)}`, null, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }),

  signWebhookPayload: (session: TenantSession, secretName: string, payload: string) =>
    apiRequest<{ secretName: string; signature: string }>('/api/webhooks/sign', session, {
      method: 'POST',
      body: JSON.stringify({ secretName, payload }),
    }),

  // Real Live HTTP Request Tester
  testHttpRequest: (
    session: TenantSession,
    body: {
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
    }
  ) =>
    apiRequest<{
      ok: boolean;
      error?: string;
      result?: {
        status: number;
        url: string;
        method: string;
        latencyMs: number;
        sinkDeliveryId?: string;
        headers: Record<string, string>;
        body: unknown;
      };
    }>('/api/http/test', session, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Real Per-Tenant Transactional State & Saga Ledger
  getTenantState: (session: TenantSession) =>
    apiRequest<{ state: TenantStateSnapshot }>('/api/state', session),

  adjustInventory: (
    session: TenantSession,
    body: { sku: string; name?: string; warehouse?: string; deltaAvailable: number }
  ) =>
    apiRequest<{ item: TenantInventoryItem }>('/api/state/inventory', session, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  adjustBalance: (
    session: TenantSession,
    body: { accountId: string; label?: string; currency?: string; deltaAvailable: number }
  ) =>
    apiRequest<{ balance: TenantAccountBalance }>('/api/state/balances', session, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  setKv: (session: TenantSession, key: string, value: unknown) =>
    apiRequest<{ record: TenantKvRecord }>('/api/state/kv', session, {
      method: 'POST',
      body: JSON.stringify({ key, value }),
    }),

  deleteKv: (session: TenantSession, key: string) =>
    apiRequest<{ deleted: boolean }>(`/api/state/kv/${encodeURIComponent(key)}`, session, {
      method: 'DELETE',
    }),

  clearSinkDeliveries: (session: TenantSession) =>
    apiRequest<{ cleared: boolean }>('/api/state/sink', session, {
      method: 'DELETE',
    }),

  // Human-in-the-Loop Durable Approvals
  listApprovals: (session: TenantSession, status?: ApprovalStatus) => {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return apiRequest<{ approvals: ApprovalRequest[] }>(`/api/approvals${qs}`, session);
  },

  decideApproval: (
    session: TenantSession,
    approvalId: string,
    body: { decision: 'approved' | 'rejected'; decidedBy?: string; comment?: string }
  ) =>
    apiRequest<{ approval: ApprovalRequest; resumed: boolean }>(
      `/api/approvals/${encodeURIComponent(approvalId)}/decide`,
      session,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    ),

  getPrometheusMetrics: async (): Promise<string> => {
    const res = await fetch('/api/metrics');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },

  // Real AI Automation Agent (LM Studio & Google AI Studio / Gemini)
  getAiConfig: (session: TenantSession) =>
    apiRequest<{ config: AiProviderConfig }>('/api/ai/config', session),

  saveAiConfig: (session: TenantSession, body: SaveAiConfigInput) =>
    apiRequest<{ config: AiProviderConfig }>('/api/ai/config', session, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  testAiConnection: (session: TenantSession, body: AiTestConnectionInput = {}) =>
    apiRequest<{
      result: {
        ok: boolean;
        provider: 'google_ai_studio' | 'lm_studio';
        model: string;
        latencyMs: number;
        reply?: string;
        error?: string;
      };
    }>('/api/ai/test', session, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listLmStudioModels: (
    session: TenantSession,
    body: { baseUrl?: string; apiKey?: string } = {}
  ) =>
    apiRequest<{ models: Array<{ id: string; ownedBy?: string }>; latencyMs: number }>(
      '/api/ai/lmstudio/models',
      session,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    ),

  chatAiAgent: (session: TenantSession, body: AiAgentChatRequest) =>
    apiRequest<{ response: AiAgentChatResponse }>('/api/ai/agent/chat', session, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  diagnoseRun: (session: TenantSession, runId: string) =>
    apiRequest<{ diagnosis: RunDiagnosisResponse }>(
      `/api/ai/diagnose-run/${encodeURIComponent(runId)}`,
      session,
      { method: 'POST' }
    ),

  diffWorkflowVersions: (
    session: TenantSession,
    workflowId: string,
    from: string | number,
    to: string | number
  ) =>
    apiRequest<{ diff: WorkflowDiffSummary }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/diff?from=${encodeURIComponent(String(from))}&to=${encodeURIComponent(String(to))}`,
      session
    ),

  restoreWorkflowVersion: (
    session: TenantSession,
    workflowId: string,
    versionNumber: number
  ) =>
    apiRequest<{ workflow: Workflow; restoredFromVersion: number }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/versions/${versionNumber}/restore`,
      session,
      { method: 'POST' }
    ),

  listRbacMembers: (session: TenantSession) =>
    apiRequest<{ members: TenantMember[]; currentRole: RbacRole }>('/api/rbac/members', session),

  setRbacMemberRole: (session: TenantSession, userId: string, role: RbacRole) =>
    apiRequest<{ member: TenantMember; members: TenantMember[] }>('/api/rbac/members', session, {
      method: 'POST',
      body: JSON.stringify({ userId, role }),
    }),

  exportSignedAudit: (session: TenantSession) =>
    apiRequest<{ bundle: SignedAuditBundle }>('/api/audit/export', session),

  verifySignedAudit: (session: TenantSession, bundle: SignedAuditBundle) =>
    apiRequest<{ valid: boolean; algorithm: string; keyFingerprint: string; reason: string }>(
      '/api/audit/verify',
      session,
      { method: 'POST', body: JSON.stringify({ bundle }) }
    ),

  dryRunWorkflow: (
    session: TenantSession,
    workflowId: string,
    body: { input: Record<string, unknown>; nodes?: Workflow['nodes']; edges?: Workflow['edges'] }
  ) =>
    apiRequest<{ dryRun: DryRunWorkflowResult }>(
      `/api/workflows/${encodeURIComponent(workflowId)}/dry-run`,
      session,
      { method: 'POST', body: JSON.stringify(body) }
    ),

  resumeRunFromStep: (
    session: TenantSession,
    runId: string,
    nodeId: string,
    body: ResumeRunFromStepInput = {}
  ) =>
    apiRequest<{ run: RunDetail; reusedSteps: string[]; resetSteps: string[] }>(
      `/api/runs/${encodeURIComponent(runId)}/resume-from/${encodeURIComponent(nodeId)}`,
      session,
      { method: 'POST', body: JSON.stringify(body) }
    ),

  listAlertRules: (session: TenantSession) =>
    apiRequest<{ rules: AlertRule[] }>('/api/alerts', session),

  createAlertRule: (session: TenantSession, body: CreateAlertRuleInput) =>
    apiRequest<{ rule: AlertRule }>('/api/alerts', session, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateAlertRule: (session: TenantSession, ruleId: string, patch: UpdateAlertRuleInput) =>
    apiRequest<{ rule: AlertRule }>(`/api/alerts/${encodeURIComponent(ruleId)}`, session, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteAlertRule: (session: TenantSession, ruleId: string) =>
    apiRequest<{ deleted: boolean; id: string }>(
      `/api/alerts/${encodeURIComponent(ruleId)}`,
      session,
      { method: 'DELETE' }
    ),

  testAlertRule: (session: TenantSession, ruleId: string) =>
    apiRequest<{
      outcome: {
        delivered: boolean;
        statusCode: number | null;
        error: string | null;
        signatureHeader?: string;
      };
      rule: AlertRule;
    }>(`/api/alerts/${encodeURIComponent(ruleId)}/test`, session, { method: 'POST' }),

  sweepApprovalSlas: (session: TenantSession) =>
    apiRequest<{ handled: number }>('/api/approvals/sweep-sla', session, { method: 'POST' }),

  // v7.0 Projects Workspace Hub
  listProjects: () => apiRequest<{ projects: ProjectSummary[] }>('/api/projects', null),

  getProjectSummary: (projectId: string) =>
    apiRequest<{ project: ProjectSummary }>(
      `/api/projects/${encodeURIComponent(projectId)}/summary`,
      null
    ),

  createProject: (input: CreateProjectInput) =>
    apiRequest<{ tenant: Tenant; project: ProjectSummary; workflows: Workflow[] }>(
      '/api/projects',
      null,
      { method: 'POST', body: JSON.stringify(input) }
    ),
};

/**
 * Connects to the Resumable Durable Event Stream (SSE) for a workflow run.
 */
export function openRunEventStream(params: {
  session: TenantSession;
  runId: string;
  sinceOffset?: number;
  onSnapshot: (run: RunDetail) => void;
  onEvent: (event: RunEvent) => void;
  onStatusChange?: (connected: boolean) => void;
}): () => void {
  const { session, runId, sinceOffset = 0, onSnapshot, onEvent, onStatusChange } = params;
  const qs = new URLSearchParams({ since: String(sinceOffset) });
  if (session.apiKey) {
    qs.set('apiKey', session.apiKey);
  } else if (session.token) {
    qs.set('token', session.token);
    qs.set('tenantId', session.tenantId);
  } else {
    qs.set('tenantId', session.tenantId);
    qs.set('userId', session.userId);
  }

  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream?${qs.toString()}`);

  es.onopen = () => onStatusChange?.(true);
  es.onerror = () => onStatusChange?.(false);

  es.addEventListener('run.snapshot', (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as { run: RunDetail };
      onSnapshot(data.run);
    } catch {
      // ignore malformed frame
    }
  });

  const eventTypes = [
    'run.queued',
    'run.started',
    'run.waiting_approval',
    'step.started',
    'step.waiting_approval',
    'approval.decided',
    'attempt.started',
    'attempt.succeeded',
    'attempt.failed',
    'step.succeeded',
    'step.failed',
    'step.skipped',
    'run.compensating',
    'compensation.started',
    'compensation.succeeded',
    'compensation.failed',
    'step.compensated',
    'run.cancel_requested',
    'run.completed',
    'dlq.enqueued',
  ];

  for (const type of eventTypes) {
    es.addEventListener(type, (e) => {
      try {
        const parsed = JSON.parse((e as MessageEvent).data) as RunEvent;
        onEvent(parsed);
        if (type === 'run.completed') {
          onStatusChange?.(false);
          es.close();
        }
      } catch {
        // ignore
      }
    });
  }

  return () => {
    onStatusChange?.(false);
    es.close();
  };
}
