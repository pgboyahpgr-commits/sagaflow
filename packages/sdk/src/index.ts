import type {
  AiAgentChatRequest,
  AiAgentChatResponse,
  AlertRule,
  ApprovalRequest,
  CreateAlertRuleInput,
  CreateProjectInput,
  DraftWorkflowInput,
  DryRunWorkflowResult,
  ProjectSummary,
  RbacRole,
  ResumeRunFromStepInput,
  RunDetail,
  RunDiagnosisResponse,
  RunSummary,
  SignedAuditBundle,
  Tenant,
  TenantMember,
  UpdateAlertRuleInput,
  Workflow,
  WorkflowDiffSummary,
  WorkflowListItem,
} from '@sagaflow/shared';

export interface SagaFlowClientOptions {
  baseUrl: string;
  apiKey?: string;
  bearerToken?: string;
  tenantId?: string;
  userId?: string;
  fetch?: typeof fetch;
  fetchImpl?: typeof fetch;
}

/**
 * Official zero-dependency TypeScript SDK for SagaFlow v5.
 * Works identically in Node.js 20+, Edge runtimes, and modern browsers.
 */
export class SagaFlowClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly bearerToken?: string;
  private readonly tenantId?: string;
  private readonly userId?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SagaFlowClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.bearerToken = options.bearerToken;
    this.tenantId = options.tenantId;
    this.userId = options.userId;
    this.fetchImpl = options.fetch ?? options.fetchImpl ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    };
    if (this.apiKey) h['X-Api-Key'] = this.apiKey;
    if (this.bearerToken) h['Authorization'] = `Bearer ${this.bearerToken}`;
    if (this.tenantId) h['X-Tenant-Id'] = this.tenantId;
    if (this.userId) h['X-User-Id'] = this.userId;
    return h;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init?.headers as Record<string, string> | undefined),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: { message: text } };
    }
    if (!res.ok) {
      const errObj = (json as { error?: { code?: string; message?: string } })?.error;
      throw new Error(
        `SagaFlow HTTP ${res.status} (${errObj?.code ?? 'error'}): ${errObj?.message ?? res.statusText}`
      );
    }
    return json as T;
  }

  health(): Promise<{ status: string; version: string }> {
    return this.request('/api/health');
  }

  getRbacMe(): Promise<{ tenantId: string; userId: string; role: RbacRole }> {
    return this.request('/api/rbac/me');
  }

  listWorkflows(): Promise<{ workflows: WorkflowListItem[] }> {
    return this.request('/api/workflows');
  }

  getWorkflow(workflowId: string): Promise<{ workflow: Workflow }> {
    return this.request(`/api/workflows/${encodeURIComponent(workflowId)}`);
  }

  createWorkflow(input: DraftWorkflowInput): Promise<{ workflow: Workflow }> {
    return this.request('/api/workflows', { method: 'POST', body: JSON.stringify(input) });
  }

  publishWorkflow(workflowId: string): Promise<{ workflow: Workflow }> {
    return this.request(`/api/workflows/${encodeURIComponent(workflowId)}/publish`, {
      method: 'POST',
    });
  }

  diffWorkflowVersions(
    workflowId: string,
    from: string | number,
    to: string | number
  ): Promise<{ diff: WorkflowDiffSummary }> {
    const q = new URLSearchParams({ from: String(from), to: String(to) });
    return this.request(`/api/workflows/${encodeURIComponent(workflowId)}/diff?${q.toString()}`);
  }

  restoreWorkflowVersion(workflowId: string, versionNumber: number): Promise<{ workflow: Workflow }> {
    return this.request(
      `/api/workflows/${encodeURIComponent(workflowId)}/versions/${versionNumber}/restore`,
      { method: 'POST' }
    );
  }

  triggerRun(
    workflowId: string,
    params: {
      idempotencyKey: string;
      input?: Record<string, unknown>;
      versionNumber?: number;
    }
  ): Promise<{ run: RunDetail }> {
    return this.request(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': params.idempotencyKey },
      body: JSON.stringify({
        input: params.input ?? {},
        versionNumber: params.versionNumber,
      }),
    });
  }

  listRuns(limit = 20): Promise<{ runs: RunSummary[] }> {
    return this.request(`/api/runs?limit=${limit}`);
  }

  getRun(runId: string): Promise<{ run: RunDetail }> {
    return this.request(`/api/runs/${encodeURIComponent(runId)}`);
  }

  async waitForRun(
    runId: string,
    options?: { pollIntervalMs?: number; timeoutMs?: number }
  ): Promise<RunDetail> {
    const interval = options?.pollIntervalMs ?? 200;
    const timeout = options?.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeout;
    const terminal = new Set(['succeeded', 'failed', 'compensated', 'cancelled']);
    while (Date.now() < deadline) {
      const { run } = await this.getRun(runId);
      if (terminal.has(run.status)) return run;
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`Timed out waiting for run ${runId} after ${timeout}ms`);
  }

  diagnoseRun(runId: string): Promise<{ diagnosis: RunDiagnosisResponse }> {
    return this.request(`/api/ai/diagnose-run/${encodeURIComponent(runId)}`, { method: 'POST' });
  }

  listApprovals(status?: string): Promise<{ approvals: ApprovalRequest[] }> {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.request(`/api/approvals${q}`);
  }

  decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    comment?: string
  ): Promise<{ approval: ApprovalRequest }> {
    return this.request(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, comment }),
    });
  }

  listMembers(): Promise<{ members: TenantMember[]; currentRole: RbacRole }> {
    return this.request('/api/rbac/members');
  }

  setMemberRole(userId: string, role: RbacRole): Promise<{ member: TenantMember }> {
    return this.request('/api/rbac/members', {
      method: 'POST',
      body: JSON.stringify({ userId, role }),
    });
  }

  exportSignedAudit(): Promise<{ bundle: SignedAuditBundle }> {
    return this.request('/api/audit/export');
  }

  verifySignedAudit(bundle: SignedAuditBundle): Promise<{ valid: boolean; reason?: string }> {
    return this.request('/api/audit/verify', {
      method: 'POST',
      body: JSON.stringify({ bundle }),
    });
  }

  chatWithAgent(body: AiAgentChatRequest): Promise<AiAgentChatResponse> {
    return this.request('/api/ai/agent/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  dryRunWorkflow(
    workflowId: string,
    input: Record<string, unknown> = {}
  ): Promise<{ dryRun: DryRunWorkflowResult }> {
    return this.request(`/api/workflows/${encodeURIComponent(workflowId)}/dry-run`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
  }

  resumeRunFromStep(
    runId: string,
    nodeId: string,
    body: ResumeRunFromStepInput = {}
  ): Promise<{ run: RunDetail; reusedSteps: string[]; resetSteps: string[] }> {
    return this.request(
      `/api/runs/${encodeURIComponent(runId)}/resume-from/${encodeURIComponent(nodeId)}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    );
  }

  listAlertRules(): Promise<{ rules: AlertRule[] }> {
    return this.request('/api/alerts');
  }

  createAlertRule(input: CreateAlertRuleInput): Promise<{ rule: AlertRule }> {
    return this.request('/api/alerts', { method: 'POST', body: JSON.stringify(input) });
  }

  updateAlertRule(ruleId: string, patch: UpdateAlertRuleInput): Promise<{ rule: AlertRule }> {
    return this.request(`/api/alerts/${encodeURIComponent(ruleId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  deleteAlertRule(ruleId: string): Promise<{ deleted: boolean; id: string }> {
    return this.request(`/api/alerts/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
  }

  testAlertRule(ruleId: string): Promise<{
    outcome: { delivered: boolean; statusCode: number | null; error: string | null };
    rule: AlertRule;
  }> {
    return this.request(`/api/alerts/${encodeURIComponent(ruleId)}/test`, { method: 'POST' });
  }

  // ---------------- v7.0 Projects Workspace Hub ----------------

  listProjects(): Promise<{ projects: ProjectSummary[] }> {
    return this.request('/api/projects');
  }

  getProjectSummary(projectId: string): Promise<{ project: ProjectSummary }> {
    return this.request(`/api/projects/${encodeURIComponent(projectId)}/summary`);
  }

  createProject(input: CreateProjectInput): Promise<{
    tenant: Tenant;
    project: ProjectSummary;
    workflows: Workflow[];
  }> {
    return this.request('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }
}
