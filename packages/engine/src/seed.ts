import { getNextCronDate } from '@sagaflow/shared';
import type { StorageAdapter } from './storage/interface.js';
import { hashPassword, type SecretCipher } from './utils/crypto.js';

export const DEMO_ADMIN_EMAIL = 'admin@sagaflow.local';
export const DEMO_ADMIN_PASSWORD = 'sagaflow123';

export const DEMO_TENANTS = {
  ACME: {
    id: 'ten_acme',
    name: 'Acme Commerce',
    slug: 'acme-commerce',
    maxConcurrentRuns: 200,
    rateLimitPerMin: 600,
  },
  GLOBEX: {
    id: 'ten_globex',
    name: 'Globex Logistics',
    slug: 'globex-logistics',
    maxConcurrentRuns: 150,
    rateLimitPerMin: 400,
  },
} as const;

export const DEMO_USER_ID = 'usr_demo_admin';

export async function ensureDefaultTenantState(storage: StorageAdapter, tenantId: string): Promise<void> {
  const state = await storage.getTenantState(tenantId).catch(() => null);
  if (!state) return;
  if (state.inventory.length === 0) {
    await storage.mutateInventory(tenantId, {
      sku: 'SKU-PRO-900',
      name: 'SagaFlow Hardware Appliance Pro',
      warehouse: 'ap-south-1',
      deltaAvailable: 5000,
    });
    await storage.mutateInventory(tenantId, {
      sku: 'SKU-EDGE-200',
      name: 'Edge Relay Module v2',
      warehouse: 'eu-central-1',
      deltaAvailable: 1200,
    });
  }
  if (state.balances.length === 0) {
    await storage.mutateBalance(tenantId, {
      accountId: 'customer_wallet',
      label: 'Customer Operating Wallet',
      currency: 'USD',
      deltaAvailable: 250000,
    });
    await storage.mutateBalance(tenantId, {
      accountId: 'merchant_revenue',
      label: 'Merchant Captured Revenue',
      currency: 'USD',
      deltaAvailable: 0,
    });
    await storage.mutateBalance(tenantId, {
      accountId: 'loyalty_credits',
      label: 'Customer Loyalty Credits',
      currency: 'PTS',
      deltaAvailable: 50000,
    });
  }
}

/**
 * Idempotently seeds two tenants, real tenant inventory/wallet balances, and four published
 * workflows backed by 100% real persistent database transactions and live webhook sink calls.
 */
export async function seedDemoData(
  storage: StorageAdapter,
  cipher?: SecretCipher
): Promise<void> {
  // Ensure default self-hosted admin account exists for JWT login
  const existingAdmin = await storage.getUserByEmail(DEMO_ADMIN_EMAIL);
  if (!existingAdmin) {
    await storage.createUser({
      id: DEMO_USER_ID,
      email: DEMO_ADMIN_EMAIL,
      name: 'SagaFlow Admin',
      passwordHash: hashPassword(DEMO_ADMIN_PASSWORD),
    });
  }

  const existingTenants = await storage.listTenants();
  if (existingTenants.length > 0) {
    const demoTenantIds = new Set<string>([DEMO_TENANTS.ACME.id, DEMO_TENANTS.GLOBEX.id]);
    for (const t of existingTenants) {
      // Never grant the well-known demo admin ownership of user-created
      // tenants; only repair membership on the two seeded demo tenants.
      if (demoTenantIds.has(t.id)) {
        await storage.ensureMembership(t.id, DEMO_USER_ID, 'owner');
      }
      await ensureDefaultTenantState(storage, t.id);
    }
    if (cipher) {
      const acmeSecrets = await storage.listSecrets(DEMO_TENANTS.ACME.id).catch(() => []);
      if (acmeSecrets.length === 0) {
        await storage.upsertSecret(DEMO_TENANTS.ACME.id, {
          name: 'PARTNER_WEBHOOK_TOKEN',
          description: 'HMAC/Bearer token encrypted at rest with AES-256-GCM',
          encryptedValue: cipher.encrypt('sf_live_partner_secret_9f3a8c'),
        }).catch(() => undefined);
      }
      const acmeSchedules = await storage.listSchedules(DEMO_TENANTS.ACME.id).catch(() => []);
      if (acmeSchedules.length === 0) {
        const wf = await storage.getWorkflow(DEMO_TENANTS.ACME.id, 'wf_order_fulfillment').catch(() => null);
        if (wf) {
          await storage.createSchedule(DEMO_TENANTS.ACME.id, {
            workflowId: wf.id,
            workflowName: wf.name,
            name: 'Hourly Order Reconciliation',
            cron: '0 * * * *',
            input: { orderId: 'ORD-CRON-HOURLY', amount: 120, source: 'cron' },
            enabled: false,
            nextRunAt: getNextCronDate('0 * * * *')?.toISOString() ?? null,
          }).catch(() => undefined);
        }
      }
    }
    return;
  }

  // Create two tenants (provisions two separate SQLite DB files in db-per-tenant mode!)
  const acme = await storage.createTenant(DEMO_TENANTS.ACME);
  const globex = await storage.createTenant(DEMO_TENANTS.GLOBEX);
  await storage.ensureMembership(acme.id, DEMO_USER_ID, 'owner');
  await storage.ensureMembership(globex.id, DEMO_USER_ID, 'owner');
  await ensureDefaultTenantState(storage, acme.id);
  await ensureDefaultTenantState(storage, globex.id);

  // Workflow 1: Order Fulfillment Saga (Transient retry recovery + Parallel fan-out + WASM script)
  const wf1 = await storage.createWorkflow(
    acme.id,
    {
      name: 'Order Fulfillment Saga (Retry + Parallel Fan-Out)',
      description:
        'Validates order in QuickJS-WASM sandbox, reserves inventory, recovers from a transient payment failure via exponential backoff retry, then ships and notifies in parallel.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Order Received',
          position: { x: 40, y: 180 },
          config: { triggerType: 'webhook', simulatedLatencyMs: 20 },
        },
        {
          id: 'enrich',
          type: 'script',
          label: 'Enrich & Validate (WASM)',
          position: { x: 320, y: 180 },
          config: {
            code: `const amount = Number(input.amount ?? 149.99);
const tax = Number((amount * 0.08).toFixed(2));
const total = Number((amount + tax).toFixed(2));
console.log("Calculated order total:", total);
return {
  orderId: input.orderId ?? "ORD-2026-8841",
  subtotal: amount,
  tax,
  total,
  priority: total >= 100 ? "express" : "standard"
};`,
            timeoutMs: 1200,
            memoryLimitMb: 16,
          },
        },
        {
          id: 'reserve',
          type: 'custom_task',
          label: 'Reserve Inventory',
          position: { x: 600, y: 180 },
          config: {
            handler: 'reserve_inventory',
            compensationHandler: 'release_inventory',
            simulatedLatencyMs: 110,
            retryPolicy: { maxAttempts: 2, initialDelayMs: 200, backoffMultiplier: 2 },
          },
        },
        {
          id: 'charge',
          type: 'custom_task',
          label: 'Charge Payment (1 Retry)',
          position: { x: 880, y: 180 },
          config: {
            handler: 'charge_payment',
            compensationHandler: 'refund_payment',
            simulateFailures: 1,
            failureMessage: 'Transient Stripe 502 Bad Gateway — retrying with backoff',
            simulatedLatencyMs: 140,
            retryPolicy: { maxAttempts: 3, initialDelayMs: 300, backoffMultiplier: 2 },
          },
        },
        {
          id: 'ship',
          type: 'custom_task',
          label: 'Create Shipment',
          position: { x: 1180, y: 95 },
          config: {
            handler: 'create_shipment',
            compensationHandler: 'cancel_shipment',
            simulatedLatencyMs: 120,
          },
        },
        {
          id: 'notify',
          type: 'custom_task',
          label: 'Send Confirmation',
          position: { x: 1180, y: 265 },
          config: {
            handler: 'send_notification',
            compensationHandler: 'send_cancellation_notice',
            simulatedLatencyMs: 90,
          },
        },
      ],
      edges: [
        { id: 'e-1', from: 'trigger', to: 'enrich' },
        { id: 'e-2', from: 'enrich', to: 'reserve' },
        { id: 'e-3', from: 'reserve', to: 'charge' },
        { id: 'e-4', from: 'charge', to: 'ship' },
        { id: 'e-5', from: 'charge', to: 'notify' },
      ],
    },
    'wf_order_fulfillment'
  );
  await storage.publishWorkflow(acme.id, wf1.id);

  // Workflow 2: Payment Failure & Distributed Saga Rollback Demo
  const wf2 = await storage.createWorkflow(
    acme.id,
    {
      name: 'Payment Decline — Full Saga Compensation Demo',
      description:
        'Reserves inventory & locks loyalty credits, then hits a permanent payment failure after 2 retries — triggering reverse-order Saga compensation rollbacks and a DLQ audit entry.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Checkout Started',
          position: { x: 40, y: 170 },
          config: { triggerType: 'api', simulatedLatencyMs: 20 },
        },
        {
          id: 'reserve',
          type: 'custom_task',
          label: 'Reserve Inventory',
          position: { x: 320, y: 170 },
          config: {
            handler: 'reserve_inventory',
            compensationHandler: 'release_inventory',
            simulatedLatencyMs: 110,
          },
        },
        {
          id: 'credits',
          type: 'custom_task',
          label: 'Lock Loyalty Credits',
          position: { x: 600, y: 170 },
          config: {
            handler: 'allocate_credits',
            compensationHandler: 'revert_credits',
            simulatedLatencyMs: 100,
          },
        },
        {
          id: 'charge',
          type: 'custom_task',
          label: 'Charge Payment (Declines)',
          position: { x: 880, y: 170 },
          config: {
            handler: 'charge_payment',
            compensationHandler: 'refund_payment',
            alwaysFail: true,
            failureMessage: 'Card declined by issuer (402 Payment Required)',
            simulatedLatencyMs: 130,
            retryPolicy: { maxAttempts: 2, initialDelayMs: 250, backoffMultiplier: 2 },
          },
        },
        {
          id: 'ship',
          type: 'custom_task',
          label: 'Dispatch Order',
          position: { x: 1160, y: 170 },
          config: {
            handler: 'create_shipment',
            compensationHandler: 'cancel_shipment',
            simulatedLatencyMs: 90,
          },
        },
      ],
      edges: [
        { id: 'e-rb-1', from: 'trigger', to: 'reserve' },
        { id: 'e-rb-2', from: 'reserve', to: 'credits' },
        { id: 'e-rb-3', from: 'credits', to: 'charge' },
        { id: 'e-rb-4', from: 'charge', to: 'ship' },
      ],
    },
    'wf_saga_rollback'
  );
  await storage.publishWorkflow(acme.id, wf2.id);

  // Workflow 3: Conditional Branching + Durable Timer + Fast Stress-Test Pipeline
  const wf3 = await storage.createWorkflow(
    acme.id,
    {
      name: 'High-Value Approval Router (Condition + Wait)',
      description:
        'Routes orders conditionally using QuickJS-WASM expressions: high-value orders (> $100) take the VIP Express branch while standard orders skip it.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Order Event',
          position: { x: 40, y: 175 },
          config: { triggerType: 'event', simulatedLatencyMs: 10 },
        },
        {
          id: 'check_vip',
          type: 'condition',
          label: 'Amount >= $100?',
          position: { x: 320, y: 175 },
          config: { expression: '(input.amount ?? 150) >= 100' },
        },
        {
          id: 'vip_hold',
          type: 'wait',
          label: 'Fraud Cooldown (250ms)',
          position: { x: 620, y: 80 },
          config: { delayMs: 250 },
        },
        {
          id: 'vip_webhook',
          type: 'http_request',
          label: 'Notify VIP Desk (Live Sink)',
          position: { x: 920, y: 80 },
          config: {
            method: 'POST',
            url: '/api/sink/acme-commerce/vip-approval',
            headers: {
              'X-Partner-Auth': 'Bearer {{secrets.PARTNER_WEBHOOK_TOKEN}}',
            },
            body: {
              tier: 'vip',
              orderId: '{{input.orderId}}',
              amount: '{{input.amount}}',
            },
          },
        },
        {
          id: 'standard_notify',
          type: 'custom_task',
          label: 'Auto-Approve Standard',
          position: { x: 620, y: 270 },
          config: { handler: 'send_notification', simulatedLatencyMs: 25 },
        },
      ],
      edges: [
        { id: 'e-c-1', from: 'trigger', to: 'check_vip' },
        { id: 'e-c-2', from: 'check_vip', to: 'vip_hold', label: 'true', condition: 'true' },
        { id: 'e-c-3', from: 'vip_hold', to: 'vip_webhook' },
        { id: 'e-c-4', from: 'check_vip', to: 'standard_notify', label: 'false', condition: 'false' },
      ],
    },
    'wf_conditional_router'
  );
  await storage.publishWorkflow(acme.id, wf3.id);

  // Workflow 4 in Globex Logistics (demonstrating physical DB-per-tenant isolation!)
  const wf4 = await storage.createWorkflow(
    globex.id,
    {
      name: 'Cross-Border Customs Clearance Pipeline',
      description:
        'Isolated inside Globex Logistics tenant database. Acme Commerce cannot view or execute this workflow (404 enforced).',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Container Docked',
          position: { x: 40, y: 160 },
          config: { triggerType: 'webhook', simulatedLatencyMs: 20 },
        },
        {
          id: 'tariff_calc',
          type: 'script',
          label: 'Calculate Duty (WASM)',
          position: { x: 340, y: 160 },
          config: {
            code: `const weightKg = Number(input.weightKg ?? 420);
const declaredUsd = Number(input.declaredUsd ?? 8500);
const dutyUsd = Number((declaredUsd * 0.045 + weightKg * 0.25).toFixed(2));
return { weightKg, declaredUsd, dutyUsd, clearedForFiling: true };`,
          },
        },
        {
          id: 'customs',
          type: 'custom_task',
          label: 'File Customs Manifest',
          position: { x: 640, y: 160 },
          config: {
            handler: 'sync_customs',
            compensationHandler: 'void_customs_manifest',
            simulatedLatencyMs: 90,
          },
        },
        {
          id: 'dispatch',
          type: 'custom_task',
          label: 'Book Inland Carrier',
          position: { x: 940, y: 160 },
          config: {
            handler: 'create_shipment',
            compensationHandler: 'cancel_shipment',
            simulatedLatencyMs: 80,
          },
        },
      ],
      edges: [
        { id: 'e-g-1', from: 'trigger', to: 'tariff_calc' },
        { id: 'e-g-2', from: 'tariff_calc', to: 'customs' },
        { id: 'e-g-3', from: 'customs', to: 'dispatch' },
      ],
    },
    'wf_globex_customs'
  );
  await storage.publishWorkflow(globex.id, wf4.id);

  // Workflow 5: High-Value Wire Transfer (Human-in-the-Loop Approval Gate + Atomic Rollback!)
  const wf5 = await storage.createWorkflow(
    acme.id,
    {
      name: 'Wire Transfer Approval Gate (Human-in-the-Loop Saga)',
      description:
        'Debits operating wallet, durably pauses for Finance approval (UI or callback webhook), and either disburses via live HTTP Sink on approval or atomically refunds every cent on rejection.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Wire Request',
          position: { x: 40, y: 170 },
          config: { triggerType: 'webhook' },
        },
        {
          id: 'hold_funds',
          type: 'custom_task',
          label: 'Hold Operating Funds',
          position: { x: 340, y: 170 },
          config: {
            handler: 'charge_payment',
            compensationHandler: 'refund_payment',
          },
        },
        {
          id: 'cfo_approval',
          type: 'approval',
          label: 'CFO Approval Gate',
          position: { x: 640, y: 170 },
          config: {
            approverRole: 'CFO / Finance Lead',
            slaMinutes: 60,
            onTimeout: 'escalate',
            prompt:
              'Approve wire transfer of ${{input.amount}} for order {{input.orderId}}? Rejecting triggers an automatic atomic wallet refund.',
          },
        },
        {
          id: 'disburse',
          type: 'http_request',
          label: 'Disburse Wire (Live Sink)',
          position: { x: 960, y: 170 },
          config: {
            method: 'POST',
            url: '/api/sink/acme-commerce/wire-disbursements',
            headers: {
              'X-Partner-Auth': 'Bearer {{secrets.PARTNER_WEBHOOK_TOKEN}}',
            },
            body: {
              event: 'wire.disbursed',
              orderId: '{{input.orderId}}',
              amount: '{{input.amount}}',
              approvedBy: '{{steps.cfo_approval.decidedBy}}',
            },
          },
        },
      ],
      edges: [
        { id: 'e-ap-1', from: 'trigger', to: 'hold_funds' },
        { id: 'e-ap-2', from: 'hold_funds', to: 'cfo_approval' },
        { id: 'e-ap-3', from: 'cfo_approval', to: 'disburse' },
      ],
    },
    'wf_human_approval'
  );
  await storage.publishWorkflow(acme.id, wf5.id);

  // Workflow 6: Real AI Order Risk Triage (LM Studio / Google AI Studio node + Conditional Branch + Approval Gate)
  const wf6 = await storage.createWorkflow(
    acme.id,
    {
      name: 'AI Order Risk Triage (LM Studio / Gemini)',
      description:
        'Uses a real executable ai_agent DAG node (LM Studio local LLM or Google AI Studio Gemini API) to score order risk and route high-risk orders to a Human Approval Gate.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Order Intake',
          position: { x: 40, y: 170 },
          config: { triggerType: 'webhook', simulatedLatencyMs: 10 },
        },
        {
          id: 'ai_triage',
          type: 'ai_agent',
          label: 'AI Risk Triage Agent',
          position: { x: 330, y: 170 },
          config: {
            provider: 'default',
            expectJson: true,
            systemPrompt:
              'You are an e-commerce fraud & risk screening agent. Respond strictly in JSON: {"riskScore": 0-100, "riskLevel": "low"|"high", "reason": "short summary"}.',
            prompt:
              'Evaluate order {{input.orderId}} for amount ${{input.amount}} USD (SKU {{input.sku}}, qty {{input.qty}}). Flag orders over $800 as high risk.',
          },
        },
        {
          id: 'risk_branch',
          type: 'condition',
          label: 'High Risk?',
          position: { x: 640, y: 170 },
          config: {
            expression:
              "steps.ai_triage?.riskLevel === 'high' || Number(steps.ai_triage?.riskScore ?? 0) >= 70",
          },
        },
        {
          id: 'manual_review',
          type: 'approval',
          label: 'Fraud Officer Review',
          position: { x: 960, y: 80 },
          config: {
            approverRole: 'Risk & Compliance',
            prompt:
              'AI flagged order {{input.orderId}} (${{input.amount}}): {{steps.ai_triage.reason}}. Approve dispatch or reject?',
          },
        },
        {
          id: 'fast_dispatch',
          type: 'http_request',
          label: 'Fast-Track Dispatch Sink',
          position: { x: 960, y: 260 },
          config: {
            method: 'POST',
            url: '/api/sink/acme-commerce/ai-dispatched',
            body: {
              event: 'order.ai_cleared',
              orderId: '{{input.orderId}}',
              riskLevel: '{{steps.ai_triage.riskLevel}}',
              reason: '{{steps.ai_triage.reason}}',
            },
          },
        },
      ],
      edges: [
        { id: 'e-ai-1', from: 'trigger', to: 'ai_triage' },
        { id: 'e-ai-2', from: 'ai_triage', to: 'risk_branch' },
        { id: 'e-ai-3', from: 'risk_branch', to: 'manual_review', label: 'true', condition: 'true' },
        { id: 'e-ai-4', from: 'risk_branch', to: 'fast_dispatch', label: 'false', condition: 'false' },
      ],
    },
    'wf_ai_triage'
  );
  await storage.publishWorkflow(acme.id, wf6.id);

  // Workflow 7: Nested Sub-Workflow Order Pipeline (Parent -> Child Saga Execution!)
  const wf7 = await storage.createWorkflow(
    acme.id,
    {
      name: 'Nested Sub-Workflow Order Pipeline (Parent → Child Saga)',
      description:
        'Demonstrates real nested Sub-Workflow orchestration: reserves real warehouse stock, invokes High-Value Approval Router as an isolated child Saga, and logs the linked childRunId into the compliance ledger.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Enterprise Order Intake',
          position: { x: 40, y: 170 },
          config: { triggerType: 'webhook', simulatedLatencyMs: 10 },
        },
        {
          id: 'reserve_parent',
          type: 'custom_task',
          label: 'Reserve Parent Stock',
          position: { x: 340, y: 170 },
          config: {
            handler: 'reserve_inventory',
            compensationHandler: 'release_inventory',
            sku: '{{input.sku}}',
            qty: '{{input.qty}}',
            simulatedLatencyMs: 30,
          },
        },
        {
          id: 'route_subflow',
          type: 'sub_workflow',
          label: 'Invoke VIP Router Sub-Flow',
          position: { x: 660, y: 170 },
          config: {
            workflowId: 'wf_conditional_router',
            timeoutMs: 15000,
            input: {
              orderId: '{{input.orderId}}',
              amount: '{{input.amount}}',
            },
          },
        },
        {
          id: 'audit_nested',
          type: 'custom_task',
          label: 'Record Parent-Child Audit',
          position: { x: 980, y: 170 },
          config: {
            handler: 'audit_log',
            message:
              'Parent order {{input.orderId}} completed nested sub-workflow run {{steps.route_subflow.childRunId}} ({{steps.route_subflow.childStatus}})',
          },
        },
      ],
      edges: [
        { id: 'e-sub-1', from: 'trigger', to: 'reserve_parent' },
        { id: 'e-sub-2', from: 'reserve_parent', to: 'route_subflow' },
        { id: 'e-sub-3', from: 'route_subflow', to: 'audit_nested' },
      ],
    },
    'wf_nested_pipeline'
  );
  await storage.publishWorkflow(acme.id, wf7.id);

  // Workflow 8 (v6.0): Dynamic for_each Batch Fan-Out + Atomic Per-Item Saga Rollback
  const wf8 = await storage.createWorkflow(
    acme.id,
    {
      name: 'Batch Order Line Fan-Out (for_each Concurrency + Rollback)',
      description:
        'Dynamically iterates over any runtime {{input.items}} array with bounded concurrency, reserves real inventory per SKU line item (with atomic rollback), and computes consolidated batch totals in QuickJS-WASM.',
      nodes: [
        {
          id: 'trigger',
          type: 'trigger',
          label: 'Batch Order Received',
          position: { x: 40, y: 170 },
          config: { triggerType: 'api', simulatedLatencyMs: 10 },
        },
        {
          id: 'reserve_batch',
          type: 'for_each',
          label: 'Reserve Each SKU (for_each)',
          position: { x: 350, y: 170 },
          config: {
            itemsExpression: '{{input.items}}',
            mode: 'custom_task',
            itemHandler: 'reserve_inventory',
            itemCompensationHandler: 'release_inventory',
            maxConcurrency: 3,
            itemConfig: {
              sku: '{{input.item.sku}}',
              qty: '{{input.item.qty}}',
            },
          },
        },
        {
          id: 'summarize_batch',
          type: 'script',
          label: 'Aggregate Batch Summary (WASM)',
          position: { x: 690, y: 170 },
          config: {
            code: `const batch = steps.reserve_batch || {};
const results = Array.isArray(batch.results) ? batch.results : [];
const totalQty = results.reduce((sum, r) => sum + Number((r && r.quantity) || 0), 0);
return { batchId: input.batchId || 'BATCH-01', linesProcessed: results.length, totalUnitsReserved: totalQty, status: 'batch_reserved' };`,
          },
        },
        {
          id: 'audit_batch',
          type: 'custom_task',
          label: 'Log Batch Completion',
          position: { x: 1010, y: 170 },
          config: {
            handler: 'audit_log',
            message:
              'Batch {{steps.summarize_batch.batchId}} reserved {{steps.summarize_batch.totalUnitsReserved}} units across {{steps.summarize_batch.linesProcessed}} SKU line(s)',
          },
        },
      ],
      edges: [
        { id: 'e-fe-1', from: 'trigger', to: 'reserve_batch' },
        { id: 'e-fe-2', from: 'reserve_batch', to: 'summarize_batch' },
        { id: 'e-fe-3', from: 'summarize_batch', to: 'audit_batch' },
      ],
    },
    'wf_batch_foreach'
  );
  await storage.publishWorkflow(acme.id, wf8.id);

  // Seed default v6.0 HMAC-signed Alert Rule delivering failures & SLA breaches into live Tenant Webhook Sink
  await storage.createAlertRule(acme.id, {
    name: 'Saga Failure & SLA Watchdog → Live Sink',
    eventTypes: ['run.failed', 'run.compensated', 'dlq.created', 'approval.sla_breached'],
    webhookUrl: '/api/sink/acme-commerce/alerts',
    signingSecret: 'sf_alert_hmac_acme_v6',
    enabled: true,
  });

  // Seed RBAC demo team members for Acme Commerce so RBAC enforcement can be tested immediately
  await storage.setMembershipRole(acme.id, 'usr_demo_admin', 'admin');
  await storage.setMembershipRole(acme.id, 'usr_demo_operator', 'operator');
  await storage.setMembershipRole(acme.id, 'usr_demo_approver', 'approver');
  await storage.setMembershipRole(acme.id, 'usr_demo_viewer', 'viewer');

  // Seed encrypted secret & sample Cron schedule for Acme Commerce
  if (cipher) {
    await storage.upsertSecret(acme.id, {
      name: 'PARTNER_WEBHOOK_TOKEN',
      description: 'HMAC/Bearer token encrypted at rest with AES-256-GCM',
      encryptedValue: cipher.encrypt('sf_live_partner_secret_9f3a8c'),
    });
  }
  await storage.createSchedule(acme.id, {
    workflowId: wf1.id,
    workflowName: wf1.name,
    name: 'Hourly Order Reconciliation',
    cron: '0 * * * *',
    input: { orderId: 'ORD-CRON-HOURLY', amount: 120, source: 'cron' },
    enabled: false,
    nextRunAt: getNextCronDate('0 * * * *')?.toISOString() ?? null,
  });
}
