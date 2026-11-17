import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createClient, type Client } from '@libsql/client';
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
  RunStep,
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

function safeTenantFileSegment(tenantId: string): string {
  const cleaned = tenantId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleaned) throw new Error('Invalid tenantId');
  return cleaned;
}

const CONTROL_DDL = [
  `CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    max_concurrent_runs INTEGER NOT NULL DEFAULT 100,
    rate_limit_per_min INTEGER NOT NULL DEFAULT 300,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS memberships (
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    created_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id)`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
];

const TENANT_DDL = [
  `CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    latest_version INTEGER,
    nodes_json TEXT NOT NULL,
    edges_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workflows_tenant ON workflows(tenant_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS workflow_versions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    nodes_json TEXT NOT NULL,
    edges_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(tenant_id, workflow_id, version_number)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL,
    input_json TEXT NOT NULL,
    error_json TEXT,
    steps_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    UNIQUE(tenant_id, workflow_id, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_tenant_created ON runs(tenant_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_tenant_status ON runs(tenant_id, status)`,
  `CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    event_offset INTEGER NOT NULL,
    type TEXT NOT NULL,
    node_id TEXT,
    payload_json TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    UNIQUE(tenant_id, run_id, event_offset)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_run_events_lookup ON run_events(tenant_id, run_id, event_offset)`,
  `CREATE TABLE IF NOT EXISTS dlq_entries (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    failed_node_id TEXT NOT NULL,
    failed_step_label TEXT NOT NULL,
    run_final_status TEXT NOT NULL,
    error_json TEXT NOT NULL,
    input_json TEXT NOT NULL,
    replayed_run_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dlq_tenant ON dlq_entries(tenant_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    encrypted_value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tenant_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    name TEXT NOT NULL,
    cron TEXT NOT NULL,
    input_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT,
    last_run_at TEXT,
    last_run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(tenant_id, enabled, next_run_at)`,
  `CREATE TABLE IF NOT EXISTS tenant_inventory (
    tenant_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    warehouse TEXT NOT NULL,
    available INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, sku)
  )`,
  `CREATE TABLE IF NOT EXISTS tenant_balances (
    tenant_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    label TEXT NOT NULL,
    currency TEXT NOT NULL,
    available REAL NOT NULL DEFAULT 0,
    locked REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, account_id)
  )`,
  `CREATE TABLE IF NOT EXISTS tenant_kv (
    tenant_id TEXT NOT NULL,
    k TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, k)
  )`,
  `CREATE TABLE IF NOT EXISTS saga_ledger (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    action TEXT NOT NULL,
    direction TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_tenant ON saga_ledger(tenant_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS webhook_sink_deliveries (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    headers_json TEXT NOT NULL,
    body_json TEXT NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 200,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sink_tenant ON webhook_sink_deliveries(tenant_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    node_id TEXT NOT NULL,
    step_label TEXT NOT NULL,
    prompt TEXT NOT NULL,
    approver_role TEXT NOT NULL,
    callback_token TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT,
    comment TEXT,
    expires_at TEXT,
    on_timeout TEXT,
    escalated_at TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_tenant ON approvals(tenant_id, status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_run_node ON approvals(tenant_id, run_id, node_id)`,
  `CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    event_types_json TEXT NOT NULL,
    webhook_url TEXT NOT NULL,
    signing_secret TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    trigger_count INTEGER NOT NULL DEFAULT 0,
    last_triggered_at TEXT,
    last_status_code INTEGER,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_alert_rules_tenant ON alert_rules(tenant_id, enabled)`,
];

/**
 * LibSQL / SQLite Storage Adapter:
 * - Default mode: `db-per-tenant` physical isolation (each tenant gets `<storagePath>/tenants/<tenantId>.db`)
 * - Shared mode: single SQLite file, `:memory:`, or remote Turso `libsql://` URL with strict tenant_id scoping
 */
export class LibSqlStorageAdapter implements StorageAdapter {
  private readonly config: StorageConfig;
  private readonly isMemory: boolean;
  private readonly isPerTenant: boolean;
  private readonly baseDir: string;
  private controlDb!: Client;
  private tenantDbs = new Map<string, Client>();
  private tenantInitPromises = new Map<string, Promise<Client>>();
  private writeLocks = new Map<string, Promise<unknown>>();

  constructor(config: StorageConfig) {
    this.config = config;
    this.isMemory = config.databaseUrl === ':memory:' || config.storagePath === ':memory:';
    this.isPerTenant =
      !this.isMemory &&
      !config.databaseUrl?.startsWith('libsql://') &&
      !config.databaseUrl?.startsWith('http') &&
      config.isolation === 'db-per-tenant';
    this.baseDir = this.isMemory ? ':memory:' : resolve(config.storagePath);
  }

  /**
   * Serializes writes per SQLite connection handle so concurrent parallel DAG branches
   * and high-concurrency stress runs never collide with SQLITE_BUSY on the same handle.
   */
  private withWriteLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    const key = this.isPerTenant ? lockKey : '__shared__';
    const prev = this.writeLocks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.writeLocks.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }

  private async configurePragmas(client: Client, isFile: boolean): Promise<void> {
    if (!isFile) return;
    await client.execute('PRAGMA journal_mode = WAL;');
    await client.execute('PRAGMA synchronous = NORMAL;');
    await client.execute('PRAGMA busy_timeout = 5000;');
  }

  async init(): Promise<void> {
    if (this.isMemory) {
      this.controlDb = createClient({ url: ':memory:' });
    } else if (this.config.databaseUrl && !this.isPerTenant) {
      this.controlDb = createClient({
        url: this.config.databaseUrl,
        authToken: this.config.libsqlAuthToken,
      });
      await this.configurePragmas(
        this.controlDb,
        this.config.databaseUrl.startsWith('file:')
      );
    } else {
      mkdirSync(this.baseDir, { recursive: true });
      if (this.isPerTenant) {
        mkdirSync(join(this.baseDir, 'tenants'), { recursive: true });
      }
      const dbFile = this.isPerTenant
        ? join(this.baseDir, 'control.db')
        : join(this.baseDir, 'sagaflow.db');
      this.controlDb = createClient({ url: `file:${dbFile}` });
      await this.configurePragmas(this.controlDb, true);
    }

    for (const stmt of CONTROL_DDL) {
      await this.controlDb.execute(stmt);
    }
    if (!this.isPerTenant) {
      for (const stmt of TENANT_DDL) {
        await this.controlDb.execute(stmt);
      }
    }
  }

  async close(): Promise<void> {
    for (const client of this.tenantDbs.values()) {
      client.close();
    }
    this.tenantDbs.clear();
    this.tenantInitPromises.clear();
    if (this.controlDb) {
      this.controlDb.close();
    }
  }

  private getTenantDbPath(tenantId: string): string {
    return join(this.baseDir, 'tenants', `${safeTenantFileSegment(tenantId)}.db`);
  }

  private async getTenantDb(tenantId: string): Promise<Client> {
    if (!this.isPerTenant) {
      return this.controlDb;
    }
    const existing = this.tenantDbs.get(tenantId);
    if (existing) return existing;

    const inflight = this.tenantInitPromises.get(tenantId);
    if (inflight) return inflight;

    const promise = (async () => {
      const filePath = this.getTenantDbPath(tenantId);
      const client = createClient({ url: `file:${filePath}` });
      await this.configurePragmas(client, true);
      for (const stmt of TENANT_DDL) {
        await client.execute(stmt);
      }
      this.tenantDbs.set(tenantId, client);
      this.tenantInitPromises.delete(tenantId);
      return client;
    })();

    this.tenantInitPromises.set(tenantId, promise);
    return promise;
  }

  // ---------------- Control Plane ----------------

  async listTenants(): Promise<Tenant[]> {
    const res = await this.controlDb.execute(
      `SELECT id, name, slug, max_concurrent_runs, rate_limit_per_min, created_at
       FROM tenants ORDER BY created_at ASC`
    );
    return res.rows.map(mapTenantRow);
  }

  async getTenant(tenantId: string): Promise<Tenant | null> {
    const res = await this.controlDb.execute({
      sql: `SELECT id, name, slug, max_concurrent_runs, rate_limit_per_min, created_at
            FROM tenants WHERE id = ?`,
      args: [tenantId],
    });
    return res.rows[0] ? mapTenantRow(res.rows[0]) : null;
  }

  async getTenantBySlug(slug: string): Promise<Tenant | null> {
    const res = await this.controlDb.execute({
      sql: `SELECT id, name, slug, max_concurrent_runs, rate_limit_per_min, created_at
            FROM tenants WHERE slug = ?`,
      args: [slug],
    });
    return res.rows[0] ? mapTenantRow(res.rows[0]) : null;
  }

  async createTenant(input: CreateTenantInput & { id?: string }): Promise<Tenant> {
    return this.withWriteLock('__control__', async () => {
      const tenant: Tenant = {
        id: input.id ?? makeId('ten'),
        name: input.name,
        slug: input.slug,
        maxConcurrentRuns: input.maxConcurrentRuns ?? 100,
        rateLimitPerMin: input.rateLimitPerMin ?? 300,
        createdAt: nowIso(),
      };
      await this.controlDb.execute({
        sql: `INSERT INTO tenants (id, name, slug, max_concurrent_runs, rate_limit_per_min, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [
          tenant.id,
          tenant.name,
          tenant.slug,
          tenant.maxConcurrentRuns,
          tenant.rateLimitPerMin,
          tenant.createdAt,
        ],
      });
      // Eagerly provision the isolated tenant database
      await this.getTenantDb(tenant.id);
      return tenant;
    });
  }

  async ensureMembership(tenantId: string, userId: string, role = 'owner'): Promise<void> {
    await this.withWriteLock('__control__', async () => {
      await this.controlDb.execute({
        sql: `INSERT OR IGNORE INTO memberships (tenant_id, user_id, role, created_at)
              VALUES (?, ?, ?, ?)`,
        args: [tenantId, userId, role, nowIso()],
      });
    });
  }

  async hasMembership(tenantId: string, userId: string): Promise<boolean> {
    const res = await this.controlDb.execute({
      sql: `SELECT 1 FROM memberships WHERE tenant_id = ? AND user_id = ? LIMIT 1`,
      args: [tenantId, userId],
    });
    return res.rows.length > 0;
  }

  async getMembershipRole(tenantId: string, userId: string): Promise<import('@sagaflow/shared').RbacRole | null> {
    const res = await this.controlDb.execute({
      sql: `SELECT role FROM memberships WHERE tenant_id = ? AND user_id = ? LIMIT 1`,
      args: [tenantId, userId],
    });
    if (res.rows.length === 0) return null;
    const { normalizeRbacRole } = await import('@sagaflow/shared');
    return normalizeRbacRole(String(res.rows[0].role ?? 'admin'));
  }

  async setMembershipRole(tenantId: string, userId: string, role: import('@sagaflow/shared').RbacRole): Promise<void> {
    await this.withWriteLock('__control__', async () => {
      await this.controlDb.execute({
        sql: `INSERT INTO memberships (tenant_id, user_id, role, created_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(tenant_id, user_id) DO UPDATE SET role = excluded.role`,
        args: [tenantId, userId, role, nowIso()],
      });
    });
  }

  async listTenantMembers(tenantId: string): Promise<import('@sagaflow/shared').TenantMember[]> {
    const { normalizeRbacRole } = await import('@sagaflow/shared');
    const res = await this.controlDb.execute({
      sql: `SELECT m.tenant_id, m.user_id, m.role, m.created_at, u.name, u.email
            FROM memberships m
            LEFT JOIN users u ON u.id = m.user_id
            WHERE m.tenant_id = ?
            ORDER BY m.created_at ASC`,
      args: [tenantId],
    });
    return res.rows.map((r) => ({
      tenantId: String(r.tenant_id),
      userId: String(r.user_id),
      role: normalizeRbacRole(String(r.role ?? 'admin')),
      name: r.name ? String(r.name) : undefined,
      email: r.email ? String(r.email) : undefined,
      createdAt: r.created_at ? String(r.created_at) : undefined,
    }));
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyInfo[]> {
    const res = await this.controlDb.execute({
      sql: `SELECT id, tenant_id, name, prefix, created_at, last_used_at, revoked_at
            FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`,
      args: [tenantId],
    });
    return res.rows.map((r) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      name: String(r.name),
      prefix: String(r.prefix),
      createdAt: String(r.created_at),
      lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
      revokedAt: r.revoked_at ? String(r.revoked_at) : null,
    }));
  }

  async createApiKey(
    tenantId: string,
    name: string,
    keyData: { id: string; prefix: string; hash: string }
  ): Promise<ApiKeyInfo> {
    return this.withWriteLock('__control__', async () => {
      const createdAt = nowIso();
      await this.controlDb.execute({
        sql: `INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [keyData.id, tenantId, name, keyData.prefix, keyData.hash, createdAt],
      });
      return {
        id: keyData.id,
        tenantId,
        name,
        prefix: keyData.prefix,
        createdAt,
        lastUsedAt: null,
        revokedAt: null,
      };
    });
  }

  async verifyApiKeyHash(hash: string): Promise<VerifiedApiKey | null> {
    return this.withWriteLock('__control__', async () => {
      const res = await this.controlDb.execute({
        sql: `SELECT id, tenant_id, name FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1`,
        args: [hash],
      });
      if (!res.rows[0]) return null;
      const row = res.rows[0];
      await this.controlDb.execute({
        sql: `UPDATE api_keys SET last_used_at = ? WHERE id = ?`,
        args: [nowIso(), String(row.id)],
      });
      return {
        keyId: String(row.id),
        tenantId: String(row.tenant_id),
        name: String(row.name),
      };
    });
  }

  async revokeApiKey(tenantId: string, keyId: string): Promise<boolean> {
    return this.withWriteLock('__control__', async () => {
      const res = await this.controlDb.execute({
        sql: `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
        args: [nowIso(), keyId, tenantId],
      });
      return (res.rowsAffected ?? 0) > 0;
    });
  }

  // ---------------- Self-Hosted Users ----------------

  async createUser(input: {
    id?: string;
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<AuthUser> {
    return this.withWriteLock('__control__', async () => {
      const user: AuthUser = {
        id: input.id ?? makeId('usr'),
        email: input.email.toLowerCase(),
        name: input.name,
        createdAt: nowIso(),
      };
      await this.controlDb.execute({
        sql: `INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
        args: [user.id, user.email, user.name, input.passwordHash, user.createdAt],
      });
      return user;
    });
  }

  async getUserByEmail(email: string): Promise<StoredAuthUser | null> {
    const res = await this.controlDb.execute({
      sql: `SELECT id, email, name, password_hash, created_at FROM users WHERE email = ? LIMIT 1`,
      args: [email.toLowerCase()],
    });
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: String(r.id),
      email: String(r.email),
      name: String(r.name),
      passwordHash: String(r.password_hash),
      createdAt: String(r.created_at),
    };
  }

  async getUserById(userId: string): Promise<AuthUser | null> {
    const res = await this.controlDb.execute({
      sql: `SELECT id, email, name, created_at FROM users WHERE id = ? LIMIT 1`,
      args: [userId],
    });
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: String(r.id),
      email: String(r.email),
      name: String(r.name),
      createdAt: String(r.created_at),
    };
  }

  async listUserTenants(userId: string): Promise<Tenant[]> {
    const res = await this.controlDb.execute({
      sql: `SELECT t.id, t.name, t.slug, t.max_concurrent_runs, t.rate_limit_per_min, t.created_at
            FROM tenants t
            INNER JOIN memberships m ON m.tenant_id = t.id
            WHERE m.user_id = ?
            ORDER BY t.created_at ASC`,
      args: [userId],
    });
    return res.rows.map(mapTenantRow);
  }

  // ---------------- Encrypted Secret Vault ----------------

  async listSecrets(tenantId: string): Promise<SecretMetadata[]> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT id, tenant_id, name, description, created_at, updated_at
            FROM secrets WHERE tenant_id = ? ORDER BY name ASC`,
      args: [tenantId],
    });
    return res.rows.map((r) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      name: String(r.name),
      description: r.description ? String(r.description) : undefined,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  async getSecretRecord(tenantId: string, name: string): Promise<StoredSecretRecord | null> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT * FROM secrets WHERE tenant_id = ? AND name = ? LIMIT 1`,
      args: [tenantId, name],
    });
    return res.rows[0] ? mapSecretRow(res.rows[0]) : null;
  }

  async getAllSecretRecords(tenantId: string): Promise<StoredSecretRecord[]> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT * FROM secrets WHERE tenant_id = ?`,
      args: [tenantId],
    });
    return res.rows.map(mapSecretRow);
  }

  async upsertSecret(
    tenantId: string,
    input: { name: string; encryptedValue: string; description?: string }
  ): Promise<SecretMetadata> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const now = nowIso();
      const existing = await this.getSecretRecord(tenantId, input.name);
      if (existing) {
        await db.execute({
          sql: `UPDATE secrets SET encrypted_value = ?, description = ?, updated_at = ?
                WHERE tenant_id = ? AND name = ?`,
          args: [
            input.encryptedValue,
            input.description ?? existing.description ?? null,
            now,
            tenantId,
            input.name,
          ],
        });
        return {
          id: existing.id,
          tenantId,
          name: existing.name,
          description: input.description ?? existing.description,
          createdAt: existing.createdAt,
          updatedAt: now,
        };
      }
      const id = makeId('sec');
      await db.execute({
        sql: `INSERT INTO secrets (id, tenant_id, name, description, encrypted_value, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [id, tenantId, input.name, input.description ?? null, input.encryptedValue, now, now],
      });
      return {
        id,
        tenantId,
        name: input.name,
        description: input.description,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  async deleteSecret(tenantId: string, name: string): Promise<boolean> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const res = await db.execute({
        sql: `DELETE FROM secrets WHERE tenant_id = ? AND name = ?`,
        args: [tenantId, name],
      });
      return (res.rowsAffected ?? 0) > 0;
    });
  }

  // ---------------- Durable Cron Schedules ----------------

  async listSchedules(tenantId: string): Promise<WorkflowSchedule[]> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT * FROM schedules WHERE tenant_id = ? ORDER BY created_at DESC`,
      args: [tenantId],
    });
    return res.rows.map(mapScheduleRow);
  }

  async listDueSchedulesAcrossTenants(nowStr: string): Promise<WorkflowSchedule[]> {
    const tenants = await this.listTenants();
    const due: WorkflowSchedule[] = [];
    for (const t of tenants) {
      const db = await this.getTenantDb(t.id);
      const res = await db.execute({
        sql: `SELECT * FROM schedules WHERE tenant_id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`,
        args: [t.id, nowStr],
      });
      for (const r of res.rows) due.push(mapScheduleRow(r));
    }
    return due;
  }

  async getSchedule(tenantId: string, scheduleId: string): Promise<WorkflowSchedule | null> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT * FROM schedules WHERE tenant_id = ? AND id = ? LIMIT 1`,
      args: [tenantId, scheduleId],
    });
    return res.rows[0] ? mapScheduleRow(res.rows[0]) : null;
  }

  async createSchedule(
    tenantId: string,
    input: CreateScheduleInput & { workflowName: string; nextRunAt: string | null }
  ): Promise<WorkflowSchedule> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const now = nowIso();
      const schedule: WorkflowSchedule = {
        id: makeId('sch'),
        tenantId,
        workflowId: input.workflowId,
        workflowName: input.workflowName,
        name: input.name,
        cron: input.cron,
        input: input.input ?? {},
        enabled: input.enabled ?? true,
        nextRunAt: input.nextRunAt,
        lastRunAt: null,
        lastRunId: null,
        createdAt: now,
        updatedAt: now,
      };
      await db.execute({
        sql: `INSERT INTO schedules (
                id, tenant_id, workflow_id, workflow_name, name, cron, input_json,
                enabled, next_run_at, last_run_at, last_run_id, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
        args: [
          schedule.id,
          tenantId,
          schedule.workflowId,
          schedule.workflowName,
          schedule.name,
          schedule.cron,
          JSON.stringify(schedule.input),
          schedule.enabled ? 1 : 0,
          schedule.nextRunAt,
          schedule.createdAt,
          schedule.updatedAt,
        ],
      });
      return schedule;
    });
  }

  async updateSchedule(
    tenantId: string,
    scheduleId: string,
    patch: UpdateScheduleInput & { nextRunAt?: string | null }
  ): Promise<WorkflowSchedule | null> {
    return this.withWriteLock(tenantId, async () => {
      const existing = await this.getSchedule(tenantId, scheduleId);
      if (!existing) return null;
      const db = await this.getTenantDb(tenantId);
      const updated: WorkflowSchedule = {
        ...existing,
        name: patch.name ?? existing.name,
        cron: patch.cron ?? existing.cron,
        input: patch.input ?? existing.input,
        enabled: patch.enabled ?? existing.enabled,
        nextRunAt: patch.nextRunAt !== undefined ? patch.nextRunAt : existing.nextRunAt,
        updatedAt: nowIso(),
      };
      await db.execute({
        sql: `UPDATE schedules
              SET name = ?, cron = ?, input_json = ?, enabled = ?, next_run_at = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ?`,
        args: [
          updated.name,
          updated.cron,
          JSON.stringify(updated.input),
          updated.enabled ? 1 : 0,
          updated.nextRunAt,
          updated.updatedAt,
          tenantId,
          scheduleId,
        ],
      });
      return updated;
    });
  }

  async markScheduleFired(
    tenantId: string,
    scheduleId: string,
    lastRunAt: string,
    lastRunId: string,
    nextRunAt: string | null
  ): Promise<WorkflowSchedule | null> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      await db.execute({
        sql: `UPDATE schedules SET last_run_at = ?, last_run_id = ?, next_run_at = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ?`,
        args: [lastRunAt, lastRunId, nextRunAt, nowIso(), tenantId, scheduleId],
      });
      return this.getSchedule(tenantId, scheduleId);
    });
  }

  async deleteSchedule(tenantId: string, scheduleId: string): Promise<boolean> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const res = await db.execute({
        sql: `DELETE FROM schedules WHERE tenant_id = ? AND id = ?`,
        args: [tenantId, scheduleId],
      });
      return (res.rowsAffected ?? 0) > 0;
    });
  }

  // ---------------- Workflows & Immutable Versions ----------------

  async listWorkflows(tenantId: string): Promise<WorkflowListItem[]> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT id, name, description, status, latest_version, nodes_json, updated_at
            FROM workflows WHERE tenant_id = ? ORDER BY updated_at DESC`,
      args: [tenantId],
    });
    return res.rows.map((r) => {
      const nodes = JSON.parse(String(r.nodes_json)) as unknown[];
      return {
        id: String(r.id),
        name: String(r.name),
        description: r.description ? String(r.description) : undefined,
        status: String(r.status) as WorkflowListItem['status'],
        latestVersion: r.latest_version === null ? null : Number(r.latest_version),
        nodeCount: nodes.length,
        updatedAt: String(r.updated_at),
      };
    });
  }

  async getWorkflow(tenantId: string, workflowId: string): Promise<Workflow | null> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT id, name, description, status, latest_version, nodes_json, edges_json, created_at, updated_at
            FROM workflows WHERE tenant_id = ? AND id = ? LIMIT 1`,
      args: [tenantId, workflowId],
    });
    return res.rows[0] ? mapWorkflowRow(res.rows[0]) : null;
  }

  async createWorkflow(tenantId: string, input: DraftWorkflowInput, id?: string): Promise<Workflow> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const now = nowIso();
      const wf: Workflow = {
        id: id ?? makeId('wf'),
        name: input.name,
        description: input.description,
        status: 'draft',
        latestVersion: null,
        nodes: input.nodes ?? [],
        edges: input.edges ?? [],
        createdAt: now,
        updatedAt: now,
      };
      await db.execute({
        sql: `INSERT INTO workflows (id, tenant_id, name, description, status, latest_version, nodes_json, edges_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          wf.id,
          tenantId,
          wf.name,
          wf.description ?? null,
          wf.status,
          wf.latestVersion,
          JSON.stringify(wf.nodes),
          JSON.stringify(wf.edges),
          wf.createdAt,
          wf.updatedAt,
        ],
      });
      return wf;
    });
  }

  async updateWorkflow(
    tenantId: string,
    workflowId: string,
    input: DraftWorkflowInput
  ): Promise<Workflow | null> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const existing = await this.getWorkflow(tenantId, workflowId);
      if (!existing) return null;

      const updatedAt = nowIso();
      const updated: Workflow = {
        ...existing,
        name: input.name,
        description: input.description ?? existing.description,
        nodes: input.nodes ?? [],
        edges: input.edges ?? [],
        updatedAt,
      };

      await db.execute({
        sql: `UPDATE workflows
              SET name = ?, description = ?, nodes_json = ?, edges_json = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ?`,
        args: [
          updated.name,
          updated.description ?? null,
          JSON.stringify(updated.nodes),
          JSON.stringify(updated.edges),
          updated.updatedAt,
          tenantId,
          workflowId,
        ],
      });
      return updated;
    });
  }

  async deleteWorkflow(tenantId: string, workflowId: string): Promise<boolean> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const res = await db.execute({
        sql: `DELETE FROM workflows WHERE tenant_id = ? AND id = ?`,
        args: [tenantId, workflowId],
      });
      await db.execute({
        sql: `DELETE FROM schedules WHERE tenant_id = ? AND workflow_id = ?`,
        args: [tenantId, workflowId],
      });
      return (res.rowsAffected ?? 0) > 0;
    });
  }

  async publishWorkflow(
    tenantId: string,
    workflowId: string
  ): Promise<{ workflow: Workflow; version: WorkflowVersionSummary } | null> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const existing = await this.getWorkflow(tenantId, workflowId);
      if (!existing) return null;

      const nextVersion = (existing.latestVersion ?? 0) + 1;
      const versionId = makeId('ver');
      const now = nowIso();

      const tx = await db.transaction('write');
      try {
        await tx.execute({
          sql: `INSERT INTO workflow_versions (id, tenant_id, workflow_id, version_number, name, nodes_json, edges_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            versionId,
            tenantId,
            workflowId,
            nextVersion,
            existing.name,
            JSON.stringify(existing.nodes),
            JSON.stringify(existing.edges),
            now,
          ],
        });
        await tx.execute({
          sql: `UPDATE workflows SET status = 'published', latest_version = ?, updated_at = ?
                WHERE tenant_id = ? AND id = ?`,
          args: [nextVersion, now, tenantId, workflowId],
        });
        await tx.commit();
      } catch (err) {
        await tx.rollback();
        throw err;
      }

      const updated: Workflow = {
        ...existing,
        status: 'published',
        latestVersion: nextVersion,
        updatedAt: now,
      };

      return {
        workflow: updated,
        version: {
          id: versionId,
          workflowId,
          versionNumber: nextVersion,
          createdAt: now,
        },
      };
    });
  }

  async getWorkflowVersion(
    tenantId: string,
    workflowId: string,
    versionNumber: number
  ): Promise<WorkflowVersion | null> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT id, workflow_id, version_number, name, nodes_json, edges_json, created_at
            FROM workflow_versions
            WHERE tenant_id = ? AND workflow_id = ? AND version_number = ? LIMIT 1`,
      args: [tenantId, workflowId, versionNumber],
    });
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: String(r.id),
      workflowId: String(r.workflow_id),
      versionNumber: Number(r.version_number),
      name: String(r.name),
      nodes: JSON.parse(String(r.nodes_json)),
      edges: JSON.parse(String(r.edges_json)),
      createdAt: String(r.created_at),
    };
  }

  async listWorkflowVersions(
    tenantId: string,
    workflowId: string
  ): Promise<WorkflowVersionSummary[]> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT id, workflow_id, version_number, created_at
            FROM workflow_versions
            WHERE tenant_id = ? AND workflow_id = ?
            ORDER BY version_number DESC`,
      args: [tenantId, workflowId],
    });
    return res.rows.map((r) => ({
      id: String(r.id),
      workflowId: String(r.workflow_id),
      versionNumber: Number(r.version_number),
      createdAt: String(r.created_at),
    }));
  }

  // ---------------- Runs & Idempotency ----------------

  async createRunIdempotent(
    tenantId: string,
    input: CreateRunStorageInput
  ): Promise<{ run: RunDetail; created: boolean }> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const existingRes = await db.execute({
        sql: `SELECT * FROM runs WHERE tenant_id = ? AND workflow_id = ? AND idempotency_key = ? LIMIT 1`,
        args: [tenantId, input.workflowId, input.idempotencyKey],
      });
      if (existingRes.rows[0]) {
        return { run: mapRunRow(existingRes.rows[0]), created: false };
      }

      const now = nowIso();
      const run: RunDetail = {
        id: input.id,
        workflowId: input.workflowId,
        workflowName: input.workflowName,
        versionNumber: input.versionNumber,
        status: 'pending',
        cancelRequested: false,
        idempotencyKey: input.idempotencyKey,
        input: input.input,
        error: null,
        steps: [],
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      };

      try {
        await db.execute({
          sql: `INSERT INTO runs (
                  id, tenant_id, workflow_id, workflow_name, version_number,
                  status, cancel_requested, idempotency_key, input_json, error_json,
                  steps_json, created_at, started_at, finished_at, duration_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            run.id,
            tenantId,
            run.workflowId,
            run.workflowName ?? '',
            run.versionNumber,
            run.status,
            0,
            input.idempotencyKey,
            JSON.stringify(run.input),
            null,
            JSON.stringify(run.steps),
            run.createdAt,
            null,
            null,
            null,
          ],
        });
        return { run, created: true };
      } catch (err) {
        // Handle race condition on UNIQUE(tenant_id, workflow_id, idempotency_key)
        const retry = await db.execute({
          sql: `SELECT * FROM runs WHERE tenant_id = ? AND workflow_id = ? AND idempotency_key = ? LIMIT 1`,
          args: [tenantId, input.workflowId, input.idempotencyKey],
        });
        if (retry.rows[0]) {
          return { run: mapRunRow(retry.rows[0]), created: false };
        }
        throw err;
      }
    });
  }

  async getRun(tenantId: string, runId: string): Promise<RunDetail | null> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT * FROM runs WHERE tenant_id = ? AND id = ? LIMIT 1`,
      args: [tenantId, runId],
    });
    return res.rows[0] ? mapRunRow(res.rows[0]) : null;
  }

  async listRuns(tenantId: string, query: ListRunsQuery): Promise<ListRunsResult> {
    const db = await this.getTenantDb(tenantId);
    const conditions: string[] = ['tenant_id = ?'];
    const args: Array<string | number> = [tenantId];

    if (query.workflowId) {
      conditions.push('workflow_id = ?');
      args.push(query.workflowId);
    }
    if (query.status) {
      conditions.push('status = ?');
      args.push(query.status);
    }
    if (query.cursor) {
      const [cursorCreatedAt, cursorId] = query.cursor.split('|');
      if (cursorCreatedAt && cursorId) {
        conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
        args.push(cursorCreatedAt, cursorCreatedAt, cursorId);
      }
    }

    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    args.push(limit + 1);

    const res = await db.execute({
      sql: `SELECT id, workflow_id, workflow_name, version_number, status, cancel_requested,
                   idempotency_key, created_at, started_at, finished_at, duration_ms
            FROM runs
            WHERE ${conditions.join(' AND ')}
            ORDER BY created_at DESC, id DESC
            LIMIT ?`,
      args,
    });

    const hasMore = res.rows.length > limit;
    const slice = hasMore ? res.rows.slice(0, limit) : res.rows;
    const runs: RunSummary[] = slice.map((r) => ({
      id: String(r.id),
      workflowId: String(r.workflow_id),
      workflowName: r.workflow_name ? String(r.workflow_name) : undefined,
      versionNumber: Number(r.version_number),
      status: String(r.status) as RunSummary['status'],
      cancelRequested: Number(r.cancel_requested) === 1,
      idempotencyKey: r.idempotency_key ? String(r.idempotency_key) : undefined,
      createdAt: String(r.created_at),
      startedAt: r.started_at ? String(r.started_at) : null,
      finishedAt: r.finished_at ? String(r.finished_at) : null,
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    }));

    const last = runs[runs.length - 1];
    const nextCursor = hasMore && last ? `${last.createdAt}|${last.id}` : null;
    return { runs, nextCursor };
  }

  async saveRun(tenantId: string, run: RunDetail): Promise<void> {
    await this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      await db.execute({
        sql: `UPDATE runs
              SET status = ?, cancel_requested = ?, error_json = ?, steps_json = ?,
                  started_at = ?, finished_at = ?, duration_ms = ?
              WHERE tenant_id = ? AND id = ?`,
        args: [
          run.status,
          run.cancelRequested ? 1 : 0,
          run.error ? JSON.stringify(run.error) : null,
          JSON.stringify(run.steps),
          run.startedAt,
          run.finishedAt,
          run.durationMs ?? null,
          tenantId,
          run.id,
        ],
      });
    });
  }

  async requestCancelRun(tenantId: string, runId: string): Promise<RunDetail | null> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      await db.execute({
        sql: `UPDATE runs SET cancel_requested = 1 WHERE tenant_id = ? AND id = ?`,
        args: [tenantId, runId],
      });
      return this.getRun(tenantId, runId);
    });
  }

  // ---------------- Durable Offset-Indexed Event Log ----------------

  async appendRunEvent(
    tenantId: string,
    runId: string,
    type: RunEventType,
    payload: Record<string, unknown>,
    nodeId?: string
  ): Promise<RunEvent> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const timestamp = nowIso();
      const res = await db.execute({
        sql: `INSERT INTO run_events (tenant_id, run_id, event_offset, type, node_id, payload_json, timestamp)
              VALUES (
                ?, ?,
                COALESCE((SELECT MAX(event_offset) FROM run_events WHERE tenant_id = ? AND run_id = ?), 0) + 1,
                ?, ?, ?, ?
              )
              RETURNING event_offset`,
        args: [
          tenantId,
          runId,
          tenantId,
          runId,
          type,
          nodeId ?? null,
          JSON.stringify(payload),
          timestamp,
        ],
      });
      const offset = Number(res.rows[0]?.event_offset ?? 1);
      return {
        offset,
        runId,
        type,
        timestamp,
        nodeId,
        payload,
      };
    });
  }

  async listRunEvents(tenantId: string, runId: string, sinceOffset = 0): Promise<RunEvent[]> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT event_offset, run_id, type, node_id, payload_json, timestamp
            FROM run_events
            WHERE tenant_id = ? AND run_id = ? AND event_offset > ?
            ORDER BY event_offset ASC`,
      args: [tenantId, runId, sinceOffset],
    });
    return res.rows.map((r) => ({
      offset: Number(r.event_offset),
      runId: String(r.run_id),
      type: String(r.type) as RunEventType,
      timestamp: String(r.timestamp),
      nodeId: r.node_id ? String(r.node_id) : undefined,
      payload: JSON.parse(String(r.payload_json)),
    }));
  }

  // ---------------- Dead-Letter Queue ----------------

  async createDlqEntry(tenantId: string, entry: DlqEntry): Promise<DlqEntry> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      await db.execute({
        sql: `INSERT INTO dlq_entries (
                id, tenant_id, run_id, workflow_id, workflow_name, version_number,
                failed_node_id, failed_step_label, run_final_status, error_json,
                input_json, replayed_run_id, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          entry.id,
          tenantId,
          entry.runId,
          entry.workflowId,
          entry.workflowName,
          entry.versionNumber,
          entry.failedNodeId,
          entry.failedStepLabel,
          entry.runFinalStatus,
          JSON.stringify(entry.error),
          JSON.stringify(entry.input),
          entry.replayedRunId,
          entry.createdAt,
        ],
      });
      return entry;
    });
  }

  async listDlqEntries(tenantId: string): Promise<DlqEntry[]> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT * FROM dlq_entries WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200`,
      args: [tenantId],
    });
    return res.rows.map(mapDlqRow);
  }

  async getDlqEntry(tenantId: string, dlqId: string): Promise<DlqEntry | null> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT * FROM dlq_entries WHERE tenant_id = ? AND id = ? LIMIT 1`,
      args: [tenantId, dlqId],
    });
    return res.rows[0] ? mapDlqRow(res.rows[0]) : null;
  }

  async markDlqReplayed(
    tenantId: string,
    dlqId: string,
    replayedRunId: string
  ): Promise<DlqEntry | null> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      await db.execute({
        sql: `UPDATE dlq_entries SET replayed_run_id = ? WHERE tenant_id = ? AND id = ?`,
        args: [replayedRunId, tenantId, dlqId],
      });
      return this.getDlqEntry(tenantId, dlqId);
    });
  }

  async deleteDlqEntry(tenantId: string, dlqId: string): Promise<boolean> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const res = await db.execute({
        sql: `DELETE FROM dlq_entries WHERE tenant_id = ? AND id = ?`,
        args: [tenantId, dlqId],
      });
      return (res.rowsAffected ?? 0) > 0;
    });
  }

  // ---------------- Real Per-Tenant Transactional State & Saga Ledger ----------------

  async getTenantState(tenantId: string): Promise<TenantStateSnapshot> {
    const db = await this.getTenantDb(tenantId);
    const [invRes, balRes, kvRes, ledRes, sinkRes] = await Promise.all([
      db.execute({
        sql: `SELECT * FROM tenant_inventory WHERE tenant_id = ? ORDER BY sku ASC`,
        args: [tenantId],
      }),
      db.execute({
        sql: `SELECT * FROM tenant_balances WHERE tenant_id = ? ORDER BY account_id ASC`,
        args: [tenantId],
      }),
      db.execute({
        sql: `SELECT * FROM tenant_kv WHERE tenant_id = ? ORDER BY k ASC`,
        args: [tenantId],
      }),
      db.execute({
        sql: `SELECT * FROM saga_ledger WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`,
        args: [tenantId],
      }),
      db.execute({
        sql: `SELECT * FROM webhook_sink_deliveries WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50`,
        args: [tenantId],
      }),
    ]);

    return {
      tenantId,
      inventory: invRes.rows.map((r) => ({
        sku: String(r.sku),
        name: String(r.name),
        warehouse: String(r.warehouse),
        available: Number(r.available),
        reserved: Number(r.reserved),
        updatedAt: String(r.updated_at),
      })),
      balances: balRes.rows.map((r) => ({
        accountId: String(r.account_id),
        label: String(r.label),
        currency: String(r.currency),
        available: Number(r.available),
        locked: Number(r.locked),
        updatedAt: String(r.updated_at),
      })),
      kv: kvRes.rows.map((r) => ({
        key: String(r.k),
        value: JSON.parse(String(r.value_json)),
        updatedAt: String(r.updated_at),
      })),
      ledger: ledRes.rows.map((r) => ({
        id: String(r.id),
        tenantId: String(r.tenant_id),
        runId: String(r.run_id),
        nodeId: String(r.node_id),
        action: String(r.action),
        direction: String(r.direction) as 'execute' | 'compensate',
        resourceType: String(r.resource_type) as SagaLedgerEntry['resourceType'],
        resourceId: String(r.resource_id),
        status: String(r.status) as SagaLedgerEntry['status'],
        summary: String(r.summary),
        beforeState: r.before_json ? JSON.parse(String(r.before_json)) : null,
        afterState: r.after_json ? JSON.parse(String(r.after_json)) : null,
        createdAt: String(r.created_at),
      })),
      sinkDeliveries: sinkRes.rows.map((r) => ({
        id: String(r.id),
        tenantId: String(r.tenant_id),
        channel: String(r.channel),
        method: String(r.method),
        path: String(r.path),
        headers: JSON.parse(String(r.headers_json)),
        body: JSON.parse(String(r.body_json)),
        statusCode: Number(r.status_code),
        createdAt: String(r.created_at),
      })),
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
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const curRes = await db.execute({
        sql: `SELECT * FROM tenant_inventory WHERE tenant_id = ? AND sku = ? LIMIT 1`,
        args: [tenantId, input.sku],
      });
      const now = nowIso();
      let before: TenantInventoryItem | null = null;
      let nextAvailable: number;
      let nextReserved: number;
      let name = input.name ?? input.sku;
      let warehouse = input.warehouse ?? 'ap-south-1';

      if (curRes.rows[0]) {
        const r = curRes.rows[0];
        before = {
          sku: String(r.sku),
          name: String(r.name),
          warehouse: String(r.warehouse),
          available: Number(r.available),
          reserved: Number(r.reserved),
          updatedAt: String(r.updated_at),
        };
        name = input.name ?? before.name;
        warehouse = input.warehouse ?? before.warehouse;
        nextAvailable = before.available + input.deltaAvailable;
        nextReserved = Math.max(0, before.reserved + (input.deltaReserved ?? 0));
      } else {
        nextAvailable = Math.max(0, input.deltaAvailable < 0 ? 100 + input.deltaAvailable : input.deltaAvailable);
        nextReserved = Math.max(0, input.deltaReserved ?? 0);
      }

      if (input.requireSufficient && nextAvailable < 0) {
        throw new Error(
          `Insufficient inventory for ${input.sku}: requested ${Math.abs(input.deltaAvailable)}, available ${before?.available ?? 0}`
        );
      }
      nextAvailable = Math.max(0, nextAvailable);

      await db.execute({
        sql: `INSERT INTO tenant_inventory (tenant_id, sku, name, warehouse, available, reserved, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(tenant_id, sku) DO UPDATE SET
                name = excluded.name,
                warehouse = excluded.warehouse,
                available = excluded.available,
                reserved = excluded.reserved,
                updated_at = excluded.updated_at`,
        args: [tenantId, input.sku, name, warehouse, nextAvailable, nextReserved, now],
      });

      return {
        before,
        item: {
          sku: input.sku,
          name,
          warehouse,
          available: nextAvailable,
          reserved: nextReserved,
          updatedAt: now,
        },
      };
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
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const curRes = await db.execute({
        sql: `SELECT * FROM tenant_balances WHERE tenant_id = ? AND account_id = ? LIMIT 1`,
        args: [tenantId, input.accountId],
      });
      const now = nowIso();
      let before: TenantAccountBalance | null = null;
      let nextAvailable: number;
      let nextLocked: number;
      let label = input.label ?? input.accountId;
      let currency = input.currency ?? 'USD';

      if (curRes.rows[0]) {
        const r = curRes.rows[0];
        before = {
          accountId: String(r.account_id),
          label: String(r.label),
          currency: String(r.currency),
          available: Number(r.available),
          locked: Number(r.locked),
          updatedAt: String(r.updated_at),
        };
        label = input.label ?? before.label;
        currency = input.currency ?? before.currency;
        nextAvailable = Number((before.available + input.deltaAvailable).toFixed(2));
        nextLocked = Math.max(0, Number((before.locked + (input.deltaLocked ?? 0)).toFixed(2)));
      } else {
        nextAvailable = Number(Math.max(0, input.deltaAvailable).toFixed(2));
        nextLocked = Math.max(0, Number((input.deltaLocked ?? 0).toFixed(2)));
      }

      if (input.requireSufficient && nextAvailable < 0) {
        throw new Error(
          `Insufficient balance on "${input.accountId}": needed ${Math.abs(input.deltaAvailable)} ${currency}, available ${before?.available ?? 0} ${currency}`
        );
      }

      await db.execute({
        sql: `INSERT INTO tenant_balances (tenant_id, account_id, label, currency, available, locked, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(tenant_id, account_id) DO UPDATE SET
                label = excluded.label,
                currency = excluded.currency,
                available = excluded.available,
                locked = excluded.locked,
                updated_at = excluded.updated_at`,
        args: [tenantId, input.accountId, label, currency, nextAvailable, nextLocked, now],
      });

      return {
        before,
        balance: {
          accountId: input.accountId,
          label,
          currency,
          available: nextAvailable,
          locked: nextLocked,
          updatedAt: now,
        },
      };
    });
  }

  async setKv(
    tenantId: string,
    key: string,
    value: unknown
  ): Promise<{ record: TenantKvRecord; previousValue: unknown; existed: boolean }> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const cur = await db.execute({
        sql: `SELECT value_json FROM tenant_kv WHERE tenant_id = ? AND k = ? LIMIT 1`,
        args: [tenantId, key],
      });
      const existed = Boolean(cur.rows[0]);
      const previousValue = cur.rows[0] ? JSON.parse(String(cur.rows[0].value_json)) : undefined;
      const now = nowIso();
      await db.execute({
        sql: `INSERT INTO tenant_kv (tenant_id, k, value_json, updated_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(tenant_id, k) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        args: [tenantId, key, JSON.stringify(value ?? null), now],
      });
      return { record: { key, value, updatedAt: now }, previousValue, existed };
    });
  }

  async deleteKv(tenantId: string, key: string): Promise<boolean> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const res = await db.execute({
        sql: `DELETE FROM tenant_kv WHERE tenant_id = ? AND k = ?`,
        args: [tenantId, key],
      });
      return (res.rowsAffected ?? 0) > 0;
    });
  }

  async appendLedgerEntry(
    tenantId: string,
    entry: Omit<SagaLedgerEntry, 'id' | 'tenantId' | 'createdAt'>
  ): Promise<SagaLedgerEntry> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const full: SagaLedgerEntry = {
        ...entry,
        id: makeId('ldg'),
        tenantId,
        createdAt: nowIso(),
      };
      await db.execute({
        sql: `INSERT INTO saga_ledger (
                id, tenant_id, run_id, node_id, action, direction,
                resource_type, resource_id, status, summary, before_json, after_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          full.id,
          tenantId,
          full.runId,
          full.nodeId,
          full.action,
          full.direction,
          full.resourceType,
          full.resourceId,
          full.status,
          full.summary,
          full.beforeState ? JSON.stringify(full.beforeState) : null,
          full.afterState ? JSON.stringify(full.afterState) : null,
          full.createdAt,
        ],
      });
      return full;
    });
  }

  async recordSinkDelivery(
    tenantId: string,
    delivery: Omit<WebhookSinkDelivery, 'id' | 'tenantId' | 'createdAt'>
  ): Promise<WebhookSinkDelivery> {
    return this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      const full: WebhookSinkDelivery = {
        ...delivery,
        id: makeId('snk'),
        tenantId,
        createdAt: nowIso(),
      };
      await db.execute({
        sql: `INSERT INTO webhook_sink_deliveries (
                id, tenant_id, channel, method, path, headers_json, body_json, status_code, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          full.id,
          tenantId,
          full.channel,
          full.method,
          full.path,
          JSON.stringify(full.headers),
          JSON.stringify(full.body ?? null),
          full.statusCode,
          full.createdAt,
        ],
      });
      return full;
    });
  }

  async clearSinkDeliveries(tenantId: string): Promise<void> {
    await this.withWriteLock(tenantId, async () => {
      const db = await this.getTenantDb(tenantId);
      await db.execute({
        sql: `DELETE FROM webhook_sink_deliveries WHERE tenant_id = ?`,
        args: [tenantId],
      });
    });
  }

  // ---------------- Recovery & Observability ----------------

  async listPendingRunsAcrossTenants(): Promise<Array<{ tenantId: string; runId: string }>> {
    const tenants = await this.listTenants();
    const pending: Array<{ tenantId: string; runId: string }> = [];
    for (const t of tenants) {
      const db = await this.getTenantDb(t.id);
      const res = await db.execute({
        sql: `SELECT id FROM runs WHERE tenant_id = ? AND status IN ('pending', 'running', 'compensating')`,
        args: [t.id],
      });
      for (const r of res.rows) {
        pending.push({ tenantId: t.id, runId: String(r.id) });
      }
    }
    return pending;
  }

  async getTenantMetrics(tenantId: string, rateLimitUsed: number): Promise<MetricsSnapshot> {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found`);
    }
    const db = await this.getTenantDb(tenantId);
    const [workflows, runsRes, dlqEntries, storage] = await Promise.all([
      this.listWorkflows(tenantId),
      db.execute({
        sql: `SELECT * FROM runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1000`,
        args: [tenantId],
      }),
      this.listDlqEntries(tenantId),
      this.getStorageStatus(tenantId),
    ]);
    const runs = runsRes.rows.map(mapRunRow);
    return buildMetricsSnapshot({
      tenant,
      storage,
      workflows,
      runs,
      dlqEntries,
      rateLimitUsed,
    });
  }

  async getStorageStatus(tenantId?: string): Promise<StorageStatus> {
    const tenants = await this.listTenants();
    return {
      driver: 'sqlite',
      isolation: this.isPerTenant ? 'db-per-tenant' : 'shared',
      location: this.isMemory
        ? ':memory:'
        : this.config.databaseUrl && !this.isPerTenant
          ? this.config.databaseUrl
          : this.baseDir,
      queueDriver: this.config.queueDriver,
      workerConcurrency: this.config.workerConcurrency,
      tenantDbPath: tenantId && this.isPerTenant ? this.getTenantDbPath(tenantId) : undefined,
      tenantCount: tenants.length,
    };
  }

  // ---------------- Human-in-the-Loop Durable Approvals ----------------

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
    const db = await this.getTenantDb(tenantId);
    return this.withWriteLock(tenantId, async () => {
      const id = makeId('apr');
      const callbackToken = `${makeId('cbk')}${makeId('tok').slice(4)}`;
      const createdAt = nowIso();
      await db.execute({
        sql: `INSERT INTO approvals (id, tenant_id, run_id, workflow_id, workflow_name, node_id, step_label, prompt, approver_role, callback_token, payload_json, status, expires_at, on_timeout, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        args: [
          id,
          tenantId,
          input.runId,
          input.workflowId,
          input.workflowName,
          input.nodeId,
          input.stepLabel,
          input.prompt,
          input.approverRole,
          callbackToken,
          JSON.stringify(input.payload ?? {}),
          input.expiresAt ?? null,
          input.onTimeout ?? null,
          createdAt,
        ],
      });
      return {
        id,
        tenantId,
        runId: input.runId,
        workflowId: input.workflowId,
        workflowName: input.workflowName,
        nodeId: input.nodeId,
        stepLabel: input.stepLabel,
        prompt: input.prompt,
        approverRole: input.approverRole,
        callbackToken,
        payload: input.payload ?? {},
        status: 'pending',
        decidedBy: null,
        comment: null,
        expiresAt: input.expiresAt ?? null,
        onTimeout: input.onTimeout ?? null,
        escalatedAt: null,
        createdAt,
        decidedAt: null,
      };
    });
  }

  async listApprovals(tenantId: string, status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    const db = await this.getTenantDb(tenantId);
    const res = status
      ? await db.execute({
          sql: `SELECT * FROM approvals WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200`,
          args: [tenantId, status],
        })
      : await db.execute({
          sql: `SELECT * FROM approvals WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200`,
          args: [tenantId],
        });
    return res.rows.map(mapApprovalRow);
  }

  async getApproval(tenantId: string, approvalId: string): Promise<ApprovalRequest | null> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT * FROM approvals WHERE tenant_id = ? AND id = ?`,
      args: [tenantId, approvalId],
    });
    return res.rows[0] ? mapApprovalRow(res.rows[0]) : null;
  }

  async getApprovalByRunNode(
    tenantId: string,
    runId: string,
    nodeId: string
  ): Promise<ApprovalRequest | null> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT * FROM approvals WHERE tenant_id = ? AND run_id = ? AND node_id = ? ORDER BY created_at DESC LIMIT 1`,
      args: [tenantId, runId, nodeId],
    });
    return res.rows[0] ? mapApprovalRow(res.rows[0]) : null;
  }

  async getApprovalByToken(token: string): Promise<ApprovalRequest | null> {
    const tenants = await this.listTenants();
    for (const t of tenants) {
      const db = await this.getTenantDb(t.id);
      const res = await db.execute({
        sql: `SELECT * FROM approvals WHERE callback_token = ? LIMIT 1`,
        args: [token],
      });
      if (res.rows[0]) return mapApprovalRow(res.rows[0]);
    }
    return null;
  }

  async decideApproval(
    tenantId: string,
    approvalId: string,
    decision: { status: 'approved' | 'rejected'; decidedBy: string; comment?: string }
  ): Promise<ApprovalRequest | null> {
    const db = await this.getTenantDb(tenantId);
    return this.withWriteLock(tenantId, async () => {
      const decidedAt = nowIso();
      const upd = await db.execute({
        sql: `UPDATE approvals SET status = ?, decided_by = ?, comment = ?, decided_at = ?
              WHERE tenant_id = ? AND id = ? AND status = 'pending'`,
        args: [
          decision.status,
          decision.decidedBy,
          decision.comment ?? null,
          decidedAt,
          tenantId,
          approvalId,
        ],
      });
      if (upd.rowsAffected === 0) return null;
      const res = await db.execute({
        sql: `SELECT * FROM approvals WHERE tenant_id = ? AND id = ?`,
        args: [tenantId, approvalId],
      });
      return res.rows[0] ? mapApprovalRow(res.rows[0]) : null;
    });
  }

  async markApprovalEscalated(tenantId: string, approvalId: string): Promise<void> {
    const db = await this.getTenantDb(tenantId);
    await this.withWriteLock(tenantId, async () => {
      await db.execute({
        sql: `UPDATE approvals SET escalated_at = ? WHERE tenant_id = ? AND id = ?`,
        args: [nowIso(), tenantId, approvalId],
      });
    });
  }

  async listExpiredPendingApprovals(nowIsoStr: string): Promise<ApprovalRequest[]> {
    const tenants = await this.listTenants();
    const expired: ApprovalRequest[] = [];
    for (const t of tenants) {
      const db = await this.getTenantDb(t.id);
      const res = await db.execute({
        sql: `SELECT * FROM approvals WHERE tenant_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`,
        args: [t.id, nowIsoStr],
      });
      for (const row of res.rows) expired.push(mapApprovalRow(row));
    }
    return expired;
  }

  async listAlertRules(tenantId: string): Promise<AlertRule[]> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT * FROM alert_rules WHERE tenant_id = ? ORDER BY created_at DESC`,
      args: [tenantId],
    });
    return res.rows.map(mapAlertRuleRow);
  }

  async getAlertRule(tenantId: string, ruleId: string): Promise<AlertRule | null> {
    const db = await this.getTenantDb(tenantId);
    const res = await db.execute({
      sql: `SELECT * FROM alert_rules WHERE tenant_id = ? AND id = ?`,
      args: [tenantId, ruleId],
    });
    return res.rows[0] ? mapAlertRuleRow(res.rows[0]) : null;
  }

  async createAlertRule(tenantId: string, input: CreateAlertRuleInput): Promise<AlertRule> {
    const db = await this.getTenantDb(tenantId);
    return this.withWriteLock(tenantId, async () => {
      const id = makeId('alr');
      const now = nowIso();
      await db.execute({
        sql: `INSERT INTO alert_rules (id, tenant_id, name, event_types_json, webhook_url, signing_secret, enabled, trigger_count, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        args: [
          id,
          tenantId,
          input.name,
          JSON.stringify(input.eventTypes),
          input.webhookUrl,
          input.signingSecret ?? null,
          input.enabled === false ? 0 : 1,
          now,
          now,
        ],
      });
      return {
        id,
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
    });
  }

  async updateAlertRule(
    tenantId: string,
    ruleId: string,
    patch: UpdateAlertRuleInput
  ): Promise<AlertRule | null> {
    const db = await this.getTenantDb(tenantId);
    return this.withWriteLock(tenantId, async () => {
      const existing = await this.getAlertRule(tenantId, ruleId);
      if (!existing) return null;
      const updated: AlertRule = {
        ...existing,
        name: patch.name ?? existing.name,
        eventTypes: patch.eventTypes ?? existing.eventTypes,
        webhookUrl: patch.webhookUrl ?? existing.webhookUrl,
        signingSecret:
          patch.signingSecret !== undefined ? patch.signingSecret : existing.signingSecret,
        enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
        updatedAt: nowIso(),
      };
      await db.execute({
        sql: `UPDATE alert_rules SET name = ?, event_types_json = ?, webhook_url = ?, signing_secret = ?, enabled = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ?`,
        args: [
          updated.name,
          JSON.stringify(updated.eventTypes),
          updated.webhookUrl,
          updated.signingSecret ?? null,
          updated.enabled ? 1 : 0,
          updated.updatedAt,
          tenantId,
          ruleId,
        ],
      });
      return updated;
    });
  }

  async deleteAlertRule(tenantId: string, ruleId: string): Promise<boolean> {
    const db = await this.getTenantDb(tenantId);
    return this.withWriteLock(tenantId, async () => {
      const res = await db.execute({
        sql: `DELETE FROM alert_rules WHERE tenant_id = ? AND id = ?`,
        args: [tenantId, ruleId],
      });
      return (res.rowsAffected ?? 0) > 0;
    });
  }

  async recordAlertDelivery(
    tenantId: string,
    ruleId: string,
    result: { statusCode: number | null; error: string | null }
  ): Promise<void> {
    const db = await this.getTenantDb(tenantId);
    await this.withWriteLock(tenantId, async () => {
      await db.execute({
        sql: `UPDATE alert_rules SET trigger_count = trigger_count + 1, last_triggered_at = ?, last_status_code = ?, last_error = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ?`,
        args: [nowIso(), result.statusCode, result.error, nowIso(), tenantId, ruleId],
      });
    });
  }
}

function mapTenantRow(r: Record<string, unknown>): Tenant {
  return {
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    maxConcurrentRuns: Number(r.max_concurrent_runs),
    rateLimitPerMin: Number(r.rate_limit_per_min),
    createdAt: String(r.created_at),
  };
}

function mapWorkflowRow(r: Record<string, unknown>): Workflow {
  return {
    id: String(r.id),
    name: String(r.name),
    description: r.description ? String(r.description) : undefined,
    status: String(r.status) as Workflow['status'],
    latestVersion: r.latest_version === null ? null : Number(r.latest_version),
    nodes: JSON.parse(String(r.nodes_json)),
    edges: JSON.parse(String(r.edges_json)),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapRunRow(r: Record<string, unknown>): RunDetail {
  return {
    id: String(r.id),
    workflowId: String(r.workflow_id),
    workflowName: r.workflow_name ? String(r.workflow_name) : undefined,
    versionNumber: Number(r.version_number),
    status: String(r.status) as RunDetail['status'],
    cancelRequested: Number(r.cancel_requested) === 1,
    idempotencyKey: r.idempotency_key ? String(r.idempotency_key) : undefined,
    input: JSON.parse(String(r.input_json)),
    error: r.error_json ? JSON.parse(String(r.error_json)) : null,
    steps: JSON.parse(String(r.steps_json)) as RunStep[],
    createdAt: String(r.created_at),
    startedAt: r.started_at ? String(r.started_at) : null,
    finishedAt: r.finished_at ? String(r.finished_at) : null,
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
  };
}

function mapDlqRow(r: Record<string, unknown>): DlqEntry {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    workflowId: String(r.workflow_id),
    workflowName: String(r.workflow_name),
    versionNumber: Number(r.version_number),
    failedNodeId: String(r.failed_node_id),
    failedStepLabel: String(r.failed_step_label),
    runFinalStatus: String(r.run_final_status) as DlqEntry['runFinalStatus'],
    error: JSON.parse(String(r.error_json)),
    input: JSON.parse(String(r.input_json)),
    replayedRunId: r.replayed_run_id ? String(r.replayed_run_id) : null,
    createdAt: String(r.created_at),
  };
}

function mapSecretRow(r: Record<string, unknown>): StoredSecretRecord {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    name: String(r.name),
    description: r.description ? String(r.description) : undefined,
    encryptedValue: String(r.encrypted_value),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapScheduleRow(r: Record<string, unknown>): WorkflowSchedule {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    workflowId: String(r.workflow_id),
    workflowName: String(r.workflow_name),
    name: String(r.name),
    cron: String(r.cron),
    input: JSON.parse(String(r.input_json)),
    enabled: Number(r.enabled) === 1,
    nextRunAt: r.next_run_at ? String(r.next_run_at) : null,
    lastRunAt: r.last_run_at ? String(r.last_run_at) : null,
    lastRunId: r.last_run_id ? String(r.last_run_id) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapApprovalRow(r: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    runId: String(r.run_id),
    workflowId: String(r.workflow_id),
    workflowName: String(r.workflow_name),
    nodeId: String(r.node_id),
    stepLabel: String(r.step_label),
    prompt: String(r.prompt),
    approverRole: String(r.approver_role),
    callbackToken: String(r.callback_token),
    payload: JSON.parse(String(r.payload_json)),
    status: String(r.status) as ApprovalStatus,
    decidedBy: r.decided_by ? String(r.decided_by) : null,
    comment: r.comment ? String(r.comment) : null,
    expiresAt: r.expires_at ? String(r.expires_at) : null,
    onTimeout: r.on_timeout
      ? (String(r.on_timeout) as 'reject' | 'approve' | 'escalate')
      : null,
    escalatedAt: r.escalated_at ? String(r.escalated_at) : null,
    createdAt: String(r.created_at),
    decidedAt: r.decided_at ? String(r.decided_at) : null,
  };
}

function mapAlertRuleRow(r: Record<string, unknown>): AlertRule {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    name: String(r.name),
    eventTypes: JSON.parse(String(r.event_types_json)) as AlertRule['eventTypes'],
    webhookUrl: String(r.webhook_url),
    signingSecret: r.signing_secret ? String(r.signing_secret) : null,
    enabled: Number(r.enabled) !== 0,
    triggerCount: Number(r.trigger_count ?? 0),
    lastTriggeredAt: r.last_triggered_at ? String(r.last_triggered_at) : null,
    lastStatusCode:
      r.last_status_code !== null && r.last_status_code !== undefined
        ? Number(r.last_status_code)
        : null,
    lastError: r.last_error ? String(r.last_error) : null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
