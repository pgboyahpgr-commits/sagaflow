import {
  AdjustBalanceSchema,
  AiAgentChatRequestSchema,
  AiTestConnectionSchema,
  ApiError,
  CUSTOM_TASK_HANDLERS,
  CreateAlertRuleSchema,
  CreateApiKeySchema,
  CreateProjectSchema,
  CreateScheduleSchema,
  CreateTenantSchema,
  DecideApprovalSchema,
  DraftWorkflowSchema,
  DryRunWorkflowSchema,
  HttpTestSchema,
  ListRunsQuerySchema,
  LoginUserSchema,
  RegisterUserSchema,
  RestockInventorySchema,
  ResumeRunFromStepSchema,
  SandboxTestSchema,
  SaveAiConfigSchema,
  StartRunBodySchema,
  StressTestSchema,
  UpdateAlertRuleSchema,
  UpdateScheduleSchema,
  UpsertSecretSchema,
  UpsertTenantMemberSchema,
  WorkflowDefinitionSchema,
  computeWorkflowDiff,
  describeCron,
  getNextCronDate,
  isTerminalRunStatus,
  validateCronExpression,
  validateWorkflowGraph,
  type ProjectSummary,
  type SignedAuditBundle,
} from '@sagaflow/shared';
import {
  CronScheduler,
  DEMO_USER_ID,
  RunEventBus,
  SagaOrchestrator,
  SecretCipher,
  computeWebhookHmac,
  deliverAlertToRule,
  diagnoseWorkflowRun,
  dryRunWorkflowGraph,
  ensureDefaultTenantState,
  executeLiveHttpRequest,
  fetchLmStudioModels,
  generateApiKey,
  getAiConfig,
  hashPassword,
  makeId,
  redactSecrets,
  resolveAiCredentials,
  resolveTemplates,
  runAiAutomationAgent,
  runInQuickJSSandbox,
  runStressTest,
  saveAiConfig,
  signJwt,
  testAiConnection,
  verifyJwt,
  verifyPassword,
  verifyWebhookHmac,
  type QueueAdapter,
  type StorageAdapter,
} from '@sagaflow/engine';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ZodError } from 'zod';
import {
  TenantRateLimiter,
  createTenantAuthMiddleware,
  extractBearerOrCookieToken,
  formatZodError,
  type AuthContext,
} from './middleware.js';
import { buildOpenApiSpec, renderApiDocsHtml } from './openapi.js';

export interface CreateAppOptions {
  storage: StorageAdapter;
  queue: QueueAdapter;
  eventBus: RunEventBus;
  orchestrator: SagaOrchestrator;
  cipher?: SecretCipher;
  scheduler?: CronScheduler;
  jwtSecret?: string;
  role?: 'all' | 'api' | 'worker';
  authMode?: 'dev' | 'prod';
  rateLimitWindowMs?: number;
}

type AppEnv = {
  Variables: {
    auth: AuthContext;
  };
};

async function parseJsonBody(c: any): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_request', 'Request body must be valid JSON.');
  }
}

export function createApiApp(options: CreateAppOptions): Hono<AppEnv> {
  const { storage, queue, eventBus, orchestrator } = options;
  const authMode = options.authMode ?? ((process.env.AUTH_MODE as 'dev' | 'prod') || 'dev');
  const role = options.role ?? ((process.env.ROLE as 'all' | 'api' | 'worker') || 'all');
  const cipher =
    options.cipher ?? new SecretCipher({ masterKey: process.env.SAGAFLOW_MASTER_KEY ?? 'sagaflow-dev-master' });
  const jwtSecret =
    options.jwtSecret ??
    process.env.SAGAFLOW_JWT_SECRET ??
    process.env.SAGAFLOW_MASTER_KEY ??
    cipher.getSigningSecret().toString('hex');
  const scheduler = options.scheduler;
  const rateLimiter = new TenantRateLimiter(options.rateLimitWindowMs ?? 60_000);

  /**
   * Resolve the signed-in user from the HttpOnly session cookie or a Bearer JWT.
   * Used by the control-plane routes (tenants/projects), which are open in
   * AUTH_MODE=dev for a zero-friction local experience but must never leak or
   * mutate data anonymously in AUTH_MODE=prod.
   */
  const resolveSessionUser = async (c: any) => {
    const { jwtToken } = extractBearerOrCookieToken(c);
    if (!jwtToken) return null;
    const payload = verifyJwt(jwtToken, jwtSecret);
    if (!payload) return null;
    const user = await storage.getUserById(payload.sub);
    if (!user) return null;
    return { id: user.id, email: user.email, name: user.name };
  };

  const setSessionCookie = (c: any, token: string, maxAgeSeconds = 7 * 86400) => {
    const forwardedProto = c.req.header('x-forwarded-proto');
    const isHttps =
      forwardedProto === 'https' || String(c.req.url ?? '').startsWith('https://');
    const secure = isHttps ? '; Secure' : '';
    const value = token ? encodeURIComponent(token) : '';
    c.header(
      'Set-Cookie',
      `sf_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`
    );
  };

  const app = new Hono<AppEnv>();

  // Global unified error handler (API Contract v1.1 Section 7)
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(err.toJSON(), err.status as any);
    }
    if (err instanceof ZodError) {
      const apiErr = formatZodError(err);
      return c.json(apiErr.toJSON(), 400);
    }
    console.error('[SagaFlow API Error]', err);
    return c.json(
      {
        code: 'internal_error',
        message: 'An unexpected server error occurred.',
      },
      500
    );
  });

  // ---------------- Public / Health / Validate Routes ----------------

  app.get('/api/health', async (c) => {
    const storageStatus = await storage.getStorageStatus();
    return c.json({
      status: 'ok',
      version: process.env.SAGAFLOW_VERSION ?? '8.0.0',
      role,
      authMode,
      encryption: 'AES-256-GCM',
      deployment: {
        platform: process.env.VERCEL ? 'vercel' : 'self-hosted',
        ephemeralStorage: process.env.STORAGE_EPHEMERAL === 'true',
      },
      scheduler: scheduler ? scheduler.getStats() : { running: false, pollIntervalMs: 0, totalFired: 0 },
      storage: storageStatus,
      queue: {
        driver: queue.driver,
        ...queue.getStats(),
      },
      handlers: CUSTOM_TASK_HANDLERS,
      timestamp: new Date().toISOString(),
    });
  });

  // ---------------- Self-Hosted User Authentication (scrypt + HS256 JWT) ----------------

  app.post('/api/auth/register', async (c) => {
    const raw = await parseJsonBody(c);
    const input = RegisterUserSchema.parse(raw);
    const existing = await storage.getUserByEmail(input.email);
    if (existing) {
      throw new ApiError(409, 'conflict', `An account with email "${input.email}" already exists.`);
    }

    const user = await storage.createUser({
      email: input.email,
      name: input.name,
      passwordHash: hashPassword(input.password),
    });

    // Grant access to a brand-new tenant if requested, otherwise attach to existing demo tenants in dev mode
    const tenants = [];
    if (input.tenantName) {
      const slug =
        input.tenantName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') +
        '-' +
        makeId('t').slice(-4);
      const t = await storage.createTenant({
        name: input.tenantName,
        slug,
        maxConcurrentRuns: 100,
        rateLimitPerMin: 300,
      });
      await ensureDefaultTenantState(storage, t.id);
      await storage.ensureMembership(t.id, user.id, 'owner');
      tenants.push(t);
    } else {
      const allTenants = await storage.listTenants();
      if (allTenants.length > 0 && authMode === 'dev') {
        for (const t of allTenants) {
          await storage.ensureMembership(t.id, user.id, 'member');
          tenants.push(t);
        }
      } else {
        const slug = `org-${makeId('t').slice(-6)}`;
        const t = await storage.createTenant({
          name: `${input.name}'s Workspace`,
          slug,
          maxConcurrentRuns: 100,
          rateLimitPerMin: 300,
        });
        await ensureDefaultTenantState(storage, t.id);
        await storage.ensureMembership(t.id, user.id, 'owner');
        tenants.push(t);
      }
    }

    const token = signJwt({ sub: user.id, email: user.email, name: user.name }, jwtSecret);
    setSessionCookie(c, token);
    return c.json({ user, token, tenants }, 201);
  });

  app.post('/api/auth/login', async (c) => {
    const raw = await parseJsonBody(c);
    const input = LoginUserSchema.parse(raw);
    const stored = await storage.getUserByEmail(input.email);
    if (!stored || !verifyPassword(input.password, stored.passwordHash)) {
      throw new ApiError(401, 'unauthenticated', 'Invalid email or password.');
    }

    const user = {
      id: stored.id,
      email: stored.email,
      name: stored.name,
      createdAt: stored.createdAt,
    };
    const tenants = await storage.listUserTenants(user.id);
    const token = signJwt({ sub: user.id, email: user.email, name: user.name }, jwtSecret);
    setSessionCookie(c, token);
    return c.json({ user, token, tenants });
  });

  app.post('/api/auth/logout', (c) => {
    setSessionCookie(c, '', 0);
    return c.json({ loggedOut: true });
  });

  app.get('/api/auth/me', async (c) => {
    const { jwtToken } = extractBearerOrCookieToken(c);
    if (!jwtToken) {
      return c.json({ authenticated: false, authMode, user: null, tenants: [] });
    }
    const payload = verifyJwt(jwtToken, jwtSecret);
    if (!payload) {
      return c.json({ authenticated: false, authMode, user: null, tenants: [] });
    }
    const user = await storage.getUserById(payload.sub);
    if (!user) {
      return c.json({ authenticated: false, authMode, user: null, tenants: [] });
    }
    const tenants = await storage.listUserTenants(user.id);
    return c.json({ authenticated: true, authMode, user, tenants });
  });

  // ---------------- Public Inbound Webhook Ingress ----------------

  /**
   * POST /api/hooks/:tenantSlug/:workflowId
   * Public webhook endpoint so external systems (Stripe, GitHub, Shopify, curl) can trigger
   * published workflows without user credentials.
   * Supports optional HMAC-SHA256 verification via `X-SagaFlow-Signature: sha256=<hex>`
   * (or `X-Hub-Signature-256`) when the trigger node defines `config.webhookSecretName`
   * (referencing a tenant secret in the AES-256-GCM vault) or `config.requireSignature: true`.
   */
  app.post('/api/hooks/:tenantSlug/:workflowId', async (c) => {
    const tenantSlug = c.req.param('tenantSlug');
    const workflowId = c.req.param('workflowId');

    const tenant = await storage.getTenantBySlug(tenantSlug);
    if (!tenant) {
      throw new ApiError(404, 'workflow_not_found', 'Webhook endpoint not found.');
    }

    // Per-tenant rate limiting applies to inbound webhooks too!
    const rl = rateLimiter.checkAndConsume(tenant.id, tenant.rateLimitPerMin);
    c.header('X-RateLimit-Limit', String(rl.limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, rl.limit - rl.used)));
    if (!rl.allowed) {
      throw new ApiError(429, 'rate_limit_exceeded', 'Tenant webhook rate limit exceeded.');
    }

    const wf = await storage.getWorkflow(tenant.id, workflowId);
    if (!wf) {
      throw new ApiError(404, 'workflow_not_found', 'Webhook workflow not found.');
    }
    if (wf.latestVersion === null) {
      throw new ApiError(
        409,
        'workflow_not_published',
        'Workflow must be published before accepting inbound webhooks.'
      );
    }

    const rawBody = await c.req.text();
    let parsedBody: Record<string, unknown> = {};
    if (rawBody.trim()) {
      try {
        const json = JSON.parse(rawBody);
        parsedBody =
          json && typeof json === 'object' && !Array.isArray(json)
            ? (json as Record<string, unknown>)
            : { data: json };
      } catch {
        throw new ApiError(400, 'invalid_request', 'Webhook payload must be valid JSON.');
      }
    }

    // Check trigger node config for optional HMAC-SHA256 signature enforcement
    const version = await storage.getWorkflowVersion(tenant.id, wf.id, wf.latestVersion);
    const triggerNode = version?.nodes.find((n) => n.type === 'trigger');
    const triggerCfg = (triggerNode?.config ?? {}) as Record<string, unknown>;
    const secretName =
      typeof triggerCfg.webhookSecretName === 'string' && triggerCfg.webhookSecretName.trim()
        ? triggerCfg.webhookSecretName.trim()
        : triggerCfg.requireSignature
          ? 'WEBHOOK_SECRET'
          : null;

    let signatureVerified = false;
    const providedSig =
      c.req.header('x-sagaflow-signature') ?? c.req.header('x-hub-signature-256');

    if (secretName) {
      const secretRec = await storage.getSecretRecord(tenant.id, secretName);
      if (!secretRec) {
        throw new ApiError(
          401,
          'invalid_webhook_signature',
          `Webhook requires HMAC signature using tenant secret "${secretName}", which is not configured.`
        );
      }
      const secretVal = cipher.decrypt(secretRec.encryptedValue);
      if (!providedSig || !verifyWebhookHmac(secretVal, rawBody, providedSig)) {
        throw new ApiError(
          401,
          'invalid_webhook_signature',
          'Missing or invalid HMAC-SHA256 webhook signature.'
        );
      }
      signatureVerified = true;
    } else if (providedSig) {
      // Opportunistically verify if caller passed a signature and WEBHOOK_SECRET exists
      const fallbackRec = await storage.getSecretRecord(tenant.id, 'WEBHOOK_SECRET');
      if (fallbackRec) {
        const secretVal = cipher.decrypt(fallbackRec.encryptedValue);
        if (!verifyWebhookHmac(secretVal, rawBody, providedSig)) {
          throw new ApiError(
            401,
            'invalid_webhook_signature',
            'Invalid HMAC-SHA256 webhook signature against WEBHOOK_SECRET.'
          );
        }
        signatureVerified = true;
      }
    }

    const idempotencyKey =
      c.req.header('idempotency-key') ??
      c.req.header('x-delivery-id') ??
      `hook_${makeId('evt')}`;

    const webhookInput: Record<string, unknown> = {
      ...parsedBody,
      _webhook: {
        tenantSlug,
        workflowId,
        deliveryId: idempotencyKey,
        signatureVerified,
        receivedAt: new Date().toISOString(),
      },
    };

    const { run, created } = await storage.createRunIdempotent(tenant.id, {
      id: makeId('run'),
      workflowId: wf.id,
      workflowName: wf.name,
      versionNumber: wf.latestVersion,
      idempotencyKey,
      input: webhookInput,
    });
    const deduplicated = !created;

    if (created) {
      await orchestrator.enqueueRun(tenant.id, run.id);
    }

    return c.json(
      {
        accepted: true,
        deduplicated,
        signatureVerified,
        run: {
          id: run.id,
          workflowId: run.workflowId,
          versionNumber: run.versionNumber,
          status: run.status,
          createdAt: run.createdAt,
        },
      },
      deduplicated ? 200 : 202
    );
  });

  /**
   * POST /api/workflows/validate (no saving, no tenant required — API Contract Section 3 & 4.2)
   */
  app.post('/api/workflows/validate', async (c) => {
    const raw = await parseJsonBody(c);
    const parsed = WorkflowDefinitionSchema.parse(raw);
    const result = validateWorkflowGraph(parsed.nodes, parsed.edges);

    if (!result.valid) {
      throw new ApiError(
        422,
        'invalid_workflow_graph',
        `Workflow graph has ${result.issues.length} validation issue(s).`,
        result.issues
      );
    }

    return c.json({
      valid: true,
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
      topologicalOrder: result.topologicalOrder,
    });
  });

  // ---------------- Tenant Control Plane Routes ----------------

  app.get('/api/tenants', async (c) => {
    if (authMode === 'prod') {
      const user = await resolveSessionUser(c);
      if (!user) return c.json({ tenants: [] });
      return c.json({ tenants: await storage.listUserTenants(user.id) });
    }
    const tenants = await storage.listTenants();
    return c.json({ tenants });
  });

  app.post('/api/tenants', async (c) => {
    const raw = await parseJsonBody(c);
    const input = CreateTenantSchema.parse(raw);
    const sessionUser = authMode === 'prod' ? await resolveSessionUser(c) : null;
    if (authMode === 'prod' && !sessionUser) {
      throw new ApiError(401, 'unauthenticated', 'Sign in to provision a new tenant.');
    }
    const existing = await storage.getTenantBySlug(input.slug);
    if (existing) {
      throw new ApiError(409, 'invalid_request', `Tenant slug "${input.slug}" is already taken.`);
    }
    const tenant = await storage.createTenant(input);
    await ensureDefaultTenantState(storage, tenant.id);
    // In dev mode, grant demo admin membership so the UI can switch into the newly provisioned tenant immediately
    const userId = sessionUser?.id ?? c.req.header('x-user-id') ?? DEMO_USER_ID;
    await storage.ensureMembership(tenant.id, userId, 'owner');
    if (authMode !== 'prod') {
      await storage.ensureMembership(tenant.id, DEMO_USER_ID, 'owner');
    }
    return c.json({ tenant }, 201);
  });

  // ---------------- v7.0 Projects Workspace Hub (Empty or Template-Backed Isolated Projects) ----------------

  const buildProjectSummary = async (tenant: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
  }): Promise<ProjectSummary> => {
    const [workflows, runsPage, approvals, dlq, state] = await Promise.all([
      storage.listWorkflows(tenant.id),
      storage.listRuns(tenant.id, { limit: 12 }),
      storage.listApprovals(tenant.id, 'pending'),
      storage.listDlqEntries(tenant.id),
      storage.getTenantState(tenant.id),
    ]);
    const descKv = state.kv.find((r) => r.key === '__project_meta');
    const meta =
      descKv?.value && typeof descKv.value === 'object'
        ? (descKv.value as { description?: string })
        : {};
    const openDlq = dlq.filter((d) => !d.replayedRunId).length;
    const succeededRuns = runsPage.runs.filter((r) => r.status === 'succeeded').length;
    const failedRuns = runsPage.runs.filter(
      (r) => r.status === 'failed' || r.status === 'compensated'
    ).length;

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      description: meta.description,
      createdAt: tenant.createdAt,
      workflowCount: workflows.length,
      publishedWorkflowCount: workflows.filter((w) => w.status === 'published').length,
      runCount: runsPage.runs.length,
      succeededRuns,
      failedRuns,
      pendingApprovals: approvals.length,
      openDlq,
      recentWorkflows: workflows.slice(0, 6).map((w) => ({
        id: w.id,
        name: w.name,
        status: w.status,
        latestVersion: w.latestVersion,
        nodeCount: w.nodeCount,
        updatedAt: w.updatedAt,
      })),
      recentRuns: runsPage.runs.slice(0, 6).map((r) => ({
        id: r.id,
        workflowId: r.workflowId,
        workflowName: r.workflowName ?? r.workflowId,
        status: r.status,
        durationMs: r.durationMs ?? null,
        createdAt: r.createdAt,
      })),
    };
  };

  app.get('/api/projects', async (c) => {
    let tenants = await storage.listTenants();
    if (authMode === 'prod') {
      const user = await resolveSessionUser(c);
      if (!user) return c.json({ projects: [] });
      const allowed = new Set((await storage.listUserTenants(user.id)).map((t) => t.id));
      tenants = tenants.filter((t) => allowed.has(t.id));
    }
    const projects = await Promise.all(tenants.map((t) => buildProjectSummary(t)));
    return c.json({ projects });
  });

  app.get('/api/projects/:id/summary', async (c) => {
    const tenant = await storage.getTenant(c.req.param('id'));
    if (!tenant) {
      throw new ApiError(404, 'tenant_not_found', 'Project not found.');
    }
    if (authMode === 'prod') {
      const user = await resolveSessionUser(c);
      const allowed = user ? new Set((await storage.listUserTenants(user.id)).map((t) => t.id)) : null;
      // Non-leaking tenant semantics: an inaccessible project is indistinguishable from a missing one.
      if (!allowed?.has(tenant.id)) {
        throw new ApiError(404, 'tenant_not_found', 'Project not found.');
      }
    }
    const project = await buildProjectSummary(tenant);
    return c.json({ project });
  });

  app.post('/api/projects', async (c) => {
    const raw = await parseJsonBody(c);
    const input = CreateProjectSchema.parse(raw);
    const sessionUser = authMode === 'prod' ? await resolveSessionUser(c) : null;
    if (authMode === 'prod' && !sessionUser) {
      throw new ApiError(401, 'unauthenticated', 'Sign in to create a project.');
    }

    // Derive a clean URL-safe slug if omitted, ensuring uniqueness
    const baseSlug = (
      input.slug ??
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 36)
    ) || `project-${makeId('p').slice(-6)}`;

    let slug = baseSlug.length >= 2 ? baseSlug : `${baseSlug}-app`;
    const existing = await storage.getTenantBySlug(slug);
    if (existing) {
      if (input.slug) {
        throw new ApiError(409, 'conflict', `Project slug "${slug}" is already taken.`);
      }
      slug = `${slug.slice(0, 38)}-${makeId('p').slice(-4)}`;
    }

    const tenant = await storage.createTenant({
      name: input.name,
      slug,
      maxConcurrentRuns: input.maxConcurrentRuns,
      rateLimitPerMin: input.rateLimitPerMin,
    });
    await ensureDefaultTenantState(storage, tenant.id);
    if (input.description) {
      await storage.setKv(tenant.id, '__project_meta', {
        description: input.description,
        mode: input.mode,
        createdAt: tenant.createdAt,
      });
    }

    const userId = sessionUser?.id ?? c.req.header('x-user-id') ?? DEMO_USER_ID;
    await storage.ensureMembership(tenant.id, userId, 'owner');
    if (authMode !== 'prod') {
      await storage.ensureMembership(tenant.id, DEMO_USER_ID, 'owner');
    }

    const createdWorkflows = [];
    if (input.mode === 'template' && input.starterWorkflows && input.starterWorkflows.length > 0) {
      for (const wfDraft of input.starterWorkflows) {
        const created = await storage.createWorkflow(tenant.id, wfDraft);
        if (input.autoPublish && created.nodes.length > 0) {
          const check = validateWorkflowGraph(created.nodes, created.edges);
          if (check.valid) {
            const pub = await storage.publishWorkflow(tenant.id, created.id);
            createdWorkflows.push(pub?.workflow ?? created);
            continue;
          }
        }
        createdWorkflows.push(created);
      }
    }

    const project = await buildProjectSummary(tenant);
    return c.json({ tenant, project, workflows: createdWorkflows }, 201);
  });

  // ---------------- Prometheus / OpenMetrics Endpoint ----------------

  app.get('/api/metrics', async (c) => {
    const tenants = await storage.listTenants();
    const mem = process.memoryUsage();
    const lines: string[] = [
      '# HELP sagaflow_tenants_total Number of provisioned tenants.',
      '# TYPE sagaflow_tenants_total gauge',
      `sagaflow_tenants_total ${tenants.length}`,
      '# HELP sagaflow_process_resident_memory_bytes Process RSS memory in bytes.',
      '# TYPE sagaflow_process_resident_memory_bytes gauge',
      `sagaflow_process_resident_memory_bytes ${mem.rss}`,
      '# HELP sagaflow_runs_total Total workflow runs by tenant and status.',
      '# TYPE sagaflow_runs_total gauge',
      '# HELP sagaflow_dlq_open Open dead-letter queue entries by tenant.',
      '# TYPE sagaflow_dlq_open gauge',
      '# HELP sagaflow_approvals_pending Pending human-in-the-loop approvals by tenant.',
      '# TYPE sagaflow_approvals_pending gauge',
      '# HELP sagaflow_run_latency_ms Run latency summary in milliseconds by tenant.',
      '# TYPE sagaflow_run_latency_ms gauge',
    ];

    for (const t of tenants) {
      const [m, pendingApprovals] = await Promise.all([
        storage.getTenantMetrics(t.id, rateLimiter.getUsed(t.id)),
        storage.listApprovals(t.id, 'pending'),
      ]);
      const slug = t.slug.replace(/"/g, '\\"');
      lines.push(`sagaflow_runs_total{tenant="${slug}",status="succeeded"} ${m.totals.succeeded}`);
      lines.push(`sagaflow_runs_total{tenant="${slug}",status="compensated"} ${m.totals.compensated}`);
      lines.push(`sagaflow_runs_total{tenant="${slug}",status="failed"} ${m.totals.failed}`);
      lines.push(`sagaflow_runs_total{tenant="${slug}",status="cancelled"} ${m.totals.cancelled}`);
      lines.push(`sagaflow_runs_total{tenant="${slug}",status="active"} ${m.totals.activeRuns}`);
      lines.push(`sagaflow_dlq_open{tenant="${slug}"} ${m.totals.dlqOpen}`);
      lines.push(`sagaflow_approvals_pending{tenant="${slug}"} ${pendingApprovals.length}`);
      lines.push(`sagaflow_run_latency_ms{tenant="${slug}",quantile="0.5"} ${m.latency.p50Ms}`);
      lines.push(`sagaflow_run_latency_ms{tenant="${slug}",quantile="0.95"} ${m.latency.p95Ms}`);
      lines.push(`sagaflow_run_latency_ms{tenant="${slug}",quantile="0.99"} ${m.latency.p99Ms}`);
    }

    return c.text(`${lines.join('\n')}\n`, 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });

  // ---------------- Public Human-in-the-Loop Callback Webhook ----------------

  app.post('/api/callbacks/approval/:token', async (c) => {
    const token = c.req.param('token');
    const raw = await parseJsonBody(c);
    const input = DecideApprovalSchema.parse(raw);
    const { approval, found } = await orchestrator.decideApprovalByToken(token, {
      decision: input.decision,
      decidedBy: input.decidedBy ?? 'external-callback',
      comment: input.comment,
    });
    if (!found) {
      throw new ApiError(404, 'approval_not_found', 'Approval callback token not found.');
    }
    if (!approval) {
      throw new ApiError(409, 'approval_already_decided', 'This approval request has already been decided.');
    }
    return c.json({ approval, resumed: true });
  });

  // ---------------- Public Real Persisted Webhook Sink ----------------

  app.all('/api/sink/:tenantSlug/:channel', async (c) => {
    const tenantSlug = c.req.param('tenantSlug');
    const channel = c.req.param('channel');
    const tenant =
      (await storage.getTenantBySlug(tenantSlug)) ?? (await storage.getTenant(tenantSlug));
    if (!tenant) {
      throw new ApiError(404, 'tenant_not_found', 'Sink tenant not found.');
    }
    const raw = await c.req.text();
    let body: unknown = null;
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const headersObj: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      if (!['cookie', 'authorization'].includes(k.toLowerCase())) {
        headersObj[k] = v;
      }
    });
    const delivery = await storage.recordSinkDelivery(tenant.id, {
      channel,
      method: c.req.method,
      path: c.req.path,
      headers: headersObj,
      body,
      statusCode: 200,
    });
    return c.json({ received: true, delivery });
  });

  // ---------------- Public OpenAPI 3.1 Spec & Interactive Explorer ----------------

  app.get('/api/openapi.json', (c) => {
    const url = new URL(c.req.url);
    return c.json(buildOpenApiSpec(url.origin));
  });

  app.get('/api/docs', (c) => {
    return c.html(renderApiDocsHtml());
  });

  // ---------------- Tenant-Scoped Authenticated Routes ----------------

  const tenantAuth = createTenantAuthMiddleware({ storage, rateLimiter, authMode, jwtSecret });

  app.use('/api/workflows', tenantAuth);
  app.use('/api/workflows/*', async (c, next) => {
    if (c.req.path === '/api/workflows/validate') {
      return next();
    }
    return tenantAuth(c, next);
  });
  app.use('/api/runs', tenantAuth);
  app.use('/api/runs/*', tenantAuth);
  app.use('/api/dlq', tenantAuth);
  app.use('/api/dlq/*', tenantAuth);
  app.use('/api/api-keys', tenantAuth);
  app.use('/api/api-keys/*', tenantAuth);
  app.use('/api/secrets', tenantAuth);
  app.use('/api/secrets/*', tenantAuth);
  app.use('/api/schedules', tenantAuth);
  app.use('/api/schedules/*', tenantAuth);
  app.use('/api/approvals', tenantAuth);
  app.use('/api/approvals/*', tenantAuth);
  app.use('/api/state', tenantAuth);
  app.use('/api/state/*', tenantAuth);
  app.use('/api/http/*', tenantAuth);
  app.use('/api/webhooks/*', tenantAuth);
  app.use('/api/admin/*', tenantAuth);
  app.use('/api/sandbox/*', tenantAuth);
  app.use('/api/ai/*', tenantAuth);
  app.use('/api/rbac/*', tenantAuth);
  app.use('/api/audit/*', tenantAuth);
  app.use('/api/alerts', tenantAuth);
  app.use('/api/alerts/*', tenantAuth);

  // ---------------- Workflow CRUD, Publish, Import/Export ----------------

  app.get('/api/workflows', async (c) => {
    const { tenantId } = c.get('auth');
    const workflows = await storage.listWorkflows(tenantId);
    return c.json({ workflows });
  });

  app.post('/api/workflows', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = DraftWorkflowSchema.parse(raw);
    const workflow = await storage.createWorkflow(tenantId, input);
    return c.json({ workflow }, 201);
  });

  app.post('/api/workflows/import', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = (await parseJsonBody(c)) as Record<string, unknown>;
    const candidate = raw && typeof raw === 'object' && 'workflow' in raw ? raw.workflow : raw;
    const input = DraftWorkflowSchema.parse(candidate);
    const workflow = await storage.createWorkflow(tenantId, {
      ...input,
      name: `${input.name} (Imported)`,
    });
    return c.json({ workflow }, 201);
  });

  app.get('/api/workflows/:id', async (c) => {
    const { tenantId } = c.get('auth');
    const workflow = await storage.getWorkflow(tenantId, c.req.param('id'));
    if (!workflow) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }
    return c.json({ workflow });
  });

  app.put('/api/workflows/:id', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = DraftWorkflowSchema.parse(raw);
    const workflow = await storage.updateWorkflow(tenantId, c.req.param('id'), input);
    if (!workflow) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }
    return c.json({ workflow });
  });

  app.delete('/api/workflows/:id', async (c) => {
    const { tenantId } = c.get('auth');
    const deleted = await storage.deleteWorkflow(tenantId, c.req.param('id'));
    if (!deleted) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }
    return c.json({ deleted: true });
  });

  app.get('/api/workflows/:id/versions', async (c) => {
    const { tenantId } = c.get('auth');
    const wf = await storage.getWorkflow(tenantId, c.req.param('id'));
    if (!wf) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }
    const versions = await storage.listWorkflowVersions(tenantId, wf.id);
    return c.json({ versions });
  });

  app.get('/api/workflows/:id/export', async (c) => {
    const { tenantId } = c.get('auth');
    const wf = await storage.getWorkflow(tenantId, c.req.param('id'));
    if (!wf) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }
    return c.json({
      schemaVersion: 'sagaflow/v1',
      exportedAt: new Date().toISOString(),
      workflow: {
        name: wf.name,
        description: wf.description,
        nodes: wf.nodes,
        edges: wf.edges,
      },
    });
  });

  app.post('/api/workflows/:id/publish', async (c) => {
    const { tenantId } = c.get('auth');
    const workflowId = c.req.param('id');
    const draft = await storage.getWorkflow(tenantId, workflowId);
    if (!draft) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }

    // Strict schema check (requires >= 1 node) + full DAG validation before freezing version
    const strictCheck = WorkflowDefinitionSchema.safeParse({
      name: draft.name,
      description: draft.description,
      nodes: draft.nodes,
      edges: draft.edges,
    });
    if (!strictCheck.success) {
      throw new ApiError(
        422,
        'invalid_workflow_graph',
        'Workflow draft must contain at least one valid node before publishing.',
        strictCheck.error.issues.map((i) => ({
          code: i.code,
          path: i.path.join('.'),
          message: i.message,
        }))
      );
    }

    const validation = validateWorkflowGraph(draft.nodes, draft.edges);
    if (!validation.valid) {
      throw new ApiError(
        422,
        'invalid_workflow_graph',
        `Cannot publish workflow: ${validation.issues.length} graph issue(s) detected.`,
        validation.issues
      );
    }

    const published = await storage.publishWorkflow(tenantId, workflowId);
    if (!published) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }
    return c.json(published, 201);
  });

  app.get('/api/workflows/:id/diff', async (c) => {
    const { tenantId } = c.get('auth');
    const workflowId = c.req.param('id');
    const wf = await storage.getWorkflow(tenantId, workflowId);
    if (!wf) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }

    const fromParam = (c.req.query('from') ?? String(wf.latestVersion ?? 'draft')).trim();
    const toParam = (c.req.query('to') ?? 'draft').trim();

    const loadRef = async (ref: string) => {
      if (ref === 'draft') {
        return { label: 'draft', nodes: wf.nodes, edges: wf.edges };
      }
      const vNum = Number(ref.replace(/^v/i, ''));
      if (!Number.isInteger(vNum) || vNum < 1) {
        throw new ApiError(400, 'invalid_request', `Invalid version reference "${ref}".`);
      }
      const ver = await storage.getWorkflowVersion(tenantId, workflowId, vNum);
      if (!ver) {
        throw new ApiError(404, 'workflow_not_found', `Workflow version v${vNum} not found.`);
      }
      return { label: `v${vNum}`, nodes: ver.nodes, edges: ver.edges };
    };

    const [a, b] = await Promise.all([loadRef(fromParam), loadRef(toParam)]);
    const diff = computeWorkflowDiff({
      workflowId,
      fromRef: a.label,
      toRef: b.label,
      fromNodes: a.nodes,
      fromEdges: a.edges,
      toNodes: b.nodes,
      toEdges: b.edges,
    });
    return c.json({ diff });
  });

  app.post('/api/workflows/:id/versions/:version/restore', async (c) => {
    const { tenantId } = c.get('auth');
    const workflowId = c.req.param('id');
    const vNum = Number(c.req.param('version'));
    if (!Number.isInteger(vNum) || vNum < 1) {
      throw new ApiError(400, 'invalid_request', 'Version number must be a positive integer.');
    }
    const wf = await storage.getWorkflow(tenantId, workflowId);
    if (!wf) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }
    const ver = await storage.getWorkflowVersion(tenantId, workflowId, vNum);
    if (!ver) {
      throw new ApiError(404, 'workflow_not_found', `Version v${vNum} not found.`);
    }
    const restored = await storage.updateWorkflow(tenantId, workflowId, {
      name: ver.name || wf.name,
      description: wf.description,
      nodes: ver.nodes,
      edges: ver.edges,
    });
    if (!restored) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }
    return c.json({ workflow: restored, restoredFromVersion: vNum });
  });

  // ---------------- Runs, Idempotency, Resumable SSE Stream, Cancel ----------------

  app.post('/api/workflows/:id/runs', async (c) => {
    const { tenantId } = c.get('auth');
    const workflowId = c.req.param('id');
    const idempotencyKey = c.req.header('idempotency-key')?.trim();

    if (!idempotencyKey) {
      throw new ApiError(
        400,
        'invalid_request',
        'Idempotency-Key header is required to start a run.',
        [{ path: 'Idempotency-Key', message: 'Required UUID/unique key header is missing' }]
      );
    }

    const wf = await storage.getWorkflow(tenantId, workflowId);
    if (!wf) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }
    if (wf.latestVersion === null) {
      throw new ApiError(
        409,
        'workflow_not_published',
        'Workflow has no published version. Publish the workflow before starting a run.'
      );
    }

    const raw = await parseJsonBody(c);
    const body = StartRunBodySchema.parse(raw);
    const targetVersion = body.versionNumber ?? wf.latestVersion;

    const version = await storage.getWorkflowVersion(tenantId, wf.id, targetVersion);
    if (!version) {
      throw new ApiError(
        404,
        'workflow_not_found',
        `Published version ${targetVersion} not found for workflow "${wf.id}".`
      );
    }

    // Server order per Contract Section 5.2: persist run first, then enqueue!
    const { run, created } = await storage.createRunIdempotent(tenantId, {
      id: makeId('run'),
      workflowId: wf.id,
      workflowName: wf.name,
      versionNumber: targetVersion,
      idempotencyKey,
      input: body.input ?? {},
    });

    const summary = {
      id: run.id,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      versionNumber: run.versionNumber,
      status: run.status,
      cancelRequested: run.cancelRequested,
      idempotencyKey: run.idempotencyKey,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
    };

    if (!created) {
      return c.json({ run: summary }, 200);
    }

    await orchestrator.enqueueRun(tenantId, run.id);
    return c.json({ run: summary }, 202);
  });

  app.get('/api/runs', async (c) => {
    const { tenantId } = c.get('auth');
    const query = ListRunsQuerySchema.parse({
      workflowId: c.req.query('workflowId') || undefined,
      status: c.req.query('status') || undefined,
      limit: c.req.query('limit') || undefined,
      cursor: c.req.query('cursor') || undefined,
    });
    const result = await storage.listRuns(tenantId, query);
    return c.json(result);
  });

  app.get('/api/runs/:id', async (c) => {
    const { tenantId } = c.get('auth');
    const run = await storage.getRun(tenantId, c.req.param('id'));
    if (!run) {
      throw new ApiError(404, 'run_not_found', 'Run not found.');
    }
    const events = await storage.listRunEvents(tenantId, run.id, 0);
    return c.json({ run, events });
  });

  /**
   * GET /api/runs/:id/stream — Resumable Durable Event Stream (SSE)
   * Supports `?since=<offset>` or `Last-Event-ID` header for zero-loss reconnect replay!
   */
  app.get('/api/runs/:id/stream', async (c) => {
    const { tenantId } = c.get('auth');
    const runId = c.req.param('id');
    const run = await storage.getRun(tenantId, runId);
    if (!run) {
      throw new ApiError(404, 'run_not_found', 'Run not found.');
    }

    // Browsers resend Last-Event-ID on automatic reconnect; prefer it over the
    // original `since` query so reconnects resume instead of replaying from 0.
    const sinceRaw = c.req.header('last-event-id') ?? c.req.query('since') ?? '0';
    let lastOffset = Number.parseInt(sinceRaw, 10) || 0;

    return streamSSE(c, async (stream) => {
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      // 1. Send current run snapshot immediately
      await stream.writeSSE({
        event: 'run.snapshot',
        data: JSON.stringify({ run }),
      });

      // 2. Replay any persisted events newer than lastOffset
      const backlog = await storage.listRunEvents(tenantId, runId, lastOffset);
      for (const evt of backlog) {
        if (closed) return;
        lastOffset = Math.max(lastOffset, evt.offset);
        await stream.writeSSE({
          id: String(evt.offset),
          event: evt.type,
          data: JSON.stringify(evt),
        });
      }

      // If run is already terminal, send final snapshot and close stream cleanly
      const refreshed = await storage.getRun(tenantId, runId);
      if (refreshed && isTerminalRunStatus(refreshed.status)) {
        await stream.writeSSE({
          event: 'run.snapshot',
          data: JSON.stringify({ run: refreshed }),
        });
        return;
      }

      // 3. Subscribe to live events until terminal completion or client disconnect
      await new Promise<void>((resolve) => {
        const unsubscribe = eventBus.subscribe(tenantId, runId, (evt) => {
          if (closed || evt.offset <= lastOffset) return;
          lastOffset = evt.offset;
          void (async () => {
            try {
              await stream.writeSSE({
                id: String(evt.offset),
                event: evt.type,
                data: JSON.stringify(evt),
              });
              const latestRun = await storage.getRun(tenantId, runId);
              if (latestRun) {
                await stream.writeSSE({
                  event: 'run.snapshot',
                  data: JSON.stringify({ run: latestRun }),
                });
              }
              if (evt.type === 'run.completed') {
                cleanup();
              }
            } catch {
              cleanup();
            }
          })();
        });

        const heartbeat = setInterval(() => {
          if (closed) {
            cleanup();
            return;
          }
          void stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => cleanup());
        }, 15_000);

        const cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        };

        stream.onAbort(cleanup);
      });
    });
  });

  app.post('/api/runs/:id/cancel', async (c) => {
    const { tenantId } = c.get('auth');
    const runId = c.req.param('id');
    const existing = await storage.getRun(tenantId, runId);
    if (!existing) {
      throw new ApiError(404, 'run_not_found', 'Run not found.');
    }
    if (isTerminalRunStatus(existing.status)) {
      throw new ApiError(
        409,
        'run_not_cancellable',
        `Run "${runId}" is already in terminal status "${existing.status}".`
      );
    }

    const updated = await orchestrator.requestCancel(tenantId, runId);
    if (!updated) {
      throw new ApiError(404, 'run_not_found', 'Run not found.');
    }

    return c.json({
      run: {
        id: updated.id,
        workflowId: updated.workflowId,
        workflowName: updated.workflowName,
        versionNumber: updated.versionNumber,
        status: updated.status,
        cancelRequested: updated.cancelRequested,
        createdAt: updated.createdAt,
        startedAt: updated.startedAt,
        finishedAt: updated.finishedAt,
      },
    });
  });

  // ---------------- Dead-Letter Queue (DLQ) ----------------

  app.get('/api/dlq', async (c) => {
    const { tenantId } = c.get('auth');
    const entries = await storage.listDlqEntries(tenantId);
    return c.json({ entries });
  });

  app.post('/api/dlq/:id/replay', async (c) => {
    const { tenantId } = c.get('auth');
    const entry = await storage.getDlqEntry(tenantId, c.req.param('id'));
    if (!entry) {
      throw new ApiError(404, 'dlq_not_found', 'Dead-letter queue entry not found.');
    }

    const wf = await storage.getWorkflow(tenantId, entry.workflowId);
    const targetVersion = wf?.latestVersion ?? entry.versionNumber;
    const { run } = await storage.createRunIdempotent(tenantId, {
      id: makeId('run'),
      workflowId: entry.workflowId,
      workflowName: entry.workflowName,
      versionNumber: targetVersion,
      idempotencyKey: `dlq_replay_${entry.id}_${Date.now()}`,
      input: entry.input,
    });

    await orchestrator.enqueueRun(tenantId, run.id);
    const updatedEntry = await storage.markDlqReplayed(tenantId, entry.id, run.id);

    return c.json({ run, entry: updatedEntry }, 202);
  });

  app.delete('/api/dlq/:id', async (c) => {
    const { tenantId } = c.get('auth');
    const deleted = await storage.deleteDlqEntry(tenantId, c.req.param('id'));
    if (!deleted) {
      throw new ApiError(404, 'dlq_not_found', 'Dead-letter queue entry not found.');
    }
    return c.json({ deleted: true });
  });

  // ---------------- QuickJS-WASM Live Script Sandbox Tester ----------------

  app.post('/api/sandbox/test', async (c) => {
    const raw = await parseJsonBody(c);
    const input = SandboxTestSchema.parse(raw);
    const result = await runInQuickJSSandbox(input);
    return c.json({ result });
  });

  // ---------------- Live HTTP Request Tester (No Mocks!) ----------------

  app.post('/api/http/test', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = HttpTestSchema.parse(raw);

    // Decrypt tenant secrets so {{secrets.*}} templates resolve in live tests too, then redact!
    const secretRecs = await storage.getAllSecretRecords(tenantId);
    const secretMap: Record<string, string> = {};
    for (const r of secretRecs) {
      try {
        secretMap[r.name] = cipher.decrypt(r.encryptedValue);
      } catch {
        // ignore
      }
    }
    const secretVals = Object.values(secretMap);
    const tplCtx = { input: {}, steps: {}, secrets: secretMap, env: { tenantId, runId: 'live_test' } };
    const resolvedUrl = String(resolveTemplates(input.url, tplCtx));
    const resolvedHeaders = input.headers
      ? (resolveTemplates(input.headers, tplCtx) as Record<string, string>)
      : {};
    const resolvedBody = input.body !== undefined ? resolveTemplates(input.body, tplCtx) : undefined;

    try {
      const result = await executeLiveHttpRequest({
        method: input.method,
        url: resolvedUrl,
        headers: resolvedHeaders,
        body: resolvedBody,
        timeoutMs: input.timeoutMs ?? 8000,
        tenantId,
        storage,
      });
      return c.json({ ok: true, result: redactSecrets(result, secretVals) });
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err), secretVals);
      return c.json({ ok: false, error: msg }, 200);
    }
  });

  // ---------------- HMAC-SHA256 Webhook Signature Helper ----------------

  app.post('/api/webhooks/sign', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = (await parseJsonBody(c)) as { secretName?: string; payload?: string };
    const secretName = String(raw.secretName ?? 'WEBHOOK_SECRET').trim();
    const payload = typeof raw.payload === 'string' ? raw.payload : JSON.stringify(raw.payload ?? {});
    const rec = await storage.getSecretRecord(tenantId, secretName);
    if (!rec) {
      throw new ApiError(404, 'secret_not_found', `Secret "${secretName}" not found in tenant vault.`);
    }
    const secretVal = cipher.decrypt(rec.encryptedValue);
    const signature = computeWebhookHmac(secretVal, payload);
    return c.json({ secretName, signature });
  });

  // ---------------- Real Per-Tenant Transactional State & Saga Ledger ----------------

  app.get('/api/state', async (c) => {
    const { tenantId } = c.get('auth');
    const state = await storage.getTenantState(tenantId);
    return c.json({ state });
  });

  app.post('/api/state/inventory', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = RestockInventorySchema.parse(raw);
    const { item, before } = await storage.mutateInventory(tenantId, input);
    await storage.appendLedgerEntry(tenantId, {
      runId: 'manual_ops',
      nodeId: 'console',
      action: input.deltaAvailable >= 0 ? 'restock_inventory' : 'adjust_inventory',
      direction: 'execute',
      resourceType: 'inventory',
      resourceId: item.sku,
      status: 'committed',
      summary: `Manual inventory adjustment ${input.deltaAvailable >= 0 ? '+' : ''}${input.deltaAvailable} on ${item.sku} (available -> ${item.available})`,
      beforeState: before ? { available: before.available, reserved: before.reserved } : null,
      afterState: { available: item.available, reserved: item.reserved },
    });
    return c.json({ item });
  });

  app.post('/api/state/balances', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = AdjustBalanceSchema.parse(raw);
    const { balance, before } = await storage.mutateBalance(tenantId, input);
    await storage.appendLedgerEntry(tenantId, {
      runId: 'manual_ops',
      nodeId: 'console',
      action: input.deltaAvailable >= 0 ? 'credit_balance' : 'debit_balance',
      direction: 'execute',
      resourceType: 'balance',
      resourceId: balance.accountId,
      status: 'committed',
      summary: `Manual balance adjustment ${input.deltaAvailable >= 0 ? '+' : ''}${input.deltaAvailable} ${balance.currency} on ${balance.accountId} (available -> ${balance.available})`,
      beforeState: before ? { available: before.available, locked: before.locked } : null,
      afterState: { available: balance.available, locked: balance.locked },
    });
    return c.json({ balance });
  });

  app.post('/api/state/kv', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = (await parseJsonBody(c)) as { key?: string; value?: unknown };
    const key = String(raw.key ?? '').trim();
    if (!key) throw new ApiError(400, 'invalid_request', 'KV key is required.');
    const { record } = await storage.setKv(tenantId, key, raw.value ?? null);
    return c.json({ record }, 201);
  });

  app.delete('/api/state/kv/:key', async (c) => {
    const { tenantId } = c.get('auth');
    const deleted = await storage.deleteKv(tenantId, c.req.param('key'));
    return c.json({ deleted });
  });

  app.delete('/api/state/sink', async (c) => {
    const { tenantId } = c.get('auth');
    await storage.clearSinkDeliveries(tenantId);
    return c.json({ cleared: true });
  });

  // ---------------- Human-in-the-Loop Durable Approvals ----------------

  app.get('/api/approvals', async (c) => {
    const { tenantId } = c.get('auth');
    const st = c.req.query('status');
    const status =
      st === 'pending' || st === 'approved' || st === 'rejected' ? st : undefined;
    const approvals = await storage.listApprovals(tenantId, status);
    return c.json({ approvals });
  });

  app.post('/api/approvals/:id/decide', async (c) => {
    const { tenantId, userId } = c.get('auth');
    const approvalId = c.req.param('id');
    const raw = await parseJsonBody(c);
    const input = DecideApprovalSchema.parse(raw);

    const existing = await storage.getApproval(tenantId, approvalId);
    if (!existing) {
      throw new ApiError(404, 'approval_not_found', 'Approval request not found.');
    }
    if (existing.status !== 'pending') {
      throw new ApiError(
        409,
        'approval_already_decided',
        `Approval "${approvalId}" was already ${existing.status}.`
      );
    }

    const decided = await orchestrator.decideApproval(tenantId, approvalId, {
      decision: input.decision,
      decidedBy: input.decidedBy ?? userId ?? 'operator',
      comment: input.comment,
    });
    if (!decided) {
      throw new ApiError(409, 'approval_already_decided', 'Approval already decided.');
    }
    return c.json({ approval: decided, resumed: true });
  });

  // ---------------- Cryptographic API Keys ----------------

  app.get('/api/api-keys', async (c) => {
    const { tenantId } = c.get('auth');
    const apiKeys = await storage.listApiKeys(tenantId);
    return c.json({ apiKeys });
  });

  app.post('/api/api-keys', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const { name } = CreateApiKeySchema.parse(raw);
    const generated = generateApiKey();
    const apiKey = await storage.createApiKey(tenantId, name, {
      id: makeId('key'),
      prefix: generated.prefix,
      hash: generated.hash,
    });
    return c.json({ apiKey, rawKey: generated.rawKey }, 201);
  });

  app.delete('/api/api-keys/:id', async (c) => {
    const { tenantId } = c.get('auth');
    const revoked = await storage.revokeApiKey(tenantId, c.req.param('id'));
    if (!revoked) {
      throw new ApiError(404, 'api_key_not_found', 'API key not found or already revoked.');
    }
    return c.json({ revoked: true });
  });

  // ---------------- Encrypted Per-Tenant Secrets Vault (AES-256-GCM) ----------------

  app.get('/api/secrets', async (c) => {
    const { tenantId } = c.get('auth');
    const secrets = await storage.listSecrets(tenantId);
    return c.json({
      secrets: secrets.filter((s) => !s.name.startsWith('__SAGAFLOW_AI_')),
    });
  });

  app.post('/api/secrets', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = UpsertSecretSchema.parse(raw);
    const encryptedValue = cipher.encrypt(input.value);
    const secret = await storage.upsertSecret(tenantId, {
      name: input.name,
      description: input.description,
      encryptedValue,
    });
    return c.json({ secret }, 201);
  });

  app.delete('/api/secrets/:name', async (c) => {
    const { tenantId } = c.get('auth');
    const deleted = await storage.deleteSecret(tenantId, c.req.param('name'));
    if (!deleted) {
      throw new ApiError(404, 'secret_not_found', 'Secret not found.');
    }
    return c.json({ deleted: true });
  });

  // ---------------- Durable Cron Schedules ----------------

  app.get('/api/schedules', async (c) => {
    const { tenantId } = c.get('auth');
    const schedules = await storage.listSchedules(tenantId);
    return c.json({
      schedules: schedules.map((s) => ({
        ...s,
        description: describeCron(s.cron),
      })),
    });
  });

  app.post('/api/schedules', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = CreateScheduleSchema.parse(raw);

    const cronCheck = validateCronExpression(input.cron);
    if (!cronCheck.valid) {
      throw new ApiError(400, 'invalid_request', `Invalid cron expression: ${cronCheck.error}`);
    }

    const wf = await storage.getWorkflow(tenantId, input.workflowId);
    if (!wf) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }
    if (wf.latestVersion === null) {
      throw new ApiError(
        409,
        'workflow_not_published',
        'Workflow must be published before attaching a cron schedule.'
      );
    }

    const enabled = input.enabled ?? true;
    const nextRunAt = enabled ? (getNextCronDate(input.cron)?.toISOString() ?? null) : null;
    const schedule = await storage.createSchedule(tenantId, {
      ...input,
      enabled,
      workflowName: wf.name,
      nextRunAt,
    });

    return c.json({ schedule: { ...schedule, description: describeCron(schedule.cron) } }, 201);
  });

  app.patch('/api/schedules/:id', async (c) => {
    const { tenantId } = c.get('auth');
    const scheduleId = c.req.param('id');
    const existing = await storage.getSchedule(tenantId, scheduleId);
    if (!existing) {
      throw new ApiError(404, 'schedule_not_found', 'Schedule not found.');
    }

    const raw = await parseJsonBody(c);
    const patch = UpdateScheduleSchema.parse(raw);

    const nextCron = patch.cron ?? existing.cron;
    if (patch.cron) {
      const cronCheck = validateCronExpression(patch.cron);
      if (!cronCheck.valid) {
        throw new ApiError(400, 'invalid_request', `Invalid cron expression: ${cronCheck.error}`);
      }
    }

    const nextEnabled = patch.enabled ?? existing.enabled;
    const nextRunAt = nextEnabled ? (getNextCronDate(nextCron)?.toISOString() ?? null) : null;
    const updated = await storage.updateSchedule(tenantId, scheduleId, {
      ...patch,
      nextRunAt,
    });
    if (!updated) {
      throw new ApiError(404, 'schedule_not_found', 'Schedule not found.');
    }
    return c.json({ schedule: { ...updated, description: describeCron(updated.cron) } });
  });

  app.delete('/api/schedules/:id', async (c) => {
    const { tenantId } = c.get('auth');
    const deleted = await storage.deleteSchedule(tenantId, c.req.param('id'));
    if (!deleted) {
      throw new ApiError(404, 'schedule_not_found', 'Schedule not found.');
    }
    return c.json({ deleted: true });
  });

  app.post('/api/schedules/:id/trigger', async (c) => {
    const { tenantId } = c.get('auth');
    const scheduleId = c.req.param('id');
    const existing = await storage.getSchedule(tenantId, scheduleId);
    if (!existing) {
      throw new ApiError(404, 'schedule_not_found', 'Schedule not found.');
    }
    const wf = await storage.getWorkflow(tenantId, existing.workflowId);
    if (!wf || wf.latestVersion === null) {
      throw new ApiError(
        409,
        'workflow_not_published',
        'Scheduled workflow is missing or unpublished.'
      );
    }

    const now = new Date();
    const { run } = await storage.createRunIdempotent(tenantId, {
      id: makeId('run'),
      workflowId: wf.id,
      workflowName: wf.name,
      versionNumber: wf.latestVersion,
      idempotencyKey: `cron_manual_${existing.id}_${now.getTime()}`,
      input: {
        ...existing.input,
        _schedule: {
          scheduleId: existing.id,
          name: existing.name,
          cron: existing.cron,
          firedAt: now.toISOString(),
          manual: true,
        },
      },
    });
    await orchestrator.enqueueRun(tenantId, run.id);
    const nextRunAt = existing.enabled ? (getNextCronDate(existing.cron, now)?.toISOString() ?? null) : null;
    const updated = await storage.markScheduleFired(tenantId, existing.id, now.toISOString(), run.id, nextRunAt);
    return c.json({ run, schedule: updated }, 202);
  });

  // ---------------- Admin Observability & Concurrency Stress Tester ----------------

  app.get('/api/admin/metrics', async (c) => {
    const { tenantId } = c.get('auth');
    const metrics = await storage.getTenantMetrics(tenantId, rateLimiter.getUsed(tenantId));
    return c.json({ metrics });
  });

  app.post('/api/admin/stress-test', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = StressTestSchema.parse(raw);
    const wf = await storage.getWorkflow(tenantId, input.workflowId);
    if (!wf) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }
    if (wf.latestVersion === null) {
      throw new ApiError(
        409,
        'workflow_not_published',
        'Workflow must be published before stress testing.'
      );
    }

    const result = await runStressTest({
      tenantId,
      input,
      storage,
      orchestrator,
      eventBus,
    });
    return c.json({ result });
  });

  // ---------------- AI Automation Agent (LM Studio & Google AI Studio) ----------------

  app.get('/api/ai/config', async (c) => {
    const { tenantId } = c.get('auth');
    const config = await getAiConfig(storage, tenantId);
    return c.json({ config });
  });

  app.put('/api/ai/config', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = SaveAiConfigSchema.parse(raw);
    const config = await saveAiConfig(storage, cipher, tenantId, input);
    return c.json({ config });
  });

  app.post('/api/ai/test', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = AiTestConnectionSchema.parse(raw ?? {});
    const result = await testAiConnection(storage, cipher, tenantId, input);
    return c.json({ result }, result.ok ? 200 : 502);
  });

  app.post('/api/ai/lmstudio/models', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = (await parseJsonBody(c)) as { baseUrl?: string; apiKey?: string } | null;
    const creds = await resolveAiCredentials(storage, cipher, tenantId);
    const baseUrl = raw?.baseUrl?.trim() || creds.config.lmStudioBaseUrl;
    const apiKey = raw?.apiKey?.trim() || creds.lmStudioApiKey;
    try {
      const data = await fetchLmStudioModels(baseUrl, apiKey);
      return c.json(data);
    } catch (err) {
      throw new ApiError(
        502,
        'ai_provider_error',
        err instanceof Error ? err.message : 'Failed to list LM Studio models.'
      );
    }
  });

  app.post('/api/ai/agent/chat', async (c) => {
    const { tenantId, userId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = AiAgentChatRequestSchema.parse(raw);
    const tenant = await storage.getTenant(tenantId);
    try {
      const response = await runAiAutomationAgent({
        storage,
        cipher,
        orchestrator,
        tenantId,
        tenantSlug: tenant?.slug ?? tenantId,
        userId: userId ?? 'operator',
        request: input,
      });
      return c.json({ response });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'AI provider request failed.';
      const isNotConfigured = msg.toLowerCase().includes('not configured');
      throw new ApiError(
        isNotConfigured ? 422 : 502,
        isNotConfigured ? 'ai_not_configured' : 'ai_provider_error',
        msg
      );
    }
  });

  app.post('/api/ai/diagnose-run/:runId', async (c) => {
    const { tenantId } = c.get('auth');
    const runId = c.req.param('runId');
    const diagnosis = await diagnoseWorkflowRun({
      storage,
      cipher,
      tenantId,
      runId,
    });
    if (!diagnosis) {
      throw new ApiError(404, 'run_not_found', 'Run not found.');
    }
    return c.json({ diagnosis });
  });

  // ---------------- Tenant RBAC Management ----------------

  app.get('/api/rbac/me', async (c) => {
    const auth = c.get('auth');
    return c.json({
      tenantId: auth.tenantId,
      userId: auth.userId ?? null,
      role: auth.role,
      authMethod: auth.authMethod,
    });
  });

  app.get('/api/rbac/members', async (c) => {
    const auth = c.get('auth');
    const members = await storage.listTenantMembers(auth.tenantId);
    return c.json({ members, currentRole: auth.role });
  });

  app.post('/api/rbac/members', async (c) => {
    const auth = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = UpsertTenantMemberSchema.parse(raw);
    await storage.setMembershipRole(auth.tenantId, input.userId, input.role);
    const members = await storage.listTenantMembers(auth.tenantId);
    const member = members.find((m) => m.userId === input.userId) ?? {
      tenantId: auth.tenantId,
      userId: input.userId,
      role: input.role,
    };
    return c.json({ member, members });
  });

  // ---------------- Cryptographically Signed Compliance Audit Export ----------------

  const auditKeyFingerprint = createHash('sha256')
    .update(jwtSecret)
    .digest('hex')
    .slice(0, 16);

  const signAuditPayload = (payload: Omit<SignedAuditBundle, 'signature'>): string => {
    return createHmac('sha256', jwtSecret).update(JSON.stringify(payload)).digest('hex');
  };

  app.get('/api/audit/export', async (c) => {
    const { tenantId, tenant } = c.get('auth');
    const [workflows, runsRes, approvals, tenantState, dlq, secrets] = await Promise.all([
      storage.listWorkflows(tenantId),
      storage.listRuns(tenantId, { limit: 100 }),
      storage.listApprovals(tenantId),
      storage.getTenantState(tenantId),
      storage.listDlqEntries(tenantId),
      storage.listSecrets(tenantId),
    ]);
    const ledger = tenantState.ledger;

    const visibleSecrets = secrets.filter((s) => !s.name.startsWith('__SF_INTERNAL_'));
    const generatedAt = new Date().toISOString();
    const unsignedPayload: Omit<SignedAuditBundle, 'signature'> = {
      schemaVersion: 'sagaflow.audit.v1',
      generatedAt,
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      summary: {
        workflows: workflows.length,
        runs: runsRes.runs.length,
        approvals: approvals.length,
        ledgerEntries: ledger.length,
        dlqEntries: dlq.length,
        secretsCount: visibleSecrets.length,
      },
      workflows,
      runs: runsRes.runs,
      approvals,
      ledger,
      dlq,
    };

    const digest = signAuditPayload(unsignedPayload);
    const bundle: SignedAuditBundle = {
      ...unsignedPayload,
      signature: {
        algorithm: 'HMAC-SHA256',
        keyFingerprint: auditKeyFingerprint,
        digest,
        signedAt: generatedAt,
      },
    };
    return c.json({ bundle });
  });

  app.post('/api/audit/verify', async (c) => {
    const raw = (await parseJsonBody(c)) as { bundle?: SignedAuditBundle } | null;
    const bundle = raw?.bundle;
    if (!bundle || !bundle.signature?.digest) {
      throw new ApiError(400, 'invalid_request', 'Provide { bundle } with a signature digest.');
    }
    const { signature, ...unsigned } = bundle;
    const expected = signAuditPayload(unsigned);
    const a = Buffer.from(signature.digest, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    const valid = a.length === b.length && timingSafeEqual(a, b);
    return c.json({
      valid,
      algorithm: signature.algorithm,
      keyFingerprint: signature.keyFingerprint,
      reason: valid
        ? 'HMAC-SHA256 digest matches payload byte-for-byte — untampered compliance export.'
        : 'Signature mismatch — payload was modified or signed by a different cluster key.',
    });
  });

  // ---------------- v6.0 Studio Safe Dry-Run & Template Debugger ----------------

  app.post('/api/workflows/:workflowId/dry-run', async (c) => {
    const { tenantId } = c.get('auth');
    const workflowId = c.req.param('workflowId');
    const wf = await storage.getWorkflow(tenantId, workflowId);
    if (!wf) {
      throw new ApiError(404, 'workflow_not_found', 'Workflow not found.');
    }
    const raw = (await parseJsonBody(c)) ?? {};
    const parsed = DryRunWorkflowSchema.parse(raw);
    const secrets = await storage.listSecrets(tenantId);
    const secretNames = secrets
      .map((s) => s.name)
      .filter((n) => !n.startsWith('__SAGAFLOW_AI_'));
    const result = await dryRunWorkflowGraph({
      workflowId: wf.id,
      workflowName: wf.name,
      tenantId,
      nodes: parsed.nodes ?? wf.nodes,
      edges: parsed.edges ?? wf.edges,
      input: parsed.input,
      secretNames,
    });
    return c.json({ dryRun: result });
  });

  // ---------------- v6.0 Time-Travel Replay (Resume From Step Checkpoint) ----------------

  app.post('/api/runs/:runId/resume-from/:nodeId', async (c) => {
    const { tenantId } = c.get('auth');
    const runId = c.req.param('runId');
    const nodeId = c.req.param('nodeId');
    const raw = (await parseJsonBody(c)) ?? {};
    const body = ResumeRunFromStepSchema.parse(raw);
    const headerKey = c.req.header('idempotency-key')?.trim();

    try {
      const result = await orchestrator.resumeRunFromStep(tenantId, runId, nodeId, {
        inputOverrides: body.inputOverrides,
        stepOutputOverrides: body.stepOutputOverrides,
        idempotencyKey: body.idempotencyKey ?? headerKey,
      });
      return c.json(result, 202);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to resume run from step';
      if (msg.includes('not found')) {
        throw new ApiError(404, 'run_not_found', msg);
      }
      throw new ApiError(400, 'invalid_request', msg);
    }
  });

  // ---------------- v6.0 Real Alert Rules & SLA Escalation Webhooks ----------------

  app.get('/api/alerts', async (c) => {
    const { tenantId } = c.get('auth');
    const rules = await storage.listAlertRules(tenantId);
    return c.json({ rules });
  });

  app.post('/api/alerts', async (c) => {
    const { tenantId } = c.get('auth');
    const raw = await parseJsonBody(c);
    const input = CreateAlertRuleSchema.parse(raw);
    const rule = await storage.createAlertRule(tenantId, input);
    return c.json({ rule }, 201);
  });

  app.patch('/api/alerts/:ruleId', async (c) => {
    const { tenantId } = c.get('auth');
    const ruleId = c.req.param('ruleId');
    const raw = await parseJsonBody(c);
    const patch = UpdateAlertRuleSchema.parse(raw);
    const rule = await storage.updateAlertRule(tenantId, ruleId, patch);
    if (!rule) {
      throw new ApiError(404, 'alert_rule_not_found', 'Alert rule not found.');
    }
    return c.json({ rule });
  });

  app.delete('/api/alerts/:ruleId', async (c) => {
    const { tenantId } = c.get('auth');
    const ruleId = c.req.param('ruleId');
    const deleted = await storage.deleteAlertRule(tenantId, ruleId);
    if (!deleted) {
      throw new ApiError(404, 'alert_rule_not_found', 'Alert rule not found.');
    }
    return c.json({ deleted: true, id: ruleId });
  });

  app.post('/api/alerts/:ruleId/test', async (c) => {
    const { tenantId } = c.get('auth');
    const ruleId = c.req.param('ruleId');
    const rule = await storage.getAlertRule(tenantId, ruleId);
    if (!rule) {
      throw new ApiError(404, 'alert_rule_not_found', 'Alert rule not found.');
    }
    const outcome = await deliverAlertToRule(storage, rule, {
      event: rule.eventTypes[0] ?? 'run.failed',
      tenantId,
      timestamp: new Date().toISOString(),
      summary: `Test alert delivery from SagaFlow v6.0 rule "${rule.name}"`,
      data: { test: true, ruleId: rule.id, webhookUrl: rule.webhookUrl },
    });
    const updated = await storage.getAlertRule(tenantId, ruleId);
    return c.json({ outcome, rule: updated ?? rule });
  });

  app.post('/api/approvals/sweep-sla', async (c) => {
    if (!scheduler) {
      return c.json({ handled: 0, note: 'Scheduler not active in this process.' });
    }
    const handled = await scheduler.sweepExpiredApprovals(new Date());
    return c.json({ handled });
  });

  return app;
}
