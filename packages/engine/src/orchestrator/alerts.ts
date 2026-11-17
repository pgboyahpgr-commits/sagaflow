import { createHmac } from 'node:crypto';
import type { AlertEventType, AlertRule } from '@sagaflow/shared';
import type { StorageAdapter } from '../storage/interface.js';

export interface AlertDispatchPayload {
  event: AlertEventType;
  tenantId: string;
  timestamp: string;
  summary: string;
  data: Record<string, unknown>;
}

export interface AlertDeliveryOutcome {
  ruleId: string;
  ruleName: string;
  delivered: boolean;
  statusCode: number | null;
  error: string | null;
  signatureHeader?: string;
}

function buildSignature(secret: string, bodyStr: string): string {
  return `sha256=${createHmac('sha256', secret).update(bodyStr).digest('hex')}`;
}

/**
 * Delivers a single alert payload to either:
 * 1) In-process tenant webhook sink (`/api/sink/:slug/:channel`) — zero-mock real DB persistence, OR
 * 2) Live outbound HTTP/HTTPS endpoint (Slack, Discord, PagerDuty, custom receiver) with optional HMAC-SHA256 signing.
 */
export async function deliverAlertToRule(
  storage: StorageAdapter,
  rule: AlertRule,
  payload: AlertDispatchPayload
): Promise<AlertDeliveryOutcome> {
  const bodyStr = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'SagaFlow-AlertEngine/6.0',
    'X-SagaFlow-Event': payload.event,
    'X-SagaFlow-Tenant-Id': payload.tenantId,
    'X-SagaFlow-Alert-Rule-Id': rule.id,
  };
  if (rule.signingSecret && rule.signingSecret.trim().length > 0) {
    headers['X-SagaFlow-Signature'] = buildSignature(rule.signingSecret.trim(), bodyStr);
  }

  // Support local/in-process sink paths (`/api/sink/:slug/:channel`) directly so alerts work 100% offline & in serverless
  const sinkMatch = rule.webhookUrl.match(/(?:https?:\/\/[^/]+)?\/api\/sink\/([^/]+)\/([^/?#]+)/i);
  if (sinkMatch) {
    try {
      const slug = decodeURIComponent(sinkMatch[1]);
      const channel = decodeURIComponent(sinkMatch[2]);
      const tenant = await storage.getTenantBySlug(slug);
      const targetTenantId = tenant?.id ?? rule.tenantId;
      await storage.recordSinkDelivery(targetTenantId, {
        channel,
        method: 'POST',
        path: `/api/sink/${slug}/${channel}`,
        headers,
        body: payload,
        statusCode: 200,
      });
      await storage.recordAlertDelivery(rule.tenantId, rule.id, { statusCode: 200, error: null });
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        delivered: true,
        statusCode: 200,
        error: null,
        signatureHeader: headers['X-SagaFlow-Signature'],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await storage.recordAlertDelivery(rule.tenantId, rule.id, { statusCode: 500, error: msg });
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        delivered: false,
        statusCode: 500,
        error: msg,
      };
    }
  }

  // Real outbound HTTP/HTTPS webhook delivery
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(rule.webhookUrl, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    const ok = res.status >= 200 && res.status < 300;
    const errMsg = ok ? null : `HTTP ${res.status} ${res.statusText}`;
    await storage.recordAlertDelivery(rule.tenantId, rule.id, {
      statusCode: res.status,
      error: errMsg,
    });
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      delivered: ok,
      statusCode: res.status,
      error: errMsg,
      signatureHeader: headers['X-SagaFlow-Signature'],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await storage.recordAlertDelivery(rule.tenantId, rule.id, { statusCode: null, error: msg });
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      delivered: false,
      statusCode: null,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispatches an operational event to all enabled tenant Alert Rules subscribed to `event`.
 * Never throws so alert network failures can never crash core Saga execution.
 */
export async function dispatchTenantAlerts(
  storage: StorageAdapter,
  tenantId: string,
  event: AlertEventType,
  summary: string,
  data: Record<string, unknown>
): Promise<AlertDeliveryOutcome[]> {
  try {
    const rules = await storage.listAlertRules(tenantId);
    const matching = rules.filter((r) => r.enabled && r.eventTypes.includes(event));
    if (matching.length === 0) return [];
    const payload: AlertDispatchPayload = {
      event,
      tenantId,
      timestamp: new Date().toISOString(),
      summary,
      data,
    };
    return await Promise.all(matching.map((r) => deliverAlertToRule(storage, r, payload)));
  } catch {
    return [];
  }
}
