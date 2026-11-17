import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
  SagaLedgerEntry,
  SecretMetadata,
  StorageStatus,
  StoredSecretRecord,
  Tenant,
  TenantAccountBalance,
  TenantInventoryItem,
  TenantKvRecord,
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
import { makeId, nowIso } from '../utils/id.js';
import type {
  CreateRunStorageInput,
  ListRunsResult,
  StorageAdapter,
  StorageConfig,
  StoredAuthUser,
  VerifiedApiKey,
} from './interface.js';
import { buildMetricsSnapshot } from './metrics.js';

interface ControlStoreData {
  tenants: Tenant[];
  memberships: Array<{ tenantId: string; userId: string; role: string }>;
  apiKeys: Array<ApiKeyInfo & { hash: string }>;
  users?: StoredAuthUser[];
}

interface TenantStoreData {
  workflows: Workflow[];
  versions: WorkflowVersion[];
  runs: RunDetail[];
  events: Record<string, RunEvent[]>;
  dlq: DlqEntry[];
  secrets?: StoredSecretRecord[];
  schedules?: WorkflowSchedule[];
  inventory?: TenantInventoryItem[];
  balances?: TenantAccountBalance[];
  kv?: TenantKvRecord[];
  ledger?: SagaLedgerEntry[];
  sinkDeliveries?: WebhookSinkDelivery[];
  approvals?: ApprovalRequest[];
  alertRules?: AlertRule[];
}

function safeSegment(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!s) throw new Error('Invalid tenant ID');
  return s;
}

/**
 * Portable JSON Folder Storage Adapter ("Store Anything Anywhere"):
 * Writes clean, human-readable JSON files atomically (temp file + rename) into any directory
 * (local folder, Git repo, Dropbox, Syncthing, NFS mount) with per-tenant file isolation.
 */
export class JsonFileStorageAdapter implements StorageAdapter {
  private readonly config: StorageConfig;
  private readonly baseDir: string;
  private controlCache: ControlStoreData | null = null;
  private tenantCache = new Map<string, TenantStoreData>();
  private writeChains = new Map<string, Promise<unknown>>();

  constructor(config: StorageConfig) {
    this.config = config;
    this.baseDir = resolve(config.storagePath);
  }

  async init(): Promise<void> {
    mkdirSync(join(this.baseDir, 'tenants'), { recursive: true });
    await this.loadControl();
  }

  async close(): Promise<void> {
    await Promise.all(this.writeChains.values());
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeChains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.writeChains.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }

  private async atomicWriteJson(filePath: string, data: unknown): Promise<void> {
    const tmp = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, filePath);
  }

  private get controlPath(): string {
    return join(this.baseDir, 'control.json');
  }

  private tenantPath(tenantId: string): string {
    return join(this.baseDir, 'tenants', `${safeSegment(tenantId)}.json`);
  }

  private async loadControl(): Promise<ControlStoreData> {
    if (this.controlCache) return this.controlCache;
    if (existsSync(this.controlPath)) {
      const raw = await readFile(this.controlPath, 'utf8');
      this.controlCache = JSON.parse(raw) as ControlStoreData;
    } else {
      this.controlCache = { tenants: [], memberships: [], apiKeys: [] };
      await this.atomicWriteJson(this.controlPath, this.controlCache);
    }
    return this.controlCache;
  }

  private async saveControl(data: ControlStoreData): Promise<void> {
    this.controlCache = data;
    await this.atomicWriteJson(this.controlPath, data);
  }

  private async loadTenant(tenantId: string): Promise<TenantStoreData> {
    const cached = this.tenantCache.get(tenantId);
    if (cached) return cached;
    const p = this.tenantPath(tenantId);
    if (existsSync(p)) {
      const raw = await readFile(p, 'utf8');
      const parsed = JSON.parse(raw) as TenantStoreData;
      this.tenantCache.set(tenantId, parsed);
      return parsed;
    }
    const fresh: TenantStoreData = {
      workflows: [],
      versions: [],
      runs: [],
      events: {},
      dlq: [],
    };
    this.tenantCache.set(tenantId, fresh);
    await this.atomicWriteJson(p, fresh);
    return fresh;
  }

  private async saveTenant(tenantId: string, data: TenantStoreData): Promise<void> {
    this.tenantCache.set(tenantId, data);
    await this.atomicWriteJson(this.tenantPath(tenantId), data);
  }

  // ---------------- Control Plane ----------------

  async listTenants(): Promise<Tenant[]> {
    const c = await this.loadControl();
    return [...c.tenants];
  }

  async getTenant(tenantId: string): Promise<Tenant | null> {
    const c = await this.loadControl();
    return c.tenants.find((t) => t.id === tenantId) ?? null;
  }

  async getTenantBySlug(slug: string): Promise<Tenant | null> {
    const c = await this.loadControl();
    return c.tenants.find((t) => t.slug === slug) ?? null;
  }

  async createTenant(input: CreateTenantInput & { id?: string }): Promise<Tenant> {
    return this.withLock('control', async () => {
      const c = await this.loadControl();
      if (c.tenants.some((t) => t.slug === input.slug)) {
        throw new Error(`Tenant slug "${input.slug}" already exists`);
      }
      const tenant: Tenant = {
        id: input.id ?? makeId('ten'),
        name: input.name,
        slug: input.slug,
        maxConcurrentRuns: input.maxConcurrentRuns ?? 100,
        rateLimitPerMin: input.rateLimitPerMin ?? 300,
        createdAt: nowIso(),
      };
      c.tenants.push(tenant);
      await this.saveControl(c);
      await this.loadTenant(tenant.id);
      return tenant;
    });
  }

  async ensureMembership(tenantId: string, userId: string, role = 'owner'): Promise<void> {
    return this.withLock('control', async () => {
      const c = await this.loadControl();
      if (!c.memberships.some((m) => m.tenantId === tenantId && m.userId === userId)) {
        c.memberships.push({ tenantId, userId, role });
        await this.saveControl(c);
      }
    });
  }

  async hasMembership(tenantId: string, userId: string): Promise<boolean> {
    const c = await this.loadControl();
    return c.memberships.some((m) => m.tenantId === tenantId && m.userId === userId);
  }

  async getMembershipRole(tenantId: string, userId: string): Promise<import('@sagaflow/shared').RbacRole | null> {
    const c = await this.loadControl();
    const row = c.memberships.find((m) => m.tenantId === tenantId && m.userId === userId);
    if (!row) return null;
    const { normalizeRbacRole } = await import('@sagaflow/shared');
    return normalizeRbacRole(row.role);
  }

  async setMembershipRole(tenantId: string, userId: string, role: import('@sagaflow/shared').RbacRole): Promise<void> {
    return this.withLock('control', async () => {
      const c = await this.loadControl();
      const existing = c.memberships.find((m) => m.tenantId === tenantId && m.userId === userId);
      if (existing) {
        existing.role = role;
      } else {
        c.memberships.push({ tenantId, userId, role });
      }
      await this.saveControl(c);
    });
  }

  async listTenantMembers(tenantId: string): Promise<import('@sagaflow/shared').TenantMember[]> {
    const { normalizeRbacRole } = await import('@sagaflow/shared');
    const c = await this.loadControl();
    return c.memberships
      .filter((m) => m.tenantId === tenantId)
      .map((m) => {
        const u = (c.users ?? []).find((usr) => usr.id === m.userId);
        return {
          tenantId: m.tenantId,
          userId: m.userId,
          role: normalizeRbacRole(m.role),
          name: u?.name,
          email: u?.email,
        };
      });
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyInfo[]> {
    const c = await this.loadControl();
    return c.apiKeys
      .filter((k) => k.tenantId === tenantId)
      .map(({ hash: _h, ...info }) => info);
  }

  async createApiKey(
    tenantId: string,
    name: string,
    keyData: { id: string; prefix: string; hash: string }
  ): Promise<ApiKeyInfo> {
    return this.withLock('control', async () => {
      const c = await this.loadControl();
      const entry = {
        id: keyData.id,
        tenantId,
        name,
        prefix: keyData.prefix,
        hash: keyData.hash,
        createdAt: nowIso(),
        lastUsedAt: null,
        revokedAt: null,
      };
      c.apiKeys.unshift(entry);
      await this.saveControl(c);
      const { hash: _h, ...info } = entry;
      return info;
    });
  }

  async verifyApiKeyHash(hash: string): Promise<VerifiedApiKey | null> {
    return this.withLock('control', async () => {
      const c = await this.loadControl();
      const key = c.apiKeys.find((k) => k.hash === hash && !k.revokedAt);
      if (!key) return null;
      key.lastUsedAt = nowIso();
      await this.saveControl(c);
      return { keyId: key.id, tenantId: key.tenantId, name: key.name };
    });
  }

  async revokeApiKey(tenantId: string, keyId: string): Promise<boolean> {
    return this.withLock('control', async () => {
      const c = await this.loadControl();
      const key = c.apiKeys.find((k) => k.id === keyId && k.tenantId === tenantId && !k.revokedAt);
      if (!key) return false;
      key.revokedAt = nowIso();
      await this.saveControl(c);
      return true;
    });
  }

  // ---------------- Self-Hosted Users ----------------

  async createUser(input: {
    id?: string;
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<AuthUser> {
    return this.withLock('control', async () => {
      const c = await this.loadControl();
      if (!c.users) c.users = [];
      const email = input.email.toLowerCase();
      if (c.users.some((u) => u.email === email)) {
        throw new Error(`User with email "${email}" already exists`);
      }
      const record: StoredAuthUser = {
        id: input.id ?? makeId('usr'),
        email,
        name: input.name,
        passwordHash: input.passwordHash,
        createdAt: nowIso(),
      };
      c.users.push(record);
      await this.saveControl(c);
      const { passwordHash: _p, ...user } = record;
      return user;
    });
  }

  async getUserByEmail(email: string): Promise<StoredAuthUser | null> {
    const c = await this.loadControl();
    const u = (c.users ?? []).find((x) => x.email === email.toLowerCase());
    return u ? structuredClone(u) : null;
  }

  async getUserById(userId: string): Promise<AuthUser | null> {
    const c = await this.loadControl();
    const u = (c.users ?? []).find((x) => x.id === userId);
    if (!u) return null;
    const { passwordHash: _p, ...user } = u;
    return structuredClone(user);
  }

  async listUserTenants(userId: string): Promise<Tenant[]> {
    const c = await this.loadControl();
    const allowed = new Set(
      c.memberships.filter((m) => m.userId === userId).map((m) => m.tenantId)
    );
    return c.tenants.filter((t) => allowed.has(t.id));
  }

  // ---------------- Encrypted Secret Vault ----------------

  async listSecrets(tenantId: string): Promise<SecretMetadata[]> {
    const t = await this.loadTenant(tenantId);
    return (t.secrets ?? [])
      .map(({ encryptedValue: _e, ...meta }) => structuredClone(meta))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSecretRecord(tenantId: string, name: string): Promise<StoredSecretRecord | null> {
    const t = await this.loadTenant(tenantId);
    const rec = (t.secrets ?? []).find((s) => s.name === name);
    return rec ? structuredClone(rec) : null;
  }

  async getAllSecretRecords(tenantId: string): Promise<StoredSecretRecord[]> {
    const t = await this.loadTenant(tenantId);
    return structuredClone(t.secrets ?? []);
  }

  async upsertSecret(
    tenantId: string,
    input: { name: string; encryptedValue: string; description?: string }
  ): Promise<SecretMetadata> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      if (!t.secrets) t.secrets = [];
      const now = nowIso();
      const idx = t.secrets.findIndex((s) => s.name === input.name);
      if (idx !== -1) {
        const cur = t.secrets[idx];
        t.secrets[idx] = {
          ...cur,
          encryptedValue: input.encryptedValue,
          description: input.description ?? cur.description,
          updatedAt: now,
        };
        await this.saveTenant(tenantId, t);
        const { encryptedValue: _e, ...meta } = t.secrets[idx];
        return structuredClone(meta);
      }
      const created: StoredSecretRecord = {
        id: makeId('sec'),
        tenantId,
        name: input.name,
        description: input.description,
        encryptedValue: input.encryptedValue,
        createdAt: now,
        updatedAt: now,
      };
      t.secrets.push(created);
      await this.saveTenant(tenantId, t);
      const { encryptedValue: _e, ...meta } = created;
      return structuredClone(meta);
    });
  }

  async deleteSecret(tenantId: string, name: string): Promise<boolean> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      if (!t.secrets) return false;
      const before = t.secrets.length;
      t.secrets = t.secrets.filter((s) => s.name !== name);
      if (t.secrets.length === before) return false;
      await this.saveTenant(tenantId, t);
      return true;
    });
  }

  // ---------------- Durable Cron Schedules ----------------

  async listSchedules(tenantId: string): Promise<WorkflowSchedule[]> {
    const t = await this.loadTenant(tenantId);
    return structuredClone(t.schedules ?? []).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  async listDueSchedulesAcrossTenants(nowStr: string): Promise<WorkflowSchedule[]> {
    const tenants = await this.listTenants();
    const due: WorkflowSchedule[] = [];
    for (const ten of tenants) {
      const t = await this.loadTenant(ten.id);
      for (const s of t.schedules ?? []) {
        if (s.enabled && s.nextRunAt && s.nextRunAt <= nowStr) {
          due.push(structuredClone(s));
        }
      }
    }
    return due;
  }

  async getSchedule(tenantId: string, scheduleId: string): Promise<WorkflowSchedule | null> {
    const t = await this.loadTenant(tenantId);
    const s = (t.schedules ?? []).find((x) => x.id === scheduleId);
    return s ? structuredClone(s) : null;
  }

  async createSchedule(
    tenantId: string,
    input: CreateScheduleInput & { workflowName: string; nextRunAt: string | null }
  ): Promise<WorkflowSchedule> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      if (!t.schedules) t.schedules = [];
      const now = nowIso();
      const schedule: WorkflowSchedule = {
        id: makeId('sch'),
        tenantId,
        workflowId: input.workflowId,
        workflowName: input.workflowName,
        name: input.name,
        cron: input.cron,
        input: structuredClone(input.input ?? {}),
        enabled: input.enabled ?? true,
        nextRunAt: input.nextRunAt,
        lastRunAt: null,
        lastRunId: null,
        createdAt: now,
        updatedAt: now,
      };
      t.schedules.push(schedule);
      await this.saveTenant(tenantId, t);
      return structuredClone(schedule);
    });
  }

  async updateSchedule(
    tenantId: string,
    scheduleId: string,
    patch: UpdateScheduleInput & { nextRunAt?: string | null }
  ): Promise<WorkflowSchedule | null> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      if (!t.schedules) return null;
      const idx = t.schedules.findIndex((x) => x.id === scheduleId);
      if (idx === -1) return null;
      const cur = t.schedules[idx];
      const updated: WorkflowSchedule = {
        ...cur,
        name: patch.name ?? cur.name,
        cron: patch.cron ?? cur.cron,
        input: patch.input ? structuredClone(patch.input) : cur.input,
        enabled: patch.enabled ?? cur.enabled,
        nextRunAt: patch.nextRunAt !== undefined ? patch.nextRunAt : cur.nextRunAt,
        updatedAt: nowIso(),
      };
      t.schedules[idx] = updated;
      await this.saveTenant(tenantId, t);
      return structuredClone(updated);
    });
  }

  async markScheduleFired(
    tenantId: string,
    scheduleId: string,
    lastRunAt: string,
    lastRunId: string,
    nextRunAt: string | null
  ): Promise<WorkflowSchedule | null> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const s = (t.schedules ?? []).find((x) => x.id === scheduleId);
      if (!s) return null;
      s.lastRunAt = lastRunAt;
      s.lastRunId = lastRunId;
      s.nextRunAt = nextRunAt;
      s.updatedAt = nowIso();
      await this.saveTenant(tenantId, t);
      return structuredClone(s);
    });
  }

  async deleteSchedule(tenantId: string, scheduleId: string): Promise<boolean> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      if (!t.schedules) return false;
      const before = t.schedules.length;
      t.schedules = t.schedules.filter((x) => x.id !== scheduleId);
      if (t.schedules.length === before) return false;
      await this.saveTenant(tenantId, t);
      return true;
    });
  }

  // ---------------- Workflows ----------------

  async listWorkflows(tenantId: string): Promise<WorkflowListItem[]> {
    const t = await this.loadTenant(tenantId);
    return [...t.workflows]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        status: w.status,
        latestVersion: w.latestVersion,
        nodeCount: w.nodes.length,
        updatedAt: w.updatedAt,
      }));
  }

  async getWorkflow(tenantId: string, workflowId: string): Promise<Workflow | null> {
    const t = await this.loadTenant(tenantId);
    const wf = t.workflows.find((w) => w.id === workflowId);
    return wf ? structuredClone(wf) : null;
  }

  async createWorkflow(tenantId: string, input: DraftWorkflowInput, id?: string): Promise<Workflow> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const now = nowIso();
      const wf: Workflow = {
        id: id ?? makeId('wf'),
        name: input.name,
        description: input.description,
        status: 'draft',
        latestVersion: null,
        nodes: structuredClone(input.nodes ?? []),
        edges: structuredClone(input.edges ?? []),
        createdAt: now,
        updatedAt: now,
      };
      t.workflows.push(wf);
      await this.saveTenant(tenantId, t);
      return structuredClone(wf);
    });
  }

  async updateWorkflow(
    tenantId: string,
    workflowId: string,
    input: DraftWorkflowInput
  ): Promise<Workflow | null> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const idx = t.workflows.findIndex((w) => w.id === workflowId);
      if (idx === -1) return null;
      const existing = t.workflows[idx];
      const updated: Workflow = {
        ...existing,
        name: input.name,
        description: input.description ?? existing.description,
        nodes: structuredClone(input.nodes ?? []),
        edges: structuredClone(input.edges ?? []),
        updatedAt: nowIso(),
      };
      t.workflows[idx] = updated;
      await this.saveTenant(tenantId, t);
      return structuredClone(updated);
    });
  }

  async deleteWorkflow(tenantId: string, workflowId: string): Promise<boolean> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const before = t.workflows.length;
      t.workflows = t.workflows.filter((w) => w.id !== workflowId);
      if (t.workflows.length === before) return false;
      if (t.schedules) {
        t.schedules = t.schedules.filter((s) => s.workflowId !== workflowId);
      }
      await this.saveTenant(tenantId, t);
      return true;
    });
  }

  async publishWorkflow(
    tenantId: string,
    workflowId: string
  ): Promise<{ workflow: Workflow; version: WorkflowVersionSummary } | null> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const idx = t.workflows.findIndex((w) => w.id === workflowId);
      if (idx === -1) return null;
      const existing = t.workflows[idx];
      const nextVersion = (existing.latestVersion ?? 0) + 1;
      const now = nowIso();
      const version: WorkflowVersion = {
        id: makeId('ver'),
        workflowId,
        versionNumber: nextVersion,
        name: existing.name,
        nodes: structuredClone(existing.nodes),
        edges: structuredClone(existing.edges),
        createdAt: now,
      };
      t.versions.push(version);
      const updated: Workflow = {
        ...existing,
        status: 'published',
        latestVersion: nextVersion,
        updatedAt: now,
      };
      t.workflows[idx] = updated;
      await this.saveTenant(tenantId, t);
      return {
        workflow: structuredClone(updated),
        version: {
          id: version.id,
          workflowId: version.workflowId,
          versionNumber: version.versionNumber,
          createdAt: version.createdAt,
        },
      };
    });
  }

  async getWorkflowVersion(
    tenantId: string,
    workflowId: string,
    versionNumber: number
  ): Promise<WorkflowVersion | null> {
    const t = await this.loadTenant(tenantId);
    const v = t.versions.find(
      (ver) => ver.workflowId === workflowId && ver.versionNumber === versionNumber
    );
    return v ? structuredClone(v) : null;
  }

  async listWorkflowVersions(
    tenantId: string,
    workflowId: string
  ): Promise<WorkflowVersionSummary[]> {
    const t = await this.loadTenant(tenantId);
    return t.versions
      .filter((v) => v.workflowId === workflowId)
      .sort((a, b) => b.versionNumber - a.versionNumber)
      .map((v) => ({
        id: v.id,
        workflowId: v.workflowId,
        versionNumber: v.versionNumber,
        createdAt: v.createdAt,
      }));
  }

  // ---------------- Runs ----------------

  async createRunIdempotent(
    tenantId: string,
    input: CreateRunStorageInput
  ): Promise<{ run: RunDetail; created: boolean }> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const existing = t.runs.find(
        (r) => r.workflowId === input.workflowId && r.idempotencyKey === input.idempotencyKey
      );
      if (existing) {
        return { run: structuredClone(existing), created: false };
      }
      const run: RunDetail = {
        id: input.id,
        workflowId: input.workflowId,
        workflowName: input.workflowName,
        versionNumber: input.versionNumber,
        status: 'pending',
        cancelRequested: false,
        idempotencyKey: input.idempotencyKey,
        input: structuredClone(input.input),
        error: null,
        steps: [],
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      };
      t.runs.push(run);
      await this.saveTenant(tenantId, t);
      return { run: structuredClone(run), created: true };
    });
  }

  async getRun(tenantId: string, runId: string): Promise<RunDetail | null> {
    const t = await this.loadTenant(tenantId);
    const run = t.runs.find((r) => r.id === runId);
    return run ? structuredClone(run) : null;
  }

  async listRuns(tenantId: string, query: ListRunsQuery): Promise<ListRunsResult> {
    const t = await this.loadTenant(tenantId);
    let list = [...t.runs].sort((a, b) => {
      const cmp = b.createdAt.localeCompare(a.createdAt);
      return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
    });
    if (query.workflowId) list = list.filter((r) => r.workflowId === query.workflowId);
    if (query.status) list = list.filter((r) => r.status === query.status);
    if (query.cursor) {
      const [cTime, cId] = query.cursor.split('|');
      list = list.filter(
        (r) => r.createdAt < cTime || (r.createdAt === cTime && r.id < cId)
      );
    }
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const hasMore = list.length > limit;
    const page = list.slice(0, limit);
    const runs: RunSummary[] = page.map(({ input: _i, error: _e, steps: _s, ...summary }) => summary);
    const last = runs[runs.length - 1];
    return {
      runs,
      nextCursor: hasMore && last ? `${last.createdAt}|${last.id}` : null,
    };
  }

  async saveRun(tenantId: string, run: RunDetail): Promise<void> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const idx = t.runs.findIndex((r) => r.id === run.id);
      if (idx !== -1) {
        t.runs[idx] = structuredClone(run);
        await this.saveTenant(tenantId, t);
      }
    });
  }

  async requestCancelRun(tenantId: string, runId: string): Promise<RunDetail | null> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const run = t.runs.find((r) => r.id === runId);
      if (!run) return null;
      run.cancelRequested = true;
      await this.saveTenant(tenantId, t);
      return structuredClone(run);
    });
  }

  // ---------------- Events ----------------

  async appendRunEvent(
    tenantId: string,
    runId: string,
    type: RunEventType,
    payload: Record<string, unknown>,
    nodeId?: string
  ): Promise<RunEvent> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      if (!t.events[runId]) t.events[runId] = [];
      const list = t.events[runId];
      const event: RunEvent = {
        offset: list.length + 1,
        runId,
        type,
        timestamp: nowIso(),
        nodeId,
        payload,
      };
      list.push(event);
      await this.saveTenant(tenantId, t);
      return event;
    });
  }

  async listRunEvents(tenantId: string, runId: string, sinceOffset = 0): Promise<RunEvent[]> {
    const t = await this.loadTenant(tenantId);
    return (t.events[runId] ?? []).filter((e) => e.offset > sinceOffset);
  }

  // ---------------- DLQ ----------------

  async createDlqEntry(tenantId: string, entry: DlqEntry): Promise<DlqEntry> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      t.dlq.unshift(structuredClone(entry));
      await this.saveTenant(tenantId, t);
      return entry;
    });
  }

  async listDlqEntries(tenantId: string): Promise<DlqEntry[]> {
    const t = await this.loadTenant(tenantId);
    return structuredClone(t.dlq);
  }

  async getDlqEntry(tenantId: string, dlqId: string): Promise<DlqEntry | null> {
    const t = await this.loadTenant(tenantId);
    const e = t.dlq.find((d) => d.id === dlqId);
    return e ? structuredClone(e) : null;
  }

  async markDlqReplayed(
    tenantId: string,
    dlqId: string,
    replayedRunId: string
  ): Promise<DlqEntry | null> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const e = t.dlq.find((d) => d.id === dlqId);
      if (!e) return null;
      e.replayedRunId = replayedRunId;
      await this.saveTenant(tenantId, t);
      return structuredClone(e);
    });
  }

  async deleteDlqEntry(tenantId: string, dlqId: string): Promise<boolean> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const before = t.dlq.length;
      t.dlq = t.dlq.filter((d) => d.id !== dlqId);
      if (t.dlq.length === before) return false;
      await this.saveTenant(tenantId, t);
      return true;
    });
  }

  // ---------------- Real Per-Tenant Transactional State & Saga Ledger ----------------

  async getTenantState(tenantId: string): Promise<TenantStateSnapshot> {
    const t = await this.loadTenant(tenantId);
    return {
      tenantId,
      inventory: structuredClone(t.inventory ?? []).sort((a, b) => a.sku.localeCompare(b.sku)),
      balances: structuredClone(t.balances ?? []).sort((a, b) => a.accountId.localeCompare(b.accountId)),
      kv: structuredClone(t.kv ?? []).sort((a, b) => a.key.localeCompare(b.key)),
      ledger: structuredClone(t.ledger ?? []).slice(0, 100),
      sinkDeliveries: structuredClone(t.sinkDeliveries ?? []).slice(0, 50),
    };
  }

  async mutateInventory(
    tenantId: string,
    input: {
      sku: string;
      name?: string;
      warehouse?: string;
      deltaAvailable: number;
      deltaReserved?: number;
      requireSufficient?: boolean;
    }
  ): Promise<{ item: TenantInventoryItem; before: TenantInventoryItem | null }> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      if (!t.inventory) t.inventory = [];
      const now = nowIso();
      const idx = t.inventory.findIndex((i) => i.sku === input.sku);
      const before = idx !== -1 ? structuredClone(t.inventory[idx]) : null;
      let nextAvailable = before
        ? before.available + input.deltaAvailable
        : Math.max(0, input.deltaAvailable < 0 ? 100 + input.deltaAvailable : input.deltaAvailable);
      const nextReserved = Math.max(0, (before?.reserved ?? 0) + (input.deltaReserved ?? 0));
      if (input.requireSufficient && nextAvailable < 0) {
        throw new Error(
          `Insufficient inventory for ${input.sku}: requested ${Math.abs(input.deltaAvailable)}, available ${before?.available ?? 0}`
        );
      }
      nextAvailable = Math.max(0, nextAvailable);
      const item: TenantInventoryItem = {
        sku: input.sku,
        name: input.name ?? before?.name ?? input.sku,
        warehouse: input.warehouse ?? before?.warehouse ?? 'ap-south-1',
        available: nextAvailable,
        reserved: nextReserved,
        updatedAt: now,
      };
      if (idx !== -1) t.inventory[idx] = item;
      else t.inventory.push(item);
      await this.saveTenant(tenantId, t);
      return { before, item: structuredClone(item) };
    });
  }

  async mutateBalance(
    tenantId: string,
    input: {
      accountId: string;
      label?: string;
      currency?: string;
      deltaAvailable: number;
      deltaLocked?: number;
      requireSufficient?: boolean;
    }
  ): Promise<{ balance: TenantAccountBalance; before: TenantAccountBalance | null }> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      if (!t.balances) t.balances = [];
      const now = nowIso();
      const idx = t.balances.findIndex((b) => b.accountId === input.accountId);
      const before = idx !== -1 ? structuredClone(t.balances[idx]) : null;
      const currency = input.currency ?? before?.currency ?? 'USD';
      const nextAvailable = Number(((before?.available ?? 0) + input.deltaAvailable).toFixed(2));
      const nextLocked = Math.max(0, Number(((before?.locked ?? 0) + (input.deltaLocked ?? 0)).toFixed(2)));
      if (input.requireSufficient && nextAvailable < 0) {
        throw new Error(
          `Insufficient balance on "${input.accountId}": needed ${Math.abs(input.deltaAvailable)} ${currency}, available ${before?.available ?? 0} ${currency}`
        );
      }
      const balance: TenantAccountBalance = {
        accountId: input.accountId,
        label: input.label ?? before?.label ?? input.accountId,
        currency,
        available: nextAvailable,
        locked: nextLocked,
        updatedAt: now,
      };
      if (idx !== -1) t.balances[idx] = balance;
      else t.balances.push(balance);
      await this.saveTenant(tenantId, t);
      return { before, balance: structuredClone(balance) };
    });
  }

  async setKv(
    tenantId: string,
    key: string,
    value: unknown
  ): Promise<{ record: TenantKvRecord; previousValue: unknown; existed: boolean }> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      if (!t.kv) t.kv = [];
      const idx = t.kv.findIndex((x) => x.key === key);
      const existed = idx !== -1;
      const previousValue = existed ? structuredClone(t.kv[idx].value) : undefined;
      const record: TenantKvRecord = { key, value: structuredClone(value ?? null), updatedAt: nowIso() };
      if (idx !== -1) t.kv[idx] = record;
      else t.kv.push(record);
      await this.saveTenant(tenantId, t);
      return { record: structuredClone(record), previousValue, existed };
    });
  }

  async deleteKv(tenantId: string, key: string): Promise<boolean> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      if (!t.kv) return false;
      const before = t.kv.length;
      t.kv = t.kv.filter((x) => x.key !== key);
      if (t.kv.length === before) return false;
      await this.saveTenant(tenantId, t);
      return true;
    });
  }

  async appendLedgerEntry(
    tenantId: string,
    entry: Omit<SagaLedgerEntry, 'id' | 'tenantId' | 'createdAt'>
  ): Promise<SagaLedgerEntry> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      if (!t.ledger) t.ledger = [];
      const full: SagaLedgerEntry = {
        ...entry,
        id: makeId('ldg'),
        tenantId,
        createdAt: nowIso(),
      };
      t.ledger.unshift(full);
      if (t.ledger.length > 500) t.ledger = t.ledger.slice(0, 500);
      await this.saveTenant(tenantId, t);
      return structuredClone(full);
    });
  }

  async recordSinkDelivery(
    tenantId: string,
    delivery: Omit<WebhookSinkDelivery, 'id' | 'tenantId' | 'createdAt'>
  ): Promise<WebhookSinkDelivery> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      if (!t.sinkDeliveries) t.sinkDeliveries = [];
      const full: WebhookSinkDelivery = {
        ...delivery,
        id: makeId('snk'),
        tenantId,
        createdAt: nowIso(),
      };
      t.sinkDeliveries.unshift(full);
      if (t.sinkDeliveries.length > 200) t.sinkDeliveries = t.sinkDeliveries.slice(0, 200);
      await this.saveTenant(tenantId, t);
      return structuredClone(full);
    });
  }

  async clearSinkDeliveries(tenantId: string): Promise<void> {
    await this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      t.sinkDeliveries = [];
      await this.saveTenant(tenantId, t);
    });
  }

  async listPendingRunsAcrossTenants(): Promise<Array<{ tenantId: string; runId: string }>> {
    const tenants = await this.listTenants();
    const out: Array<{ tenantId: string; runId: string }> = [];
    for (const ten of tenants) {
      const t = await this.loadTenant(ten.id);
      for (const r of t.runs) {
        if (r.status === 'pending' || r.status === 'running' || r.status === 'compensating') {
          out.push({ tenantId: ten.id, runId: r.id });
        }
      }
    }
    return out;
  }

  async getTenantMetrics(tenantId: string, rateLimitUsed: number): Promise<MetricsSnapshot> {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    const t = await this.loadTenant(tenantId);
    return buildMetricsSnapshot({
      tenant,
      storage: await this.getStorageStatus(tenantId),
      workflows: await this.listWorkflows(tenantId),
      runs: t.runs,
      dlqEntries: t.dlq,
      rateLimitUsed,
    });
  }

  async getStorageStatus(tenantId?: string): Promise<StorageStatus> {
    const tenants = await this.listTenants();
    return {
      driver: 'json',
      isolation: 'db-per-tenant',
      location: this.baseDir,
      queueDriver: this.config.queueDriver,
      workerConcurrency: this.config.workerConcurrency,
      tenantDbPath: tenantId ? this.tenantPath(tenantId) : undefined,
      tenantCount: tenants.length,
    };
  }

  async createApproval(
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
  ): Promise<ApprovalRequest> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      t.approvals ??= [];
      const req: ApprovalRequest = {
        id: makeId('apr'),
        tenantId,
        runId: input.runId,
        workflowId: input.workflowId,
        workflowName: input.workflowName,
        nodeId: input.nodeId,
        stepLabel: input.stepLabel,
        prompt: input.prompt,
        approverRole: input.approverRole,
        callbackToken: `${makeId('cbk')}${makeId('tok').slice(4)}`,
        payload: input.payload ?? {},
        status: 'pending',
        decidedBy: null,
        comment: null,
        expiresAt: input.expiresAt ?? null,
        onTimeout: input.onTimeout ?? null,
        escalatedAt: null,
        createdAt: nowIso(),
        decidedAt: null,
      };
      t.approvals.unshift(req);
      await this.saveTenant(tenantId, t);
      return structuredClone(req);
    });
  }

  async listApprovals(tenantId: string, status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    const t = await this.loadTenant(tenantId);
    const list = t.approvals ?? [];
    return status ? list.filter((a) => a.status === status) : list;
  }

  async getApproval(tenantId: string, approvalId: string): Promise<ApprovalRequest | null> {
    const t = await this.loadTenant(tenantId);
    return (t.approvals ?? []).find((a) => a.id === approvalId) ?? null;
  }

  async getApprovalByRunNode(
    tenantId: string,
    runId: string,
    nodeId: string
  ): Promise<ApprovalRequest | null> {
    const t = await this.loadTenant(tenantId);
    return (t.approvals ?? []).find((a) => a.runId === runId && a.nodeId === nodeId) ?? null;
  }

  async getApprovalByToken(token: string): Promise<ApprovalRequest | null> {
    const tenants = await this.listTenants();
    for (const ten of tenants) {
      const t = await this.loadTenant(ten.id);
      const found = (t.approvals ?? []).find((a) => a.callbackToken === token);
      if (found) return found;
    }
    return null;
  }

  async decideApproval(
    tenantId: string,
    approvalId: string,
    decision: { status: 'approved' | 'rejected'; decidedBy: string; comment?: string }
  ): Promise<ApprovalRequest | null> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const target = (t.approvals ?? []).find((a) => a.id === approvalId);
      if (!target || target.status !== 'pending') return null;
      target.status = decision.status;
      target.decidedBy = decision.decidedBy;
      target.comment = decision.comment ?? null;
      target.decidedAt = nowIso();
      await this.saveTenant(tenantId, t);
      return structuredClone(target);
    });
  }

  async markApprovalEscalated(tenantId: string, approvalId: string): Promise<void> {
    await this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const target = (t.approvals ?? []).find((a) => a.id === approvalId);
      if (target) {
        target.escalatedAt = nowIso();
        await this.saveTenant(tenantId, t);
      }
    });
  }

  async listExpiredPendingApprovals(nowIsoStr: string): Promise<ApprovalRequest[]> {
    const tenants = await this.listTenants();
    const out: ApprovalRequest[] = [];
    for (const ten of tenants) {
      const t = await this.loadTenant(ten.id);
      for (const a of t.approvals ?? []) {
        if (a.status === 'pending' && a.expiresAt && a.expiresAt <= nowIsoStr) {
          out.push(structuredClone(a));
        }
      }
    }
    return out;
  }

  async listAlertRules(tenantId: string): Promise<AlertRule[]> {
    const t = await this.loadTenant(tenantId);
    return structuredClone(t.alertRules ?? []);
  }

  async getAlertRule(tenantId: string, ruleId: string): Promise<AlertRule | null> {
    const t = await this.loadTenant(tenantId);
    const found = (t.alertRules ?? []).find((r) => r.id === ruleId);
    return found ? structuredClone(found) : null;
  }

  async createAlertRule(tenantId: string, input: CreateAlertRuleInput): Promise<AlertRule> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      t.alertRules ??= [];
      const now = nowIso();
      const rule: AlertRule = {
        id: makeId('alr'),
        tenantId,
        name: input.name,
        eventTypes: input.eventTypes,
        webhookUrl: input.webhookUrl,
        signingSecret: input.signingSecret ?? null,
        enabled: input.enabled !== false,
        triggerCount: 0,
        lastTriggeredAt: null,
        lastStatusCode: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      };
      t.alertRules.unshift(rule);
      await this.saveTenant(tenantId, t);
      return structuredClone(rule);
    });
  }

  async updateAlertRule(
    tenantId: string,
    ruleId: string,
    patch: UpdateAlertRuleInput
  ): Promise<AlertRule | null> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const target = (t.alertRules ?? []).find((r) => r.id === ruleId);
      if (!target) return null;
      if (patch.name !== undefined) target.name = patch.name;
      if (patch.eventTypes !== undefined) target.eventTypes = patch.eventTypes;
      if (patch.webhookUrl !== undefined) target.webhookUrl = patch.webhookUrl;
      if (patch.signingSecret !== undefined) target.signingSecret = patch.signingSecret;
      if (patch.enabled !== undefined) target.enabled = patch.enabled;
      target.updatedAt = nowIso();
      await this.saveTenant(tenantId, t);
      return structuredClone(target);
    });
  }

  async deleteAlertRule(tenantId: string, ruleId: string): Promise<boolean> {
    return this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const before = (t.alertRules ?? []).length;
      t.alertRules = (t.alertRules ?? []).filter((r) => r.id !== ruleId);
      if (t.alertRules.length === before) return false;
      await this.saveTenant(tenantId, t);
      return true;
    });
  }

  async recordAlertDelivery(
    tenantId: string,
    ruleId: string,
    result: { statusCode: number | null; error: string | null }
  ): Promise<void> {
    await this.withLock(tenantId, async () => {
      const t = await this.loadTenant(tenantId);
      const target = (t.alertRules ?? []).find((r) => r.id === ruleId);
      if (!target) return;
      target.triggerCount += 1;
      target.lastTriggeredAt = nowIso();
      target.lastStatusCode = result.statusCode;
      target.lastError = result.error;
      target.updatedAt = nowIso();
      await this.saveTenant(tenantId, t);
    });
  }
}
