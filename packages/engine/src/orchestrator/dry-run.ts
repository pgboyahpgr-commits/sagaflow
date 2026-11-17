import {
  validateWorkflowGraph,
  type DryRunStepTrace,
  type DryRunWorkflowResult,
  type WorkflowEdge,
  type WorkflowNode,
} from '@sagaflow/shared';
import { runInQuickJSSandbox } from '../sandbox/quickjs.js';
import { resolveTemplates, type TemplateContext } from './template.js';

function collectTemplateRefs(
  obj: unknown,
  ctx: TemplateContext,
  prefix = ''
): Array<{ key: string; expression: string; value: unknown }> {
  const refs: Array<{ key: string; expression: string; value: unknown }> = [];
  if (typeof obj === 'string') {
    if (obj.includes('{{') && obj.includes('}}')) {
      refs.push({
        key: prefix || 'value',
        expression: obj,
        value: resolveTemplates(obj, ctx),
      });
    }
    return refs;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => refs.push(...collectTemplateRefs(v, ctx, `${prefix}[${i}]`)));
    return refs;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      refs.push(...collectTemplateRefs(v, ctx, prefix ? `${prefix}.${k}` : k));
    }
  }
  return refs;
}

function evalSimpleCondition(expr: string, input: Record<string, unknown>, steps: Record<string, unknown>): boolean {
  const m = expr.match(/^\s*([a-zA-Z0-9_.]+)\s*(>=|<=|===|==|!==|!=|>|<)\s*(.+)\s*$/);
  if (!m) return Boolean(expr.trim());
  const [, pathStr, op, rawRhs] = m;
  const resolvePath = (p: string): unknown => {
    const parts = p.split('.');
    let cur: unknown = parts[0] === 'input' ? input : parts[0] === 'steps' ? steps : { input, steps };
    const startIdx = parts[0] === 'input' || parts[0] === 'steps' ? 1 : 0;
    for (let i = startIdx; i < parts.length; i++) {
      if (cur && typeof cur === 'object') {
        cur = (cur as Record<string, unknown>)[parts[i]];
      } else {
        return undefined;
      }
    }
    return cur;
  };
  const lhs = resolvePath(pathStr);
  const trimmed = rawRhs.trim();
  let rhs: unknown = trimmed;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) rhs = Number(trimmed);
  else if (trimmed === 'true') rhs = true;
  else if (trimmed === 'false') rhs = false;
  else if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    rhs = trimmed.slice(1, -1);
  }
  switch (op) {
    case '>':
      return Number(lhs) > Number(rhs);
    case '>=':
      return Number(lhs) >= Number(rhs);
    case '<':
      return Number(lhs) < Number(rhs);
    case '<=':
      return Number(lhs) <= Number(rhs);
    case '===':
    case '==':
      return lhs == rhs;
    case '!==':
    case '!=':
      return lhs != rhs;
    default:
      return false;
  }
}

/**
 * Safe Zero-Mutation Studio Dry-Run & Step-by-Step Expression Debugger.
 * Evaluates DAG topology, resolves {{input.*}} / {{steps.*}} / masked {{secrets.*}},
 * runs real QuickJS-WASM scripts in isolation, and evaluates condition branches
 * WITHOUT mutating any tenant database table.
 */
export async function dryRunWorkflowGraph(params: {
  workflowId: string;
  workflowName: string;
  tenantId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  input: Record<string, unknown>;
  secretNames: string[];
}): Promise<DryRunWorkflowResult> {
  const totalStart = Date.now();
  const validation = validateWorkflowGraph(params.nodes, params.edges);
  const warnings: string[] = [];

  if (!validation.valid) {
    return {
      workflowId: params.workflowId,
      workflowName: params.workflowName,
      valid: false,
      input: params.input,
      steps: [],
      totalDurationMs: Date.now() - totalStart,
      warnings: validation.issues.map((i) => `[${i.code}] ${i.message}`),
    };
  }

  // Mask every tenant secret so dry-run proves resolution without ever disclosing raw secret values
  const maskedSecrets: Record<string, string> = {};
  for (const name of params.secretNames) {
    maskedSecrets[name] = `[SECRET:${name}:REDACTED]`;
  }

  const nodeMap = new Map(params.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, WorkflowEdge[]>();
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const n of params.nodes) {
    incoming.set(n.id, []);
    outgoing.set(n.id, []);
  }
  for (const e of params.edges) {
    incoming.get(e.to)?.push(e);
    outgoing.get(e.from)?.push(e);
  }

  const stepOutputs: Record<string, unknown> = {};
  const skipped = new Set<string>();
  const halted = new Set<string>();
  const branchDecisions = new Map<string, string>();
  const traces: DryRunStepTrace[] = [];

  let order = 0;
  for (const nodeId of validation.topologicalOrder) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    order++;
    const stepStart = Date.now();

    // Check if all incoming edges are blocked by a skipped/halted parent or untaken condition/switch branch
    const inEdges = incoming.get(nodeId) ?? [];
    if (inEdges.length > 0) {
      const anyActiveEdge = inEdges.some((e) => {
        if (skipped.has(e.from) || halted.has(e.from)) return false;
        const parentBranch = branchDecisions.get(e.from);
        if (parentBranch !== undefined && e.condition && e.condition !== 'always') {
          return e.condition === parentBranch;
        }
        return true;
      });
      if (!anyActiveEdge) {
        skipped.add(nodeId);
        traces.push({
          nodeId: node.id,
          label: node.label ?? node.id,
          type: node.type,
          order,
          status: 'would_skip',
          resolvedConfig: (node.config ?? {}) as Record<string, unknown>,
          resolvedTemplates: [],
          note: 'Skipped because upstream condition/filter/switch selected another path.',
          durationMs: Date.now() - stepStart,
        });
        continue;
      }
    }

    const tplCtx: TemplateContext = {
      input: params.input,
      steps: stepOutputs,
      secrets: maskedSecrets,
      env: { tenantId: params.tenantId, runId: 'dry_run_preview' },
    };

    const rawCfg = (node.config ?? {}) as Record<string, unknown>;
    const resolvedTemplates = collectTemplateRefs(rawCfg, tplCtx);
    const resolvedConfig = resolveTemplates(rawCfg, tplCtx) as Record<string, unknown>;

    let status: DryRunStepTrace['status'] = 'would_execute';
    let previewOutput: unknown = { simulated: true, nodeId: node.id };
    let branchDecision: boolean | string | null = null;
    let note = 'Dry-run validated (zero DB mutations).';

    try {
      switch (node.type) {
        case 'trigger': {
          previewOutput = {
            triggered: true,
            triggerType: String(resolvedConfig.triggerType ?? 'api'),
            input: params.input,
          };
          note = 'Entrypoint trigger binds incoming payload.';
          break;
        }
        case 'script': {
          const code = String(rawCfg.code ?? 'return { ok: true };');
          const sandboxRes = await runInQuickJSSandbox({
            code,
            input: params.input,
            steps: stepOutputs,
            secrets: maskedSecrets,
            timeoutMs: 2000,
            memoryLimitMb: 16,
          });
          if (!sandboxRes.ok) {
            throw new Error(sandboxRes.error ?? 'QuickJS sandbox error');
          }
          previewOutput = sandboxRes.output;
          note = `Executed live inside QuickJS-WASM sandbox (${sandboxRes.logs.length} log line(s)).`;
          break;
        }
        case 'condition': {
          const expr = String(rawCfg.expression ?? 'true');
          const passed = evalSimpleCondition(expr, params.input, stepOutputs);
          branchDecision = passed;
          branchDecisions.set(node.id, passed ? 'true' : 'false');
          previewOutput = { expression: expr, result: passed, branch: passed ? 'true' : 'false' };
          note = `Expression "${expr}" evaluated to ${passed ? 'TRUE' : 'FALSE'}.`;
          break;
        }
        case 'transform': {
          const base: Record<string, unknown> = resolvedConfig.mergeWithInput ? { ...params.input } : {};
          const pickFields = Array.isArray(rawCfg.pick) ? rawCfg.pick.map((f) => String(f)) : [];
          for (const pathStr of pickFields) {
            const val = resolveTemplates(`{{${pathStr}}}`, tplCtx);
            const key = pathStr.split('.').pop() || pathStr;
            base[key] = val;
          }
          if (
            resolvedConfig.mappings &&
            typeof resolvedConfig.mappings === 'object' &&
            !Array.isArray(resolvedConfig.mappings)
          ) {
            Object.assign(base, resolvedConfig.mappings as Record<string, unknown>);
          }
          const omitFields = Array.isArray(rawCfg.omit) ? rawCfg.omit.map((f) => String(f)) : [];
          for (const k of omitFields) delete base[k];
          previewOutput = base;
          note = `Mapped ${Object.keys(base).length} field(s) declaratively (zero code).`;
          break;
        }
        case 'filter': {
          const rawField = String(rawCfg.field ?? '{{input.amount}}').trim();
          const fieldExpr = rawField.includes('{{') ? rawField : `{{${rawField}}}`;
          const actual = resolveTemplates(fieldExpr, tplCtx);
          const operator = String(resolvedConfig.operator ?? 'exists').toLowerCase();
          const expected = resolvedConfig.value;
          const passed = evalDryRunFilter(actual, operator, expected);
          branchDecision = passed;
          if (!passed) {
            const onFail = String(resolvedConfig.onFail ?? 'skip_downstream').toLowerCase();
            if (onFail === 'fail_run') {
              status = 'error';
              warnings.push(`Filter "${node.label}" would fail the run (${rawField} ${operator}).`);
            } else {
              halted.add(node.id);
            }
          }
          previewOutput = { passed, field: rawField, operator, actual, expected: expected ?? null };
          note = passed
            ? `Filter passed (${rawField} ${operator}) — downstream steps will execute.`
            : `Filter blocked (${rawField} ${operator}) — downstream steps will be skipped.`;
          break;
        }
        case 'switch': {
          const rawExpr = String(rawCfg.expression ?? '{{input.tier}}').trim();
          const exprTemplate = rawExpr.includes('{{') ? rawExpr : `{{${rawExpr}}}`;
          const actual = resolveTemplates(exprTemplate, tplCtx);
          const rawCases = Array.isArray(rawCfg.cases)
            ? (rawCfg.cases as Array<{ key?: string; label?: string; operator?: string; value?: unknown }>)
            : [];
          const defaultCase = String(resolvedConfig.defaultCase ?? 'default');
          let matchedKey = defaultCase;
          for (const c of rawCases) {
            const key = String(c.key ?? c.value ?? '').trim();
            if (!key) continue;
            const op = String(c.operator ?? 'eq').toLowerCase();
            const expected = c.value !== undefined ? resolveTemplates(c.value, tplCtx) : key;
            if (evalDryRunFilter(actual, op, expected)) {
              matchedKey = key;
              break;
            }
          }
          branchDecision = matchedKey;
          branchDecisions.set(node.id, matchedKey);
          previewOutput = { expression: rawExpr, value: actual, branch: matchedKey };
          note = `Switch routed "${String(actual ?? '')}" -> branch "${matchedKey}".`;
          break;
        }
        case 'email': {
          const to = String(resolvedConfig.to ?? 'ops@acme.local');
          const subject = String(resolvedConfig.subject ?? 'SagaFlow Notification');
          previewOutput = {
            dryRun: true,
            sent: true,
            to,
            subject,
            provider: String(resolvedConfig.provider ?? 'sink'),
          };
          note = `Will send email to "${to}" ("${subject}") — skipped live send in dry-run.`;
          break;
        }
        case 'slack_discord': {
          const platform = String(resolvedConfig.platform ?? 'slack');
          const channelName = String(resolvedConfig.channelName ?? '#alerts');
          const title = String(resolvedConfig.title ?? 'SagaFlow Notification');
          previewOutput = { dryRun: true, delivered: true, platform, channelName, title };
          note = `Will post ${platform.toUpperCase()} message to ${channelName} ("${title}") — skipped live POST in dry-run.`;
          break;
        }
        case 'database': {
          const operation = String(resolvedConfig.operation ?? 'set');
          const collection = String(resolvedConfig.collection ?? 'records');
          const key = String(resolvedConfig.key ?? 'item_1');
          previewOutput = {
            dryRun: true,
            operation,
            key: `${collection}:${key}`,
            value: resolvedConfig.value ?? null,
          };
          note = `Dry-run validated DB ${operation.toUpperCase()} on "${collection}:${key}" — zero database writes executed.`;
          break;
        }
        case 'approval': {
          status = 'would_pause';
          const role = String(resolvedConfig.approverRole ?? 'admin');
          const slaMs = Number(resolvedConfig.timeoutMs ?? 0);
          previewOutput = {
            approved: true,
            approverRole: role,
            prompt: String(resolvedConfig.prompt ?? 'Approve step?'),
            slaTimeoutMs: slaMs || null,
          };
          note = `Run will park durably (zero worker threads) awaiting ${role} approval${slaMs ? ` (SLA ${Math.round(slaMs / 1000)}s)` : ''}.`;
          break;
        }
        case 'for_each': {
          const rawItems = resolvedConfig.items ?? resolvedConfig.itemsExpression;
          let arr: unknown[] = [];
          if (Array.isArray(rawItems)) arr = rawItems;
          else if (typeof rawItems === 'string') {
            try {
              const parsed = JSON.parse(rawItems);
              if (Array.isArray(parsed)) arr = parsed;
            } catch {
              arr = [];
            }
          }
          const maxConcurrency = Math.min(20, Math.max(1, Number(resolvedConfig.maxConcurrency ?? 4)));
          previewOutput = {
            itemCount: arr.length,
            maxConcurrency,
            mode: String(resolvedConfig.mode ?? 'script'),
            sampleItems: arr.slice(0, 3),
          };
          note =
            arr.length > 0
              ? `Will fan out over ${arr.length} item(s) with maxConcurrency=${maxConcurrency}.`
              : 'Items expression resolved to an empty array (0 iterations).';
          if (arr.length === 0) {
            warnings.push(`Step "${node.label}" (${node.id}) resolved 0 items for for_each fan-out.`);
          }
          break;
        }
        case 'sub_workflow': {
          const targetId = String(resolvedConfig.workflowId ?? '');
          previewOutput = {
            childRunId: 'run_dry_preview_child',
            childWorkflowId: targetId,
            childStatus: 'succeeded',
            output: {},
          };
          note = targetId
            ? `Will launch isolated child Saga "${targetId}" with resolved input.`
            : 'Missing target workflowId in sub_workflow config.';
          if (!targetId) {
            status = 'error';
            warnings.push(`Sub-workflow step "${node.label}" is missing target workflowId.`);
          }
          break;
        }
        case 'http_request': {
          const method = String(resolvedConfig.method ?? 'POST').toUpperCase();
          const url = String(resolvedConfig.url ?? '');
          previewOutput = { status: 200, dryRun: true, method, url };
          note = `Will send ${method} ${url || '(no URL configured)'} (skipped live network call in dry-run).`;
          break;
        }
        case 'ai_agent': {
          previewOutput = {
            provider: String(resolvedConfig.provider ?? 'default'),
            riskLevel: 'low',
            decision: 'approve',
            dryRun: true,
          };
          note = 'Will invoke configured LM Studio / Gemini model with resolved prompt.';
          break;
        }
        case 'wait': {
          const ms = Number(resolvedConfig.ms ?? resolvedConfig.durationMs ?? 100);
          previewOutput = { waitedMs: ms };
          note = `Will wait ${ms}ms before continuing.`;
          break;
        }
        case 'custom_task': {
          const handler = String(resolvedConfig.handler ?? 'audit_log');
          const comp = resolvedConfig.compensationHandler
            ? String(resolvedConfig.compensationHandler)
            : null;
          previewOutput = {
            handler,
            dryRun: true,
            sku: resolvedConfig.sku ?? params.input.sku,
            qty: resolvedConfig.qty ?? params.input.qty,
            amount: resolvedConfig.amount ?? params.input.amount,
          };
          note = `Dry-run validated DB handler "${handler}"${comp ? ` (Saga compensator: ${comp})` : ''} — no database writes executed.`;
          break;
        }
      }
    } catch (err) {
      status = 'error';
      const msg = err instanceof Error ? err.message : String(err);
      note = `Dry-run error: ${msg}`;
      warnings.push(`Step "${node.label}" (${node.id}): ${msg}`);
    }

    stepOutputs[node.id] = previewOutput;
    traces.push({
      nodeId: node.id,
      label: node.label ?? node.id,
      type: node.type,
      order,
      status,
      resolvedConfig,
      resolvedTemplates,
      previewOutput,
      branchDecision,
      note,
      durationMs: Date.now() - stepStart,
    });
  }

  return {
    workflowId: params.workflowId,
    workflowName: params.workflowName,
    valid: true,
    input: params.input,
    steps: traces,
    totalDurationMs: Date.now() - totalStart,
    warnings,
  };
}

function evalDryRunFilter(actual: unknown, operator: string, expected: unknown): boolean {
  switch (operator) {
    case 'exists':
      return actual !== undefined && actual !== null && actual !== '';
    case 'empty':
      return actual === undefined || actual === null || actual === '';
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
      return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'not_contains':
      return !String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
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
