import {
  WorkflowDefinitionSchema,
  getNextCronDate,
  validateCronExpression,
  validateWorkflowGraph,
  type AiAgentChatRequest,
  type AiAgentChatResponse,
  type AiAgentToolExecution,
  type WorkflowEdge,
  type WorkflowNode,
} from '@sagaflow/shared';
import type { StorageAdapter } from '../storage/interface.js';
import type { SecretCipher } from '../utils/crypto.js';
import type { SagaOrchestrator } from '../orchestrator/saga-engine.js';
import { makeId } from '../utils/id.js';
import { callLlmProvider, resolveAiCredentials } from './provider.js';

interface ParsedAgentEnvelope {
  reply: string;
  actions?: Array<{
    tool: string;
    args?: Record<string, unknown>;
  }>;
}

/** Auto-layout DAG nodes cleanly left-to-right if the LLM omitted positions */
function ensureNodePositions(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const needsLayout = nodes.some((n) => !n.position || (n.position.x === 0 && n.position.y === 0));
  if (!needsLayout) return nodes;

  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    inDeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (adj.has(e.from) && inDeg.has(e.to)) {
      adj.get(e.from)!.push(e.to);
      inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    }
  }
  const layer = new Map<string, number>();
  const queue = nodes.filter((n) => (inDeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  for (const id of queue) layer.set(id, 0);
  while (queue.length > 0) {
    const u = queue.shift()!;
    const uLayer = layer.get(u) ?? 0;
    for (const v of adj.get(u) ?? []) {
      layer.set(v, Math.max(layer.get(v) ?? 0, uLayer + 1));
      const d = (inDeg.get(v) ?? 1) - 1;
      inDeg.set(v, d);
      if (d <= 0) queue.push(v);
    }
  }
  const cols = new Map<number, WorkflowNode[]>();
  for (const n of nodes) {
    const col = layer.get(n.id) ?? 0;
    if (!cols.has(col)) cols.set(col, []);
    cols.get(col)!.push(n);
  }
  return nodes.map((n) => {
    const col = layer.get(n.id) ?? 0;
    const list = cols.get(col) ?? [n];
    const row = list.indexOf(n);
    const startY = 175 - ((list.length - 1) * 155) / 2;
    return {
      ...n,
      position: { x: 60 + col * 300, y: Math.max(40, Math.round(startY + row * 155)) },
    };
  });
}

function extractJsonEnvelope(rawText: string): ParsedAgentEnvelope {
  const trimmed = rawText.trim();
  const candidates: string[] = [trimmed];

  // Extract fenced ```json ... ``` blocks
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) candidates.unshift(fenceMatch[1].trim());

  // Extract outermost { ... }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as Partial<ParsedAgentEnvelope>;
      if (parsed && typeof parsed === 'object' && (typeof parsed.reply === 'string' || Array.isArray(parsed.actions))) {
        return {
          reply: typeof parsed.reply === 'string' ? parsed.reply : 'Executed requested automation actions.',
          actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        };
      }
    } catch {
      // try next candidate
    }
  }

  return { reply: trimmed, actions: [] };
}

export async function runAiAutomationAgent(opts: {
  storage: StorageAdapter;
  cipher: SecretCipher;
  orchestrator: SagaOrchestrator;
  tenantId: string;
  tenantSlug: string;
  userId: string;
  request: AiAgentChatRequest;
}): Promise<AiAgentChatResponse> {
  const { storage, cipher, orchestrator, tenantId, tenantSlug, userId, request } = opts;
  const creds = await resolveAiCredentials(storage, cipher, tenantId);
  const provider = request.providerOverride ?? creds.config.provider;

  // Gather REAL live tenant context for grounded automation
  const [workflows, runsPage, approvals, dlqEntries, tenantState, schedules] = await Promise.all([
    storage.listWorkflows(tenantId),
    storage.listRuns(tenantId, { limit: 8 }),
    storage.listApprovals(tenantId),
    storage.listDlqEntries(tenantId),
    storage.getTenantState(tenantId),
    storage.listSchedules(tenantId),
  ]);

  const liveSnapshot = {
    tenantId,
    tenantSlug,
    workflows: workflows.map((w) => ({
      id: w.id,
      name: w.name,
      status: w.status,
      latestVersion: w.latestVersion,
      nodeCount: w.nodeCount,
    })),
    recentRuns: runsPage.runs.map((r) => ({
      id: r.id,
      workflowId: r.workflowId,
      workflowName: r.workflowName,
      status: r.status,
      durationMs: r.durationMs,
    })),
    pendingApprovals: approvals
      .filter((a) => a.status === 'pending')
      .map((a) => ({
        id: a.id,
        runId: a.runId,
        workflowName: a.workflowName,
        stepLabel: a.stepLabel,
        approverRole: a.approverRole,
        prompt: a.prompt,
      })),
    openDlq: dlqEntries.slice(0, 5).map((d) => ({
      id: d.id,
      runId: d.runId,
      workflowName: d.workflowName,
      failedStepLabel: d.failedStepLabel,
      error: d.error.message,
    })),
    inventory: tenantState.inventory.map((i) => ({
      sku: i.sku,
      name: i.name,
      available: i.available,
      reserved: i.reserved,
    })),
    balances: tenantState.balances.map((b) => ({
      accountId: b.accountId,
      currency: b.currency,
      available: b.available,
      locked: b.locked,
    })),
    schedules: schedules.map((s) => ({
      id: s.id,
      name: s.name,
      workflowId: s.workflowId,
      cron: s.cron,
      enabled: s.enabled,
    })),
  };

  const systemPrompt = `You are SagaFlow AI Automation Agent — an autonomous engineering copilot inside a live Multi-Tenant Distributed Workflow & Saga Orchestration Engine.

LIVE TENANT STATE (REAL DATABASE SNAPSHOT):
${JSON.stringify(liveSnapshot)}

RESPONSE PROTOCOL:
Always respond with a single valid JSON object (no markdown outside the JSON):
{
  "reply": "Clear, concise summary of what you analyzed, built, or executed.",
  "actions": [
    { "tool": "<tool_name>", "args": { ... } }
  ]
}
If the user is only asking a question or wants analysis, set "actions": [].

AVAILABLE REAL TOOLS (executed directly against this tenant's database & Saga engine):
1. "create_workflow" — Build & optionally publish a valid DAG workflow.
   args: {
     "name": string,
     "description": string,
     "publish": boolean (default true),
     "nodes": [{
       "id": "trigger" | "<slug>",
       "type": "trigger" | "transform" | "filter" | "condition" | "switch" | "for_each" | "wait" | "http_request" | "email" | "slack_discord" | "database" | "script" | "custom_task" | "approval" | "sub_workflow" | "ai_agent",
       "label": string,
       "config": object
     }],
     "edges": [{ "id": "e1", "from": "<nodeId>", "to": "<nodeId>", "condition": "always"|"true"|"false"|"<switchCaseKey>", "label"?: string }]
   }
   Real custom_task handlers (zero-mock): "reserve_inventory" (compensator "release_inventory"), "charge_payment" (compensator "refund_payment"), "allocate_credits" (compensator "revert_credits"), "create_shipment" (compensator "cancel_shipment"), "kv_set", "audit_log".
   For "transform": config { "mappings": { "field": "{{input.x}}" }, "mergeWithInput": true }.
   For "filter": config { "field": "{{input.email}}", "operator": "contains"|"eq"|"gt"|"exists", "value": "@", "onFail": "skip_downstream"|"fail_run" }.
   For "switch": config { "expression": "{{input.priority}}", "cases": [{ "key": "urgent", "operator": "eq", "value": "urgent" }], "defaultCase": "default" }.
   For "email": config { "to": "{{input.email}}", "subject": "...", "body": "...", "provider": "sink"|"resend"|"webhook" }.
   For "slack_discord": config { "platform": "slack"|"discord"|"teams", "channelName": "#alerts", "title": "...", "message": "...", "severity": "info"|"success"|"warning"|"critical" }.
   For "database": config { "operation": "set"|"get"|"increment"|"delete"|"list", "collection": "leads", "key": "{{input.id}}", "value": { ... } } (auto-rolls back on Saga failure!).
   Real live HTTP sink URL for notifications: "/api/sink/${tenantSlug}/<channel-name>" (method "POST").
   For "approval" nodes: config { "approverRole": "Operations Lead", "prompt": "Approve {{input.orderId}}?", "slaMinutes": 30, "onTimeout": "reject"|"approve"|"escalate" }.
   For "script" nodes: config { "code": "return { ...input, ok: true };" }.
   For "condition" nodes: config { "expression": "(input.amount ?? 0) >= 500" } with outgoing edges condition="true" and condition="false".
   For "ai_agent" nodes: config { "systemPrompt": "...", "prompt": "Analyze {{input.orderId}}", "expectJson": true }.
2. "run_workflow" — Launch a real idempotent Saga run on a published workflow (or "$LAST_CREATED" right after create_workflow).
   args: { "workflowId": string, "input": object }
3. "decide_approval" — Approve (resume) or reject (atomic DB rollback) a pending Human Approval Gate.
   args: { "approvalId": string, "decision": "approved" | "rejected", "comment"?: string }
4. "create_schedule" — Create a durable 5-field UTC cron schedule (e.g. "0 * * * *").
   args: { "workflowId": string, "name": string, "cron": string, "input"?: object, "enabled"?: boolean }
5. "adjust_inventory" — Restock or adjust a SKU in tenant_inventory.
   args: { "sku": string, "deltaAvailable": number, "name"?: string }
6. "adjust_balance" — Top up or adjust an account in tenant_balances.
   args: { "accountId": string, "deltaAvailable": number, "currency"?: string }
7. "replay_dlq" — Replay a captured DLQ failure.
   args: { "dlqId": string }

Keep workflow graphs strictly acyclic (DAG), concise (3–6 steps), and immediately runnable.`;

  const completion = await callLlmProvider({
    provider,
    googleApiKey: creds.googleApiKey,
    googleModel: request.modelOverride || creds.config.googleModel,
    googleBaseUrl: creds.config.googleBaseUrl,
    lmStudioBaseUrl: creds.config.lmStudioBaseUrl,
    lmStudioModel: request.modelOverride || creds.config.lmStudioModel,
    lmStudioApiKey: creds.lmStudioApiKey,
    messages: [
      { role: 'system', content: systemPrompt },
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    temperature: creds.config.temperature,
    maxTokens: creds.config.maxTokens,
    expectJson: provider === 'google_ai_studio',
  });

  const envelope = extractJsonEnvelope(completion.text);
  const executedActions: AiAgentToolExecution[] = [];
  let lastCreatedWorkflowId: string | null = null;

  for (const act of envelope.actions ?? []) {
    const tool = String(act.tool ?? '').trim();
    const args = (act.args && typeof act.args === 'object' ? act.args : {}) as Record<string, unknown>;
    if (!tool) continue;

    if (!request.autoExecute) {
      executedActions.push({
        tool,
        summary: `Proposed ${tool}(${JSON.stringify(args).slice(0, 120)})`,
        status: 'proposed',
        data: args,
      });
      continue;
    }

    try {
      if (tool === 'create_workflow') {
        const rawNodes = Array.isArray(args.nodes) ? (args.nodes as WorkflowNode[]) : [];
        const rawEdges = Array.isArray(args.edges) ? (args.edges as WorkflowEdge[]) : [];
        const laidOutNodes = ensureNodePositions(rawNodes, rawEdges);
        const parsedDef = WorkflowDefinitionSchema.safeParse({
          name: String(args.name ?? 'AI Generated Workflow').slice(0, 160),
          description: typeof args.description === 'string' ? args.description : undefined,
          nodes: laidOutNodes,
          edges: rawEdges,
        });
        if (!parsedDef.success) {
          throw new Error(
            `Generated workflow failed schema validation: ${parsedDef.error.issues[0]?.message ?? 'invalid shape'}`
          );
        }
        const validation = validateWorkflowGraph(parsedDef.data.nodes, parsedDef.data.edges);
        if (!validation.valid) {
          throw new Error(
            `Generated DAG invalid: ${validation.issues.map((e) => e.message).join('; ')}`
          );
        }
        const created = await storage.createWorkflow(tenantId, parsedDef.data);
        lastCreatedWorkflowId = created.id;
        let versionNum: number | null = null;
        if (args.publish !== false) {
          const pub = await storage.publishWorkflow(tenantId, created.id);
          versionNum = pub?.version.versionNumber ?? null;
        }
        executedActions.push({
          tool,
          summary: `Created ${versionNum ? `& published v${versionNum} of ` : ''}"${created.name}" (${created.nodes.length} steps)`,
          status: 'succeeded',
          workflowId: created.id,
          data: {
            workflowId: created.id,
            name: created.name,
            version: versionNum,
            nodes: created.nodes.map((n) => ({
              id: n.id,
              type: n.type,
              label: n.label,
              compensationHandler:
                typeof n.config?.compensationHandler === 'string'
                  ? n.config.compensationHandler
                  : undefined,
            })),
          },
        });
      } else if (tool === 'run_workflow') {
        let workflowId = String(args.workflowId ?? '').trim();
        if (workflowId === '$LAST_CREATED' && lastCreatedWorkflowId) {
          workflowId = lastCreatedWorkflowId;
        }
        if (!workflowId) throw new Error('workflowId is required');
        const wf = await storage.getWorkflow(tenantId, workflowId);
        if (!wf) throw new Error(`Workflow ${workflowId} not found`);
        if (wf.latestVersion === null) throw new Error(`Workflow "${wf.name}" is not published yet`);
        const input = (args.input && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>;
        const idempKey = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const { run } = await storage.createRunIdempotent(tenantId, {
          id: makeId('run'),
          workflowId: wf.id,
          workflowName: wf.name,
          versionNumber: wf.latestVersion,
          idempotencyKey: idempKey,
          input,
        });
        await orchestrator.enqueueRun(tenantId, run.id);
        executedActions.push({
          tool,
          summary: `Started Saga run ${run.id} on "${wf.name}"`,
          status: 'succeeded',
          workflowId: wf.id,
          runId: run.id,
          data: { runId: run.id, status: run.status },
        });
      } else if (tool === 'decide_approval') {
        const approvalId = String(args.approvalId ?? '').trim();
        const decision = args.decision === 'rejected' ? 'rejected' : 'approved';
        const comment = typeof args.comment === 'string' ? args.comment : 'Decided via SagaFlow AI Agent';
        const decided = await orchestrator.decideApproval(tenantId, approvalId, {
          decision,
          decidedBy: `ai-agent (${userId})`,
          comment,
        });
        if (!decided) throw new Error(`Approval ${approvalId} not found or already decided`);
        executedActions.push({
          tool,
          summary: `${decision === 'approved' ? 'Approved & resumed' : 'Rejected & rolled back'} approval ${approvalId}`,
          status: 'succeeded',
          approvalId,
          runId: decided.runId,
          data: { approvalId, decision, runId: decided.runId },
        });
      } else if (tool === 'create_schedule') {
        let workflowId = String(args.workflowId ?? '').trim();
        if (workflowId === '$LAST_CREATED' && lastCreatedWorkflowId) {
          workflowId = lastCreatedWorkflowId;
        }
        const cron = String(args.cron ?? '0 * * * *').trim();
        const check = validateCronExpression(cron);
        if (!check.valid) throw new Error(`Invalid cron expression "${cron}": ${check.error}`);
        const wf = await storage.getWorkflow(tenantId, workflowId);
        if (!wf) throw new Error(`Workflow ${workflowId} not found`);
        const schedule = await storage.createSchedule(tenantId, {
          workflowId,
          workflowName: wf.name,
          name: String(args.name ?? `AI Schedule (${cron})`),
          cron,
          input: (args.input && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>,
          enabled: args.enabled !== false,
          nextRunAt: getNextCronDate(cron, new Date())?.toISOString() ?? null,
        });
        executedActions.push({
          tool,
          summary: `Created UTC cron schedule "${schedule.name}" (${schedule.cron})`,
          status: 'succeeded',
          workflowId,
          scheduleId: schedule.id,
          data: { scheduleId: schedule.id, cron: schedule.cron },
        });
      } else if (tool === 'adjust_inventory') {
        const sku = String(args.sku ?? 'SKU-PRO-900');
        const delta = Number(args.deltaAvailable ?? 0);
        const { item: updated } = await storage.mutateInventory(tenantId, {
          sku,
          name: typeof args.name === 'string' ? args.name : undefined,
          deltaAvailable: delta,
        });
        executedActions.push({
          tool,
          summary: `Updated inventory ${updated.sku}: ${delta >= 0 ? '+' : ''}${delta} → ${updated.available} available`,
          status: 'succeeded',
          data: updated,
        });
      } else if (tool === 'adjust_balance') {
        const accountId = String(args.accountId ?? 'customer_wallet');
        const delta = Number(args.deltaAvailable ?? 0);
        const { balance: updated } = await storage.mutateBalance(tenantId, {
          accountId,
          currency: typeof args.currency === 'string' ? args.currency : undefined,
          deltaAvailable: delta,
        });
        executedActions.push({
          tool,
          summary: `Updated account ${updated.accountId}: ${delta >= 0 ? '+' : ''}${delta} → ${updated.available} ${updated.currency}`,
          status: 'succeeded',
          data: updated,
        });
      } else if (tool === 'replay_dlq') {
        const dlqId = String(args.dlqId ?? '').trim();
        const dlq = await storage.getDlqEntry(tenantId, dlqId);
        if (!dlq) throw new Error(`DLQ entry ${dlqId} not found`);
        const { run } = await storage.createRunIdempotent(tenantId, {
          id: makeId('run'),
          workflowId: dlq.workflowId,
          workflowName: dlq.workflowName,
          versionNumber: dlq.versionNumber,
          idempotencyKey: `ai_replay_${dlqId}_${Date.now()}`,
          input: dlq.input,
        });
        await orchestrator.enqueueRun(tenantId, run.id);
        await storage.markDlqReplayed(tenantId, dlqId, run.id);
        executedActions.push({
          tool,
          summary: `Replayed DLQ ${dlqId} → new run ${run.id}`,
          status: 'succeeded',
          workflowId: dlq.workflowId,
          runId: run.id,
          data: { dlqId, runId: run.id },
        });
      } else {
        executedActions.push({
          tool,
          summary: `Ignored unknown tool "${tool}"`,
          status: 'failed',
          error: `Unsupported tool "${tool}"`,
        });
      }
    } catch (err) {
      executedActions.push({
        tool,
        summary: `Failed executing ${tool}`,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    reply: envelope.reply,
    provider: completion.provider,
    model: completion.model,
    latencyMs: completion.latencyMs,
    usage: completion.usage,
    actions: executedActions,
  };
}
