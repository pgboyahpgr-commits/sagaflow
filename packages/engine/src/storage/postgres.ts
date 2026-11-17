import { Pool, type PoolClient } from 'pg';
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

const PG_DDL = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  max_concurrent_runs INT NOT NULL DEFAULT 100,
  rate_limit_per_min INT NOT NULL DEFAULT 300,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  latest_version INT,
  nodes_json JSONB NOT NULL,
  edges_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  version_number INT NOT NULL,
  name TEXT NOT NULL,
  nodes_json JSONB NOT NULL,
  edges_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, workflow_id, version_number)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  version_number INT NOT NULL,
  status TEXT NOT NULL,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  idempotency_key TEXT NOT NULL,
  input_json JSONB NOT NULL,
  error_json JSONB,
  steps_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INT,
  UNIQUE (tenant_id, workflow_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS run_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  event_offset INT NOT NULL,
  type TEXT NOT NULL,
  node_id TEXT,
  payload_json JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, run_id, event_offset)
);

CREATE TABLE IF NOT EXISTS dlq_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  version_number INT NOT NULL,
  failed_node_id TEXT NOT NULL,
  failed_step_label TEXT NOT NULL,
  run_final_status TEXT NOT NULL,
  error_json JSONB NOT NULL,
  input_json JSONB NOT NULL,
  replayed_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  encrypted_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  input_json JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS tenant_inventory (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  warehouse TEXT NOT NULL,
  available INT NOT NULL DEFAULT 0,
  reserved INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, sku)
);

CREATE TABLE IF NOT EXISTS tenant_balances (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  currency TEXT NOT NULL,
  available DOUBLE PRECISION NOT NULL DEFAULT 0,
  locked DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);

CREATE TABLE IF NOT EXISTS tenant_kv (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  k TEXT NOT NULL,
  value_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, k)
);

CREATE TABLE IF NOT EXISTS saga_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  action TEXT NOT NULL,
  direction TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  before_json JSONB,
  after_json JSONB,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_sink_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  headers_json JSONB NOT NULL,
  body_json JSONB NOT NULL,
  status_code INT NOT NULL DEFAULT 200,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  node_id TEXT NOT NULL,
  step_label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  approver_role TEXT NOT NULL,
  callback_token TEXT NOT NULL UNIQUE,
  payload_json JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  comment TEXT,
  expires_at TIMESTAMPTZ,
  on_timeout TEXT,
  escalated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  event_types_json JSONB NOT NULL DEFAULT '[]',
  webhook_url TEXT NOT NULL,
  signing_secret TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  trigger_count INT NOT NULL DEFAULT 0,
  last_triggered_at TIMESTAMPTZ,
  last_status_code INT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlq_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_kv ENABLE ROW LEVEL SECURITY;
ALTER TABLE saga_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_sink_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'workflows','workflow_versions','runs','run_events','dlq_entries','secrets','schedules',
    'tenant_inventory','tenant_balances','tenant_kv','saga_ledger','webhook_sink_deliveries','approvals','alert_rules'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_rls_%I ON %I', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY tenant_rls_%I ON %I USING (tenant_id = current_setting(''app.current_tenant'', true)) WITH CHECK (tenant_id = current_setting(''app.current_tenant'', true))',
      tbl, tbl
    );
  END LOOP;
END $$;
`;

/**
 * Self-hosted Production PostgreSQL Adapter with Native Row-Level Security (RLS).
 * Every tenant operation runs inside a transaction with `SET LOCAL app.current_tenant`.
 */
export class PostgresStorageAdapter implements StorageAdapter {
  private readonly config: StorageConfig;
  private pool: Pool;

  constructor(config: StorageConfig) {
    if (!config.databaseUrl) {
      throw new Error('DATABASE_URL is required when STORAGE_DRIVER=postgres');
    }
    this.config = config;
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 20 });
  }

  async init(): Promise<void> {
    await this.pool.query(PG_DDL);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async withTenantTx<T>(
    tenantId: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
      const res = await fn(client);
      await client.query('COMMIT');
      return res;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listTenants(): Promise<Tenant[]> {
    const res = await this.pool.query(
      `SELECT id, name, slug, max_concurrent_runs, rate_limit_per_min, created_at FROM tenants ORDER BY created_at ASC`
    );
    return res.rows.map(mapPgTenant);
  }

  async getTenant(tenantId: string): Promise<Tenant | null> {
    const res = await this.pool.query(
      `SELECT id, name, slug, max_concurrent_runs, rate_limit_per_min, created_at FROM tenants WHERE id = $1`,
      [tenantId]
    );
    return res.rows[0] ? mapPgTenant(res.rows[0]) : null;
  }

  async getTenantBySlug(slug: string): Promise<Tenant | null> {
    const res = await this.pool.query(
      `SELECT id, name, slug, max_concurrent_runs, rate_limit_per_min, created_at FROM tenants WHERE slug = $1`,
      [slug]
    );
    return res.rows[0] ? mapPgTenant(res.rows[0]) : null;
  }

  async createTenant(input: CreateTenantInput & { id?: string }): Promise<Tenant> {
    const tenant: Tenant = {
      id: input.id ?? makeId('ten'),
      name: input.name,
      slug: input.slug,
      maxConcurrentRuns: input.maxConcurrentRuns ?? 100,
      rateLimitPerMin: input.rateLimitPerMin ?? 300,
      createdAt: nowIso(),
    };
    await this.pool.query(
      `INSERT INTO tenants (id, name, slug, max_concurrent_runs, rate_limit_per_min, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tenant.id,
        tenant.name,
        tenant.slug,
        tenant.maxConcurrentRuns,
        tenant.rateLimitPerMin,
        tenant.createdAt,
      ]
    );
    return tenant;
  }

  async ensureMembership(tenantId: string, userId: string, role = 'owner'): Promise<void> {
    await this.pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [tenantId, userId, role, nowIso()]
    );
  }

  async hasMembership(tenantId: string, userId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
      [tenantId, userId]
    );
    return res.rows.length > 0;
  }

  async getMembershipRole(tenantId: string, userId: string): Promise<import('@sagaflow/shared').RbacRole | null> {
    const res = await this.pool.query(
      `SELECT role FROM memberships WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
      [tenantId, userId]
    );
    if (res.rows.length === 0) return null;
    const { normalizeRbacRole } = await import('@sagaflow/shared');
    return normalizeRbacRole(String(res.rows[0].role ?? 'admin'));
  }

  async setMembershipRole(tenantId: string, userId: string, role: import('@sagaflow/shared').RbacRole): Promise<void> {
    await this.pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [tenantId, userId, role, nowIso()]
    );
  }

  async listTenantMembers(tenantId: string): Promise<import('@sagaflow/shared').TenantMember[]> {
    const { normalizeRbacRole } = await import('@sagaflow/shared');
    const res = await this.pool.query(
      `SELECT m.tenant_id, m.user_id, m.role, m.created_at, u.name, u.email
       FROM memberships m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1
       ORDER BY m.created_at ASC`,
      [tenantId]
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      tenantId: String(r.tenant_id),
      userId: String(r.user_id),
      role: normalizeRbacRole(String(r.role ?? 'admin')),
      name: r.name ? String(r.name) : undefined,
      email: r.email ? String(r.email) : undefined,
      createdAt: r.created_at ? String(r.created_at) : undefined,
    }));
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyInfo[]> {
    const res = await this.pool.query(
      `SELECT id, tenant_id, name, prefix, created_at, last_used_at, revoked_at
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      prefix: r.prefix,
      createdAt: new Date(r.created_at).toISOString(),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
      revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    }));
  }

  async createApiKey(
    tenantId: string,
    name: string,
    keyData: { id: string; prefix: string; hash: string }
  ): Promise<ApiKeyInfo> {
    const createdAt = nowIso();
    await this.pool.query(
      `INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [keyData.id, tenantId, name, keyData.prefix, keyData.hash, createdAt]
    );
    return {
      id: keyData.id,
      tenantId,
      name,
      prefix: keyData.prefix,
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
    };
  }

  async verifyApiKeyHash(hash: string): Promise<VerifiedApiKey | null> {
    const res = await this.pool.query(
      `UPDATE api_keys SET last_used_at = $1
       WHERE key_hash = $2 AND revoked_at IS NULL
       RETURNING id, tenant_id, name`,
      [nowIso(), hash]
    );
    if (!res.rows[0]) return null;
    return {
      keyId: res.rows[0].id,
      tenantId: res.rows[0].tenant_id,
      name: res.rows[0].name,
    };
  }

  async revokeApiKey(tenantId: string, keyId: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE api_keys SET revoked_at = $1 WHERE id = $2 AND tenant_id = $3 AND revoked_at IS NULL`,
      [nowIso(), keyId, tenantId]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async createUser(input: {
    id?: string;
    email: string;
    name: string;
    passwordHash: string;
  }): Promise<AuthUser> {
    const user: AuthUser = {
      id: input.id ?? makeId('usr'),
      email: input.email.toLowerCase(),
      name: input.name,
      createdAt: nowIso(),
    };
    await this.pool.query(
      `INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, user.email, user.name, input.passwordHash, user.createdAt]
    );
    return user;
  }

  async getUserByEmail(email: string): Promise<StoredAuthUser | null> {
    const res = await this.pool.query(
      `SELECT id, email, name, password_hash, created_at FROM users WHERE email = $1 LIMIT 1`,
      [email.toLowerCase()]
    );
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      passwordHash: r.password_hash,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async getUserById(userId: string): Promise<AuthUser | null> {
    const res = await this.pool.query(
      `SELECT id, email, name, created_at FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    if (!res.rows[0]) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async listUserTenants(userId: string): Promise<Tenant[]> {
    const res = await this.pool.query(
      `SELECT t.id, t.name, t.slug, t.max_concurrent_runs, t.rate_limit_per_min, t.created_at
       FROM tenants t INNER JOIN memberships m ON m.tenant_id = t.id
       WHERE m.user_id = $1 ORDER BY t.created_at ASC`,
      [userId]
    );
    return res.rows.map(mapPgTenant);
  }

  async listSecrets(tenantId: string): Promise<SecretMetadata[]> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, tenant_id, name, description, created_at, updated_at
         FROM secrets WHERE tenant_id = $1 ORDER BY name ASC`,
        [tenantId]
      );
      return res.rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        name: r.name,
        description: r.description ?? undefined,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      }));
    });
  }

  async getSecretRecord(tenantId: string, name: string): Promise<StoredSecretRecord | null> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM secrets WHERE tenant_id = $1 AND name = $2 LIMIT 1`,
        [tenantId, name]
      );
      return res.rows[0] ? mapPgSecret(res.rows[0]) : null;
    });
  }

  async getAllSecretRecords(tenantId: string): Promise<StoredSecretRecord[]> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(`SELECT * FROM secrets WHERE tenant_id = $1`, [tenantId]);
      return res.rows.map(mapPgSecret);
    });
  }

  async upsertSecret(
    tenantId: string,
    input: { name: string; encryptedValue: string; description?: string }
  ): Promise<SecretMetadata> {
    return this.withTenantTx(tenantId, async (client) => {
      const id = makeId('sec');
      const now = nowIso();
      const res = await client.query(
        `INSERT INTO secrets (id, tenant_id, name, description, encrypted_value, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (tenant_id, name) DO UPDATE
           SET encrypted_value = EXCLUDED.encrypted_value,
               description = COALESCE(EXCLUDED.description, secrets.description),
               updated_at = EXCLUDED.updated_at
         RETURNING id, tenant_id, name, description, created_at, updated_at`,
        [id, tenantId, input.name, input.description ?? null, input.encryptedValue, now]
      );
      const r = res.rows[0];
      return {
        id: r.id,
        tenantId: r.tenant_id,
        name: r.name,
        description: r.description ?? undefined,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      };
    });
  }

  async deleteSecret(tenantId: string, name: string): Promise<boolean> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `DELETE FROM secrets WHERE tenant_id = $1 AND name = $2`,
        [tenantId, name]
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  async listSchedules(tenantId: string): Promise<WorkflowSchedule[]> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM schedules WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId]
      );
      return res.rows.map(mapPgSchedule);
    });
  }

  async listDueSchedulesAcrossTenants(nowStr: string): Promise<WorkflowSchedule[]> {
    const tenants = await this.listTenants();
    const out: WorkflowSchedule[] = [];
    for (const t of tenants) {
      const rows = await this.withTenantTx(t.id, async (client) => {
        const res = await client.query(
          `SELECT * FROM schedules WHERE tenant_id = $1 AND enabled = TRUE AND next_run_at IS NOT NULL AND next_run_at <= $2`,
          [t.id, nowStr]
        );
        return res.rows.map(mapPgSchedule);
      });
      out.push(...rows);
    }
    return out;
  }

  async getSchedule(tenantId: string, scheduleId: string): Promise<WorkflowSchedule | null> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM schedules WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, scheduleId]
      );
      return res.rows[0] ? mapPgSchedule(res.rows[0]) : null;
    });
  }

  async createSchedule(
    tenantId: string,
    input: CreateScheduleInput & { workflowName: string; nextRunAt: string | null }
  ): Promise<WorkflowSchedule> {
    return this.withTenantTx(tenantId, async (client) => {
      const now = nowIso();
      const id = makeId('sch');
      const res = await client.query(
        `INSERT INTO schedules (
           id, tenant_id, workflow_id, workflow_name, name, cron, input_json,
           enabled, next_run_at, last_run_at, last_run_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NULL, NULL, $10, $10)
         RETURNING *`,
        [
          id,
          tenantId,
          input.workflowId,
          input.workflowName,
          input.name,
          input.cron,
          JSON.stringify(input.input ?? {}),
          input.enabled ?? true,
          input.nextRunAt,
          now,
        ]
      );
      return mapPgSchedule(res.rows[0]);
    });
  }

  async updateSchedule(
    tenantId: string,
    scheduleId: string,
    patch: UpdateScheduleInput & { nextRunAt?: string | null }
  ): Promise<WorkflowSchedule | null> {
    return this.withTenantTx(tenantId, async (client) => {
      const curRes = await client.query(
        `SELECT * FROM schedules WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, scheduleId]
      );
      if (!curRes.rows[0]) return null;
      const cur = mapPgSchedule(curRes.rows[0]);
      const res = await client.query(
        `UPDATE schedules
         SET name = $1, cron = $2, input_json = $3::jsonb, enabled = $4, next_run_at = $5, updated_at = $6
         WHERE tenant_id = $7 AND id = $8 RETURNING *`,
        [
          patch.name ?? cur.name,
          patch.cron ?? cur.cron,
          JSON.stringify(patch.input ?? cur.input),
          patch.enabled ?? cur.enabled,
          patch.nextRunAt !== undefined ? patch.nextRunAt : cur.nextRunAt,
          nowIso(),
          tenantId,
          scheduleId,
        ]
      );
      return res.rows[0] ? mapPgSchedule(res.rows[0]) : null;
    });
  }

  async markScheduleFired(
    tenantId: string,
    scheduleId: string,
    lastRunAt: string,
    lastRunId: string,
    nextRunAt: string | null
  ): Promise<WorkflowSchedule | null> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE schedules SET last_run_at = $1, last_run_id = $2, next_run_at = $3, updated_at = $4
         WHERE tenant_id = $5 AND id = $6 RETURNING *`,
        [lastRunAt, lastRunId, nextRunAt, nowIso(), tenantId, scheduleId]
      );
      return res.rows[0] ? mapPgSchedule(res.rows[0]) : null;
    });
  }

  async deleteSchedule(tenantId: string, scheduleId: string): Promise<boolean> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `DELETE FROM schedules WHERE tenant_id = $1 AND id = $2`,
        [tenantId, scheduleId]
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  async listWorkflows(tenantId: string): Promise<WorkflowListItem[]> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, name, description, status, latest_version, nodes_json, updated_at
         FROM workflows WHERE tenant_id = $1 ORDER BY updated_at DESC`,
        [tenantId]
      );
      return res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description ?? undefined,
        status: r.status,
        latestVersion: r.latest_version,
        nodeCount: Array.isArray(r.nodes_json) ? r.nodes_json.length : 0,
        updatedAt: new Date(r.updated_at).toISOString(),
      }));
    });
  }

  async getWorkflow(tenantId: string, workflowId: string): Promise<Workflow | null> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM workflows WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, workflowId]
      );
      return res.rows[0] ? mapPgWorkflow(res.rows[0]) : null;
    });
  }

  async createWorkflow(tenantId: string, input: DraftWorkflowInput, id?: string): Promise<Workflow> {
    return this.withTenantTx(tenantId, async (client) => {
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
      await client.query(
        `INSERT INTO workflows (id, tenant_id, name, description, status, latest_version, nodes_json, edges_json, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
        [
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
        ]
      );
      return wf;
    });
  }

  async updateWorkflow(
    tenantId: string,
    workflowId: string,
    input: DraftWorkflowInput
  ): Promise<Workflow | null> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE workflows
         SET name = $1, description = COALESCE($2, description), nodes_json = $3::jsonb, edges_json = $4::jsonb, updated_at = $5
         WHERE tenant_id = $6 AND id = $7
         RETURNING *`,
        [
          input.name,
          input.description ?? null,
          JSON.stringify(input.nodes ?? []),
          JSON.stringify(input.edges ?? []),
          nowIso(),
          tenantId,
          workflowId,
        ]
      );
      return res.rows[0] ? mapPgWorkflow(res.rows[0]) : null;
    });
  }

  async deleteWorkflow(tenantId: string, workflowId: string): Promise<boolean> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `DELETE FROM workflows WHERE tenant_id = $1 AND id = $2`,
        [tenantId, workflowId]
      );
      await client.query(`DELETE FROM schedules WHERE tenant_id = $1 AND workflow_id = $2`, [
        tenantId,
        workflowId,
      ]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  async publishWorkflow(
    tenantId: string,
    workflowId: string
  ): Promise<{ workflow: Workflow; version: WorkflowVersionSummary } | null> {
    return this.withTenantTx(tenantId, async (client) => {
      const cur = await client.query(
        `SELECT * FROM workflows WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, workflowId]
      );
      if (!cur.rows[0]) return null;
      const wf = mapPgWorkflow(cur.rows[0]);
      const nextVer = (wf.latestVersion ?? 0) + 1;
      const versionId = makeId('ver');
      const now = nowIso();
      await client.query(
        `INSERT INTO workflow_versions (id, tenant_id, workflow_id, version_number, name, nodes_json, edges_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
        [
          versionId,
          tenantId,
          workflowId,
          nextVer,
          wf.name,
          JSON.stringify(wf.nodes),
          JSON.stringify(wf.edges),
          now,
        ]
      );
      await client.query(
        `UPDATE workflows SET status = 'published', latest_version = $1, updated_at = $2
         WHERE tenant_id = $3 AND id = $4`,
        [nextVer, now, tenantId, workflowId]
      );
      return {
        workflow: { ...wf, status: 'published', latestVersion: nextVer, updatedAt: now },
        version: { id: versionId, workflowId, versionNumber: nextVer, createdAt: now },
      };
    });
  }

  async getWorkflowVersion(
    tenantId: string,
    workflowId: string,
    versionNumber: number
  ): Promise<WorkflowVersion | null> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM workflow_versions WHERE tenant_id = $1 AND workflow_id = $2 AND version_number = $3 LIMIT 1`,
        [tenantId, workflowId, versionNumber]
      );
      if (!res.rows[0]) return null;
      const r = res.rows[0];
      return {
        id: r.id,
        workflowId: r.workflow_id,
        versionNumber: Number(r.version_number),
        name: r.name,
        nodes: r.nodes_json,
        edges: r.edges_json,
        createdAt: new Date(r.created_at).toISOString(),
      };
    });
  }

  async listWorkflowVersions(
    tenantId: string,
    workflowId: string
  ): Promise<WorkflowVersionSummary[]> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, workflow_id, version_number, created_at FROM workflow_versions
         WHERE tenant_id = $1 AND workflow_id = $2 ORDER BY version_number DESC`,
        [tenantId, workflowId]
      );
      return res.rows.map((r) => ({
        id: r.id,
        workflowId: r.workflow_id,
        versionNumber: Number(r.version_number),
        createdAt: new Date(r.created_at).toISOString(),
      }));
    });
  }

  async createRunIdempotent(
    tenantId: string,
    input: CreateRunStorageInput
  ): Promise<{ run: RunDetail; created: boolean }> {
    return this.withTenantTx(tenantId, async (client) => {
      const existing = await client.query(
        `SELECT * FROM runs WHERE tenant_id = $1 AND workflow_id = $2 AND idempotency_key = $3 LIMIT 1`,
        [tenantId, input.workflowId, input.idempotencyKey]
      );
      if (existing.rows[0]) {
        return { run: mapPgRun(existing.rows[0]), created: false };
      }
      const now = nowIso();
      const inserted = await client.query(
        `INSERT INTO runs (
           id, tenant_id, workflow_id, workflow_name, version_number, status, cancel_requested,
           idempotency_key, input_json, error_json, steps_json, created_at
         ) VALUES ($1, $2, $3, $4, $5, 'pending', FALSE, $6, $7::jsonb, NULL, '[]'::jsonb, $8)
         ON CONFLICT (tenant_id, workflow_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          input.id,
          tenantId,
          input.workflowId,
          input.workflowName,
          input.versionNumber,
          input.idempotencyKey,
          JSON.stringify(input.input),
          now,
        ]
      );
      if (inserted.rows[0]) {
        return { run: mapPgRun(inserted.rows[0]), created: true };
      }
      const fallback = await client.query(
        `SELECT * FROM runs WHERE tenant_id = $1 AND workflow_id = $2 AND idempotency_key = $3 LIMIT 1`,
        [tenantId, input.workflowId, input.idempotencyKey]
      );
      return { run: mapPgRun(fallback.rows[0]), created: false };
    });
  }

  async getRun(tenantId: string, runId: string): Promise<RunDetail | null> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM runs WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, runId]
      );
      return res.rows[0] ? mapPgRun(res.rows[0]) : null;
    });
  }

  async listRuns(tenantId: string, query: ListRunsQuery): Promise<ListRunsResult> {
    return this.withTenantTx(tenantId, async (client) => {
      const conds: string[] = ['tenant_id = $1'];
      const args: unknown[] = [tenantId];
      let p = 2;
      if (query.workflowId) {
        conds.push(`workflow_id = $${p++}`);
        args.push(query.workflowId);
      }
      if (query.status) {
        conds.push(`status = $${p++}`);
        args.push(query.status);
      }
      if (query.cursor) {
        const [cTime, cId] = query.cursor.split('|');
        if (cTime && cId) {
          conds.push(`(created_at < $${p} OR (created_at = $${p} AND id < $${p + 1}))`);
          args.push(cTime, cId);
          p += 2;
        }
      }
      const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
      args.push(limit + 1);
      const res = await client.query(
        `SELECT id, workflow_id, workflow_name, version_number, status, cancel_requested,
                idempotency_key, created_at, started_at, finished_at, duration_ms
         FROM runs WHERE ${conds.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT $${p}`,
        args
      );
      const hasMore = res.rows.length > limit;
      const runs: RunSummary[] = res.rows.slice(0, limit).map((r) => ({
        id: r.id,
        workflowId: r.workflow_id,
        workflowName: r.workflow_name ?? undefined,
        versionNumber: Number(r.version_number),
        status: r.status,
        cancelRequested: Boolean(r.cancel_requested),
        idempotencyKey: r.idempotency_key ?? undefined,
        createdAt: new Date(r.created_at).toISOString(),
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      }));
      const last = runs[runs.length - 1];
      return { runs, nextCursor: hasMore && last ? `${last.createdAt}|${last.id}` : null };
    });
  }

  async saveRun(tenantId: string, run: RunDetail): Promise<void> {
    await this.withTenantTx(tenantId, async (client) => {
      await client.query(
        `UPDATE runs
         SET status = $1, cancel_requested = $2, error_json = $3::jsonb, steps_json = $4::jsonb,
             started_at = $5, finished_at = $6, duration_ms = $7
         WHERE tenant_id = $8 AND id = $9`,
        [
          run.status,
          run.cancelRequested,
          run.error ? JSON.stringify(run.error) : null,
          JSON.stringify(run.steps),
          run.startedAt,
          run.finishedAt,
          run.durationMs ?? null,
          tenantId,
          run.id,
        ]
      );
    });
  }

  async requestCancelRun(tenantId: string, runId: string): Promise<RunDetail | null> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE runs SET cancel_requested = TRUE WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tenantId, runId]
      );
      return res.rows[0] ? mapPgRun(res.rows[0]) : null;
    });
  }

  async appendRunEvent(
    tenantId: string,
    runId: string,
    type: RunEventType,
    payload: Record<string, unknown>,
    nodeId?: string
  ): Promise<RunEvent> {
    return this.withTenantTx(tenantId, async (client) => {
      const maxRes = await client.query(
        `SELECT COALESCE(MAX(event_offset), 0) AS max_off FROM run_events WHERE tenant_id = $1 AND run_id = $2`,
        [tenantId, runId]
      );
      const offset = Number(maxRes.rows[0].max_off) + 1;
      const timestamp = nowIso();
      await client.query(
        `INSERT INTO run_events (tenant_id, run_id, event_offset, type, node_id, payload_json, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [tenantId, runId, offset, type, nodeId ?? null, JSON.stringify(payload), timestamp]
      );
      return { offset, runId, type, timestamp, nodeId, payload };
    });
  }

  async listRunEvents(tenantId: string, runId: string, sinceOffset = 0): Promise<RunEvent[]> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `SELECT event_offset, run_id, type, node_id, payload_json, timestamp
         FROM run_events WHERE tenant_id = $1 AND run_id = $2 AND event_offset > $3
         ORDER BY event_offset ASC`,
        [tenantId, runId, sinceOffset]
      );
      return res.rows.map((r) => ({
        offset: Number(r.event_offset),
        runId: r.run_id,
        type: r.type,
        timestamp: new Date(r.timestamp).toISOString(),
        nodeId: r.node_id ?? undefined,
        payload: r.payload_json,
      }));
    });
  }

  async createDlqEntry(tenantId: string, entry: DlqEntry): Promise<DlqEntry> {
    await this.withTenantTx(tenantId, async (client) => {
      await client.query(
        `INSERT INTO dlq_entries (
           id, tenant_id, run_id, workflow_id, workflow_name, version_number,
           failed_node_id, failed_step_label, run_final_status, error_json,
           input_json, replayed_run_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)`,
        [
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
        ]
      );
    });
    return entry;
  }

  async listDlqEntries(tenantId: string): Promise<DlqEntry[]> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM dlq_entries WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [tenantId]
      );
      return res.rows.map(mapPgDlq);
    });
  }

  async getDlqEntry(tenantId: string, dlqId: string): Promise<DlqEntry | null> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM dlq_entries WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
        [tenantId, dlqId]
      );
      return res.rows[0] ? mapPgDlq(res.rows[0]) : null;
    });
  }

  async markDlqReplayed(
    tenantId: string,
    dlqId: string,
    replayedRunId: string
  ): Promise<DlqEntry | null> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE dlq_entries SET replayed_run_id = $1 WHERE tenant_id = $2 AND id = $3 RETURNING *`,
        [replayedRunId, tenantId, dlqId]
      );
      return res.rows[0] ? mapPgDlq(res.rows[0]) : null;
    });
  }

  async deleteDlqEntry(tenantId: string, dlqId: string): Promise<boolean> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(
        `DELETE FROM dlq_entries WHERE tenant_id = $1 AND id = $2`,
        [tenantId, dlqId]
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  async getTenantState(tenantId: string): Promise<TenantStateSnapshot> {
    return this.withTenantTx(tenantId, async (client) => {
      const [inv, bal, kv, led, snk] = await Promise.all([
        client.query(`SELECT * FROM tenant_inventory WHERE tenant_id = $1 ORDER BY sku ASC`, [tenantId]),
        client.query(`SELECT * FROM tenant_balances WHERE tenant_id = $1 ORDER BY account_id ASC`, [tenantId]),
        client.query(`SELECT * FROM tenant_kv WHERE tenant_id = $1 ORDER BY k ASC`, [tenantId]),
        client.query(`SELECT * FROM saga_ledger WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`, [tenantId]),
        client.query(`SELECT * FROM webhook_sink_deliveries WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`, [tenantId]),
      ]);
      return {
        tenantId,
        inventory: inv.rows.map((r) => ({
          sku: r.sku,
          name: r.name,
          warehouse: r.warehouse,
          available: Number(r.available),
          reserved: Number(r.reserved),
          updatedAt: new Date(r.updated_at).toISOString(),
        })),
        balances: bal.rows.map((r) => ({
          accountId: r.account_id,
          label: r.label,
          currency: r.currency,
          available: Number(r.available),
          locked: Number(r.locked),
          updatedAt: new Date(r.updated_at).toISOString(),
        })),
        kv: kv.rows.map((r) => ({
          key: r.k,
          value: r.value_json,
          updatedAt: new Date(r.updated_at).toISOString(),
        })),
        ledger: led.rows.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          runId: r.run_id,
          nodeId: r.node_id,
          action: r.action,
          direction: r.direction,
          resourceType: r.resource_type,
          resourceId: r.resource_id,
          status: r.status,
          summary: r.summary,
          beforeState: r.before_json ?? null,
          afterState: r.after_json ?? null,
          createdAt: new Date(r.created_at).toISOString(),
        })),
        sinkDeliveries: snk.rows.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          channel: r.channel,
          method: r.method,
          path: r.path,
          headers: r.headers_json,
          body: r.body_json,
          statusCode: Number(r.status_code),
          createdAt: new Date(r.created_at).toISOString(),
        })),
      };
    });
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
    return this.withTenantTx(tenantId, async (client) => {
      const cur = await client.query(
        `SELECT * FROM tenant_inventory WHERE tenant_id = $1 AND sku = $2 FOR UPDATE`,
        [tenantId, input.sku]
      );
      const before: TenantInventoryItem | null = cur.rows[0]
        ? {
            sku: cur.rows[0].sku,
            name: cur.rows[0].name,
            warehouse: cur.rows[0].warehouse,
            available: Number(cur.rows[0].available),
            reserved: Number(cur.rows[0].reserved),
            updatedAt: new Date(cur.rows[0].updated_at).toISOString(),
          }
        : null;
      let nextAvail = before
        ? before.available + input.deltaAvailable
        : Math.max(0, input.deltaAvailable < 0 ? 100 + input.deltaAvailable : input.deltaAvailable);
      const nextRes = Math.max(0, (before?.reserved ?? 0) + (input.deltaReserved ?? 0));
      if (input.requireSufficient && nextAvail < 0) {
        throw new Error(
          `Insufficient inventory for ${input.sku}: requested ${Math.abs(input.deltaAvailable)}, available ${before?.available ?? 0}`
        );
      }
      nextAvail = Math.max(0, nextAvail);
      const now = nowIso();
      const name = input.name ?? before?.name ?? input.sku;
      const warehouse = input.warehouse ?? before?.warehouse ?? 'ap-south-1';
      await client.query(
        `INSERT INTO tenant_inventory (tenant_id, sku, name, warehouse, available, reserved, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, sku) DO UPDATE SET
           name = EXCLUDED.name, warehouse = EXCLUDED.warehouse,
           available = EXCLUDED.available, reserved = EXCLUDED.reserved, updated_at = EXCLUDED.updated_at`,
        [tenantId, input.sku, name, warehouse, nextAvail, nextRes, now]
      );
      return {
        before,
        item: { sku: input.sku, name, warehouse, available: nextAvail, reserved: nextRes, updatedAt: now },
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
    return this.withTenantTx(tenantId, async (client) => {
      const cur = await client.query(
        `SELECT * FROM tenant_balances WHERE tenant_id = $1 AND account_id = $2 FOR UPDATE`,
        [tenantId, input.accountId]
      );
      const before: TenantAccountBalance | null = cur.rows[0]
        ? {
            accountId: cur.rows[0].account_id,
            label: cur.rows[0].label,
            currency: cur.rows[0].currency,
            available: Number(cur.rows[0].available),
            locked: Number(cur.rows[0].locked),
            updatedAt: new Date(cur.rows[0].updated_at).toISOString(),
          }
        : null;
      const currency = input.currency ?? before?.currency ?? 'USD';
      const nextAvail = Number(((before?.available ?? 0) + input.deltaAvailable).toFixed(2));
      const nextLocked = Math.max(0, Number(((before?.locked ?? 0) + (input.deltaLocked ?? 0)).toFixed(2)));
      if (input.requireSufficient && nextAvail < 0) {
        throw new Error(
          `Insufficient balance on "${input.accountId}": needed ${Math.abs(input.deltaAvailable)} ${currency}, available ${before?.available ?? 0} ${currency}`
        );
      }
      const now = nowIso();
      const label = input.label ?? before?.label ?? input.accountId;
      await client.query(
        `INSERT INTO tenant_balances (tenant_id, account_id, label, currency, available, locked, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, account_id) DO UPDATE SET
           label = EXCLUDED.label, currency = EXCLUDED.currency,
           available = EXCLUDED.available, locked = EXCLUDED.locked, updated_at = EXCLUDED.updated_at`,
        [tenantId, input.accountId, label, currency, nextAvail, nextLocked, now]
      );
      return {
        before,
        balance: { accountId: input.accountId, label, currency, available: nextAvail, locked: nextLocked, updatedAt: now },
      };
    });
  }

  async setKv(
    tenantId: string,
    key: string,
    value: unknown
  ): Promise<{ record: TenantKvRecord; previousValue: unknown; existed: boolean }> {
    return this.withTenantTx(tenantId, async (client) => {
      const cur = await client.query(
        `SELECT value_json FROM tenant_kv WHERE tenant_id = $1 AND k = $2 LIMIT 1`,
        [tenantId, key]
      );
      const existed = Boolean(cur.rows[0]);
      const previousValue = existed ? cur.rows[0].value_json : undefined;
      const now = nowIso();
      await client.query(
        `INSERT INTO tenant_kv (tenant_id, k, value_json, updated_at) VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (tenant_id, k) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at`,
        [tenantId, key, JSON.stringify(value ?? null), now]
      );
      return { record: { key, value, updatedAt: now }, previousValue, existed };
    });
  }

  async deleteKv(tenantId: string, key: string): Promise<boolean> {
    return this.withTenantTx(tenantId, async (client) => {
      const res = await client.query(`DELETE FROM tenant_kv WHERE tenant_id = $1 AND k = $2`, [tenantId, key]);
      return (res.rowCount ?? 0) > 0;
    });
  }

  async appendLedgerEntry(
    tenantId: string,
    entry: Omit<SagaLedgerEntry, 'id' | 'tenantId' | 'createdAt'>
  ): Promise<SagaLedgerEntry> {
    return this.withTenantTx(tenantId, async (client) => {
      const full: SagaLedgerEntry = { ...entry, id: makeId('ldg'), tenantId, createdAt: nowIso() };
      await client.query(
        `INSERT INTO saga_ledger (
           id, tenant_id, run_id, node_id, action, direction,
           resource_type, resource_id, status, summary, before_json, after_json, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)`,
        [
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
        ]
      );
      return full;
    });
  }

  async recordSinkDelivery(
    tenantId: string,
    delivery: Omit<WebhookSinkDelivery, 'id' | 'tenantId' | 'createdAt'>
  ): Promise<WebhookSinkDelivery> {
    return this.withTenantTx(tenantId, async (client) => {
      const full: WebhookSinkDelivery = { ...delivery, id: makeId('snk'), tenantId, createdAt: nowIso() };
      await client.query(
        `INSERT INTO webhook_sink_deliveries (
           id, tenant_id, channel, method, path, headers_json, body_json, status_code, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
        [
          full.id,
          tenantId,
          full.channel,
          full.method,
          full.path,
          JSON.stringify(full.headers),
          JSON.stringify(full.body ?? null),
          full.statusCode,
          full.createdAt,
        ]
      );
      return full;
    });
  }

  async clearSinkDeliveries(tenantId: string): Promise<void> {
    await this.withTenantTx(tenantId, async (client) => {
      await client.query(`DELETE FROM webhook_sink_deliveries WHERE tenant_id = $1`, [tenantId]);
    });
  }

  async listPendingRunsAcrossTenants(): Promise<Array<{ tenantId: string; runId: string }>> {
    const tenants = await this.listTenants();
    const out: Array<{ tenantId: string; runId: string }> = [];
    for (const t of tenants) {
      const rows = await this.withTenantTx(t.id, async (client) => {
        const r = await client.query(
          `SELECT id FROM runs WHERE tenant_id = $1 AND status IN ('pending', 'running', 'compensating')`,
          [t.id]
        );
        return r.rows;
      });
      for (const r of rows) out.push({ tenantId: t.id, runId: r.id });
    }
    return out;
  }

  async getTenantMetrics(tenantId: string, rateLimitUsed: number): Promise<MetricsSnapshot> {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    const [workflows, runs, dlqEntries, storage] = await Promise.all([
      this.listWorkflows(tenantId),
      this.withTenantTx(tenantId, async (c) => {
        const r = await c.query(
          `SELECT * FROM runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1000`,
          [tenantId]
        );
        return r.rows.map(mapPgRun);
      }),
      this.listDlqEntries(tenantId),
      this.getStorageStatus(tenantId),
    ]);
    return buildMetricsSnapshot({ tenant, storage, workflows, runs, dlqEntries, rateLimitUsed });
  }

  async getStorageStatus(_tenantId?: string): Promise<StorageStatus> {
    const tenants = await this.listTenants();
    const sanitizedUrl = (this.config.databaseUrl ?? '').replace(/:\/\/[^@]+@/, '://***@');
    return {
      driver: 'postgres',
      isolation: 'rls',
      location: sanitizedUrl,
      queueDriver: this.config.queueDriver,
      workerConcurrency: this.config.workerConcurrency,
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
    return this.withTenantTx(tenantId, async (c) => {
      const id = makeId('apr');
      const callbackToken = `${makeId('cbk')}${makeId('tok').slice(4)}`;
      const createdAt = nowIso();
      await c.query(
        `INSERT INTO approvals (id, tenant_id, run_id, workflow_id, workflow_name, node_id, step_label, prompt, approver_role, callback_token, payload_json, status, expires_at, on_timeout, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,$14)`,
        [
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
        ]
      );
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
    return this.withTenantTx(tenantId, async (c) => {
      const r = status
        ? await c.query(
            `SELECT * FROM approvals WHERE tenant_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 200`,
            [tenantId, status]
          )
        : await c.query(
            `SELECT * FROM approvals WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`,
            [tenantId]
          );
      return r.rows.map(mapPgApproval);
    });
  }

  async getApproval(tenantId: string, approvalId: string): Promise<ApprovalRequest | null> {
    return this.withTenantTx(tenantId, async (c) => {
      const r = await c.query(
        `SELECT * FROM approvals WHERE tenant_id = $1 AND id = $2`,
        [tenantId, approvalId]
      );
      return r.rows[0] ? mapPgApproval(r.rows[0]) : null;
    });
  }

  async getApprovalByRunNode(
    tenantId: string,
    runId: string,
    nodeId: string
  ): Promise<ApprovalRequest | null> {
    return this.withTenantTx(tenantId, async (c) => {
      const r = await c.query(
        `SELECT * FROM approvals WHERE tenant_id = $1 AND run_id = $2 AND node_id = $3 ORDER BY created_at DESC LIMIT 1`,
        [tenantId, runId, nodeId]
      );
      return r.rows[0] ? mapPgApproval(r.rows[0]) : null;
    });
  }

  async getApprovalByToken(token: string): Promise<ApprovalRequest | null> {
    const tenants = await this.listTenants();
    for (const t of tenants) {
      const found = await this.withTenantTx(t.id, async (c) => {
        const r = await c.query(`SELECT * FROM approvals WHERE callback_token = $1 LIMIT 1`, [token]);
        return r.rows[0] ? mapPgApproval(r.rows[0]) : null;
      });
      if (found) return found;
    }
    return null;
  }

  async decideApproval(
    tenantId: string,
    approvalId: string,
    decision: { status: 'approved' | 'rejected'; decidedBy: string; comment?: string }
  ): Promise<ApprovalRequest | null> {
    return this.withTenantTx(tenantId, async (c) => {
      const decidedAt = nowIso();
      const r = await c.query(
        `UPDATE approvals SET status = $1, decided_by = $2, comment = $3, decided_at = $4
         WHERE tenant_id = $5 AND id = $6 AND status = 'pending' RETURNING *`,
        [decision.status, decision.decidedBy, decision.comment ?? null, decidedAt, tenantId, approvalId]
      );
      return r.rows[0] ? mapPgApproval(r.rows[0]) : null;
    });
  }

  async markApprovalEscalated(tenantId: string, approvalId: string): Promise<void> {
    await this.withTenantTx(tenantId, async (c) => {
      await c.query(`UPDATE approvals SET escalated_at = $1 WHERE tenant_id = $2 AND id = $3`, [
        nowIso(),
        tenantId,
        approvalId,
      ]);
    });
  }

  async listExpiredPendingApprovals(nowIsoStr: string): Promise<ApprovalRequest[]> {
    const tenants = await this.listTenants();
    const expired: ApprovalRequest[] = [];
    for (const t of tenants) {
      const rows = await this.withTenantTx(t.id, async (c) => {
        const r = await c.query(
          `SELECT * FROM approvals WHERE tenant_id = $1 AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $2`,
          [t.id, nowIsoStr]
        );
        return r.rows.map(mapPgApproval);
      });
      expired.push(...rows);
    }
    return expired;
  }

  async listAlertRules(tenantId: string): Promise<AlertRule[]> {
    return this.withTenantTx(tenantId, async (c) => {
      const r = await c.query(
        `SELECT * FROM alert_rules WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId]
      );
      return r.rows.map(mapPgAlertRule);
    });
  }

  async getAlertRule(tenantId: string, ruleId: string): Promise<AlertRule | null> {
    return this.withTenantTx(tenantId, async (c) => {
      const r = await c.query(`SELECT * FROM alert_rules WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        ruleId,
      ]);
      return r.rows[0] ? mapPgAlertRule(r.rows[0]) : null;
    });
  }

  async createAlertRule(tenantId: string, input: CreateAlertRuleInput): Promise<AlertRule> {
    return this.withTenantTx(tenantId, async (c) => {
      const id = makeId('alr');
      const now = nowIso();
      await c.query(
        `INSERT INTO alert_rules (id, tenant_id, name, event_types_json, webhook_url, signing_secret, enabled, trigger_count, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9)`,
        [
          id,
          tenantId,
          input.name,
          JSON.stringify(input.eventTypes),
          input.webhookUrl,
          input.signingSecret ?? null,
          input.enabled !== false,
          now,
          now,
        ]
      );
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
    return this.withTenantTx(tenantId, async (c) => {
      const cur = await c.query(`SELECT * FROM alert_rules WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        ruleId,
      ]);
      if (!cur.rows[0]) return null;
      const existing = mapPgAlertRule(cur.rows[0]);
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
      await c.query(
        `UPDATE alert_rules SET name=$1, event_types_json=$2, webhook_url=$3, signing_secret=$4, enabled=$5, updated_at=$6
         WHERE tenant_id=$7 AND id=$8`,
        [
          updated.name,
          JSON.stringify(updated.eventTypes),
          updated.webhookUrl,
          updated.signingSecret ?? null,
          updated.enabled,
          updated.updatedAt,
          tenantId,
          ruleId,
        ]
      );
      return updated;
    });
  }

  async deleteAlertRule(tenantId: string, ruleId: string): Promise<boolean> {
    return this.withTenantTx(tenantId, async (c) => {
      const r = await c.query(`DELETE FROM alert_rules WHERE tenant_id = $1 AND id = $2`, [
        tenantId,
        ruleId,
      ]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  async recordAlertDelivery(
    tenantId: string,
    ruleId: string,
    result: { statusCode: number | null; error: string | null }
  ): Promise<void> {
    await this.withTenantTx(tenantId, async (c) => {
      await c.query(
        `UPDATE alert_rules SET trigger_count = trigger_count + 1, last_triggered_at = $1, last_status_code = $2, last_error = $3, updated_at = $4
         WHERE tenant_id = $5 AND id = $6`,
        [nowIso(), result.statusCode, result.error, nowIso(), tenantId, ruleId]
      );
    });
  }
}

function mapPgTenant(r: Record<string, any>): Tenant {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    maxConcurrentRuns: Number(r.max_concurrent_runs),
    rateLimitPerMin: Number(r.rate_limit_per_min),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function mapPgWorkflow(r: Record<string, any>): Workflow {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    status: r.status,
    latestVersion: r.latest_version === null ? null : Number(r.latest_version),
    nodes: r.nodes_json,
    edges: r.edges_json,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function mapPgRun(r: Record<string, any>): RunDetail {
  return {
    id: r.id,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name ?? undefined,
    versionNumber: Number(r.version_number),
    status: r.status,
    cancelRequested: Boolean(r.cancel_requested),
    idempotencyKey: r.idempotency_key ?? undefined,
    input: r.input_json,
    error: r.error_json ?? null,
    steps: r.steps_json,
    createdAt: new Date(r.created_at).toISOString(),
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
  };
}

function mapPgDlq(r: Record<string, any>): DlqEntry {
  return {
    id: r.id,
    runId: r.run_id,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name,
    versionNumber: Number(r.version_number),
    failedNodeId: r.failed_node_id,
    failedStepLabel: r.failed_step_label,
    runFinalStatus: r.run_final_status,
    error: r.error_json,
    input: r.input_json,
    replayedRunId: r.replayed_run_id ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function mapPgSecret(r: Record<string, any>): StoredSecretRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    description: r.description ?? undefined,
    encryptedValue: r.encrypted_value,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function mapPgSchedule(r: Record<string, any>): WorkflowSchedule {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name,
    name: r.name,
    cron: r.cron,
    input: r.input_json,
    enabled: Boolean(r.enabled),
    nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
    lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
    lastRunId: r.last_run_id ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function mapPgApproval(r: Record<string, any>): ApprovalRequest {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    runId: r.run_id,
    workflowId: r.workflow_id,
    workflowName: r.workflow_name,
    nodeId: r.node_id,
    stepLabel: r.step_label,
    prompt: r.prompt,
    approverRole: r.approver_role,
    callbackToken: r.callback_token,
    payload: r.payload_json ?? {},
    status: r.status,
    decidedBy: r.decided_by ?? null,
    comment: r.comment ?? null,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    onTimeout: r.on_timeout ?? null,
    escalatedAt: r.escalated_at ? new Date(r.escalated_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
  };
}

function mapPgAlertRule(r: Record<string, any>): AlertRule {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    eventTypes: Array.isArray(r.event_types_json)
      ? r.event_types_json
      : JSON.parse(String(r.event_types_json ?? '[]')),
    webhookUrl: r.webhook_url,
    signingSecret: r.signing_secret ?? null,
    enabled: Boolean(r.enabled),
    triggerCount: Number(r.trigger_count ?? 0),
    lastTriggeredAt: r.last_triggered_at ? new Date(r.last_triggered_at).toISOString() : null,
    lastStatusCode:
      r.last_status_code !== null && r.last_status_code !== undefined
        ? Number(r.last_status_code)
        : null,
    lastError: r.last_error ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
