import type {
  AlertRule,
  ApiKeyInfo,
  ApprovalRequest,
  ApprovalStatus,
  AuthUser,
  CreateAlertRuleInput,
  CreateScheduleInput,
  CreateTenantInput,
  DlqEntry,
  DraftWorkflowInput,
  ListRunsQuery,
  MetricsSnapshot,
  RunDetail,
  RunEvent,
  RunEventType,
  RunSummary,
  RbacRole,
  SagaLedgerEntry,
  SecretMetadata,
  StorageStatus,
  StoredSecretRecord,
  Tenant,
  TenantAccountBalance,
  TenantInventoryItem,
  TenantKvRecord,
  TenantMember,
  TenantStateSnapshot,
  UpdateAlertRuleInput,
  UpdateScheduleInput,
  WebhookSinkDelivery,
  Workflow,
  WorkflowListItem,
  WorkflowSchedule,
  WorkflowVersion,
  WorkflowVersionSummary,
} from '@sagaflow/shared';

export interface StoredAuthUser extends AuthUser {
  passwordHash: string;
}

export interface CreateRunStorageInput {
  id: string;
  workflowId: string;
  workflowName: string;
  versionNumber: number;
  idempotencyKey: string;
  input: Record<string, unknown>;
}

export interface ListRunsResult {
  runs: RunSummary[];
  nextCursor: string | null;
}

export interface VerifiedApiKey {
  keyId: string;
  tenantId: string;
  name: string;
}

export interface StorageConfig {
  driver: 'sqlite' | 'json' | 'postgres';
  isolation: 'db-per-tenant' | 'shared' | 'rls';
  storagePath: string;
  databaseUrl?: string;
  libsqlAuthToken?: string;
  queueDriver: 'local' | 'nats';
  workerConcurrency: number;
}

/**
 * Storage-agnostic persistence contract enabling "Store Anything Anywhere":
 * - LibSQL / SQLite (zero-config local file, db-per-tenant physical isolation, or remote Turso)
 * - JSON directory store (human-readable portable files in any synced folder / Git / NFS)
 * - PostgreSQL with Row-Level Security (self-hosted multi-node production)
 */
export interface StorageAdapter {
  init(): Promise<void>;
  close(): Promise<void>;

  // Control-plane: Tenants, Memberships, Cryptographic API Keys
  listTenants(): Promise<Tenant[]>;
  getTenant(tenantId: string): Promise<Tenant | null>;
  getTenantBySlug(slug: string): Promise<Tenant | null>;
  createTenant(input: CreateTenantInput & { id?: string }): Promise<Tenant>;
  ensureMembership(tenantId: string, userId: string, role?: string): Promise<void>;
  hasMembership(tenantId: string, userId: string): Promise<boolean>;
  getMembershipRole(tenantId: string, userId: string): Promise<RbacRole | null>;
  setMembershipRole(tenantId: string, userId: string, role: RbacRole): Promise<void>;
  listTenantMembers(tenantId: string): Promise<TenantMember[]>;

  listApiKeys(tenantId: string): Promise<ApiKeyInfo[]>;
  createApiKey(
    tenantId: string,
    name: string,
    keyData: { id: string; prefix: string; hash: string }
  ): Promise<ApiKeyInfo>;
  verifyApiKeyHash(hash: string): Promise<VerifiedApiKey | null>;
  revokeApiKey(tenantId: string, keyId: string): Promise<boolean>;

  // Control-plane: Self-hosted Users (scrypt password hash + memberships)
  createUser(input: {
    id?: string;
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<AuthUser>;
  getUserByEmail(email: string): Promise<StoredAuthUser | null>;
  getUserById(userId: string): Promise<AuthUser | null>;
  listUserTenants(userId: string): Promise<Tenant[]>;

  // Tenant-scoped Encrypted Secret Vault (AES-256-GCM ciphertexts)
  listSecrets(tenantId: string): Promise<SecretMetadata[]>;
  getSecretRecord(tenantId: string, name: string): Promise<StoredSecretRecord | null>;
  getAllSecretRecords(tenantId: string): Promise<StoredSecretRecord[]>;
  upsertSecret(
    tenantId: string,
    input: { name: string; encryptedValue: string; description?: string }
  ): Promise<SecretMetadata>;
  deleteSecret(tenantId: string, name: string): Promise<boolean>;

  // Tenant-scoped Durable Cron Schedules
  listSchedules(tenantId: string): Promise<WorkflowSchedule[]>;
  listDueSchedulesAcrossTenants(nowIso: string): Promise<WorkflowSchedule[]>;
  getSchedule(tenantId: string, scheduleId: string): Promise<WorkflowSchedule | null>;
  createSchedule(
    tenantId: string,
    input: CreateScheduleInput & { workflowName: string; nextRunAt: string | null }
  ): Promise<WorkflowSchedule>;
  updateSchedule(
    tenantId: string,
    scheduleId: string,
    patch: UpdateScheduleInput & { nextRunAt?: string | null }
  ): Promise<WorkflowSchedule | null>;
  markScheduleFired(
    tenantId: string,
    scheduleId: string,
    lastRunAt: string,
    lastRunId: string,
    nextRunAt: string | null
  ): Promise<WorkflowSchedule | null>;
  deleteSchedule(tenantId: string, scheduleId: string): Promise<boolean>;

  // Tenant-scoped Workflows & Immutable Versions
  listWorkflows(tenantId: string): Promise<WorkflowListItem[]>;
  getWorkflow(tenantId: string, workflowId: string): Promise<Workflow | null>;
  createWorkflow(tenantId: string, input: DraftWorkflowInput, id?: string): Promise<Workflow>;
  updateWorkflow(tenantId: string, workflowId: string, input: DraftWorkflowInput): Promise<Workflow | null>;
  deleteWorkflow(tenantId: string, workflowId: string): Promise<boolean>;
  publishWorkflow(
    tenantId: string,
    workflowId: string
  ): Promise<{ workflow: Workflow; version: WorkflowVersionSummary } | null>;
  getWorkflowVersion(
    tenantId: string,
    workflowId: string,
    versionNumber: number
  ): Promise<WorkflowVersion | null>;
  listWorkflowVersions(tenantId: string, workflowId: string): Promise<WorkflowVersionSummary[]>;

  // Tenant-scoped Runs & Idempotency
  createRunIdempotent(
    tenantId: string,
    input: CreateRunStorageInput
  ): Promise<{ run: RunDetail; created: boolean }>;
  getRun(tenantId: string, runId: string): Promise<RunDetail | null>;
  listRuns(tenantId: string, query: ListRunsQuery): Promise<ListRunsResult>;
  saveRun(tenantId: string, run: RunDetail): Promise<void>;
  requestCancelRun(tenantId: string, runId: string): Promise<RunDetail | null>;

  // Durable Offset-Indexed Event Log (powers Resumable SSE Streams)
  appendRunEvent(
    tenantId: string,
    runId: string,
    type: RunEventType,
    payload: Record<string, unknown>,
    nodeId?: string
  ): Promise<RunEvent>;
  listRunEvents(tenantId: string, runId: string, sinceOffset?: number): Promise<RunEvent[]>;

  // Dead-Letter Queue (DLQ)
  createDlqEntry(tenantId: string, entry: DlqEntry): Promise<DlqEntry>;
  listDlqEntries(tenantId: string): Promise<DlqEntry[]>;
  getDlqEntry(tenantId: string, dlqId: string): Promise<DlqEntry | null>;
  markDlqReplayed(tenantId: string, dlqId: string, replayedRunId: string): Promise<DlqEntry | null>;
  deleteDlqEntry(tenantId: string, dlqId: string): Promise<boolean>;

  // Real Per-Tenant Transactional State, Saga Ledger & Webhook Sink
  getTenantState(tenantId: string): Promise<TenantStateSnapshot>;
  mutateInventory(
    tenantId: string,
    input: {
      sku: string;
      name?: string;
      warehouse?: string;
      deltaAvailable: number;
      deltaReserved?: number;
      requireSufficient?: boolean;
    }
  ): Promise<{ item: TenantInventoryItem; before: TenantInventoryItem | null }>;
  mutateBalance(
    tenantId: string,
    input: {
      accountId: string;
      label?: string;
      currency?: string;
      deltaAvailable: number;
      deltaLocked?: number;
      requireSufficient?: boolean;
    }
  ): Promise<{ balance: TenantAccountBalance; before: TenantAccountBalance | null }>;
  setKv(
    tenantId: string,
    key: string,
    value: unknown
  ): Promise<{ record: TenantKvRecord; previousValue: unknown; existed: boolean }>;
  deleteKv(tenantId: string, key: string): Promise<boolean>;
  appendLedgerEntry(
    tenantId: string,
    entry: Omit<SagaLedgerEntry, 'id' | 'tenantId' | 'createdAt'>
  ): Promise<SagaLedgerEntry>;
  recordSinkDelivery(
    tenantId: string,
    delivery: Omit<WebhookSinkDelivery, 'id' | 'tenantId' | 'createdAt'>
  ): Promise<WebhookSinkDelivery>;
  clearSinkDeliveries(tenantId: string): Promise<void>;

  // Human-in-the-Loop Durable Approvals
  createApproval(
    tenantId: string,
    input: {
      runId: string;
      workflowId: string;
      workflowName: string;
      nodeId: string;
      stepLabel: string;
      prompt: string;
      approverRole: string;
      payload: Record<string, unknown>;
      expiresAt?: string | null;
      onTimeout?: 'reject' | 'approve' | 'escalate' | null;
    }
  ): Promise<ApprovalRequest>;
  listApprovals(tenantId: string, status?: ApprovalStatus): Promise<ApprovalRequest[]>;
  getApproval(tenantId: string, approvalId: string): Promise<ApprovalRequest | null>;
  getApprovalByRunNode(
    tenantId: string,
    runId: string,
    nodeId: string
  ): Promise<ApprovalRequest | null>;
  getApprovalByToken(token: string): Promise<ApprovalRequest | null>;
  decideApproval(
    tenantId: string,
    approvalId: string,
    decision: { status: 'approved' | 'rejected'; decidedBy: string; comment?: string }
  ): Promise<ApprovalRequest | null>;
  markApprovalEscalated(tenantId: string, approvalId: string): Promise<void>;
  listExpiredPendingApprovals(nowIso: string): Promise<ApprovalRequest[]>;

  // Alert Rules (v6.0 Real Webhook Escalations)
  listAlertRules(tenantId: string): Promise<AlertRule[]>;
  getAlertRule(tenantId: string, ruleId: string): Promise<AlertRule | null>;
  createAlertRule(tenantId: string, input: CreateAlertRuleInput): Promise<AlertRule>;
  updateAlertRule(
    tenantId: string,
    ruleId: string,
    patch: UpdateAlertRuleInput
  ): Promise<AlertRule | null>;
  deleteAlertRule(tenantId: string, ruleId: string): Promise<boolean>;
  recordAlertDelivery(
    tenantId: string,
    ruleId: string,
    result: { statusCode: number | null; error: string | null }
  ): Promise<void>;

  // Recovery & Observability
  listPendingRunsAcrossTenants(): Promise<Array<{ tenantId: string; runId: string }>>;
  getTenantMetrics(tenantId: string, rateLimitUsed: number): Promise<MetricsSnapshot>;
  getStorageStatus(tenantId?: string): Promise<StorageStatus>;
}
