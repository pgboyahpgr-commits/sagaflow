import { getNextCronDate, type RunDetail, type WorkflowSchedule } from '@sagaflow/shared';
import type { StorageAdapter } from '../storage/interface.js';
import { makeId, nowIso } from '../utils/id.js';
import { dispatchTenantAlerts } from './alerts.js';
import type { SagaOrchestrator } from './saga-engine.js';

/**
 * Durable Cron Scheduler:
 * - Polls due schedules across all tenants every tick (default 15s)
 * - Uses minute-scoped deterministic idempotency keys (`cron_<scheduleId>_<YYYY-MM-DDTHH:MM>`)
 *   so even in multi-node deployments a scheduled minute never double-triggers
 * - Computes and persists the next UTC run time immediately
 */
export class CronScheduler {
  private readonly storage: StorageAdapter;
  private readonly orchestrator: SagaOrchestrator;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private totalFired = 0;

  constructor(storage: StorageAdapter, orchestrator: SagaOrchestrator, pollIntervalMs = 15_000) {
    this.storage = storage;
    this.orchestrator = orchestrator;
    this.pollIntervalMs = pollIntervalMs;
  }

  getStats() {
    return {
      running: this.timer !== null,
      pollIntervalMs: this.pollIntervalMs,
      totalFired: this.totalFired,
    };
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(referenceDate: Date = new Date()): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let triggered = 0;

    try {
      const nowStr = referenceDate.toISOString();
      const due = await this.storage.listDueSchedulesAcrossTenants(nowStr);
      for (const schedule of due) {
        const minuteBucket = nowStr.slice(0, 16);
        const fired = await this.fireSchedule(
          schedule.tenantId,
          schedule,
          `cron_${schedule.id}_${minuteBucket}`,
          referenceDate
        );
        if (fired) {
          triggered++;
          this.totalFired++;
        }
      }

      // Sweep Approval Gate SLA timeouts (reject -> rollback, approve -> resume, escalate -> alert)
      await this.sweepExpiredApprovals(referenceDate);
    } catch (err) {
      console.error('[CronScheduler] Tick error:', err);
    } finally {
      this.ticking = false;
    }
    return triggered;
  }

  /**
   * Sweeps all pending Human-in-the-Loop approvals whose SLA `expiresAt` has passed.
   */
  async sweepExpiredApprovals(referenceDate: Date = new Date()): Promise<number> {
    const expired = await this.storage.listExpiredPendingApprovals(referenceDate.toISOString());
    let handled = 0;
    for (const apr of expired) {
      const action = apr.onTimeout ?? 'reject';
      if (action === 'escalate') {
        if (!apr.escalatedAt) {
          await this.storage.markApprovalEscalated(apr.tenantId, apr.id);
          await dispatchTenantAlerts(
            this.storage,
            apr.tenantId,
            'approval.sla_breached',
            `SLA Escalation: Approval "${apr.stepLabel}" (${apr.id}) breached deadline (${apr.expiresAt})`,
            {
              approvalId: apr.id,
              runId: apr.runId,
              workflowId: apr.workflowId,
              approverRole: apr.approverRole,
              expiresAt: apr.expiresAt,
              action: 'escalate',
            }
          );
          handled++;
        }
        continue;
      }

      const decisionStatus = action === 'approve' ? 'approved' : 'rejected';
      const decided = await this.storage.decideApproval(apr.tenantId, apr.id, {
        status: decisionStatus,
        decidedBy: 'system:sla-watchdog',
        comment:
          decisionStatus === 'rejected'
            ? `Approval SLA deadline (${apr.expiresAt}) expired — auto-rejected (atomic Saga rollback triggered).`
            : `Approval SLA deadline (${apr.expiresAt}) expired — auto-approved by SLA policy.`,
      });
      if (decided) {
        await dispatchTenantAlerts(
          this.storage,
          apr.tenantId,
          'approval.sla_breached',
          `Approval SLA Expired (${decisionStatus.toUpperCase()}): "${apr.stepLabel}" on ${apr.workflowName}`,
          {
            approvalId: apr.id,
            runId: apr.runId,
            workflowId: apr.workflowId,
            decision: decisionStatus,
            expiresAt: apr.expiresAt,
          }
        );
        await this.orchestrator.enqueueRun(apr.tenantId, apr.runId);
        handled++;
      }
    }
    return handled;
  }

  async triggerNow(tenantId: string, scheduleId: string): Promise<{ run: RunDetail; schedule: WorkflowSchedule } | null> {
    const schedule = await this.storage.getSchedule(tenantId, scheduleId);
    if (!schedule) return null;
    const result = await this.fireSchedule(
      tenantId,
      schedule,
      `cron_manual_${schedule.id}_${Date.now()}`,
      new Date()
    );
    return result;
  }

  private async fireSchedule(
    tenantId: string,
    schedule: WorkflowSchedule,
    idempotencyKey: string,
    refDate: Date
  ): Promise<{ run: RunDetail; schedule: WorkflowSchedule } | null> {
    const wf = await this.storage.getWorkflow(tenantId, schedule.workflowId);
    if (!wf || wf.latestVersion === null) {
      return null;
    }

    const { run, created } = await this.storage.createRunIdempotent(tenantId, {
      id: makeId('run'),
      workflowId: wf.id,
      workflowName: wf.name,
      versionNumber: wf.latestVersion,
      idempotencyKey,
      input: {
        ...schedule.input,
        _scheduledBy: {
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          cron: schedule.cron,
          firedAt: nowIso(),
        },
      },
    });

    const nextRunAt = schedule.enabled ? getNextCronDate(schedule.cron, refDate).toISOString() : null;
    const updatedSchedule =
      (await this.storage.markScheduleFired(tenantId, schedule.id, nowIso(), run.id, nextRunAt)) ??
      schedule;

    if (created) {
      await this.orchestrator.enqueueRun(tenantId, run.id);
    }

    return { run, schedule: updatedSchedule };
  }
}
