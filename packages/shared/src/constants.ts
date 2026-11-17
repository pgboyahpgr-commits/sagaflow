export const WORKFLOW_STATUSES = ['draft', 'published'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const RUN_STATUSES = [
  'pending',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'compensating',
  'compensated',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'succeeded',
  'failed',
  'compensated',
  'cancelled',
]);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export const STEP_STATUSES = [
  'pending',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'compensated',
  'skipped',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const ATTEMPT_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const ATTEMPT_KINDS = ['execute', 'compensate'] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export const STEP_KINDS = [
  'trigger',
  'http_request',
  'condition',
  'switch',
  'filter',
  'transform',
  'wait',
  'approval',
  'script',
  'custom_task',
  'email',
  'slack_discord',
  'database',
  'ai_agent',
  'sub_workflow',
  'for_each',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

export const ALERT_EVENT_TYPES = [
  'run.failed',
  'run.compensated',
  'dlq.created',
  'approval.requested',
  'approval.sla_breached',
] as const;
export type AlertEventType = (typeof ALERT_EVENT_TYPES)[number];

export const RBAC_ROLES = ['admin', 'operator', 'approver', 'viewer'] as const;
export type RbacRole = (typeof RBAC_ROLES)[number];

export function normalizeRbacRole(raw: string | null | undefined): RbacRole {
  const v = String(raw ?? 'admin').toLowerCase();
  if (v === 'owner' || v === 'admin') return 'admin';
  if (v === 'operator') return 'operator';
  if (v === 'approver') return 'approver';
  if (v === 'viewer') return 'viewer';
  return 'viewer';
}

export const ISSUE_CODES = [
  'duplicate_node_id',
  'duplicate_edge_id',
  'missing_node_reference',
  'cycle',
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export const ERROR_CODES = [
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'workflow_not_found',
  'run_not_found',
  'dlq_not_found',
  'tenant_not_found',
  'api_key_not_found',
  'secret_not_found',
  'schedule_not_found',
  'alert_rule_not_found',
  'approval_not_found',
  'approval_already_decided',
  'ai_not_configured',
  'ai_provider_error',
  'invalid_webhook_signature',
  'conflict',
  'workflow_not_published',
  'run_not_cancellable',
  'invalid_workflow_graph',
  'rate_limit_exceeded',
  'internal_error',
  'api_unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const GRAPH_LIMITS = {
  NAME_MIN: 1,
  NAME_MAX: 160,
  ID_MIN: 1,
  ID_MAX: 100,
  MAX_NODES: 500,
  MAX_EDGES: 2000,
} as const;

export const CUSTOM_TASK_HANDLERS = [
  {
    name: 'reserve_inventory',
    label: 'Reserve Inventory',
    compensator: 'release_inventory',
    description: 'Reserves stock items in warehouse; rolls back by releasing reservation.',
  },
  {
    name: 'allocate_credits',
    label: 'Allocate Loyalty Credits',
    compensator: 'revert_credits',
    description: 'Locks customer loyalty credits; rolls back by restoring balance.',
  },
  {
    name: 'charge_payment',
    label: 'Charge Payment',
    compensator: 'refund_payment',
    description: 'Charges payment gateway; rolls back by issuing a full refund.',
  },
  {
    name: 'create_shipment',
    label: 'Create Shipment',
    compensator: 'cancel_shipment',
    description: 'Books carrier pickup & tracking ID; rolls back by voiding label.',
  },
  {
    name: 'send_notification',
    label: 'Send Notification',
    compensator: 'send_cancellation_notice',
    description: 'Dispatches customer email/webhook; rolls back with cancellation update.',
  },
  {
    name: 'sync_customs',
    label: 'Sync Customs Manifest',
    compensator: 'void_customs_manifest',
    description: 'Files cross-border customs entry into tenant ledger; rolls back by voiding manifest.',
  },
  {
    name: 'kv_set',
    label: 'Persist State Key-Value',
    compensator: 'kv_revert',
    description: 'Writes a durable key/value record into tenant state; rolls back to previous value on compensation.',
  },
  {
    name: 'audit_log',
    label: 'Write Audit Ledger Entry',
    compensator: null,
    description: 'Appends an immutable structured compliance entry to the tenant ledger.',
  },
  {
    name: 'noop',
    label: 'Passthrough Step',
    compensator: null,
    description: 'Passes resolved template params downstream without side effects.',
  },
] as const;
