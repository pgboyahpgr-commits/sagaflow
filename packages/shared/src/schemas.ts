import { z } from 'zod';
import {
  ATTEMPT_KINDS,
  ATTEMPT_STATUSES,
  GRAPH_LIMITS,
  ISSUE_CODES,
  RUN_STATUSES,
  STEP_KINDS,
  STEP_STATUSES,
  WORKFLOW_STATUSES,
} from './constants.js';

export const PositionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Position = z.infer<typeof PositionSchema>;

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  initialDelayMs: z.number().int().min(10).max(30000).default(250),
  backoffMultiplier: z.number().min(1).max(5).default(2),
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const WorkflowNodeSchema = z.object({
  id: z.string().min(GRAPH_LIMITS.ID_MIN).max(GRAPH_LIMITS.ID_MAX),
  type: z.enum(STEP_KINDS),
  label: z.string().min(1).max(120).optional(),
  position: PositionSchema.optional(),
  config: z.record(z.unknown()).default({}),
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowEdgeSchema = z.object({
  id: z.string().min(GRAPH_LIMITS.ID_MIN).max(GRAPH_LIMITS.ID_MAX),
  from: z.string().min(GRAPH_LIMITS.ID_MIN).max(GRAPH_LIMITS.ID_MAX),
  to: z.string().min(GRAPH_LIMITS.ID_MIN).max(GRAPH_LIMITS.ID_MAX),
  label: z.string().max(80).optional(),
  condition: z.string().max(80).optional(),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

/**
 * Draft schema: allows 0 nodes and incomplete/invalid graphs per API Contract D3.
 */
export const DraftWorkflowSchema = z.object({
  name: z.string().trim().min(GRAPH_LIMITS.NAME_MIN).max(GRAPH_LIMITS.NAME_MAX),
  description: z.string().max(500).optional(),
  nodes: z.array(WorkflowNodeSchema).max(GRAPH_LIMITS.MAX_NODES).default([]),
  edges: z.array(WorkflowEdgeSchema).max(GRAPH_LIMITS.MAX_EDGES).default([]),
});
export type DraftWorkflowInput = z.infer<typeof DraftWorkflowSchema>;

/**
 * Strict WorkflowDefinition: requires at least 1 node (used for validate & publish).
 */
export const WorkflowDefinitionSchema = DraftWorkflowSchema.extend({
  nodes: z.array(WorkflowNodeSchema).min(1, 'Workflow must contain at least one node').max(GRAPH_LIMITS.MAX_NODES),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const GraphIssueSchema = z.object({
  code: z.enum(ISSUE_CODES),
  message: z.string(),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
  path: z.string().optional(),
});
export type GraphIssue = z.infer<typeof GraphIssueSchema>;

export const StartRunBodySchema = z
  .object({
    versionNumber: z.number().int().positive().optional(),
    input: z.record(z.unknown()).optional(),
  })
  .optional()
  .default({});
export type StartRunBody = z.infer<typeof StartRunBodySchema>;

export const ListRunsQuerySchema = z.object({
  workflowId: z.string().optional(),
  status: z.enum(RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;

export const CreateTenantSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, 'Slug must contain lowercase letters, numbers, and hyphens only')
    .min(2)
    .max(48),
  maxConcurrentRuns: z.number().int().min(1).max(10000).default(100),
  rateLimitPerMin: z.number().int().min(10).max(10000).default(300),
});
export type CreateTenantInput = z.infer<typeof CreateTenantSchema>;

export const CreateApiKeySchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeySchema>;

export const SandboxTestSchema = z.object({
  code: z.string().min(1).max(20000),
  input: z.record(z.unknown()).default({}),
  steps: z.record(z.unknown()).default({}),
  timeoutMs: z.number().int().min(50).max(5000).default(1500),
  memoryLimitMb: z.number().int().min(2).max(64).default(16),
});
export type SandboxTestInput = z.infer<typeof SandboxTestSchema>;

export const StressTestSchema = z.object({
  workflowId: z.string().min(1),
  totalRuns: z.number().int().min(5).max(1000).default(50),
  concurrency: z.number().int().min(1).max(100).default(20),
  input: z.record(z.unknown()).optional(),
});
export type StressTestInput = z.infer<typeof StressTestSchema>;

export const UpsertSecretSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'Secret name must be UPPER_SNAKE_CASE (2-64 chars, e.g. STRIPE_KEY)'),
  value: z.string().min(1).max(8192),
  description: z.string().max(240).optional(),
});
export type UpsertSecretInput = z.infer<typeof UpsertSecretSchema>;

export const CreateScheduleSchema = z.object({
  workflowId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  cron: z.string().trim().min(9).max(100),
  input: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>;

export const UpdateScheduleSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  cron: z.string().trim().min(9).max(100).optional(),
  input: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleSchema>;

export const RegisterUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  name: z.string().trim().min(2).max(100),
  password: z.string().min(6).max(128),
  tenantId: z.string().optional(),
  tenantName: z.string().trim().min(2).max(80).optional(),
});
export type RegisterUserInput = z.infer<typeof RegisterUserSchema>;

export const LoginUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
export type LoginUserInput = z.infer<typeof LoginUserSchema>;

// ============================================================
// API Resource Shapes (API Contract v1.1 + Extensions)
// ============================================================

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  status: (typeof WORKFLOW_STATUSES)[number];
  latestVersion: number | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowListItem {
  id: string;
  name: string;
  description?: string;
  status: (typeof WORKFLOW_STATUSES)[number];
  latestVersion: number | null;
  nodeCount: number;
  updatedAt: string;
}

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  versionNumber: number;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: string;
}

export interface WorkflowVersionSummary {
  id: string;
  workflowId: string;
  versionNumber: number;
  createdAt: string;
}

export interface StepError {
  code?: string;
  message: string;
}

export interface StepAttempt {
  attempt: number;
  kind: (typeof ATTEMPT_KINDS)[number];
  status: (typeof ATTEMPT_STATUSES)[number];
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  output?: unknown;
  logs?: string[];
  error: StepError | null;
}

export interface RunStep {
  nodeId: string;
  label: string;
  kind: (typeof STEP_KINDS)[number];
  status: (typeof STEP_STATUSES)[number];
  output?: unknown;
  attempts: StepAttempt[];
}

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName?: string;
  versionNumber: number;
  status: (typeof RUN_STATUSES)[number];
  cancelRequested: boolean;
  idempotencyKey?: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs?: number | null;
}

export interface RunDetail extends RunSummary {
  input: Record<string, unknown>;
  error: StepError | null;
  steps: RunStep[];
}

export type RunEventType =
  | 'run.queued'
  | 'run.started'
  | 'run.waiting_approval'
  | 'step.started'
  | 'step.waiting_approval'
  | 'approval.decided'
  | 'attempt.started'
  | 'attempt.succeeded'
  | 'attempt.failed'
  | 'step.succeeded'
  | 'step.failed'
  | 'step.skipped'
  | 'run.compensating'
  | 'compensation.started'
  | 'compensation.succeeded'
  | 'compensation.failed'
  | 'step.compensated'
  | 'run.cancel_requested'
  | 'run.completed'
  | 'dlq.enqueued';

export interface RunEvent {
  offset: number;
  runId: string;
  type: RunEventType;
  timestamp: string;
  nodeId?: string;
  payload: Record<string, unknown>;
}

export interface DlqEntry {
  id: string;
  runId: string;
  workflowId: string;
  workflowName: string;
  versionNumber: number;
  failedNodeId: string;
  failedStepLabel: string;
  runFinalStatus: (typeof RUN_STATUSES)[number];
  error: StepError;
  input: Record<string, unknown>;
  replayedRunId: string | null;
  createdAt: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  maxConcurrentRuns: number;
  rateLimitPerMin: number;
  createdAt: string;
}

export interface ApiKeyInfo {
  id: string;
  tenantId: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface StorageStatus {
  driver: 'sqlite' | 'json' | 'postgres';
  isolation: 'db-per-tenant' | 'shared' | 'rls';
  location: string;
  queueDriver: 'local' | 'nats';
  workerConcurrency: number;
  tenantDbPath?: string;
  tenantCount: number;
}

export interface StepHeatmapEntry {
  nodeId: string;
  label: string;
  kind: string;
  totalAttempts: number;
  failedAttempts: number;
  compensatedAttempts: number;
  avgLatencyMs: number;
  failureRate: number;
}

export interface MetricsSnapshot {
  tenantId: string;
  storage: StorageStatus;
  totals: {
    workflows: number;
    publishedWorkflows: number;
    runs: number;
    activeRuns: number;
    succeeded: number;
    compensated: number;
    failed: number;
    cancelled: number;
    dlqOpen: number;
  };
  quotas: {
    maxConcurrentRuns: number;
    activeRuns: number;
    rateLimitPerMin: number;
    rateLimitUsed: number;
  };
  latency: {
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    samples: number;
  };
  failureHeatmap: StepHeatmapEntry[];
  recentThroughput: Array<{ bucket: string; total: number; succeeded: number; compensated: number; failed: number }>;
}

export interface StressTestResult {
  workflowId: string;
  workflowName: string;
  totalRuns: number;
  concurrency: number;
  elapsedMs: number;
  runsPerSecond: number;
  outcomes: {
    succeeded: number;
    compensated: number;
    failed: number;
    cancelled: number;
  };
  latency: {
    minMs: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
}

export interface ApiErrorDetail {
  code?: string;
  message: string;
  path?: string;
  nodeId?: string;
  edgeId?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  errors?: ApiErrorDetail[];
}

export interface SecretMetadata {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSecretRecord extends SecretMetadata {
  encryptedValue: string;
}

export interface WorkflowSchedule {
  id: string;
  tenantId: string;
  workflowId: string;
  workflowName: string;
  name: string;
  cron: string;
  input: Record<string, unknown>;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

// ============================================================
// Real Per-Tenant Transactional State & Saga Ledger Shapes
// ============================================================

export interface TenantInventoryItem {
  sku: string;
  name: string;
  warehouse: string;
  available: number;
  reserved: number;
  updatedAt: string;
}

export interface TenantAccountBalance {
  accountId: string;
  label: string;
  currency: string;
  available: number;
  locked: number;
  updatedAt: string;
}

export interface TenantKvRecord {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface SagaLedgerEntry {
  id: string;
  tenantId: string;
  runId: string;
  nodeId: string;
  action: string;
  direction: 'execute' | 'compensate';
  resourceType: 'inventory' | 'balance' | 'payment' | 'shipment' | 'notification' | 'customs' | 'kv' | 'audit';
  resourceId: string;
  status: 'committed' | 'compensated' | 'failed';
  summary: string;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  createdAt: string;
}

export interface WebhookSinkDelivery {
  id: string;
  tenantId: string;
  channel: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  statusCode: number;
  createdAt: string;
}

export interface TenantStateSnapshot {
  tenantId: string;
  inventory: TenantInventoryItem[];
  balances: TenantAccountBalance[];
  kv: TenantKvRecord[];
  ledger: SagaLedgerEntry[];
  sinkDeliveries: WebhookSinkDelivery[];
}

export const RestockInventorySchema = z.object({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120).optional(),
  warehouse: z.string().trim().min(1).max(64).optional(),
  deltaAvailable: z.number().int().min(-100000).max(100000),
});

export const AdjustBalanceSchema = z.object({
  accountId: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(120).optional(),
  currency: z.string().trim().min(1).max(12).optional(),
  deltaAvailable: z.number().min(-1_000_000).max(1_000_000),
});

export const HttpTestSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  url: z.string().trim().min(1).max(2048),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
  timeoutMs: z.number().int().min(500).max(15000).optional(),
});

// ============================================================
// Human-in-the-Loop Durable Approval Gate Shapes
// ============================================================

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
  id: string;
  tenantId: string;
  runId: string;
  workflowId: string;
  workflowName: string;
  nodeId: string;
  stepLabel: string;
  prompt: string;
  approverRole: string;
  callbackToken: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  decidedBy: string | null;
  comment: string | null;
  expiresAt?: string | null;
  onTimeout?: 'reject' | 'approve' | 'escalate' | null;
  escalatedAt?: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export const DecideApprovalSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string().trim().min(1).max(120).optional(),
  comment: z.string().trim().max(500).optional(),
});
export type DecideApprovalInput = z.infer<typeof DecideApprovalSchema>;

// ============================================================
// AI Automation Agent (LM Studio & Google AI Studio / Gemini)
// ============================================================

export const AI_PROVIDERS = ['google_ai_studio', 'lm_studio'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiProviderConfig {
  provider: AiProvider;
  googleModel: string;
  googleBaseUrl: string;
  lmStudioBaseUrl: string;
  lmStudioModel: string;
  temperature: number;
  maxTokens: number;
  hasGoogleApiKey: boolean;
  hasLmStudioApiKey: boolean;
  updatedAt: string;
}

export const SaveAiConfigSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  googleApiKey: z.string().trim().max(512).optional(),
  clearGoogleApiKey: z.boolean().optional(),
  googleModel: z.string().trim().min(1).max(120).optional(),
  googleBaseUrl: z.string().trim().url().max(512).optional(),
  lmStudioBaseUrl: z.string().trim().min(1).max(512).optional(),
  lmStudioModel: z.string().trim().max(200).optional(),
  lmStudioApiKey: z.string().trim().max(512).optional(),
  clearLmStudioApiKey: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(16384).optional(),
});
export type SaveAiConfigInput = z.infer<typeof SaveAiConfigSchema>;

export const AiTestConnectionSchema = z.object({
  provider: z.enum(AI_PROVIDERS).optional(),
  googleApiKey: z.string().trim().max(512).optional(),
  googleModel: z.string().trim().min(1).max(120).optional(),
  googleBaseUrl: z.string().trim().url().max(512).optional(),
  lmStudioBaseUrl: z.string().trim().min(1).max(512).optional(),
  lmStudioModel: z.string().trim().max(200).optional(),
  lmStudioApiKey: z.string().trim().max(512).optional(),
});
export type AiTestConnectionInput = z.infer<typeof AiTestConnectionSchema>;

export const AiChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(16000),
});
export type AiChatMessage = z.infer<typeof AiChatMessageSchema>;

export const AiAgentChatRequestSchema = z.object({
  messages: z.array(AiChatMessageSchema).min(1).max(30),
  autoExecute: z.boolean().default(true),
  providerOverride: z.enum(AI_PROVIDERS).optional(),
  modelOverride: z.string().trim().min(1).max(200).optional(),
});
export type AiAgentChatRequest = z.infer<typeof AiAgentChatRequestSchema>;

export interface AiAgentToolExecution {
  tool: string;
  summary: string;
  status: 'succeeded' | 'failed' | 'proposed';
  workflowId?: string;
  runId?: string;
  approvalId?: string;
  scheduleId?: string;
  data?: unknown;
  error?: string;
}

export interface AiAgentChatResponse {
  reply: string;
  provider: AiProvider;
  model: string;
  latencyMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  actions: AiAgentToolExecution[];
}

// ============================================================
// v5 Enterprise Extensions: Version Diff, RBAC, Signed Audits & AI Forensics
// ============================================================

export interface WorkflowNodeDiff {
  id: string;
  label: string;
  type: (typeof STEP_KINDS)[number];
  changedFields: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export interface WorkflowDiffSummary {
  workflowId: string;
  fromRef: string;
  toRef: string;
  identical: boolean;
  addedNodes: Array<{ id: string; label: string; type: (typeof STEP_KINDS)[number] }>;
  removedNodes: Array<{ id: string; label: string; type: (typeof STEP_KINDS)[number] }>;
  modifiedNodes: WorkflowNodeDiff[];
  addedEdges: Array<{ id: string; from: string; to: string; condition?: string }>;
  removedEdges: Array<{ id: string; from: string; to: string; condition?: string }>;
}

export interface TenantMember {
  tenantId: string;
  userId: string;
  role: 'admin' | 'operator' | 'approver' | 'viewer';
  name?: string;
  email?: string;
  createdAt?: string;
}

export const UpsertTenantMemberSchema = z.object({
  userId: z.string().trim().min(2).max(120),
  role: z.enum(['admin', 'operator', 'approver', 'viewer']),
});
export type UpsertTenantMemberInput = z.infer<typeof UpsertTenantMemberSchema>;

export interface SignedAuditBundle {
  schemaVersion: 'sagaflow.audit.v1';
  generatedAt: string;
  tenant: {
    id: string;
    name: string;
    slug: string;
  };
  summary: {
    workflows: number;
    runs: number;
    approvals: number;
    ledgerEntries: number;
    dlqEntries: number;
    secretsCount: number;
  };
  workflows: WorkflowListItem[];
  runs: RunSummary[];
  approvals: ApprovalRequest[];
  ledger: SagaLedgerEntry[];
  dlq: DlqEntry[];
  signature: {
    algorithm: 'HMAC-SHA256';
    keyFingerprint: string;
    digest: string;
    signedAt: string;
  };
}

export interface RunDiagnosisResponse {
  runId: string;
  workflowName: string;
  runStatus: (typeof RUN_STATUSES)[number];
  source: 'llm' | 'deterministic';
  provider?: AiProvider;
  model?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  headline: string;
  rootCause: string;
  failedStep?: {
    nodeId: string;
    label: string;
    kind: string;
    attempts: number;
    error: string;
  };
  rollbackIntegrity: {
    compensatedSteps: number;
    ledgerRollbacks: number;
    verifiedClean: boolean;
    summary: string;
  };
  recommendations: Array<{
    title: string;
    detail: string;
    actionType?: 'replay' | 'edit_workflow' | 'configure_ai' | 'inspect_ledger';
  }>;
  latencyMs: number;
}

// ============================================================
// SagaFlow v6.0 — Time-Travel Step Resume, Dry-Run Debugger & Alert Rules
// ============================================================

export const ResumeRunFromStepSchema = z.object({
  inputOverrides: z.record(z.unknown()).optional(),
  stepOutputOverrides: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().trim().min(1).max(128).optional(),
});
export type ResumeRunFromStepInput = z.infer<typeof ResumeRunFromStepSchema>;

export const DryRunWorkflowSchema = z.object({
  input: z.record(z.unknown()).default({}),
  nodes: z.array(WorkflowNodeSchema).optional(),
  edges: z.array(WorkflowEdgeSchema).optional(),
});
export type DryRunWorkflowInput = z.infer<typeof DryRunWorkflowSchema>;

export interface DryRunStepTrace {
  nodeId: string;
  label: string;
  type: (typeof STEP_KINDS)[number];
  order: number;
  status: 'would_execute' | 'would_skip' | 'would_pause' | 'error';
  resolvedConfig: Record<string, unknown>;
  resolvedTemplates: Array<{ key: string; expression: string; value: unknown }>;
  previewOutput?: unknown;
  branchDecision?: boolean | string | null;
  note: string;
  durationMs: number;
}

export interface DryRunWorkflowResult {
  workflowId: string;
  workflowName: string;
  valid: boolean;
  input: Record<string, unknown>;
  steps: DryRunStepTrace[];
  totalDurationMs: number;
  warnings: string[];
}

export interface AlertRule {
  id: string;
  tenantId: string;
  name: string;
  eventTypes: Array<
    'run.failed' | 'run.compensated' | 'dlq.created' | 'approval.requested' | 'approval.sla_breached'
  >;
  webhookUrl: string;
  signingSecret?: string | null;
  enabled: boolean;
  triggerCount: number;
  lastTriggeredAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CreateAlertRuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  eventTypes: z
    .array(
      z.enum([
        'run.failed',
        'run.compensated',
        'dlq.created',
        'approval.requested',
        'approval.sla_breached',
      ])
    )
    .min(1),
  webhookUrl: z.string().trim().min(1).max(2048),
  signingSecret: z.string().trim().max(256).optional(),
  enabled: z.boolean().default(true),
});
export type CreateAlertRuleInput = z.infer<typeof CreateAlertRuleSchema>;

export const UpdateAlertRuleSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  eventTypes: z
    .array(
      z.enum([
        'run.failed',
        'run.compensated',
        'dlq.created',
        'approval.requested',
        'approval.sla_breached',
      ])
    )
    .min(1)
    .optional(),
  webhookUrl: z.string().trim().min(1).max(2048).optional(),
  signingSecret: z.string().trim().max(256).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateAlertRuleInput = z.infer<typeof UpdateAlertRuleSchema>;

// ---------------- v7.0 Projects / Workspace Creation ----------------

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, 'Slug must contain lowercase letters, numbers, and hyphens only')
    .min(2)
    .max(48)
    .optional(),
  description: z.string().trim().max(300).optional(),
  mode: z.enum(['empty', 'template']).default('empty'),
  starterWorkflows: z.array(DraftWorkflowSchema).max(10).optional(),
  autoPublish: z.boolean().default(true),
  maxConcurrentRuns: z.number().int().min(1).max(10000).default(100),
  rateLimitPerMin: z.number().int().min(10).max(10000).default(300),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  description?: string;
  createdAt: string;
  workflowCount: number;
  publishedWorkflowCount: number;
  runCount: number;
  succeededRuns: number;
  failedRuns: number;
  pendingApprovals: number;
  openDlq: number;
  recentWorkflows: Array<{
    id: string;
    name: string;
    status: 'draft' | 'published';
    latestVersion: number | null;
    nodeCount: number;
    updatedAt: string;
  }>;
  recentRuns: Array<{
    id: string;
    workflowId: string;
    workflowName: string;
    status: string;
    durationMs: number | null;
    createdAt: string;
  }>;
}





