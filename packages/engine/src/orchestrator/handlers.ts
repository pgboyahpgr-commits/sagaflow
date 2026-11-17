import type { AiProvider, WorkflowNode } from '@sagaflow/shared';
import type { StorageAdapter } from '../storage/interface.js';
import type { SecretCipher } from '../utils/crypto.js';
import { callLlmProvider, resolveAiCredentials } from '../ai/provider.js';
import { runInQuickJSSandbox } from '../sandbox/quickjs.js';
import { resolveTemplates } from './template.js';

export interface SubWorkflowInvocationResult {
  childRunId: string;
  childWorkflowId: string;
  childWorkflowName: string;
  childStatus: string;
  durationMs: number | null;
  output: Record<string, unknown>;
  error: string | null;
}

export interface StepExecutionContext {
  tenantId: string;
  runId: string;
  attempt: number;
  input: Record<string, unknown>;
  stepOutputs: Record<string, unknown>;
  /** Real persistent StorageAdapter backing per-tenant state, ledger & webhook sink */
  storage?: StorageAdapter;
  /** Tenant secret encryption cipher (used by real ai_agent step nodes) */
  cipher?: SecretCipher;
  /** Decrypted tenant secrets (orchestrator redacts values from all outputs/logs/errors) */
  secrets?: Record<string, string>;
  /** Real nested sub-workflow invoker provided by SagaOrchestrator */
  invokeSubWorkflow?: (params: {
    workflowId: string;
    versionNumber?: number;
    input: Record<string, unknown>;
    idempotencyKey: string;
    timeoutMs: number;
  }) => Promise<SubWorkflowInvocationResult>;
  signal: AbortSignal;
}

export interface StepExecutionOutput {
  output: unknown;
  logs?: string[];
  branch?: string;
  haltDownstream?: boolean;
}

export class StepCancelledError extends Error {
  constructor() {
    super('Run cancelled');
    this.name = 'StepCancelledError';
  }
}

export async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal.aborted) throw new StepCancelledError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new StepCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function isBlockedPrivateUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('169.254.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function getCompensatorName(node: WorkflowNode): string | null {
  const cfg = node.config ?? {};
  if (typeof cfg.compensationHandler === 'string' && cfg.compensationHandler.trim()) {
    return cfg.compensationHandler.trim();
  }
  if (node.type === 'custom_task') {
    const handler = String(cfg.handler ?? 'noop');
    const defaults: Record<string, string | null> = {
      reserve_inventory: 'release_inventory',
      allocate_credits: 'revert_credits',
      charge_payment: 'refund_payment',
      create_shipment: 'cancel_shipment',
      send_notification: 'send_cancellation_notice',
      sync_customs: 'void_customs_manifest',
      kv_set: 'kv_revert',
      audit_log: null,
      noop: null,
    };
    return defaults[handler] ?? null;
  }
  if (node.type === 'http_request' && typeof cfg.compensationUrl === 'string' && cfg.compensationUrl.trim()) {
    return 'http_compensate';
  }
  if (
    node.type === 'sub_workflow' &&
    typeof cfg.compensationWorkflowId === 'string' &&
    cfg.compensationWorkflowId.trim()
  ) {
    return 'sub_workflow_compensate';
  }
  if (node.type === 'for_each') {
    const mode = String(cfg.mode ?? 'script');
    if (typeof cfg.itemCompensationHandler === 'string' && cfg.itemCompensationHandler.trim()) {
      return 'for_each_compensate';
    }
    if (mode === 'custom_task') {
      const h = String(cfg.itemHandler ?? '');
      if (
        [
          'reserve_inventory',
          'allocate_credits',
          'charge_payment',
          'create_shipment',
          'send_notification',
          'sync_customs',
          'kv_set',
        ].includes(h)
      ) {
        return 'for_each_compensate';
      }
    }
  }
  if (node.type === 'database') {
    const op = String(cfg.operation ?? 'get').toLowerCase();
    if (op === 'set' || op === 'increment' || op === 'delete') {
      return 'database_revert';
    }
    return null;
  }
  return null;
}

/**
 * Executes a real live HTTP request OR dispatches directly into the tenant's real persisted
 * Webhook Sink when targeting `/api/sink/<channel>`.
 */
export async function executeLiveHttpRequest(params: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  tenantId?: string;
  storage?: StorageAdapter;
  signal?: AbortSignal;
}): Promise<{
  status: number;
  url: string;
  method: string;
  latencyMs: number;
  sinkDeliveryId?: string;
  headers: Record<string, string>;
  body: unknown;
}> {
  const method = params.method.toUpperCase();
  const url = params.url.trim();
  const startedAt = Date.now();

  // Built-in real persisted tenant webhook sink (`/api/sink/<channel>` or `/api/sink/<slug>/<channel>`)
  if (url.startsWith('/api/sink/')) {
    const parts = url.replace(/^\/api\/sink\//, '').split('/').filter(Boolean);
    const channel = parts.length >= 2 ? parts.slice(1).join('/') : (parts[0] ?? 'default');
    let sinkDeliveryId: string | undefined;
    if (params.storage && params.tenantId) {
      const saved = await params.storage.recordSinkDelivery(params.tenantId, {
        channel,
        method,
        path: url,
        headers: params.headers ?? {},
        body: params.body ?? null,
        statusCode: 200,
      });
      sinkDeliveryId = saved.id;
    }
    return {
      status: 200,
      url,
      method,
      latencyMs: Date.now() - startedAt,
      sinkDeliveryId,
      headers: { 'content-type': 'application/json', 'x-sagaflow-sink': channel },
      body: {
        received: true,
        deliveryId: sinkDeliveryId,
        channel,
        receivedAt: new Date().toISOString(),
        echo: params.body ?? null,
      },
    };
  }

  if (isBlockedPrivateUrl(url)) {
    throw new Error(`SSRF Guard blocked private/invalid URL: ${url}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(params.timeoutMs ?? 8000, 500), 15000));
  const onParentAbort = () => controller.abort();
  params.signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SagaFlow-Engine/1.0',
        ...(params.headers ?? {}),
      },
      body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(params.body ?? {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep raw text
    }
    const respHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
    }
    return {
      status: response.status,
      url,
      method,
      latencyMs: Date.now() - startedAt,
      headers: respHeaders,
      body: parsed,
    };
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener('abort', onParentAbort);
  }
}

export async function executeWorkflowNode(
  node: WorkflowNode,
  ctx: StepExecutionContext
): Promise<StepExecutionOutput> {
  if (ctx.signal.aborted) throw new StepCancelledError();
  const cfg = node.config ?? {};

  switch (node.type) {
    case 'trigger': {
      const explicitDelay = Number(cfg.simulatedLatencyMs ?? 0);
      if (explicitDelay > 0) {
        await sleepWithAbort(Math.min(explicitDelay, 2000), ctx.signal);
      }
      return {
        output: {
          triggerType: String(cfg.triggerType ?? 'manual'),
          receivedAt: new Date().toISOString(),
          payload: ctx.input,
        },
        logs: [`Trigger "${node.label ?? node.id}" received ${Object.keys(ctx.input).length} input fields`],
      };
    }

    case 'wait': {
      const delayMs = Math.min(Math.max(Number(cfg.delayMs ?? 300), 10), 30000);
      await sleepWithAbort(delayMs, ctx.signal);
      return {
        output: { waitedMs: delayMs, resumedAt: new Date().toISOString() },
        logs: [`Durable timer waited ${delayMs}ms`],
      };
    }

    case 'condition': {
      const expression = String(cfg.expression ?? 'true').trim();
      const res = await runInQuickJSSandbox({
        code: `return Boolean(${expression});`,
        input: ctx.input,
        steps: ctx.stepOutputs,
        timeoutMs: 800,
        memoryLimitMb: 8,
      });
      if (!res.ok) {
        throw new Error(`Condition evaluation failed: ${res.error}`);
      }
      const matched = Boolean(res.output);
      return {
        branch: matched ? 'true' : 'false',
        output: {
          expression,
          matched,
          branch: matched ? 'true' : 'false',
        },
        logs: [`Evaluated (${expression}) => ${matched}`],
      };
    }

    case 'script': {
      const code = String(cfg.code ?? 'return { ok: true, input };');
      const timeoutMs = Number(cfg.timeoutMs ?? process.env.SANDBOX_TIMEOUT_MS ?? 1500);
      const memoryLimitMb = Number(cfg.memoryLimitMb ?? process.env.SANDBOX_MEMORY_LIMIT_MB ?? 16);
      const allowedList = Array.isArray(cfg.allowedSecrets)
        ? cfg.allowedSecrets.map((s) => String(s))
        : [];
      const scopedSecrets: Record<string, string> = {};
      if (ctx.secrets && allowedList.length > 0) {
        for (const name of allowedList) {
          if (name in ctx.secrets) scopedSecrets[name] = ctx.secrets[name];
        }
      }
      const res = await runInQuickJSSandbox({
        code,
        input: ctx.input,
        steps: ctx.stepOutputs,
        secrets: scopedSecrets,
        timeoutMs,
        memoryLimitMb,
      });
      if (!res.ok) {
        throw new Error(`QuickJS-WASM sandbox error: ${res.error}`);
      }
      return {
        output: res.output,
        logs: [
          ...res.logs,
          `Executed in QuickJS-WASM sandbox (${res.durationMs}ms, limit ${memoryLimitMb}MB)`,
        ],
      };
    }

    case 'ai_agent': {
      if (!ctx.storage || !ctx.cipher) {
        throw new Error('AI Agent step requires configured storage & encryption cipher.');
      }
      const tplCtx = {
        input: ctx.input,
        steps: ctx.stepOutputs,
        secrets: ctx.secrets ?? {},
        env: { tenantId: ctx.tenantId, runId: ctx.runId, attempt: String(ctx.attempt) },
      };
      const creds = await resolveAiCredentials(ctx.storage, ctx.cipher, ctx.tenantId);
      const rawProvider = String(cfg.provider ?? 'default');
      const provider: AiProvider =
        rawProvider === 'google_ai_studio' || rawProvider === 'lm_studio'
          ? rawProvider
          : creds.config.provider;

      const systemPrompt = String(
        resolveTemplates(
          String(
            cfg.systemPrompt ??
              'You are an autonomous workflow execution agent. Return concise valid JSON matching the task requirements.'
          ),
          tplCtx
        )
      );
      const userPrompt = String(
        resolveTemplates(
          String(
            cfg.prompt ??
              'Analyze the workflow payload and return JSON with decision and reason: {{input.orderId}}'
          ),
          tplCtx
        )
      );
      const expectJson = cfg.expectJson !== false;
      const modelOverride =
        typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : undefined;
      const temperature =
        typeof cfg.temperature === 'number' ? cfg.temperature : creds.config.temperature;

      const res = await callLlmProvider({
        provider,
        googleApiKey: creds.googleApiKey,
        googleModel: modelOverride || creds.config.googleModel,
        googleBaseUrl: creds.config.googleBaseUrl,
        lmStudioBaseUrl: creds.config.lmStudioBaseUrl,
        lmStudioModel: modelOverride || creds.config.lmStudioModel,
        lmStudioApiKey: creds.lmStudioApiKey,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        maxTokens: Number(cfg.maxTokens ?? creds.config.maxTokens ?? 1024),
        expectJson: expectJson && provider === 'google_ai_studio',
        timeoutMs: Number(cfg.timeoutMs ?? 45000),
        signal: ctx.signal,
      });

      let parsed: unknown = null;
      if (expectJson) {
        const trimmed = res.text.trim();
        const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
        for (const candidate of [fenced, trimmed].filter(Boolean) as string[]) {
          try {
            parsed = JSON.parse(candidate);
            break;
          } catch {
            // keep text output
          }
        }
      }

      const merged =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>), text: res.text }
          : { text: res.text, parsed };

      return {
        output: {
          ...merged,
          provider: res.provider,
          model: res.model,
          latencyMs: res.latencyMs,
          usage: res.usage,
        },
        logs: [
          `AI Agent [${res.provider}/${res.model}] completed in ${res.latencyMs}ms`,
        ],
      };
    }

    case 'http_request': {
      const tplCtx = {
        input: ctx.input,
        steps: ctx.stepOutputs,
        secrets: ctx.secrets ?? {},
        env: { tenantId: ctx.tenantId, runId: ctx.runId, attempt: String(ctx.attempt) },
      };
      const method = String(cfg.method ?? 'POST').toUpperCase();
      const rawUrl = String(cfg.url ?? '').trim();
      const url = rawUrl
        ? String(resolveTemplates(rawUrl, tplCtx))
        : `/api/sink/${ctx.tenantId}/${node.id}`;
      const resolvedHeaders =
        typeof cfg.headers === 'object' && cfg.headers
          ? (resolveTemplates(cfg.headers, tplCtx) as Record<string, string>)
          : {};
      const resolvedBody =
        cfg.body !== undefined
          ? resolveTemplates(cfg.body, tplCtx)
          : { input: ctx.input, steps: ctx.stepOutputs };

      // Chaos fault injection (only when explicitly configured on the node)
      const simulateFailures = Number(
        cfg.alwaysFail ? 999 : (cfg.simulateFailures ?? cfg.failFirstNAttempts ?? 0)
      );
      if (simulateFailures > 0 && ctx.attempt <= simulateFailures) {
        throw new Error(
          String(
            cfg.failureMessage ??
              `Fault injection: HTTP ${method} ${url} failed on attempt ${ctx.attempt}`
          )
        );
      }

      // Backwards-compatible explicit mock opt-in for automated unit tests only
      if (cfg.mode === 'mock') {
        const mockResp =
          cfg.mockResponse !== undefined
            ? resolveTemplates(cfg.mockResponse, tplCtx)
            : { accepted: true, requestId: `req_${ctx.runId.slice(-6)}` };
        return {
          output: {
            status: Number(cfg.mockStatus ?? 200),
            method,
            url,
            sentHeaders: Object.keys(resolvedHeaders),
            sentBody: resolvedBody,
            body: mockResp,
          },
          logs: [`HTTP ${method} ${url} -> ${cfg.mockStatus ?? 200}`],
        };
      }

      // Default: 100% REAL HTTP execution (live fetch or real persisted tenant webhook sink!)
      const res = await executeLiveHttpRequest({
        method,
        url,
        headers: resolvedHeaders,
        body: resolvedBody,
        timeoutMs: Number(cfg.timeoutMs ?? 8000),
        tenantId: ctx.tenantId,
        storage: ctx.storage,
        signal: ctx.signal,
      });

      return {
        output: {
          status: res.status,
          method: res.method,
          url: res.url,
          latencyMs: res.latencyMs,
          sinkDeliveryId: res.sinkDeliveryId,
          body: res.body,
        },
        logs: [
          `${res.sinkDeliveryId ? 'Persisted Sink' : 'Live HTTP'} ${res.method} ${res.url} -> HTTP ${res.status} (${res.latencyMs}ms)`,
        ],
      };
    }

    case 'custom_task':
    default: {
      const tplCtx = {
        input: ctx.input,
        steps: ctx.stepOutputs,
        secrets: ctx.secrets ?? {},
        env: { tenantId: ctx.tenantId, runId: ctx.runId, attempt: String(ctx.attempt) },
      };
      const resolvedParams =
        typeof cfg.params === 'object' && cfg.params
          ? (resolveTemplates(cfg.params, tplCtx) as Record<string, unknown>)
          : undefined;
      const handler = String(cfg.handler ?? 'noop');

      const explicitDelay = Number(cfg.simulatedLatencyMs ?? 0);
      if (explicitDelay > 0) {
        await sleepWithAbort(Math.min(explicitDelay, 5000), ctx.signal);
      }

      // Chaos Engineering fault injection (when explicitly configured)
      const simulateFailures = Number(
        cfg.alwaysFail ? 999 : (cfg.simulateFailures ?? cfg.failFirstNAttempts ?? 0)
      );
      if (simulateFailures > 0 && ctx.attempt <= simulateFailures) {
        const msg =
          typeof cfg.failureMessage === 'string' && cfg.failureMessage.trim()
            ? cfg.failureMessage
            : handler === 'charge_payment'
              ? 'Payment gateway declined authorization (fault injection / insufficient funds)'
              : `Transient error in "${handler}" (attempt ${ctx.attempt})`;
        if (ctx.storage) {
          await ctx.storage.appendLedgerEntry(ctx.tenantId, {
            runId: ctx.runId,
            nodeId: node.id,
            action: handler,
            direction: 'execute',
            resourceType: handler === 'charge_payment' ? 'payment' : 'audit',
            resourceId: `${handler}:${ctx.runId.slice(-6)}`,
            status: 'failed',
            summary: msg,
          });
        }
        throw new Error(msg);
      }

      const txRef = `${handler.slice(0, 4)}_${ctx.runId.slice(-6)}_${ctx.attempt}`;

      // 100% REAL persistent per-tenant database transactions!
      if (ctx.storage) {
        switch (handler) {
          case 'reserve_inventory': {
            const rawSku = cfg.sku ?? resolvedParams?.sku ?? ctx.input.sku ?? 'SKU-PRO-900';
            const sku = String(resolveTemplates(rawSku, tplCtx));
            const rawQty = resolveTemplates(
              cfg.qty ??
                cfg.quantity ??
                resolvedParams?.qty ??
                resolvedParams?.quantity ??
                ctx.input.qty ??
                ctx.input.quantity ??
                2,
              tplCtx
            );
            const parsedQty = Number(rawQty);
            const quantity = Number.isFinite(parsedQty) ? Math.max(1, parsedQty) : 1;
            const warehouse = String(cfg.warehouse ?? 'ap-south-1');
            const { item, before } = await ctx.storage.mutateInventory(ctx.tenantId, {
              sku,
              warehouse,
              deltaAvailable: -quantity,
              deltaReserved: quantity,
              requireSufficient: true,
            });
            const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
              runId: ctx.runId,
              nodeId: node.id,
              action: 'reserve_inventory',
              direction: 'execute',
              resourceType: 'inventory',
              resourceId: sku,
              status: 'committed',
              summary: `Reserved ${quantity}x ${sku} (available ${before?.available ?? item.available + quantity} -> ${item.available}, reserved ${item.reserved})`,
              beforeState: before ? { available: before.available, reserved: before.reserved } : null,
              afterState: { available: item.available, reserved: item.reserved },
            });
            return {
              output: {
                reservationId: `rsv_${txRef}`,
                ledgerId: ledger.id,
                sku,
                quantity,
                warehouse: item.warehouse,
                availableAfter: item.available,
                reservedAfter: item.reserved,
                reserved: true,
              },
              logs: [
                `DB COMMIT: Reserved ${quantity}x ${sku} in ${item.warehouse} (available: ${before?.available ?? '?'} -> ${item.available})`,
              ],
            };
          }

          case 'allocate_credits': {
            const accountId = String(cfg.accountId ?? 'loyalty_credits');
            const credits = Math.max(1, Number(cfg.credits ?? resolvedParams?.credits ?? ctx.input.credits ?? 250));
            const { balance, before } = await ctx.storage.mutateBalance(ctx.tenantId, {
              accountId,
              label: 'Customer Loyalty Credits',
              currency: 'PTS',
              deltaAvailable: -credits,
              deltaLocked: credits,
              requireSufficient: true,
            });
            const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
              runId: ctx.runId,
              nodeId: node.id,
              action: 'allocate_credits',
              direction: 'execute',
              resourceType: 'balance',
              resourceId: accountId,
              status: 'committed',
              summary: `Locked ${credits} PTS on ${accountId} (available ${before?.available ?? balance.available + credits} -> ${balance.available})`,
              beforeState: before ? { available: before.available, locked: before.locked } : null,
              afterState: { available: balance.available, locked: balance.locked },
            });
            return {
              output: {
                allocationId: `crd_${txRef}`,
                ledgerId: ledger.id,
                accountId,
                creditsLocked: credits,
                currency: balance.currency,
                availableAfter: balance.available,
                lockedAfter: balance.locked,
                locked: true,
              },
              logs: [
                `DB COMMIT: Locked ${credits} ${balance.currency} on ${accountId} (available: ${before?.available ?? '?'} -> ${balance.available})`,
              ],
            };
          }

          case 'charge_payment': {
            const upstreamTotal = Object.values(ctx.stepOutputs)
              .map((v) =>
                v && typeof v === 'object' && typeof (v as Record<string, unknown>).total === 'number'
                  ? Number((v as Record<string, unknown>).total)
                  : null
              )
              .find((n): n is number => n !== null);
            const amount = Math.max(
              0.01,
              Number(cfg.amount ?? resolvedParams?.amount ?? upstreamTotal ?? ctx.input.amount ?? 149.99)
            );
            const currency = String(cfg.currency ?? ctx.input.currency ?? 'USD');
            const walletId = String(cfg.walletAccountId ?? 'customer_wallet');
            const merchantId = String(cfg.merchantAccountId ?? 'merchant_revenue');

            // Debit customer wallet with real insufficient-funds check!
            const { balance: customerAfter, before: customerBefore } = await ctx.storage.mutateBalance(
              ctx.tenantId,
              {
                accountId: walletId,
                label: 'Customer Operating Wallet',
                currency,
                deltaAvailable: -amount,
                requireSufficient: true,
              }
            );
            // Credit merchant revenue ledger
            const { balance: merchantAfter } = await ctx.storage.mutateBalance(ctx.tenantId, {
              accountId: merchantId,
              label: 'Merchant Captured Revenue',
              currency,
              deltaAvailable: amount,
            });
            const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
              runId: ctx.runId,
              nodeId: node.id,
              action: 'charge_payment',
              direction: 'execute',
              resourceType: 'payment',
              resourceId: `chg_${txRef}`,
              status: 'committed',
              summary: `Captured ${amount} ${currency} (${walletId}: ${customerBefore?.available ?? '?'} -> ${customerAfter.available}; ${merchantId}: ${merchantAfter.available})`,
              beforeState: customerBefore ? { walletAvailable: customerBefore.available } : null,
              afterState: {
                walletAvailable: customerAfter.available,
                merchantRevenue: merchantAfter.available,
              },
            });
            return {
              output: {
                chargeId: `chg_${txRef}`,
                ledgerId: ledger.id,
                amount,
                currency,
                walletAccountId: walletId,
                merchantAccountId: merchantId,
                walletBalanceAfter: customerAfter.available,
                merchantRevenueAfter: merchantAfter.available,
                captured: true,
              },
              logs: [
                `DB COMMIT: Charged ${amount} ${currency} (wallet -> ${customerAfter.available}, revenue -> ${merchantAfter.available})`,
              ],
            };
          }

          case 'create_shipment': {
            const shipmentId = `shp_${txRef}`;
            const trackingNumber = `FS${Math.abs(hashStr(ctx.runId)).toString().slice(0, 10)}`;
            // If an upstream reserve_inventory step reserved units, commit/dispatch them out of reserved stock!
            const reservedStep = Object.values(ctx.stepOutputs).find(
              (v) =>
                v &&
                typeof v === 'object' &&
                typeof (v as Record<string, unknown>).reservationId === 'string' &&
                typeof (v as Record<string, unknown>).sku === 'string'
            ) as { sku: string; quantity?: number } | undefined;
            if (reservedStep) {
              const dispatchQty = Math.max(1, Number(reservedStep.quantity ?? 1));
              await ctx.storage.mutateInventory(ctx.tenantId, {
                sku: reservedStep.sku,
                deltaAvailable: 0,
                deltaReserved: -dispatchQty,
              });
            }
            const record = {
              shipmentId,
              orderId: String(ctx.input.orderId ?? `ORD-${ctx.runId.slice(-6)}`),
              carrier: String(cfg.carrier ?? 'FastShip Express'),
              trackingNumber,
              dispatchedSku: reservedStep?.sku ?? null,
              dispatchedQuantity: reservedStep?.quantity ?? 0,
              status: 'dispatched',
              createdAt: new Date().toISOString(),
            };
            await ctx.storage.setKv(ctx.tenantId, `shipment:${shipmentId}`, record);
            const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
              runId: ctx.runId,
              nodeId: node.id,
              action: 'create_shipment',
              direction: 'execute',
              resourceType: 'shipment',
              resourceId: shipmentId,
              status: 'committed',
              summary: reservedStep
                ? `Dispatched ${reservedStep.quantity ?? 1}x ${reservedStep.sku} via shipment ${shipmentId} (${trackingNumber})`
                : `Created shipment ${shipmentId} (tracking ${trackingNumber})`,
              afterState: record,
            });
            return {
              output: { ...record, ledgerId: ledger.id },
              logs: [`DB COMMIT: Persisted shipment ${shipmentId} (tracking ${trackingNumber})`],
            };
          }

          case 'send_notification': {
            const notificationId = `ntf_${txRef}`;
            const recipient = String(cfg.recipient ?? ctx.input.customerEmail ?? 'ops@acme.example');
            const payload = {
              notificationId,
              channel: 'email+webhook',
              recipient,
              orderId: ctx.input.orderId ?? null,
              runId: ctx.runId,
              params: resolvedParams ?? null,
              delivered: true,
            };
            const sink = await ctx.storage.recordSinkDelivery(ctx.tenantId, {
              channel: 'notifications',
              method: 'POST',
              path: `/api/sink/${ctx.tenantId}/notifications`,
              headers: { 'x-sagaflow-run': ctx.runId, 'x-notification-id': notificationId },
              body: payload,
              statusCode: 200,
            });
            const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
              runId: ctx.runId,
              nodeId: node.id,
              action: 'send_notification',
              direction: 'execute',
              resourceType: 'notification',
              resourceId: notificationId,
              status: 'committed',
              summary: `Delivered notification to ${recipient} (sink ${sink.id})`,
              afterState: { recipient, sinkDeliveryId: sink.id },
            });
            return {
              output: { ...payload, sinkDeliveryId: sink.id, ledgerId: ledger.id },
              logs: [`DELIVERED: Notification ${notificationId} -> ${recipient} (persisted sink ${sink.id})`],
            };
          }

          case 'sync_customs': {
            const manifestId = `cst_${txRef}`;
            const record = {
              manifestId,
              corridor: String(cfg.corridor ?? 'IN-EU'),
              weightKg: Number(ctx.input.weightKg ?? 420),
              declaredUsd: Number(ctx.input.declaredUsd ?? 8500),
              clearanceStatus: 'submitted',
              submittedAt: new Date().toISOString(),
            };
            await ctx.storage.setKv(ctx.tenantId, `customs:${manifestId}`, record);
            const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
              runId: ctx.runId,
              nodeId: node.id,
              action: 'sync_customs',
              direction: 'execute',
              resourceType: 'customs',
              resourceId: manifestId,
              status: 'committed',
              summary: `Filed customs manifest ${manifestId} (${record.corridor})`,
              afterState: record,
            });
            return {
              output: { ...record, ledgerId: ledger.id },
              logs: [`DB COMMIT: Filed customs manifest ${manifestId} (${record.corridor})`],
            };
          }

          case 'kv_set': {
            const key = String(
              resolveTemplates(String(cfg.kvKey ?? `run:${ctx.runId}:${node.id}`), tplCtx)
            );
            const value =
              cfg.kvValue !== undefined
                ? resolveTemplates(cfg.kvValue, tplCtx)
                : (resolvedParams ?? { runId: ctx.runId, updatedAt: new Date().toISOString() });
            const { record, previousValue, existed } = await ctx.storage.setKv(ctx.tenantId, key, value);
            const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
              runId: ctx.runId,
              nodeId: node.id,
              action: 'kv_set',
              direction: 'execute',
              resourceType: 'kv',
              resourceId: key,
              status: 'committed',
              summary: `Set KV "${key}"`,
              beforeState: existed ? { value: previousValue } : null,
              afterState: { value },
            });
            return {
              output: { key, value: record.value, previousValue, existed, ledgerId: ledger.id },
              logs: [`DB COMMIT: Set tenant state key "${key}"`],
            };
          }

          case 'audit_log': {
            const message = String(
              resolveTemplates(
                String(cfg.message ?? `Workflow step ${node.id} completed for run {{env.runId}}`),
                tplCtx
              )
            );
            const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
              runId: ctx.runId,
              nodeId: node.id,
              action: 'audit_log',
              direction: 'execute',
              resourceType: 'audit',
              resourceId: `aud_${txRef}`,
              status: 'committed',
              summary: message,
              afterState: resolvedParams ?? { input: ctx.input },
            });
            return {
              output: { auditId: ledger.id, message, loggedAt: ledger.createdAt },
              logs: [`AUDIT: ${message}`],
            };
          }
        }
      }

      const output = resolvedParams
        ? { handler, transactionRef: txRef, completed: true, params: resolvedParams }
        : { handler, transactionRef: txRef, completed: true };
      return {
        output,
        logs: [`Handler "${handler}" succeeded (ref: ${txRef})`],
      };
    }

    case 'sub_workflow': {
      if (!ctx.invokeSubWorkflow) {
        throw new Error('Sub-workflow execution requires the SagaOrchestrator runtime.');
      }
      const targetWorkflowId = String(cfg.workflowId ?? '').trim();
      if (!targetWorkflowId) {
        throw new Error('sub_workflow node requires config.workflowId (target published workflow ID).');
      }
      const versionNumber =
        typeof cfg.versionNumber === 'number' && Number.isInteger(cfg.versionNumber)
          ? cfg.versionNumber
          : undefined;
      const timeoutMs = Math.min(120_000, Math.max(1000, Number(cfg.timeoutMs ?? 30_000)));
      const rawChildInput =
        cfg.input && typeof cfg.input === 'object' && !Array.isArray(cfg.input)
          ? (cfg.input as Record<string, unknown>)
          : ctx.input;
      const subTplCtx = {
        input: ctx.input,
        steps: ctx.stepOutputs,
        secrets: ctx.secrets ?? {},
        env: { tenantId: ctx.tenantId, runId: ctx.runId },
      };
      const resolvedChildInput = resolveTemplates(rawChildInput, subTplCtx) as Record<
        string,
        unknown
      >;

      const subRes = await ctx.invokeSubWorkflow({
        workflowId: targetWorkflowId,
        versionNumber,
        input: resolvedChildInput,
        idempotencyKey: `sub:${ctx.runId}:${node.id}:att_${ctx.attempt}`,
        timeoutMs,
      });

      if (subRes.childStatus !== 'succeeded') {
        throw new Error(
          `Child workflow "${subRes.childWorkflowName}" (${subRes.childRunId}) ended with status "${subRes.childStatus}"${
            subRes.error ? `: ${subRes.error}` : ''
          }`
        );
      }

      return {
        output: {
          childRunId: subRes.childRunId,
          childWorkflowId: subRes.childWorkflowId,
          childWorkflowName: subRes.childWorkflowName,
          childStatus: subRes.childStatus,
          durationMs: subRes.durationMs,
          output: subRes.output,
        },
        logs: [
          `SUB-WORKFLOW: Invoked "${subRes.childWorkflowName}" -> ${subRes.childRunId} (${subRes.childStatus}, ${subRes.durationMs ?? 0}ms)`,
        ],
      };
    }

    case 'for_each': {
      const tplCtx = {
        input: ctx.input,
        steps: ctx.stepOutputs,
        secrets: ctx.secrets ?? {},
        env: { tenantId: ctx.tenantId, runId: ctx.runId, attempt: String(ctx.attempt) },
      };
      const rawExpr = cfg.itemsExpression ?? cfg.items ?? ctx.input.items ?? [];
      const resolvedItems = resolveTemplates(rawExpr, tplCtx);
      let items: unknown[] = [];
      if (Array.isArray(resolvedItems)) {
        items = resolvedItems;
      } else if (typeof resolvedItems === 'string' && resolvedItems.trim()) {
        try {
          const parsed = JSON.parse(resolvedItems);
          if (Array.isArray(parsed)) items = parsed;
        } catch {
          throw new Error(`for_each itemsExpression did not resolve to a JSON array.`);
        }
      }
      if (items.length > 200) {
        throw new Error(`for_each array size (${items.length}) exceeds max batch limit of 200.`);
      }

      const mode = String(cfg.mode ?? 'script') as 'script' | 'custom_task' | 'http_request';
      const maxConcurrency = Math.min(20, Math.max(1, Number(cfg.maxConcurrency ?? 4)));
      const results: unknown[] = new Array(items.length);
      const itemLogs: string[] = [];
      const succeededItems: Array<{ index: number; item: unknown; output: unknown }> = [];
      let nextIdx = 0;
      let firstError: Error | null = null;

      const buildItemNode = (idx: number): WorkflowNode => {
        if (mode === 'custom_task') {
          return {
            id: `${node.id}__item_${idx}`,
            type: 'custom_task',
            label: `${node.label ?? node.id}[${idx}]`,
            position: node.position,
            config: {
              handler: String(cfg.itemHandler ?? 'audit_log'),
              compensationHandler: cfg.itemCompensationHandler,
              ...(cfg.itemConfig && typeof cfg.itemConfig === 'object'
                ? (cfg.itemConfig as Record<string, unknown>)
                : {}),
              simulatedLatencyMs: Number(cfg.itemLatencyMs ?? 10),
            },
          };
        }
        if (mode === 'http_request') {
          return {
            id: `${node.id}__item_${idx}`,
            type: 'http_request',
            label: `${node.label ?? node.id}[${idx}]`,
            position: node.position,
            config: {
              method: String(cfg.itemMethod ?? 'POST'),
              url: String(cfg.itemUrl ?? ''),
              body: cfg.itemBody ?? { item: '{{input.item}}', index: '{{input.index}}' },
            },
          };
        }
        return {
          id: `${node.id}__item_${idx}`,
          type: 'script',
          label: `${node.label ?? node.id}[${idx}]`,
          position: node.position,
          config: {
            code: String(
              cfg.itemCode ?? 'return { index: input.index, item: input.item, processed: true };'
            ),
          },
        };
      };

      const worker = async () => {
        while (true) {
          if (firstError || ctx.signal.aborted) return;
          const idx = nextIdx++;
          if (idx >= items.length) return;
          const item = items[idx];
          const itemNode = buildItemNode(idx);
          const itemInput: Record<string, unknown> = {
            ...ctx.input,
            ...(item && typeof item === 'object' && !Array.isArray(item)
              ? (item as Record<string, unknown>)
              : {}),
            item,
            index: idx,
          };
          try {
            const res = await executeWorkflowNode(itemNode, {
              ...ctx,
              input: itemInput,
            });
            results[idx] = res.output;
            succeededItems.push({ index: idx, item, output: res.output });
            if (res.logs?.length) itemLogs.push(`[#${idx}] ${res.logs[0]}`);
          } catch (err) {
            firstError = err instanceof Error ? err : new Error(String(err));
            return;
          }
        }
      };

      const workers = Array.from({ length: Math.min(maxConcurrency, Math.max(1, items.length)) }, () =>
        worker()
      );
      await Promise.all(workers);

      if (firstError) {
        // Atomic partial-batch rollback: undo any items that succeeded before the batch failed!
        if (getCompensatorName(node) === 'for_each_compensate' && succeededItems.length > 0) {
          for (const done of [...succeededItems].reverse()) {
            const itemNode = buildItemNode(done.index);
            try {
              await compensateWorkflowNode(itemNode, done.output, {
                ...ctx,
                input: {
                  ...ctx.input,
                  ...(done.item && typeof done.item === 'object' && !Array.isArray(done.item)
                    ? (done.item as Record<string, unknown>)
                    : {}),
                  item: done.item,
                  index: done.index,
                },
              });
            } catch {
              // best-effort partial rollback before surfacing original error
            }
          }
        }
        throw firstError;
      }

      return {
        output: {
          mode,
          itemCount: items.length,
          succeededCount: succeededItems.length,
          maxConcurrency,
          results,
          items,
        },
        logs: [
          `FOR-EACH FAN-OUT: Processed ${items.length} item(s) via "${mode}" (concurrency=${maxConcurrency})`,
          ...itemLogs.slice(0, 8),
        ],
      };
    }

    case 'transform': {
      const tplCtx = {
        input: ctx.input,
        steps: ctx.stepOutputs,
        secrets: ctx.secrets ?? {},
        env: { tenantId: ctx.tenantId, runId: ctx.runId, attempt: String(ctx.attempt) },
      };
      const base: Record<string, unknown> = cfg.mergeWithInput ? { ...ctx.input } : {};
      const pickFields = Array.isArray(cfg.pick) ? cfg.pick.map((f) => String(f)) : [];
      for (const pathStr of pickFields) {
        const val = resolveTemplates(`{{${pathStr}}}`, tplCtx);
        const key = pathStr.split('.').pop() || pathStr;
        base[key] = val;
      }
      if (cfg.mappings && typeof cfg.mappings === 'object' && !Array.isArray(cfg.mappings)) {
        const resolvedMap = resolveTemplates(cfg.mappings, tplCtx) as Record<string, unknown>;
        Object.assign(base, resolvedMap);
      }
      const omitFields = Array.isArray(cfg.omit) ? cfg.omit.map((f) => String(f)) : [];
      for (const k of omitFields) {
        delete base[k];
      }
      const keyCount = Object.keys(base).length;
      return {
        output: base,
        logs: [`TRANSFORM: Mapped ${keyCount} field(s) into structured JSON output`],
      };
    }

    case 'filter': {
      const tplCtx = {
        input: ctx.input,
        steps: ctx.stepOutputs,
        secrets: ctx.secrets ?? {},
        env: { tenantId: ctx.tenantId, runId: ctx.runId, attempt: String(ctx.attempt) },
      };
      const rawField = String(cfg.field ?? '{{input.amount}}').trim();
      const fieldExpr = rawField.includes('{{') ? rawField : `{{${rawField}}}`;
      const actual = resolveTemplates(fieldExpr, tplCtx);
      const operator = String(cfg.operator ?? 'exists').toLowerCase();
      const expected = cfg.value !== undefined ? resolveTemplates(cfg.value, tplCtx) : undefined;
      const passed = evaluateFilterComparison(actual, operator, expected);
      const onFail = String(cfg.onFail ?? 'skip_downstream').toLowerCase();

      if (!passed && onFail === 'fail_run') {
        throw new Error(
          `Filter guard failed: ${rawField} (${JSON.stringify(actual)}) did not satisfy "${operator}" ${
            expected !== undefined ? JSON.stringify(expected) : ''
          }`.trim()
        );
      }

      return {
        haltDownstream: !passed,
        output: {
          passed,
          matched: passed,
          field: rawField,
          operator,
          actual,
          expected: expected ?? null,
          action: passed ? 'continue' : 'skip_downstream',
        },
        logs: [
          `FILTER: ${rawField} ${operator} ${expected !== undefined ? JSON.stringify(expected) : ''} => ${
            passed ? 'PASS (continue)' : 'FILTERED OUT (skip downstream)'
          }`,
        ],
      };
    }

    case 'switch': {
      const tplCtx = {
        input: ctx.input,
        steps: ctx.stepOutputs,
        secrets: ctx.secrets ?? {},
        env: { tenantId: ctx.tenantId, runId: ctx.runId, attempt: String(ctx.attempt) },
      };
      const rawExpr = String(cfg.expression ?? '{{input.tier}}').trim();
      const exprTemplate = rawExpr.includes('{{') ? rawExpr : `{{${rawExpr}}}`;
      const actual = resolveTemplates(exprTemplate, tplCtx);
      const rawCases = Array.isArray(cfg.cases)
        ? (cfg.cases as Array<{ key?: string; label?: string; operator?: string; value?: unknown }>)
        : [];
      const defaultCase = String(cfg.defaultCase ?? 'default');
      let matchedKey = defaultCase;
      let matchedLabel = 'Default';
      let matchedAny = false;

      for (const c of rawCases) {
        const key = String(c.key ?? c.value ?? '').trim();
        if (!key) continue;
        const op = String(c.operator ?? 'eq').toLowerCase();
        const expected = c.value !== undefined ? resolveTemplates(c.value, tplCtx) : key;
        if (evaluateFilterComparison(actual, op, expected)) {
          matchedKey = key;
          matchedLabel = String(c.label ?? key);
          matchedAny = true;
          break;
        }
      }

      return {
        branch: matchedKey,
        output: {
          expression: rawExpr,
          value: actual,
          branch: matchedKey,
          matchedCase: matchedLabel,
          usedDefault: !matchedAny,
        },
        logs: [
          `SWITCH: (${rawExpr} = ${JSON.stringify(actual)}) => routed to "${matchedKey}" (${matchedLabel})`,
        ],
      };
    }

    case 'email': {
      const tplCtx = {
        input: ctx.input,
        steps: ctx.stepOutputs,
        secrets: ctx.secrets ?? {},
        env: { tenantId: ctx.tenantId, runId: ctx.runId, attempt: String(ctx.attempt) },
      };
      const to = String(resolveTemplates(String(cfg.to ?? '{{input.email}}'), tplCtx)).trim() || 'ops@acme.local';
      const from = String(resolveTemplates(String(cfg.from ?? 'notifications@sagaflow.local'), tplCtx));
      const subject = String(resolveTemplates(String(cfg.subject ?? 'SagaFlow Notification'), tplCtx));
      const body = String(resolveTemplates(String(cfg.body ?? 'Workflow notification triggered.'), tplCtx));
      const provider = String(cfg.provider ?? 'sink').toLowerCase();
      const messageId = `msg_${ctx.runId.slice(-8)}_${Date.now().toString(36)}`;

      let deliveryMode = 'tenant_inbox_sink';
      let statusCode = 200;
      let providerResponse: unknown = null;

      if (provider === 'resend' && ctx.secrets) {
        const secretKey = String(cfg.apiKeySecret ?? 'RESEND_API_KEY');
        const apiKey = ctx.secrets[secretKey];
        if (!apiKey) {
          throw new Error(`Email step requires vault secret "${secretKey}" for Resend delivery.`);
        }
        const res = await executeLiveHttpRequest({
          method: 'POST',
          url: 'https://api.resend.com/emails',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: { from, to: [to], subject, text: body },
          tenantId: ctx.tenantId,
          storage: ctx.storage,
          signal: ctx.signal,
        });
        deliveryMode = 'resend_api';
        statusCode = res.status;
        providerResponse = res.body;
      } else if (provider === 'webhook' && typeof cfg.webhookUrl === 'string' && cfg.webhookUrl.trim()) {
        const targetUrl = String(resolveTemplates(cfg.webhookUrl.trim(), tplCtx));
        const res = await executeLiveHttpRequest({
          method: 'POST',
          url: targetUrl,
          body: { messageId, from, to, subject, body, runId: ctx.runId },
          tenantId: ctx.tenantId,
          storage: ctx.storage,
          signal: ctx.signal,
        });
        deliveryMode = 'custom_webhook';
        statusCode = res.status;
        providerResponse = res.body;
      } else if (ctx.storage) {
        const sink = await ctx.storage.recordSinkDelivery(ctx.tenantId, {
          channel: 'email',
          method: 'POST',
          path: `/api/sink/${ctx.tenantId}/email`,
          headers: { 'content-type': 'application/json', 'x-sagaflow-email-to': to },
          body: { messageId, from, to, subject, body, runId: ctx.runId, nodeId: node.id },
          statusCode: 200,
        });
        providerResponse = { sinkDeliveryId: sink.id };
      }

      if (ctx.storage) {
        await ctx.storage.appendLedgerEntry(ctx.tenantId, {
          runId: ctx.runId,
          nodeId: node.id,
          action: 'send_email',
          direction: 'execute',
          resourceType: 'notification',
          resourceId: messageId,
          status: 'committed',
          summary: `EMAIL (${deliveryMode}): To ${to} — "${subject}"`,
        });
      }

      return {
        output: {
          sent: true,
          messageId,
          to,
          from,
          subject,
          body,
          deliveryMode,
          statusCode,
          providerResponse,
        },
        logs: [`EMAIL DELIVERED (${deliveryMode}): to=${to} subject="${subject}" [${statusCode}]`],
      };
    }

    case 'slack_discord': {
      const tplCtx = {
        input: ctx.input,
        steps: ctx.stepOutputs,
        secrets: ctx.secrets ?? {},
        env: { tenantId: ctx.tenantId, runId: ctx.runId, attempt: String(ctx.attempt) },
      };
      const platform = String(cfg.platform ?? 'slack').toLowerCase();
      const channelName = String(resolveTemplates(String(cfg.channelName ?? '#alerts'), tplCtx));
      const title = String(resolveTemplates(String(cfg.title ?? 'SagaFlow Notification'), tplCtx));
      const message = String(resolveTemplates(String(cfg.message ?? 'Automation event received.'), tplCtx));
      const severity = String(cfg.severity ?? 'info').toLowerCase();
      const rawUrl = typeof cfg.webhookUrl === 'string' ? cfg.webhookUrl.trim() : '';
      const resolvedUrl = rawUrl
        ? String(resolveTemplates(rawUrl, tplCtx))
        : `/api/sink/${ctx.tenantId}/${platform}`;

      const colorMap: Record<string, number> = {
        success: 0x22e55c,
        info: 0x38bdf8,
        warning: 0xf59e0b,
        critical: 0xf43f5e,
      };

      const payload =
        platform === 'discord'
          ? {
              content: `**${title}** (${channelName})`,
              embeds: [
                {
                  title,
                  description: message,
                  color: colorMap[severity] ?? 0x22e55c,
                  footer: { text: `SagaFlow · Run ${ctx.runId}` },
                  timestamp: new Date().toISOString(),
                },
              ],
            }
          : platform === 'teams'
            ? {
                '@type': 'MessageCard',
                themeColor: severity === 'critical' ? 'F43F5E' : '22E55C',
                summary: title,
                sections: [{ activityTitle: title, activitySubtitle: channelName, text: message }],
              }
            : {
                text: `[${channelName}] ${title}: ${message}`,
                channel: channelName,
                blocks: [
                  { type: 'header', text: { type: 'plain_text', text: title } },
                  { type: 'section', text: { type: 'mrkdwn', text: message } },
                  {
                    type: 'context',
                    elements: [{ type: 'mrkdwn', text: `*Channel:* ${channelName} · *Severity:* ${severity} · *Run:* \`${ctx.runId}\`` }],
                  },
                ],
              };

      const res = await executeLiveHttpRequest({
        method: 'POST',
        url: resolvedUrl,
        headers: { 'x-sagaflow-chat-platform': platform },
        body: payload,
        tenantId: ctx.tenantId,
        storage: ctx.storage,
        signal: ctx.signal,
      });

      if (ctx.storage) {
        await ctx.storage.appendLedgerEntry(ctx.tenantId, {
          runId: ctx.runId,
          nodeId: node.id,
          action: `post_${platform}`,
          direction: 'execute',
          resourceType: 'notification',
          resourceId: `${platform}:${channelName}`,
          status: 'committed',
          summary: `${platform.toUpperCase()} (${channelName}): ${title}`,
        });
      }

      return {
        output: {
          delivered: true,
          platform,
          channelName,
          title,
          message,
          severity,
          status: res.status,
          targetUrl: resolvedUrl,
          payload,
        },
        logs: [`${platform.toUpperCase()} POST (${channelName}): "${title}" -> HTTP ${res.status}`],
      };
    }

    case 'database': {
      if (!ctx.storage) {
        throw new Error('Database step requires persistent StorageAdapter.');
      }
      const tplCtx = {
        input: ctx.input,
        steps: ctx.stepOutputs,
        secrets: ctx.secrets ?? {},
        env: { tenantId: ctx.tenantId, runId: ctx.runId, attempt: String(ctx.attempt) },
      };
      const operation = String(cfg.operation ?? 'set').toLowerCase();
      const collection = String(resolveTemplates(String(cfg.collection ?? 'records'), tplCtx)).trim() || 'records';
      const rawKey = String(resolveTemplates(String(cfg.key ?? '{{input.id}}'), tplCtx)).trim() || `row_${ctx.runId.slice(-6)}`;
      const fullKey = `${collection}:${rawKey}`;

      if (operation === 'get') {
        const state = await ctx.storage.getTenantState(ctx.tenantId);
        const entry = state.kv.find((r) => r.key === fullKey);
        return {
          output: {
            operation: 'get',
            collection,
            key: fullKey,
            found: Boolean(entry),
            value: entry ? entry.value : null,
            updatedAt: entry?.updatedAt ?? null,
          },
          logs: [`DB GET ${fullKey} => ${entry ? 'FOUND' : 'NOT FOUND'}`],
        };
      }

      if (operation === 'list') {
        const state = await ctx.storage.getTenantState(ctx.tenantId);
        const prefix = `${collection}:`;
        const rows = state.kv
          .filter((r) => r.key.startsWith(prefix))
          .map((r) => ({ key: r.key.slice(prefix.length), fullKey: r.key, value: r.value, updatedAt: r.updatedAt }));
        return {
          output: {
            operation: 'list',
            collection,
            count: rows.length,
            rows,
          },
          logs: [`DB LIST ${collection}:* => ${rows.length} record(s)`],
        };
      }

      if (operation === 'increment') {
        const deltaRaw = resolveTemplates(cfg.delta ?? 1, tplCtx);
        const delta = Number(deltaRaw) || 1;
        const state = await ctx.storage.getTenantState(ctx.tenantId);
        const prev = state.kv.find((r) => r.key === fullKey);
        const prevNum = typeof prev?.value === 'number' ? prev.value : Number(prev?.value ?? 0) || 0;
        const nextNum = prevNum + delta;
        await ctx.storage.setKv(ctx.tenantId, fullKey, nextNum);
        await ctx.storage.appendLedgerEntry(ctx.tenantId, {
          runId: ctx.runId,
          nodeId: node.id,
          action: 'database_increment',
          direction: 'execute',
          resourceType: 'kv',
          resourceId: fullKey,
          status: 'committed',
          summary: `DB INCREMENT ${fullKey}: ${prevNum} -> ${nextNum} (Δ${delta >= 0 ? '+' : ''}${delta})`,
        });
        return {
          output: {
            operation: 'increment',
            collection,
            key: fullKey,
            existed: Boolean(prev),
            previousValue: prev?.value ?? null,
            delta,
            value: nextNum,
          },
          logs: [`DB INCREMENT ${fullKey}: ${prevNum} -> ${nextNum}`],
        };
      }

      if (operation === 'delete') {
        const state = await ctx.storage.getTenantState(ctx.tenantId);
        const prev = state.kv.find((r) => r.key === fullKey);
        await ctx.storage.deleteKv(ctx.tenantId, fullKey);
        await ctx.storage.appendLedgerEntry(ctx.tenantId, {
          runId: ctx.runId,
          nodeId: node.id,
          action: 'database_delete',
          direction: 'execute',
          resourceType: 'kv',
          resourceId: fullKey,
          status: 'committed',
          summary: `DB DELETE ${fullKey} (${prev ? 'removed existing row' : 'key did not exist'})`,
        });
        return {
          output: {
            operation: 'delete',
            collection,
            key: fullKey,
            existed: Boolean(prev),
            previousValue: prev?.value ?? null,
            deleted: Boolean(prev),
          },
          logs: [`DB DELETE ${fullKey} => ${prev ? 'DELETED' : 'NOOP'}`],
        };
      }

      // Default: 'set'
      const value =
        cfg.value !== undefined ? resolveTemplates(cfg.value, tplCtx) : { input: ctx.input, savedAt: new Date().toISOString() };
      const { previousValue, existed } = await ctx.storage.setKv(ctx.tenantId, fullKey, value);
      await ctx.storage.appendLedgerEntry(ctx.tenantId, {
        runId: ctx.runId,
        nodeId: node.id,
        action: 'database_set',
        direction: 'execute',
        resourceType: 'kv',
        resourceId: fullKey,
        status: 'committed',
        summary: `DB SET ${fullKey} (${existed ? 'updated' : 'inserted'})`,
      });
      return {
        output: {
          operation: 'set',
          collection,
          key: fullKey,
          existed,
          previousValue: existed ? previousValue : null,
          value,
        },
        logs: [`DB SET ${fullKey} => committed (${existed ? 'updated' : 'created'})`],
      };
    }
  }
}

function evaluateFilterComparison(actual: unknown, operator: string, expected: unknown): boolean {
  switch (operator) {
    case 'exists':
      return actual !== undefined && actual !== null && actual !== '';
    case 'empty':
      return (
        actual === undefined ||
        actual === null ||
        actual === '' ||
        (Array.isArray(actual) && actual.length === 0)
      );
    case 'eq':
    case 'equals':
    case '==':
      return String(actual ?? '') === String(expected ?? '');
    case 'neq':
    case '!=':
      return String(actual ?? '') !== String(expected ?? '');
    case 'gt':
    case '>':
      return Number(actual) > Number(expected);
    case 'gte':
    case '>=':
      return Number(actual) >= Number(expected);
    case 'lt':
    case '<':
      return Number(actual) < Number(expected);
    case 'lte':
    case '<=':
      return Number(actual) <= Number(expected);
    case 'contains':
      return Array.isArray(actual)
        ? actual.map(String).includes(String(expected ?? ''))
        : String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'not_contains':
      return Array.isArray(actual)
        ? !actual.map(String).includes(String(expected ?? ''))
        : !String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'regex':
      try {
        return new RegExp(String(expected ?? ''), 'i').test(String(actual ?? ''));
      } catch {
        return false;
      }
    default:
      return Boolean(actual);
  }
}

export async function compensateWorkflowNode(
  node: WorkflowNode,
  originalOutput: unknown,
  ctx: StepExecutionContext
): Promise<StepExecutionOutput> {
  const compensator = getCompensatorName(node);
  const cfg = node.config ?? {};
  const explicitDelay = Number(cfg.compensationLatencyMs ?? 0);
  if (explicitDelay > 0) {
    await sleepWithAbort(Math.min(explicitDelay, 3000), ctx.signal);
  }

  if (cfg.failCompensation) {
    throw new Error(
      `Compensation handler "${compensator}" failed permanently (manual intervention required)`
    );
  }

  const orig = (originalOutput && typeof originalOutput === 'object'
    ? (originalOutput as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  // Real HTTP Compensation (e.g., DELETE /api/... or POST /api/sink/.../rollback)
  if (compensator === 'http_compensate' && typeof cfg.compensationUrl === 'string' && cfg.compensationUrl.trim()) {
    const tplCtx = {
      input: ctx.input,
      steps: { ...ctx.stepOutputs, original: orig },
      secrets: ctx.secrets ?? {},
      env: { tenantId: ctx.tenantId, runId: ctx.runId, attempt: String(ctx.attempt) },
    };
    const compUrl = String(resolveTemplates(cfg.compensationUrl, tplCtx));
    const compMethod = String(cfg.compensationMethod ?? 'DELETE').toUpperCase();
    const res = await executeLiveHttpRequest({
      method: compMethod,
      url: compUrl,
      body: { rollbackOf: node.id, runId: ctx.runId, originalOutput: orig },
      tenantId: ctx.tenantId,
      storage: ctx.storage,
      signal: ctx.signal,
    });
    return {
      output: {
        compensator: 'http_compensate',
        revertedNodeId: node.id,
        httpStatus: res.status,
        url: res.url,
        rolledBackAt: new Date().toISOString(),
      },
      logs: [`SAGA HTTP ROLLBACK: ${compMethod} ${res.url} -> HTTP ${res.status}`],
    };
  }

  // 100% REAL Persistent Database Rollback Compensations!
  if (ctx.storage) {
    switch (compensator) {
      case 'release_inventory': {
        const sku = String(orig.sku ?? cfg.sku ?? ctx.input.sku ?? 'SKU-PRO-900');
        const qty = Math.max(1, Number(orig.quantity ?? cfg.quantity ?? ctx.input.quantity ?? 2));
        const { item, before } = await ctx.storage.mutateInventory(ctx.tenantId, {
          sku,
          deltaAvailable: qty,
          deltaReserved: -qty,
        });
        const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
          runId: ctx.runId,
          nodeId: node.id,
          action: 'release_inventory',
          direction: 'compensate',
          resourceType: 'inventory',
          resourceId: sku,
          status: 'compensated',
          summary: `ROLLBACK: Released ${qty}x ${sku} (available ${before?.available ?? '?'} -> ${item.available}, reserved ${item.reserved})`,
          beforeState: before ? { available: before.available, reserved: before.reserved } : null,
          afterState: { available: item.available, reserved: item.reserved },
        });
        return {
          output: {
            compensator,
            ledgerId: ledger.id,
            revertedNodeId: node.id,
            sku,
            releasedQuantity: qty,
            availableRestored: item.available,
            reservedAfter: item.reserved,
            rolledBackAt: ledger.createdAt,
          },
          logs: [
            `DB ROLLBACK: Restored ${qty}x ${sku} (available: ${before?.available ?? '?'} -> ${item.available}, reserved: ${item.reserved})`,
          ],
        };
      }

      case 'revert_credits': {
        const accountId = String(orig.accountId ?? cfg.accountId ?? 'loyalty_credits');
        const credits = Math.max(1, Number(orig.creditsLocked ?? cfg.credits ?? ctx.input.credits ?? 250));
        const { balance, before } = await ctx.storage.mutateBalance(ctx.tenantId, {
          accountId,
          currency: 'PTS',
          deltaAvailable: credits,
          deltaLocked: -credits,
        });
        const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
          runId: ctx.runId,
          nodeId: node.id,
          action: 'revert_credits',
          direction: 'compensate',
          resourceType: 'balance',
          resourceId: accountId,
          status: 'compensated',
          summary: `ROLLBACK: Restored ${credits} PTS to ${accountId} (available ${before?.available ?? '?'} -> ${balance.available})`,
          beforeState: before ? { available: before.available, locked: before.locked } : null,
          afterState: { available: balance.available, locked: balance.locked },
        });
        return {
          output: {
            compensator,
            ledgerId: ledger.id,
            revertedNodeId: node.id,
            accountId,
            creditsRestored: credits,
            availableRestored: balance.available,
            lockedAfter: balance.locked,
            rolledBackAt: ledger.createdAt,
          },
          logs: [
            `DB ROLLBACK: Restored ${credits} PTS on ${accountId} (available: ${before?.available ?? '?'} -> ${balance.available})`,
          ],
        };
      }

      case 'refund_payment': {
        const amount = Math.max(0.01, Number(orig.amount ?? cfg.amount ?? ctx.input.amount ?? 149.99));
        const currency = String(orig.currency ?? 'USD');
        const walletId = String(orig.walletAccountId ?? 'customer_wallet');
        const merchantId = String(orig.merchantAccountId ?? 'merchant_revenue');
        const { balance: walletAfter, before: walletBefore } = await ctx.storage.mutateBalance(
          ctx.tenantId,
          { accountId: walletId, currency, deltaAvailable: amount }
        );
        const { balance: merchantAfter } = await ctx.storage.mutateBalance(ctx.tenantId, {
          accountId: merchantId,
          currency,
          deltaAvailable: -amount,
        });
        const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
          runId: ctx.runId,
          nodeId: node.id,
          action: 'refund_payment',
          direction: 'compensate',
          resourceType: 'payment',
          resourceId: String(orig.chargeId ?? `ref_${ctx.runId.slice(-6)}`),
          status: 'compensated',
          summary: `ROLLBACK: Refunded ${amount} ${currency} to ${walletId} (balance ${walletBefore?.available ?? '?'} -> ${walletAfter.available})`,
          beforeState: walletBefore ? { walletAvailable: walletBefore.available } : null,
          afterState: { walletAvailable: walletAfter.available, merchantRevenue: merchantAfter.available },
        });
        return {
          output: {
            compensator,
            ledgerId: ledger.id,
            revertedNodeId: node.id,
            refundedAmount: amount,
            currency,
            walletBalanceRestored: walletAfter.available,
            rolledBackAt: ledger.createdAt,
          },
          logs: [`DB ROLLBACK: Refunded ${amount} ${currency} to ${walletId} -> ${walletAfter.available}`],
        };
      }

      case 'cancel_shipment': {
        const shipmentId = String(orig.shipmentId ?? `shp_${ctx.runId.slice(-6)}`);
        if (typeof orig.dispatchedSku === 'string' && Number(orig.dispatchedQuantity ?? 0) > 0) {
          await ctx.storage.mutateInventory(ctx.tenantId, {
            sku: orig.dispatchedSku,
            deltaAvailable: 0,
            deltaReserved: Number(orig.dispatchedQuantity),
          });
        }
        const cancelled = { ...orig, shipmentId, status: 'cancelled', cancelledAt: new Date().toISOString() };
        await ctx.storage.setKv(ctx.tenantId, `shipment:${shipmentId}`, cancelled);
        const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
          runId: ctx.runId,
          nodeId: node.id,
          action: 'cancel_shipment',
          direction: 'compensate',
          resourceType: 'shipment',
          resourceId: shipmentId,
          status: 'compensated',
          summary: `ROLLBACK: Voided shipment ${shipmentId}`,
          afterState: cancelled,
        });
        return {
          output: { compensator, ledgerId: ledger.id, revertedNodeId: node.id, shipmentId, rolledBackAt: ledger.createdAt },
          logs: [`DB ROLLBACK: Voided shipment ${shipmentId}`],
        };
      }

      case 'send_cancellation_notice': {
        const recipient = String(orig.recipient ?? ctx.input.customerEmail ?? 'ops@acme.example');
        const sink = await ctx.storage.recordSinkDelivery(ctx.tenantId, {
          channel: 'notifications',
          method: 'POST',
          path: `/api/sink/${ctx.tenantId}/notifications`,
          headers: { 'x-sagaflow-run': ctx.runId, 'x-saga-compensation': 'true' },
          body: { type: 'cancellation_notice', recipient, revertedNodeId: node.id, runId: ctx.runId },
          statusCode: 200,
        });
        const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
          runId: ctx.runId,
          nodeId: node.id,
          action: 'send_cancellation_notice',
          direction: 'compensate',
          resourceType: 'notification',
          resourceId: sink.id,
          status: 'compensated',
          summary: `ROLLBACK: Sent cancellation notice to ${recipient}`,
        });
        return {
          output: { compensator, ledgerId: ledger.id, sinkDeliveryId: sink.id, revertedNodeId: node.id, rolledBackAt: ledger.createdAt },
          logs: [`DB ROLLBACK: Delivered cancellation notice to ${recipient} (sink ${sink.id})`],
        };
      }

      case 'void_customs_manifest': {
        const manifestId = String(orig.manifestId ?? `cst_${ctx.runId.slice(-6)}`);
        const voided = { ...orig, manifestId, clearanceStatus: 'voided', voidedAt: new Date().toISOString() };
        await ctx.storage.setKv(ctx.tenantId, `customs:${manifestId}`, voided);
        const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
          runId: ctx.runId,
          nodeId: node.id,
          action: 'void_customs_manifest',
          direction: 'compensate',
          resourceType: 'customs',
          resourceId: manifestId,
          status: 'compensated',
          summary: `ROLLBACK: Voided customs manifest ${manifestId}`,
        });
        return {
          output: { compensator, ledgerId: ledger.id, revertedNodeId: node.id, manifestId, rolledBackAt: ledger.createdAt },
          logs: [`DB ROLLBACK: Voided customs manifest ${manifestId}`],
        };
      }

      case 'kv_revert': {
        const key = String(orig.key ?? '');
        if (key) {
          if (orig.existed) {
            await ctx.storage.setKv(ctx.tenantId, key, orig.previousValue);
          } else {
            await ctx.storage.deleteKv(ctx.tenantId, key);
          }
          const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
            runId: ctx.runId,
            nodeId: node.id,
            action: 'kv_revert',
            direction: 'compensate',
            resourceType: 'kv',
            resourceId: key,
            status: 'compensated',
            summary: orig.existed ? `ROLLBACK: Restored KV "${key}" to previous value` : `ROLLBACK: Deleted KV "${key}"`,
          });
          return {
            output: { compensator, ledgerId: ledger.id, key, restoredExisted: Boolean(orig.existed), rolledBackAt: ledger.createdAt },
            logs: [`DB ROLLBACK: Reverted tenant KV "${key}"`],
          };
        }
        break;
      }
    }
  }

  if (
    node.type === 'sub_workflow' &&
    typeof cfg.compensationWorkflowId === 'string' &&
    cfg.compensationWorkflowId.trim() &&
    ctx.invokeSubWorkflow
  ) {
    const compWfId = cfg.compensationWorkflowId.trim();
    const subRes = await ctx.invokeSubWorkflow({
      workflowId: compWfId,
      input: {
        parentRunId: ctx.runId,
        compensatedNodeId: node.id,
        originalOutput,
        input: ctx.input,
      },
      idempotencyKey: `sub_comp:${ctx.runId}:${node.id}:att_${ctx.attempt}`,
      timeoutMs: 30_000,
    });
    if (subRes.childStatus !== 'succeeded') {
      throw new Error(
        `Compensation sub-workflow "${subRes.childWorkflowName}" (${subRes.childRunId}) failed: ${
          subRes.error ?? subRes.childStatus
        }`
      );
    }
    return {
      output: {
        compensator: 'sub_workflow_compensate',
        compensationRunId: subRes.childRunId,
        compensationWorkflowId: compWfId,
        rolledBackAt: new Date().toISOString(),
      },
      logs: [
        `SUB-WORKFLOW ROLLBACK: Compensation run ${subRes.childRunId} (${subRes.childWorkflowName}) succeeded`,
      ],
    };
  }

  if (node.type === 'for_each' && compensator === 'for_each_compensate') {
    const mode = String(cfg.mode ?? 'script');
    const prevResults = Array.isArray(orig.results) ? orig.results : [];
    const prevItems = Array.isArray(orig.items) ? orig.items : [];
    const rolledBack: unknown[] = [];
    for (let idx = prevResults.length - 1; idx >= 0; idx--) {
      const item = prevItems[idx];
      const itemNode: WorkflowNode = {
        id: `${node.id}__item_${idx}`,
        type: mode === 'custom_task' ? 'custom_task' : 'http_request',
        label: `${node.label ?? node.id}[${idx}]`,
        position: node.position,
        config: {
          handler: String(cfg.itemHandler ?? 'audit_log'),
          compensationHandler: cfg.itemCompensationHandler,
          ...(cfg.itemConfig && typeof cfg.itemConfig === 'object'
            ? (cfg.itemConfig as Record<string, unknown>)
            : {}),
        },
      };
      const cRes = await compensateWorkflowNode(itemNode, prevResults[idx], {
        ...ctx,
        input: {
          ...ctx.input,
          ...(item && typeof item === 'object' && !Array.isArray(item)
            ? (item as Record<string, unknown>)
            : {}),
          item,
          index: idx,
        },
      });
      rolledBack.push({ index: idx, result: cRes.output });
    }
    return {
      output: {
        compensator: 'for_each_compensate',
        revertedCount: rolledBack.length,
        revertedItems: rolledBack,
        rolledBackAt: new Date().toISOString(),
      },
      logs: [
        `FOR-EACH ROLLBACK: Atomically compensated ${rolledBack.length} batch item(s) in reverse order`,
      ],
    };
  }

  if (node.type === 'database' && compensator === 'database_revert' && ctx.storage) {
    const key = String(orig.key ?? '');
    const op = String(orig.operation ?? 'set');
    if (key) {
      if (op === 'increment') {
        const delta = Number(orig.delta ?? 1);
        const state = await ctx.storage.getTenantState(ctx.tenantId);
        const cur = state.kv.find((r) => r.key === key);
        const curNum = typeof cur?.value === 'number' ? cur.value : Number(cur?.value ?? 0) || 0;
        const revertedNum = curNum - delta;
        if (orig.existed) {
          await ctx.storage.setKv(ctx.tenantId, key, revertedNum);
        } else {
          await ctx.storage.deleteKv(ctx.tenantId, key);
        }
        const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
          runId: ctx.runId,
          nodeId: node.id,
          action: 'database_revert_increment',
          direction: 'compensate',
          resourceType: 'kv',
          resourceId: key,
          status: 'compensated',
          summary: `ROLLBACK: Reverted DB increment on "${key}" by ${-delta}`,
        });
        return {
          output: { compensator, key, revertedDelta: -delta, ledgerId: ledger.id, rolledBackAt: ledger.createdAt },
          logs: [`DB ROLLBACK: Reverted increment on "${key}" (${-delta})`],
        };
      }
      if (orig.existed) {
        await ctx.storage.setKv(ctx.tenantId, key, orig.previousValue);
      } else {
        await ctx.storage.deleteKv(ctx.tenantId, key);
      }
      const ledger = await ctx.storage.appendLedgerEntry(ctx.tenantId, {
        runId: ctx.runId,
        nodeId: node.id,
        action: 'database_revert',
        direction: 'compensate',
        resourceType: 'kv',
        resourceId: key,
        status: 'compensated',
        summary: orig.existed
          ? `ROLLBACK: Restored DB key "${key}" to previous value`
          : `ROLLBACK: Deleted newly inserted DB key "${key}"`,
      });
      return {
        output: { compensator, key, restoredExisted: Boolean(orig.existed), ledgerId: ledger.id, rolledBackAt: ledger.createdAt },
        logs: [`DB ROLLBACK: Reverted "${key}" (${orig.existed ? 'restored previous value' : 'deleted key'})`],
      };
    }
  }

  return {
    output: {
      compensator,
      revertedNodeId: node.id,
      originalOutput,
      rolledBackAt: new Date().toISOString(),
    },
    logs: [`Saga compensator "${compensator}" rolled back "${node.label ?? node.id}"`],
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}
