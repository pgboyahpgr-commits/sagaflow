import {
  RetryPolicySchema,
  isTerminalRunStatus,
  validateWorkflowGraph,
  type ApprovalRequest,
  type DlqEntry,
  type RetryPolicy,
  type RunDetail,
  type RunStep,
  type StepAttempt,
  type WorkflowEdge,
  type WorkflowNode,
} from '@sagaflow/shared';
import type { RunEventBus } from '../queue/event-bus.js';
import type { QueueAdapter, RunJob } from '../queue/queue.js';
import type { StorageAdapter } from '../storage/interface.js';
import type { SecretCipher } from '../utils/crypto.js';
import { makeId, nowIso } from '../utils/id.js';
import { dispatchTenantAlerts } from './alerts.js';
import {
  StepCancelledError,
  compensateWorkflowNode,
  executeWorkflowNode,
  getCompensatorName,
  sleepWithAbort,
  type SubWorkflowInvocationResult,
} from './handlers.js';
import { redactSecrets, resolveTemplates } from './template.js';

export class SagaOrchestrator {
  private readonly storage: StorageAdapter;
  private readonly queue: QueueAdapter;
  private readonly eventBus: RunEventBus;
  private readonly cipher?: SecretCipher;
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(
    storage: StorageAdapter,
    queue: QueueAdapter,
    eventBus: RunEventBus,
    cipher?: SecretCipher
  ) {
    this.storage = storage;
    this.queue = queue;
    this.eventBus = eventBus;
    this.cipher = cipher;
  }

  async start(): Promise<void> {
    await this.queue.start(async (job) => {
      await this.executeJob(job);
    });
  }

  async stop(): Promise<void> {
    for (const ctrl of this.activeControllers.values()) {
      ctrl.abort();
    }
    await this.queue.stop();
  }

  private runKey(tenantId: string, runId: string): string {
    return `${tenantId}::${runId}`;
  }

  async enqueueRun(tenantId: string, runId: string): Promise<void> {
    await this.eventBus.emit(tenantId, runId, 'run.queued', { status: 'pending' });
    await this.queue.enqueue({ tenantId, runId });
  }

  /**
   * Decides a pending Human-in-the-Loop approval gate and durably resumes the paused Saga run.
   * Approving resumes downstream steps; rejecting triggers full reverse-order Saga compensation!
   */
  async decideApproval(
    tenantId: string,
    approvalId: string,
    input: { decision: 'approved' | 'rejected'; decidedBy: string; comment?: string }
  ): Promise<ApprovalRequest | null> {
    const decided = await this.storage.decideApproval(tenantId, approvalId, {
      status: input.decision,
      decidedBy: input.decidedBy,
      comment: input.comment,
    });
    if (!decided) return null;

    await this.storage.appendLedgerEntry(tenantId, {
      runId: decided.runId,
      nodeId: decided.nodeId,
      action: `approval_${input.decision}`,
      direction: 'execute',
      resourceType: 'audit',
      resourceId: decided.id,
      status: input.decision === 'approved' ? 'committed' : 'failed',
      summary: `Human approval "${decided.stepLabel}" ${input.decision.toUpperCase()} by ${input.decidedBy}${input.comment ? `: ${input.comment}` : ''}`,
      afterState: { decision: input.decision, decidedBy: input.decidedBy, comment: input.comment ?? null },
    });

    await this.eventBus.emit(
      tenantId,
      decided.runId,
      'approval.decided',
      {
        approvalId: decided.id,
        decision: input.decision,
        decidedBy: input.decidedBy,
        comment: input.comment ?? null,
      },
      decided.nodeId
    );

    const run = await this.storage.getRun(tenantId, decided.runId);
    if (run && !isTerminalRunStatus(run.status)) {
      run.status = 'running';
      await this.storage.saveRun(tenantId, run);
      await this.queue.enqueue({ tenantId, runId: decided.runId });
    }
    return decided;
  }

  async decideApprovalByToken(
    token: string,
    input: { decision: 'approved' | 'rejected'; decidedBy: string; comment?: string }
  ): Promise<{ approval: ApprovalRequest | null; found: boolean }> {
    const existing = await this.storage.getApprovalByToken(token);
    if (!existing) return { approval: null, found: false };
    const decided = await this.decideApproval(existing.tenantId, existing.id, input);
    return { approval: decided, found: true };
  }

  async requestCancel(tenantId: string, runId: string): Promise<RunDetail | null> {
    const existing = await this.storage.getRun(tenantId, runId);
    if (!existing) return null;
    if (isTerminalRunStatus(existing.status)) {
      return existing;
    }

    const updated = await this.storage.requestCancelRun(tenantId, runId);
    await this.eventBus.emit(tenantId, runId, 'run.cancel_requested', {
      cancelRequested: true,
      status: updated?.status ?? existing.status,
    });

    // Wake up any sleeping wait/retry timers in the running worker
    const ctrl = this.activeControllers.get(this.runKey(tenantId, runId));
    if (ctrl) {
      ctrl.abort();
    }
    return updated;
  }

  /**
   * Time-Travel Replay (Resume from Failed/Selected Step):
   * Forks an immutable new Run from an existing Run at `targetNodeId`, preserving all
   * already-succeeded upstream step outputs (zero duplicate upstream execution) and optionally
   * patching `inputOverrides` / `stepOutputOverrides` before re-executing from `targetNodeId` onward.
   */
  async resumeRunFromStep(
    tenantId: string,
    originalRunId: string,
    targetNodeId: string,
    options?: {
      inputOverrides?: Record<string, unknown>;
      stepOutputOverrides?: Record<string, unknown>;
      idempotencyKey?: string;
    }
  ): Promise<{ run: RunDetail; reusedSteps: string[]; resetSteps: string[] }> {
    const origRun = await this.storage.getRun(tenantId, originalRunId);
    if (!origRun) {
      throw new Error(`Original run "${originalRunId}" not found.`);
    }
    const version = await this.storage.getWorkflowVersion(
      tenantId,
      origRun.workflowId,
      origRun.versionNumber
    );
    if (!version) {
      throw new Error(`Workflow version v${origRun.versionNumber} not found.`);
    }
    const nodeIds = new Set(version.nodes.map((n) => n.id));
    if (!nodeIds.has(targetNodeId)) {
      throw new Error(`Node "${targetNodeId}" does not exist in workflow v${version.versionNumber}.`);
    }

    // BFS from targetNodeId along outgoing edges to identify target + all downstream steps to re-run
    const outgoing = new Map<string, string[]>();
    for (const n of version.nodes) outgoing.set(n.id, []);
    for (const e of version.edges) outgoing.get(e.from)?.push(e.to);

    const toReset = new Set<string>();
    const queue = [targetNodeId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (toReset.has(cur)) continue;
      toReset.add(cur);
      for (const nxt of outgoing.get(cur) ?? []) {
        if (!toReset.has(nxt)) queue.push(nxt);
      }
    }

    const mergedInput: Record<string, unknown> = {
      ...origRun.input,
      ...(options?.inputOverrides ?? {}),
      _forkedFromRunId: origRun.id,
      _resumedFromNodeId: targetNodeId,
    };

    const idempotencyKey =
      options?.idempotencyKey?.trim() ||
      `resume:${origRun.id}:${targetNodeId}:${Date.now()}`;

    const { run: forkedRun, created } = await this.storage.createRunIdempotent(tenantId, {
      id: makeId('run'),
      workflowId: origRun.workflowId,
      workflowName: origRun.workflowName ?? version.name,
      versionNumber: origRun.versionNumber,
      idempotencyKey,
      input: mergedInput,
    });

    const origStepById = new Map(origRun.steps.map((s) => [s.nodeId, s]));
    const validation = validateWorkflowGraph(version.nodes, version.edges);
    const nodeMap = new Map(version.nodes.map((n) => [n.id, n]));
    const reusedSteps: string[] = [];
    const resetSteps: string[] = [];

    if (created) {
      const overrides = options?.stepOutputOverrides ?? {};
      const now = nowIso();
      forkedRun.steps = validation.topologicalOrder.map((nid) => {
        const node = nodeMap.get(nid)!;
        const origStep = origStepById.get(nid);
        if (!toReset.has(nid) && origStep && origStep.status === 'succeeded') {
          reusedSteps.push(nid);
          const effectiveOutput = nid in overrides ? overrides[nid] : origStep.output;
          return {
            nodeId: nid,
            label: node.label ?? nid,
            kind: node.type,
            status: 'succeeded',
            output: effectiveOutput,
            attempts: [
              {
                attempt: 1,
                kind: 'execute',
                status: 'succeeded',
                startedAt: now,
                finishedAt: now,
                durationMs: 0,
                output: effectiveOutput,
                logs: [
                  `TIME-TRAVEL CHECKPOINT: Reused succeeded output from run ${origRun.id}${
                    nid in overrides ? ' (patched via stepOutputOverrides)' : ''
                  }`,
                ],
                error: null,
              },
            ],
          };
        }
        resetSteps.push(nid);
        return {
          nodeId: nid,
          label: node.label ?? nid,
          kind: node.type,
          status: 'pending',
          attempts: [],
        };
      });

      await this.storage.saveRun(tenantId, forkedRun);
      await this.eventBus.emit(tenantId, forkedRun.id, 'run.queued', {
        status: 'pending',
        forkedFromRunId: origRun.id,
        resumedFromNodeId: targetNodeId,
        reusedSteps,
      });
      await this.enqueueRun(tenantId, forkedRun.id);
    }

    return { run: forkedRun, reusedSteps, resetSteps };
  }

  private parseRetryPolicy(node: WorkflowNode): RetryPolicy {
    const raw = (node.config as Record<string, unknown> | undefined)?.retryPolicy;
    const parsed = RetryPolicySchema.safeParse(raw ?? {});
    if (parsed.success) return parsed.data;
    // Defaults: triggers/conditions/waits don't need multi-retry unless configured
    if (node.type === 'trigger' || node.type === 'condition' || node.type === 'wait') {
      return { maxAttempts: 1, initialDelayMs: 100, backoffMultiplier: 1 };
    }
    return { maxAttempts: 3, initialDelayMs: 250, backoffMultiplier: 2 };
  }

  /**
   * Launches a real nested child Saga inside the same isolated tenant DB,
   * enforces max nesting depth (5) to prevent circular invocations, and awaits terminal completion.
   */
  private async invokeSubWorkflowForRun(
    tenantId: string,
    parentRunId: string,
    parentInput: Record<string, unknown>,
    signal: AbortSignal,
    params: {
      workflowId: string;
      versionNumber?: number;
      input: Record<string, unknown>;
      idempotencyKey: string;
      timeoutMs: number;
    }
  ): Promise<SubWorkflowInvocationResult> {
    const nextDepth = Number(parentInput._sagaDepth ?? 0) + 1;
    if (nextDepth > 5) {
      throw new Error(
        `Sub-workflow recursion depth limit (5) exceeded while invoking "${params.workflowId}".`
      );
    }

    const wf = await this.storage.getWorkflow(tenantId, params.workflowId);
    if (!wf) {
      throw new Error(`Target sub-workflow "${params.workflowId}" not found in tenant.`);
    }
    const targetVersion = params.versionNumber ?? wf.latestVersion;
    if (!targetVersion) {
      throw new Error(`Target sub-workflow "${wf.name}" is not published yet.`);
    }
    const ver = await this.storage.getWorkflowVersion(tenantId, wf.id, targetVersion);
    if (!ver) {
      throw new Error(`Published version v${targetVersion} of "${wf.name}" not found.`);
    }

    const childInput: Record<string, unknown> = {
      ...params.input,
      _parentRunId: parentRunId,
      _sagaDepth: nextDepth,
    };

    const { run: childRun, created } = await this.storage.createRunIdempotent(tenantId, {
      id: makeId('run'),
      workflowId: wf.id,
      workflowName: wf.name,
      versionNumber: ver.versionNumber,
      idempotencyKey: params.idempotencyKey,
      input: childInput,
    });

    const buildResult = (finalRun: RunDetail): SubWorkflowInvocationResult => {
      const output: Record<string, unknown> = {};
      for (const s of finalRun.steps) {
        if (s.output !== undefined) output[s.nodeId] = s.output;
      }
      return {
        childRunId: finalRun.id,
        childWorkflowId: finalRun.workflowId,
        childWorkflowName: finalRun.workflowName ?? wf.name,
        childStatus: finalRun.status,
        durationMs: finalRun.durationMs ?? null,
        output,
        error: finalRun.error?.message ?? null,
      };
    };

    if (isTerminalRunStatus(childRun.status)) {
      return buildResult(childRun);
    }

    return await new Promise<SubWorkflowInvocationResult>((resolve, reject) => {
      let settled = false;
      let unsub: (() => void) | null = null;
      let pollTimer: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (unsub) unsub();
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        signal.removeEventListener('abort', onAbort);
      };

      const finishFromStorage = async () => {
        if (settled) return;
        const latest = await this.storage.getRun(tenantId, childRun.id);
        if (latest && isTerminalRunStatus(latest.status)) {
          settled = true;
          cleanup();
          resolve(buildResult(latest));
        }
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        void this.requestCancel(tenantId, childRun.id);
        reject(new StepCancelledError());
      };

      signal.addEventListener('abort', onAbort, { once: true });

      unsub = this.eventBus.subscribe(tenantId, childRun.id, (ev) => {
        if (ev.type === 'run.completed') {
          void finishFromStorage();
        }
      });

      timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error(
            `Sub-workflow "${wf.name}" (${childRun.id}) timed out after ${params.timeoutMs}ms.`
          )
        );
      }, params.timeoutMs);

      pollTimer = setInterval(() => {
        void finishFromStorage();
      }, 150);

      void (async () => {
        try {
          if (created) {
            await this.enqueueRun(tenantId, childRun.id);
          }
          await finishFromStorage();
        } catch (err) {
          if (!settled) {
            settled = true;
            cleanup();
            reject(err);
          }
        }
      })();
    });
  }

  private async executeJob(job: RunJob): Promise<void> {
    const { tenantId, runId } = job;
    const run = await this.storage.getRun(tenantId, runId);
    if (!run || isTerminalRunStatus(run.status)) {
      return;
    }

    const version = await this.storage.getWorkflowVersion(
      tenantId,
      run.workflowId,
      run.versionNumber
    );
    if (!version) {
      run.status = 'failed';
      run.error = {
        code: 'version_missing',
        message: `Workflow version ${run.versionNumber} could not be loaded.`,
      };
      run.finishedAt = nowIso();
      await this.storage.saveRun(tenantId, run);
      await this.eventBus.emit(tenantId, runId, 'run.completed', {
        status: run.status,
        error: run.error,
      });
      return;
    }

    const validation = validateWorkflowGraph(version.nodes, version.edges);
    if (!validation.valid) {
      run.status = 'failed';
      run.error = {
        code: 'invalid_workflow_graph',
        message: validation.issues[0]?.message ?? 'Invalid DAG graph',
      };
      run.finishedAt = nowIso();
      await this.storage.saveRun(tenantId, run);
      await this.eventBus.emit(tenantId, runId, 'run.completed', {
        status: run.status,
        error: run.error,
      });
      return;
    }

    const key = this.runKey(tenantId, runId);
    const controller = new AbortController();
    this.activeControllers.set(key, controller);

    // Serialize all storage saves for this run so parallel branches never clobber each other
    let saveChain: Promise<void> = Promise.resolve();
    const persist = async () => {
      const snapshot = structuredClone(run);
      saveChain = saveChain.then(() => this.storage.saveRun(tenantId, snapshot));
      await saveChain;
    };

    const isCancelled = async (): Promise<boolean> => {
      if (controller.signal.aborted || run.cancelRequested) return true;
      const latest = await this.storage.getRun(tenantId, runId);
      if (latest?.cancelRequested) {
        run.cancelRequested = true;
        return true;
      }
      return false;
    };

    try {
      const startedMs = run.startedAt ? new Date(run.startedAt).getTime() : Date.now();
      const isResuming = run.steps.length > 0 && run.steps.some((s) => s.status !== 'pending');
      run.startedAt = run.startedAt ?? nowIso();
      run.status = 'running';

      const nodeMap = new Map<string, WorkflowNode>();
      for (const n of version.nodes) nodeMap.set(n.id, n);

      // Initialize or hydrate persisted steps in deterministic topological order (crash-resumable!)
      const existingById = new Map(run.steps.map((s) => [s.nodeId, s]));
      const stepMap = new Map<string, RunStep>();
      run.steps = validation.topologicalOrder.map((nodeId) => {
        const node = nodeMap.get(nodeId)!;
        const prev = existingById.get(nodeId);
        const step: RunStep = prev
          ? prev
          : {
              nodeId: node.id,
              label: node.label ?? node.id,
              kind: node.type,
              status: 'pending',
              attempts: [],
            };
        stepMap.set(node.id, step);
        return step;
      });

      await persist();
      if (!isResuming) {
        await this.eventBus.emit(tenantId, runId, 'run.started', {
          status: 'running',
          startedAt: run.startedAt,
          nodeCount: version.nodes.length,
        });
      }

      // Build DAG adjacency
      const incoming = new Map<string, WorkflowEdge[]>();
      const outgoing = new Map<string, WorkflowEdge[]>();
      for (const n of version.nodes) {
        incoming.set(n.id, []);
        outgoing.set(n.id, []);
      }
      for (const e of version.edges) {
        incoming.get(e.to)?.push(e);
        outgoing.get(e.from)?.push(e);
      }

      const activeEdgeIds = new Set<string>(version.edges.map((e) => e.id));
      const settled = new Set<string>();
      const stepOutputs: Record<string, unknown> = {};
      const completedOrder: string[] = [];

      // Re-hydrate completed & skipped checkpointed steps when resuming from a pause (e.g. approval gate)
      for (const nodeId of validation.topologicalOrder) {
        const st = stepMap.get(nodeId)!;
        const node = nodeMap.get(nodeId)!;
        if (st.status === 'succeeded') {
          settled.add(nodeId);
          completedOrder.push(nodeId);
          if (st.output !== undefined) stepOutputs[nodeId] = st.output;
          if (
            (node.type === 'condition' || node.type === 'switch') &&
            st.output &&
            typeof st.output === 'object'
          ) {
            const branch = (st.output as { branch?: string }).branch;
            if (branch) {
              for (const outEdge of outgoing.get(nodeId) ?? []) {
                const edgeCond = outEdge.condition ?? 'always';
                if (edgeCond !== 'always' && edgeCond !== branch) {
                  activeEdgeIds.delete(outEdge.id);
                }
              }
            }
          }
          if (
            node.type === 'filter' &&
            st.output &&
            typeof st.output === 'object' &&
            (st.output as { passed?: boolean }).passed === false
          ) {
            for (const outEdge of outgoing.get(nodeId) ?? []) {
              activeEdgeIds.delete(outEdge.id);
            }
          }
        } else if (st.status === 'skipped') {
          settled.add(nodeId);
          for (const outEdge of outgoing.get(nodeId) ?? []) {
            activeEdgeIds.delete(outEdge.id);
          }
        }
      }

      // Load and decrypt tenant secrets once for this run (strictly tenant-isolated)
      const tenantSecrets: Record<string, string> = {};
      if (this.cipher) {
        try {
          const records = await this.storage.getAllSecretRecords(tenantId);
          for (const rec of records) {
            try {
              tenantSecrets[rec.name] = this.cipher.decrypt(rec.encryptedValue);
            } catch {
              // Ignore malformed/unreadable secret record rather than crashing unrelated workflows
            }
          }
        } catch {
          // Storage without secrets support or transient error
        }
      }
      const secretValuesToRedact = Object.values(tenantSecrets);
      const safeOut = <T>(val: T): T =>
        secretValuesToRedact.length > 0 ? redactSecrets(val, secretValuesToRedact) : val;

      let failedNode: WorkflowNode | null = null;
      let failureMessage = '';
      let cancelledMidRun = false;
      let pausedForApproval = false;

      // Cooperative cancellation check right before starting DAG loop
      if (await isCancelled()) {
        cancelledMidRun = true;
      }

      while (!cancelledMidRun && !failedNode && !pausedForApproval && settled.size < version.nodes.length) {
        // First, propagate skips for any pending nodes whose parents are all settled with no active incoming edges
        let skippedAny = true;
        while (skippedAny) {
          skippedAny = false;
          for (const nodeId of validation.topologicalOrder) {
            if (settled.has(nodeId)) continue;
            const inc = incoming.get(nodeId) ?? [];
            if (inc.length === 0) continue;
            const allParentsSettled = inc.every((e) => settled.has(e.from));
            if (!allParentsSettled) continue;
            const hasActiveParent = inc.some(
              (e) => activeEdgeIds.has(e.id) && stepMap.get(e.from)?.status === 'succeeded'
            );
            if (!hasActiveParent) {
              settled.add(nodeId);
              const st = stepMap.get(nodeId)!;
              st.status = 'skipped';
              for (const outEdge of outgoing.get(nodeId) ?? []) {
                activeEdgeIds.delete(outEdge.id);
              }
              await persist();
              await this.eventBus.emit(
                tenantId,
                runId,
                'step.skipped',
                { label: st.label, reason: 'Upstream branch not taken' },
                nodeId
              );
              skippedAny = true;
            }
          }
        }

        // Collect all nodes currently ready to run in parallel
        const readyIds: string[] = [];
        for (const nodeId of validation.topologicalOrder) {
          if (settled.has(nodeId)) continue;
          const inc = incoming.get(nodeId) ?? [];
          if (inc.length === 0) {
            readyIds.push(nodeId);
            continue;
          }
          const allParentsSettled = inc.every((e) => settled.has(e.from));
          const hasActiveParent = inc.some(
            (e) => activeEdgeIds.has(e.id) && stepMap.get(e.from)?.status === 'succeeded'
          );
          if (allParentsSettled && hasActiveParent) {
            readyIds.push(nodeId);
          }
        }

        if (readyIds.length === 0) {
          break;
        }

        // Execute all ready nodes concurrently!
        await Promise.all(
          readyIds.map(async (nodeId) => {
            const node = nodeMap.get(nodeId)!;
            const step = stepMap.get(nodeId)!;
            const policy = this.parseRetryPolicy(node);

            if (await isCancelled()) {
              cancelledMidRun = true;
              return;
            }

            // Durable Human-in-the-Loop Approval Gate Node
            if (node.type === 'approval') {
              const cfg = (node.config ?? {}) as Record<string, unknown>;
              const existingApproval = await this.storage.getApprovalByRunNode(
                tenantId,
                runId,
                nodeId
              );
              if (!existingApproval || existingApproval.status === 'pending') {
                const tplCtx = {
                  input: run.input,
                  steps: stepOutputs,
                  secrets: {},
                  env: { tenantId, runId },
                };
                const rawPrompt = String(
                  cfg.prompt ?? `Approve execution of "${step.label}" for run ${runId}?`
                );
                const resolvedPrompt = safeOut(String(resolveTemplates(rawPrompt, tplCtx)));
                const approverRole = String(cfg.approverRole ?? 'Operations Lead');
                const slaMs =
                  typeof cfg.timeoutMs === 'number' && cfg.timeoutMs > 0
                    ? cfg.timeoutMs
                    : typeof cfg.slaMinutes === 'number' && cfg.slaMinutes > 0
                      ? cfg.slaMinutes * 60_000
                      : 0;
                const expiresAt = slaMs > 0 ? new Date(Date.now() + slaMs).toISOString() : null;
                const rawOnTimeout = String(cfg.onTimeout ?? 'reject').toLowerCase();
                const onTimeout: 'reject' | 'approve' | 'escalate' | null = expiresAt
                  ? rawOnTimeout === 'approve'
                    ? 'approve'
                    : rawOnTimeout === 'escalate'
                      ? 'escalate'
                      : 'reject'
                  : null;
                const approval =
                  existingApproval ??
                  (await this.storage.createApproval(tenantId, {
                    runId,
                    workflowId: run.workflowId,
                    workflowName: run.workflowName ?? version.name,
                    nodeId,
                    stepLabel: step.label,
                    prompt: resolvedPrompt,
                    approverRole,
                    payload: safeOut({ input: run.input, steps: stepOutputs }) as Record<
                      string,
                      unknown
                    >,
                    expiresAt,
                    onTimeout,
                  }));
                step.status = 'waiting_approval';
                step.output = {
                  approvalId: approval.id,
                  status: 'pending',
                  approverRole: approval.approverRole,
                  prompt: approval.prompt,
                  expiresAt: approval.expiresAt ?? null,
                  onTimeout: approval.onTimeout ?? null,
                  callbackPath: `/api/callbacks/approval/${approval.callbackToken}`,
                };
                pausedForApproval = true;
                await persist();
                await this.eventBus.emit(
                  tenantId,
                  runId,
                  'step.waiting_approval',
                  {
                    approvalId: approval.id,
                    label: step.label,
                    approverRole: approval.approverRole,
                    prompt: approval.prompt,
                    expiresAt: approval.expiresAt ?? null,
                  },
                  nodeId
                );
                if (!existingApproval) {
                  void dispatchTenantAlerts(
                    this.storage,
                    tenantId,
                    'approval.requested',
                    `Approval required: "${step.label}" on ${run.workflowName ?? version.name}`,
                    {
                      approvalId: approval.id,
                      runId,
                      workflowId: run.workflowId,
                      approverRole: approval.approverRole,
                      expiresAt: approval.expiresAt ?? null,
                    }
                  );
                }
                return;
              }

              // Approval has been decided!
              const att: StepAttempt = {
                attempt: step.attempts.length + 1,
                kind: 'execute',
                status: existingApproval.status === 'approved' ? 'succeeded' : 'failed',
                startedAt: existingApproval.createdAt,
                finishedAt: existingApproval.decidedAt ?? nowIso(),
                durationMs: existingApproval.decidedAt
                  ? Math.max(
                      1,
                      new Date(existingApproval.decidedAt).getTime() -
                        new Date(existingApproval.createdAt).getTime()
                    )
                  : 1,
                output:
                  existingApproval.status === 'approved'
                    ? {
                        approvalId: existingApproval.id,
                        decision: 'approved',
                        decidedBy: existingApproval.decidedBy,
                        comment: existingApproval.comment,
                        decidedAt: existingApproval.decidedAt,
                      }
                    : undefined,
                error:
                  existingApproval.status === 'rejected'
                    ? {
                        code: 'approval_rejected',
                        message: `Rejected by ${existingApproval.decidedBy ?? 'approver'}${
                          existingApproval.comment ? `: ${existingApproval.comment}` : ''
                        }`,
                      }
                    : null,
              };
              step.attempts.push(att);

              if (existingApproval.status === 'approved') {
                step.status = 'succeeded';
                step.output = att.output;
                stepOutputs[nodeId] = att.output;
                completedOrder.push(nodeId);
                settled.add(nodeId);
                await persist();
                await this.eventBus.emit(
                  tenantId,
                  runId,
                  'step.succeeded',
                  { label: step.label, output: att.output },
                  nodeId
                );
                return;
              } else {
                step.status = 'failed';
                settled.add(nodeId);
                failedNode = node;
                failureMessage = att.error?.message ?? 'Approval rejected';
                await persist();
                await this.eventBus.emit(
                  tenantId,
                  runId,
                  'step.failed',
                  { label: step.label, error: failureMessage },
                  nodeId
                );
                controller.abort();
                return;
              }
            }

            step.status = 'running';
            await persist();
            await this.eventBus.emit(
              tenantId,
              runId,
              'step.started',
              { label: step.label, kind: step.kind, maxAttempts: policy.maxAttempts },
              nodeId
            );

            let succeeded = false;
            let lastErrMessage = 'Step failed';

            for (let attemptNum = 1; attemptNum <= policy.maxAttempts; attemptNum++) {
              if (await isCancelled()) {
                cancelledMidRun = true;
                return;
              }
              if (failedNode) {
                // Another parallel branch already failed; abort cleanly
                return;
              }

              const attStartMs = Date.now();
              const attempt: StepAttempt = {
                attempt: attemptNum,
                kind: 'execute',
                status: 'running',
                startedAt: nowIso(),
                finishedAt: null,
                durationMs: null,
                error: null,
              };
              step.attempts.push(attempt);
              await persist();
              await this.eventBus.emit(
                tenantId,
                runId,
                'attempt.started',
                { attempt: attemptNum, kind: 'execute', maxAttempts: policy.maxAttempts },
                nodeId
              );

              try {
                const execRes = await executeWorkflowNode(node, {
                  tenantId,
                  runId,
                  attempt: attemptNum,
                  input: run.input,
                  stepOutputs,
                  storage: this.storage,
                  cipher: this.cipher,
                  secrets: tenantSecrets,
                  invokeSubWorkflow: (subParams) =>
                    this.invokeSubWorkflowForRun(
                      tenantId,
                      runId,
                      run.input,
                      controller.signal,
                      subParams
                    ),
                  signal: controller.signal,
                });

                const redactedOutput = safeOut(execRes.output);
                const redactedLogs = execRes.logs ? safeOut(execRes.logs) : undefined;

                attempt.status = 'succeeded';
                attempt.finishedAt = nowIso();
                attempt.durationMs = Date.now() - attStartMs;
                attempt.output = redactedOutput;
                attempt.logs = redactedLogs;

                step.status = 'succeeded';
                step.output = redactedOutput;
                // Keep stepOutputs redacted too so downstream logs never accidentally expose secrets
                stepOutputs[nodeId] = redactedOutput;
                completedOrder.push(nodeId);
                settled.add(nodeId);
                succeeded = true;

                // Evaluate conditional / switch outgoing edge routing and filter short-circuiting
                if ((node.type === 'condition' || node.type === 'switch') && execRes.branch) {
                  for (const outEdge of outgoing.get(nodeId) ?? []) {
                    const edgeCond = outEdge.condition ?? 'always';
                    if (edgeCond !== 'always' && edgeCond !== execRes.branch) {
                      activeEdgeIds.delete(outEdge.id);
                    }
                  }
                }
                if (execRes.haltDownstream) {
                  for (const outEdge of outgoing.get(nodeId) ?? []) {
                    activeEdgeIds.delete(outEdge.id);
                  }
                }

                await persist();
                await this.eventBus.emit(
                  tenantId,
                  runId,
                  'attempt.succeeded',
                  {
                    attempt: attemptNum,
                    kind: 'execute',
                    durationMs: attempt.durationMs,
                    output: redactedOutput,
                  },
                  nodeId
                );
                await this.eventBus.emit(
                  tenantId,
                  runId,
                  'step.succeeded',
                  { label: step.label, output: redactedOutput },
                  nodeId
                );
                break;
              } catch (err) {
                if (err instanceof StepCancelledError || (await isCancelled())) {
                  attempt.status = 'failed';
                  attempt.finishedAt = nowIso();
                  attempt.durationMs = Date.now() - attStartMs;
                  attempt.error = { code: 'cancelled', message: 'Cancelled by user request' };
                  cancelledMidRun = true;
                  await persist();
                  return;
                }

                lastErrMessage = safeOut(err instanceof Error ? err.message : String(err));
                attempt.status = 'failed';
                attempt.finishedAt = nowIso();
                attempt.durationMs = Date.now() - attStartMs;
                attempt.error = { message: lastErrMessage };
                await persist();
                await this.eventBus.emit(
                  tenantId,
                  runId,
                  'attempt.failed',
                  {
                    attempt: attemptNum,
                    kind: 'execute',
                    durationMs: attempt.durationMs,
                    error: lastErrMessage,
                    willRetry: attemptNum < policy.maxAttempts,
                  },
                  nodeId
                );

                if (attemptNum < policy.maxAttempts && !failedNode) {
                  const delayMs = Math.round(
                    policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attemptNum - 1)
                  );
                  try {
                    await sleepWithAbort(delayMs, controller.signal);
                  } catch {
                    if (await isCancelled()) {
                      cancelledMidRun = true;
                      return;
                    }
                    return;
                  }
                }
              }
            }

            if (!succeeded && !cancelledMidRun && !failedNode) {
              step.status = 'failed';
              settled.add(nodeId);
              failedNode = node;
              failureMessage = lastErrMessage;
              await persist();
              await this.eventBus.emit(
                tenantId,
                runId,
                'step.failed',
                { label: step.label, error: lastErrMessage },
                nodeId
              );
              // Signal sibling parallel tasks to halt cleanly before compensation starts
              controller.abort();
            }
          })
        );
      }

      // ---------------- Finalization & Saga Compensation ----------------

      if (pausedForApproval && !failedNode && !cancelledMidRun) {
        run.status = 'waiting_approval';
        await persist();
        await this.eventBus.emit(tenantId, runId, 'run.waiting_approval', {
          status: 'waiting_approval',
        });
        return;
      }

      if (cancelledMidRun) {
        run.status = 'cancelled';
        run.cancelRequested = true;
        run.finishedAt = nowIso();
        run.durationMs = Date.now() - startedMs;
        await persist();
        await this.eventBus.emit(tenantId, runId, 'run.completed', {
          status: 'cancelled',
          durationMs: run.durationMs,
        });
        return;
      }

      if (failedNode) {
        const failedStepNode: WorkflowNode = failedNode;
        run.error = {
          code: 'step_failed',
          message: `Step "${failedStepNode.label ?? failedStepNode.id}" failed: ${failureMessage}`,
        };

        // Determine compensatable steps in strict reverse execution order
        const toCompensate = [...completedOrder]
          .reverse()
          .map((id) => nodeMap.get(id)!)
          .filter((n) => getCompensatorName(n) !== null);

        let compensatedCount = 0;
        let compensationFailed = false;

        if (toCompensate.length > 0) {
          run.status = 'compensating';
          await persist();
          await this.eventBus.emit(tenantId, runId, 'run.compensating', {
            failedNodeId: failedStepNode.id,
            stepsToCompensate: toCompensate.map((n) => n.id),
          });

          // Fresh signal for compensation (parent controller was aborted to halt forward branches)
          const compController = new AbortController();

          for (const compNode of toCompensate) {
            const compStep = stepMap.get(compNode.id)!;
            const compName = getCompensatorName(compNode)!;
            const maxCompAttempts = 2;
            let compSucceeded = false;

            for (let attNum = 1; attNum <= maxCompAttempts; attNum++) {
              const cStart = Date.now();
              const compAttempt: StepAttempt = {
                attempt: attNum,
                kind: 'compensate',
                status: 'running',
                startedAt: nowIso(),
                finishedAt: null,
                durationMs: null,
                error: null,
              };
              compStep.attempts.push(compAttempt);
              await persist();
              await this.eventBus.emit(
                tenantId,
                runId,
                'compensation.started',
                { attempt: attNum, compensator: compName, label: compStep.label },
                compNode.id
              );

              try {
                const cRes = await compensateWorkflowNode(compNode, compStep.output, {
                  tenantId,
                  runId,
                  attempt: attNum,
                  input: run.input,
                  stepOutputs,
                  storage: this.storage,
                  secrets: tenantSecrets,
                  invokeSubWorkflow: (subParams) =>
                    this.invokeSubWorkflowForRun(
                      tenantId,
                      runId,
                      run.input,
                      compController.signal,
                      subParams
                    ),
                  signal: compController.signal,
                });
                compAttempt.status = 'succeeded';
                compAttempt.finishedAt = nowIso();
                compAttempt.durationMs = Date.now() - cStart;
                compAttempt.output = safeOut(cRes.output);
                compAttempt.logs = cRes.logs ? safeOut(cRes.logs) : undefined;
                compStep.status = 'compensated';
                compSucceeded = true;
                compensatedCount++;

                await persist();
                await this.eventBus.emit(
                  tenantId,
                  runId,
                  'compensation.succeeded',
                  {
                    attempt: attNum,
                    compensator: compName,
                    durationMs: compAttempt.durationMs,
                  },
                  compNode.id
                );
                await this.eventBus.emit(
                  tenantId,
                  runId,
                  'step.compensated',
                  { label: compStep.label, compensator: compName },
                  compNode.id
                );
                break;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                compAttempt.status = 'failed';
                compAttempt.finishedAt = nowIso();
                compAttempt.durationMs = Date.now() - cStart;
                compAttempt.error = { message: msg };
                await persist();
                await this.eventBus.emit(
                  tenantId,
                  runId,
                  'compensation.failed',
                  { attempt: attNum, compensator: compName, error: msg },
                  compNode.id
                );
                if (attNum < maxCompAttempts) {
                  await sleepWithAbort(150, compController.signal);
                }
              }
            }

            if (!compSucceeded) {
              compensationFailed = true;
            }
          }
        }

        // Per API Contract v1.1 Section 6:
        // "A run that fails and is rolled back ends as compensated;
        //  failed means it failed with nothing to compensate or compensation itself could not finish."
        run.status = compensatedCount > 0 && !compensationFailed ? 'compensated' : 'failed';
        run.finishedAt = nowIso();
        run.durationMs = Date.now() - startedMs;
        await persist();

        // Push to Dead-Letter Queue (DLQ) for failure auditing and 1-click replay
        const dlqEntry: DlqEntry = {
          id: makeId('dlq'),
          runId: run.id,
          workflowId: run.workflowId,
          workflowName: run.workflowName ?? version.name,
          versionNumber: run.versionNumber,
          failedNodeId: failedStepNode.id,
          failedStepLabel: failedStepNode.label ?? failedStepNode.id,
          runFinalStatus: run.status,
          error: run.error,
          input: run.input,
          replayedRunId: null,
          createdAt: nowIso(),
        };
        await this.storage.createDlqEntry(tenantId, dlqEntry);
        await this.eventBus.emit(tenantId, runId, 'dlq.enqueued', {
          dlqId: dlqEntry.id,
          failedNodeId: failedStepNode.id,
        });
        await this.eventBus.emit(tenantId, runId, 'run.completed', {
          status: run.status,
          durationMs: run.durationMs,
          error: run.error,
        });

        // Fire configured tenant Alert Rules (HMAC-SHA256 signed webhooks / live sink)
        const alertEvent = run.status === 'compensated' ? 'run.compensated' : 'run.failed';
        await dispatchTenantAlerts(
          this.storage,
          tenantId,
          alertEvent,
          `Saga ${run.status.toUpperCase()}: "${run.workflowName ?? version.name}" failed at "${failedStepNode.label ?? failedStepNode.id}"`,
          {
            runId: run.id,
            dlqId: dlqEntry.id,
            workflowId: run.workflowId,
            status: run.status,
            failedNodeId: failedStepNode.id,
            error: run.error,
          }
        );
        await dispatchTenantAlerts(
          this.storage,
          tenantId,
          'dlq.created',
          `DLQ Entry ${dlqEntry.id}: "${run.workflowName ?? version.name}" requires operator review`,
          {
            dlqId: dlqEntry.id,
            runId: run.id,
            workflowId: run.workflowId,
            failedNodeId: failedStepNode.id,
            error: run.error,
          }
        );
        return;
      }

      // All executable steps succeeded!
      run.status = 'succeeded';
      run.finishedAt = nowIso();
      run.durationMs = Date.now() - startedMs;
      await persist();
      await this.eventBus.emit(tenantId, runId, 'run.completed', {
        status: 'succeeded',
        durationMs: run.durationMs,
      });
    } finally {
      this.activeControllers.delete(key);
    }
  }
}
