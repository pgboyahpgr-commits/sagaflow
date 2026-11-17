import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  Zap,
  Globe,
  GitBranch,
  Split,
  Filter,
  Shuffle,
  Clock,
  Code2,
  Cpu,
  Mail,
  MessageSquare,
  Database,
  UserCheck,
  Bot,
  Layers,
  Repeat,
  RotateCcw,
  Radio,
} from 'lucide-react';
import type { StepKind, StepStatus } from '@sagaflow/shared';

export interface SagaNodeData extends Record<string, unknown> {
  label: string;
  stepType?: StepKind;
  nodeType?: StepKind;
  config: Record<string, unknown>;
  status?: StepStatus;
  attempts?: number;
  durationMs?: number;
  isCompensable?: boolean;
  compensationHandler?: string;
  diffStatus?: 'added' | 'modified' | 'removed' | null;
  debugStatus?: 'active' | 'would_execute' | 'would_skip' | 'would_pause' | 'error' | null;
}

const TYPE_META: Record<
  StepKind,
  {
    topBar: string;
    eyebrow: string;
    icon: React.ComponentType<{ className?: string }>;
    tag: string;
  }
> = {
  trigger: {
    topBar: 'bg-[#22e55c]',
    eyebrow: 'text-[#22e55c]',
    icon: Zap,
    tag: 'TRIGGER',
  },
  http_request: {
    topBar: 'bg-zinc-400',
    eyebrow: 'text-zinc-300',
    icon: Globe,
    tag: 'LIVE HTTP',
  },
  condition: {
    topBar: 'bg-violet-400',
    eyebrow: 'text-violet-300',
    icon: GitBranch,
    tag: 'IF / BRANCH',
  },
  switch: {
    topBar: 'bg-violet-400',
    eyebrow: 'text-violet-300',
    icon: Split,
    tag: 'SWITCH ROUTER',
  },
  filter: {
    topBar: 'bg-sky-400',
    eyebrow: 'text-sky-300',
    icon: Filter,
    tag: 'FILTER GUARD',
  },
  transform: {
    topBar: 'bg-emerald-400',
    eyebrow: 'text-emerald-300',
    icon: Shuffle,
    tag: 'TRANSFORM',
  },
  wait: {
    topBar: 'bg-zinc-500',
    eyebrow: 'text-zinc-400',
    icon: Clock,
    tag: 'WAIT',
  },
  approval: {
    topBar: 'bg-amber-400',
    eyebrow: 'text-amber-300',
    icon: UserCheck,
    tag: 'APPROVAL GATE',
  },
  script: {
    topBar: 'bg-[#22e55c]',
    eyebrow: 'text-[#73ff86]',
    icon: Code2,
    tag: 'QUICKJS-WASM',
  },
  custom_task: {
    topBar: 'bg-[#22e55c]',
    eyebrow: 'text-[#22e55c]',
    icon: Cpu,
    tag: 'SAGA TASK',
  },
  email: {
    topBar: 'bg-sky-400',
    eyebrow: 'text-sky-300',
    icon: Mail,
    tag: 'EMAIL',
  },
  slack_discord: {
    topBar: 'bg-indigo-400',
    eyebrow: 'text-indigo-300',
    icon: MessageSquare,
    tag: 'SLACK / CHAT',
  },
  database: {
    topBar: 'bg-[#22e55c]',
    eyebrow: 'text-[#73ff86]',
    icon: Database,
    tag: 'DATABASE / KV',
  },
  ai_agent: {
    topBar: 'bg-[#22e55c]',
    eyebrow: 'text-[#22e55c]',
    icon: Bot,
    tag: 'AI AGENT',
  },
  sub_workflow: {
    topBar: 'bg-[#a855f7]',
    eyebrow: 'text-[#c084fc]',
    icon: Layers,
    tag: 'SUB-FLOW',
  },
  for_each: {
    topBar: 'bg-[#22e55c]',
    eyebrow: 'text-[#73ff86]',
    icon: Repeat,
    tag: 'FOR-EACH MAP',
  },
};

const STATUS_META: Record<
  StepStatus,
  { frame: string; topBar: string; dot: string; text: string }
> = {
  pending: {
    frame: 'border-[#262c32]',
    topBar: 'bg-zinc-600',
    dot: 'bg-zinc-500',
    text: 'text-zinc-400',
  },
  running: {
    frame: 'border-[#22e55c]/75 shadow-[0_0_26px_rgba(34,229,92,0.22)]',
    topBar: 'bg-[#22e55c]',
    dot: 'bg-[#22e55c] animate-pulse',
    text: 'text-[#22e55c]',
  },
  waiting_approval: {
    frame: 'border-amber-400/75 shadow-[0_0_26px_rgba(245,158,11,0.22)]',
    topBar: 'bg-amber-400',
    dot: 'bg-amber-400 animate-pulse',
    text: 'text-amber-300',
  },
  succeeded: {
    frame: 'border-[#22e55c]/55 shadow-[0_0_18px_rgba(34,229,92,0.12)]',
    topBar: 'bg-[#22e55c]',
    dot: 'bg-[#22e55c]',
    text: 'text-[#22e55c]',
  },
  failed: {
    frame: 'border-rose-500/75 shadow-[0_0_24px_rgba(244,63,94,0.22)]',
    topBar: 'bg-rose-500',
    dot: 'bg-rose-400',
    text: 'text-rose-300',
  },
  compensated: {
    frame: 'border-violet-400/70 shadow-[0_0_22px_rgba(168,85,247,0.22)]',
    topBar: 'bg-violet-400',
    dot: 'bg-violet-400',
    text: 'text-violet-300',
  },
  skipped: {
    frame: 'border-zinc-800 opacity-55',
    topBar: 'bg-zinc-700',
    dot: 'bg-zinc-600',
    text: 'text-zinc-500',
  },
};

function getCommandPreview(type: StepKind, config: Record<string, unknown>): string {
  switch (type) {
    case 'trigger':
      return `POST /api/webhooks · ${String(config.triggerType ?? 'manual')}`;
    case 'http_request':
      return `${String(config.method ?? 'POST')} ${String(config.url ?? '/api/sink')}`;
    case 'condition':
      return String(config.expression ?? 'input.amount > 100');
    case 'wait':
      return `sleep(${String(config.durationMs ?? 1000)}ms)`;
    case 'approval':
      return `Role · ${String(config.approverRole ?? 'Approver')}`;
    case 'script':
      return `wasm · ${String(config.timeoutMs ?? 2000)}ms / ${String(config.memoryLimitMb ?? 16)}MB`;
    case 'custom_task':
      return `${String(config.handler ?? 'custom_task')}()`;
    case 'ai_agent': {
      const prov =
        config.provider === 'google_ai_studio'
          ? 'Gemini'
          : config.provider === 'lm_studio'
            ? 'LM Studio'
            : 'Tenant AI';
      const mod = config.model ? ` · ${String(config.model)}` : '';
      return `${prov}${mod}`;
    }
    case 'sub_workflow':
      return `invoke(${String(config.workflowId ?? 'select_workflow')})`;
    case 'for_each':
      return `forEach(${String(config.itemsExpression ?? '{{input.items}}')} · x${String(config.maxConcurrency ?? 4)})`;
    case 'transform': {
      const m = config.mappings && typeof config.mappings === 'object' ? Object.keys(config.mappings).length : 0;
      return `map ${m} field(s)${config.mergeWithInput ? ' + input' : ''}`;
    }
    case 'filter':
      return `${String(config.field ?? 'input.value')} ${String(config.operator ?? 'exists')} ${config.value !== undefined ? String(config.value) : ''}`.trim();
    case 'switch': {
      const count = Array.isArray(config.cases) ? config.cases.length : 0;
      return `switch(${String(config.expression ?? '{{input.type}}')}) · ${count} cases`;
    }
    case 'email':
      return `to: ${String(config.to ?? '{{input.email}}')}`;
    case 'slack_discord':
      return `${String(config.platform ?? 'slack')} · ${String(config.channelName ?? '#alerts')}`;
    case 'database':
      return `${String(config.operation ?? 'set').toUpperCase()} ${String(config.collection ?? 'records')}:${String(config.key ?? 'id')}`;
    default:
      return '';
  }
}

export const SagaNode: React.FC<NodeProps> = ({ data, selected }) => {
  const nodeData = data as SagaNodeData;
  const kind: StepKind = nodeData.stepType ?? nodeData.nodeType ?? 'custom_task';
  const meta = TYPE_META[kind] ?? TYPE_META.custom_task;
  const Icon = meta.icon;
  const statusInfo = nodeData.status ? STATUS_META[nodeData.status] : null;

  const topBarClass =
    nodeData.diffStatus === 'added'
      ? 'bg-[#22e55c]'
      : nodeData.diffStatus === 'modified'
        ? 'bg-[#f59e0b]'
        : nodeData.diffStatus === 'removed'
          ? 'bg-[#f43f5e]'
          : statusInfo
            ? statusInfo.topBar
            : meta.topBar;
  const frameClass =
    nodeData.diffStatus === 'added'
      ? 'border-[#22e55c] shadow-[0_0_24px_rgba(34,229,92,0.28)]'
      : nodeData.diffStatus === 'modified'
        ? 'border-[#f59e0b] shadow-[0_0_24px_rgba(245,158,11,0.25)]'
        : nodeData.diffStatus === 'removed'
          ? 'border-[#f43f5e] border-dashed opacity-75 shadow-[0_0_20px_rgba(244,63,94,0.22)]'
          : nodeData.debugStatus === 'active'
            ? 'border-[#39ff14] ring-2 ring-[#22e55c]/50 shadow-[0_0_28px_rgba(34,229,92,0.35)]'
            : nodeData.debugStatus === 'would_skip'
              ? 'border-[#262c32] opacity-45'
              : nodeData.debugStatus === 'would_pause'
                ? 'border-[#f59e0b]/80 shadow-[0_0_20px_rgba(245,158,11,0.2)]'
                : nodeData.debugStatus === 'error'
                  ? 'border-[#f43f5e] shadow-[0_0_20px_rgba(244,63,94,0.25)]'
                  : statusInfo
                    ? statusInfo.frame
                    : selected
                      ? 'border-[#22e55c]/80 shadow-[0_0_24px_rgba(34,229,92,0.2)]'
                      : 'border-[#262c32] hover:border-[#2f373f]';

  const preview = getCommandPreview(kind, nodeData.config ?? {});
  const isCondition = kind === 'condition';
  const isTrigger = kind === 'trigger';
  const compHandler =
    nodeData.compensationHandler ??
    (typeof nodeData.config?.compensationHandler === 'string'
      ? nodeData.config.compensationHandler
      : kind === 'database' &&
          ['set', 'increment', 'delete'].includes(String(nodeData.config?.operation ?? 'set'))
        ? 'database_revert'
        : undefined);

  return (
    <div
      className={`group relative w-[258px] overflow-hidden rounded border bg-[#15191d] transition-all duration-150 ${frameClass}`}
    >
      {/* Signature 2px Top Color Stripe */}
      <div className={`h-[2px] w-full ${topBarClass}`} />

      {!isTrigger && (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-2.5 !w-2.5 !border-2 !border-[#0c0e10] !bg-[#22e55c]"
        />
      )}

      <div className="px-3.5 py-2.5">
        {/* Eyebrow row: icon + kind + duration */}
        <div className="flex items-center justify-between gap-2">
          <div className={`flex items-center gap-1.5 font-mono text-[9.5px] font-bold tracking-[0.09em] ${meta.eyebrow}`}>
            <Icon className="h-3 w-3 shrink-0" />
            <span>{meta.tag}</span>
          </div>
          {nodeData.diffStatus ? (
            <span
              className={`rounded border px-1.5 py-0.2 font-mono text-[9px] font-bold uppercase ${
                nodeData.diffStatus === 'added'
                  ? 'border-[#22e55c]/45 bg-[#22e55c]/15 text-[#22e55c]'
                  : nodeData.diffStatus === 'modified'
                    ? 'border-[#f59e0b]/45 bg-[#f59e0b]/15 text-[#fbbf24]'
                    : 'border-[#f43f5e]/45 bg-[#f43f5e]/15 text-[#fb7185]'
              }`}
            >
              {nodeData.diffStatus === 'added'
                ? '+ ADDED'
                : nodeData.diffStatus === 'modified'
                  ? '~ MODIFIED'
                  : '- REMOVED'}
            </span>
          ) : nodeData.debugStatus === 'active' ? (
            <span className="rounded border border-[#22e55c]/50 bg-[#22e55c]/20 px-1.5 py-0.2 font-mono text-[9px] font-bold text-[#39ff14]">
              ▶ BREAKPOINT
            </span>
          ) : nodeData.durationMs !== undefined ? (
            <span className="font-mono text-[10px] font-semibold tabular-nums text-[#22e55c]">
              {nodeData.durationMs}ms
            </span>
          ) : kind === 'ai_agent' ? (
            <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/[0.10] px-1.5 py-0.2 font-mono text-[9px] font-bold text-[#22e55c]">
              LLM
            </span>
          ) : null}
        </div>

        {/* Node Title */}
        <div className="mt-1 truncate text-[13px] font-semibold tracking-tight text-[#f1f5f9]">
          {nodeData.label}
        </div>

        {/* Monospace Command / Endpoint Strip */}
        <div className="mt-2 truncate rounded border border-[#262c32] bg-[#111417] px-2 py-1 font-mono text-[10.5px] text-[#c7d1db]">
          {preview}
        </div>

        {/* Footer row: Status or Compensator */}
        <div className="mt-2.5 flex items-center justify-between gap-2">
          {statusInfo && nodeData.status ? (
            <span className={`inline-flex items-center gap-1.5 font-mono text-[9.5px] font-bold uppercase tracking-wider ${statusInfo.text}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${statusInfo.dot}`} />
              {nodeData.status.replace('_', ' ')}
            </span>
          ) : compHandler ? (
            <span className="inline-flex max-w-[170px] items-center gap-1 truncate rounded border border-violet-500/35 bg-violet-500/12 px-1.5 py-0.5 font-mono text-[9.5px] text-violet-300">
              <RotateCcw className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{compHandler}</span>
            </span>
          ) : (
            <span className="font-mono text-[9.5px] uppercase tracking-wider text-zinc-500">
              READY
            </span>
          )}

          <div className="flex items-center gap-1.5">
            {nodeData.attempts !== undefined && nodeData.attempts > 0 && (
              <span className="rounded border border-[#262c32] bg-[#111417] px-1.5 py-0.2 font-mono text-[9.5px] text-zinc-400">
                {nodeData.attempts} {nodeData.attempts === 1 ? 'try' : 'tries'}
              </span>
            )}
            <Radio className="h-3 w-3 text-zinc-600" />
          </div>
        </div>
      </div>

      {isCondition ? (
        <>
          <Handle
            type="source"
            id="true"
            position={Position.Right}
            style={{ top: '34%' }}
            className="!h-2.5 !w-2.5 !border-2 !border-[#0c0e10] !bg-[#22e55c]"
          />
          <Handle
            type="source"
            id="false"
            position={Position.Right}
            style={{ top: '70%' }}
            className="!h-2.5 !w-2.5 !border-2 !border-[#0c0e10] !bg-rose-400"
          />
          <span className="pointer-events-none absolute right-2.5 top-[27%] font-mono text-[9px] font-bold text-[#22e55c]">
            T
          </span>
          <span className="pointer-events-none absolute right-2.5 top-[63%] font-mono text-[9px] font-bold text-rose-400">
            F
          </span>
        </>
      ) : (
        <Handle
          type="source"
          position={Position.Right}
          className="!h-2.5 !w-2.5 !border-2 !border-[#0c0e10] !bg-[#22e55c]"
        />
      )}
    </div>
  );
};
