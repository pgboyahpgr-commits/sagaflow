import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import {
  AlertTriangle,
  BookTemplate,
  Bot,
  Bug,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Code2,
  Cpu,
  Database,
  Download,
  Filter,
  FlaskConical,
  GitBranch,
  Globe,
  History,
  Layers,
  LayoutGrid,
  Mail,
  MessageSquare,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Repeat,
  Rocket,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldAlert,
  Shuffle,
  Sparkles,
  Split,
  Trash2,
  Upload,
  UserCheck,
  X,
  Zap,
} from 'lucide-react';
import {
  CUSTOM_TASK_HANDLERS,
  type DryRunWorkflowResult,
  type Workflow,
  type WorkflowDiffSummary,
  type WorkflowEdge,
  type WorkflowListItem,
  type WorkflowNode,
  type WorkflowVersionSummary,
} from '@sagaflow/shared';
import { WORKFLOW_BLUEPRINTS, type WorkflowBlueprint } from './blueprints';
import { api, type TenantSession } from '../lib/api';
import { SagaNode, type SagaNodeData } from './SagaNode';
import { StatusBadge } from './StatusBadge';

const nodeTypes = { sagaNode: SagaNode };

interface WorkflowStudioProps {
  session: TenantSession;
  tenantSlug: string;
  initialWorkflowId?: string | null;
  onRunStarted: (runId: string) => void;
  onOpenAiAgent?: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'err' | 'info') => void;
}

type NodeCategory =
  | 'Triggers'
  | 'Data & Logic'
  | 'Integrations & Comms'
  | 'Code & AI'
  | 'Sagas & Governance';

const NODE_CATEGORIES: NodeCategory[] = [
  'Triggers',
  'Data & Logic',
  'Integrations & Comms',
  'Code & AI',
  'Sagas & Governance',
];

const NODE_PALETTE: Array<{
  type: WorkflowNode['type'];
  category: NodeCategory;
  label: string;
  short: string;
  summary: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  defaultConfig: Record<string, unknown>;
}> = [
  {
    type: 'trigger',
    category: 'Triggers',
    label: 'Webhook / Manual / Cron Trigger',
    short: 'Trigger',
    summary: 'Entrypoint that kicks off a workflow via API, webhook, or schedule.',
    icon: Zap,
    color: 'text-[#22e55c]',
    defaultConfig: { triggerType: 'webhook' },
  },
  {
    type: 'transform',
    category: 'Data & Logic',
    label: 'Transform / Data Mapper',
    short: 'Transform',
    summary: 'Reshape, rename, and map JSON fields with {{...}} templates — zero code.',
    icon: Shuffle,
    color: 'text-emerald-300',
    defaultConfig: {
      mergeWithInput: true,
      mappings: {
        summary: 'Order {{input.orderId}}',
        normalizedAt: '{{env.runId}}',
      },
    },
  },
  {
    type: 'filter',
    category: 'Data & Logic',
    label: 'Filter / Guard',
    short: 'Filter',
    summary: 'Continue only when a field matches a rule, or skip/fail downstream steps.',
    icon: Filter,
    color: 'text-sky-300',
    defaultConfig: {
      field: '{{input.amount}}',
      operator: 'gte',
      value: 100,
      onFail: 'skip_downstream',
    },
  },
  {
    type: 'condition',
    category: 'Data & Logic',
    label: 'If / Else Branch',
    short: 'If / Else',
    summary: 'Split execution into True and False branches using an expression.',
    icon: GitBranch,
    color: 'text-violet-300',
    defaultConfig: { expression: '(input.amount ?? 100) >= 100' },
  },
  {
    type: 'switch',
    category: 'Data & Logic',
    label: 'Switch (Multi-Way Router)',
    short: 'Switch',
    summary: 'Route payloads to 3+ named branches (e.g. urgent, billing, default).',
    icon: Split,
    color: 'text-violet-300',
    defaultConfig: {
      expression: '{{input.category}}',
      defaultCase: 'default',
      cases: [
        { key: 'urgent', label: 'Urgent', operator: 'eq', value: 'urgent' },
        { key: 'billing', label: 'Billing', operator: 'eq', value: 'billing' },
      ],
    },
  },
  {
    type: 'for_each',
    category: 'Data & Logic',
    label: 'For-Each Loop Fan-Out',
    short: 'For-Each',
    summary: 'Iterate any runtime array concurrently with atomic per-item rollback.',
    icon: Repeat,
    color: 'text-[#73ff86]',
    defaultConfig: {
      itemsExpression: '{{input.items}}',
      mode: 'custom_task',
      itemHandler: 'reserve_inventory',
      itemCompensationHandler: 'release_inventory',
      maxConcurrency: 4,
      itemConfig: { sku: '{{input.item.sku}}', qty: '{{input.item.qty}}' },
    },
  },
  {
    type: 'wait',
    category: 'Data & Logic',
    label: 'Wait / Delay',
    short: 'Wait',
    summary: 'Pause execution for a configured duration before continuing.',
    icon: Clock,
    color: 'text-zinc-300',
    defaultConfig: { delayMs: 250 },
  },
  {
    type: 'http_request',
    category: 'Integrations & Comms',
    label: 'HTTP Request',
    short: 'HTTP',
    summary: 'Call any REST/GraphQL API or live tenant webhook sink with retries.',
    icon: Globe,
    color: 'text-[#22e55c]',
    defaultConfig: {
      method: 'POST',
      url: '/api/sink/{{env.tenantId}}/events',
      headers: { 'Content-Type': 'application/json' },
      body: { orderId: '{{input.orderId}}', runId: '{{env.runId}}' },
    },
  },
  {
    type: 'email',
    category: 'Integrations & Comms',
    label: 'Email Dispatch',
    short: 'Email',
    summary: 'Send transactional emails via Resend, webhook, or local tenant inbox.',
    icon: Mail,
    color: 'text-sky-300',
    defaultConfig: {
      provider: 'sink',
      to: '{{input.email}}',
      subject: 'Update on {{input.orderId}}',
      body: 'Your request has been processed cleanly.',
    },
  },
  {
    type: 'slack_discord',
    category: 'Integrations & Comms',
    label: 'Slack / Discord / Teams',
    short: 'Slack / Chat',
    summary: 'Post formatted Block Kit, Discord Embed, or Teams messages to chat.',
    icon: MessageSquare,
    color: 'text-indigo-300',
    defaultConfig: {
      platform: 'slack',
      channelName: '#alerts',
      severity: 'info',
      title: 'Automation Event',
      message: 'Triggered for {{input.orderId}}',
    },
  },
  {
    type: 'database',
    category: 'Integrations & Comms',
    label: 'Database / KV Store',
    short: 'Database',
    summary: 'Get, Set, Increment, List, or Delete tenant DB rows with auto-rollback.',
    icon: Database,
    color: 'text-[#73ff86]',
    defaultConfig: {
      operation: 'set',
      collection: 'records',
      key: '{{input.id}}',
      value: { status: 'active' },
    },
  },
  {
    type: 'script',
    category: 'Code & AI',
    label: 'JavaScript (QuickJS-WASM)',
    short: 'JS / WASM',
    summary: 'Run custom JS safely inside an isolated WebAssembly sandbox.',
    icon: Code2,
    color: 'text-amber-300',
    defaultConfig: {
      code: 'const amount = Number(input.amount ?? 150);\nreturn { total: Number((amount * 1.08).toFixed(2)), currency: "USD" };',
    },
  },
  {
    type: 'ai_agent',
    category: 'Code & AI',
    label: 'AI Agent (LM Studio / Gemini)',
    short: 'AI Agent',
    summary: 'Classify, summarize, or make decisions with local LLMs or Gemini.',
    icon: Bot,
    color: 'text-[#22e55c]',
    defaultConfig: {
      provider: 'default',
      expectJson: true,
      systemPrompt:
        'You are a SagaFlow autonomous step agent. Return concise valid JSON with decision and reason.',
      prompt: 'Analyze order {{input.orderId}} (amount ${{input.amount}}) and return JSON.',
    },
  },
  {
    type: 'custom_task',
    category: 'Sagas & Governance',
    label: 'Transactional Saga Task',
    short: 'Saga Task',
    summary: 'Run ACID business handlers (Inventory, Wallet, Credits) with rollback.',
    icon: Cpu,
    color: 'text-[#22e55c]',
    defaultConfig: {
      handler: 'reserve_inventory',
      compensationHandler: 'release_inventory',
      sku: 'SKU-PRO-900',
      qty: 1,
    },
  },
  {
    type: 'approval',
    category: 'Sagas & Governance',
    label: 'Human Approval Gate (SLA)',
    short: 'Approval',
    summary: 'Pause with zero worker threads for human sign-off + SLA auto-action.',
    icon: UserCheck,
    color: 'text-amber-300',
    defaultConfig: {
      approverRole: 'Operations Lead',
      prompt: 'Approve execution for {{input.orderId}} (${{input.amount}})?',
      slaMinutes: 60,
      onTimeout: 'reject',
    },
  },
  {
    type: 'sub_workflow',
    category: 'Sagas & Governance',
    label: 'Nested Sub-Workflow',
    short: 'Sub-Flow',
    summary: 'Call another published workflow with lineage tracing & depth guard.',
    icon: Layers,
    color: 'text-[#c084fc]',
    defaultConfig: {
      workflowId: 'wf_conditional_router',
      timeoutMs: 15000,
      input: { orderId: '{{input.orderId}}', amount: '{{input.amount}}' },
    },
  },
];

const HANDLER_HELP: Record<string, { commit: string; rollback: string }> = {
  reserve_inventory: {
    commit: 'Decrements tenant_inventory.available & increments reserved in DB.',
    rollback: 'release_inventory restores exact available & reserved stock.',
  },
  allocate_credits: {
    commit: 'Locks loyalty_credits balance inside tenant_balances.',
    rollback: 'revert_credits unlocks & refunds exact credits.',
  },
  charge_payment: {
    commit: 'Debits customer_wallet and credits merchant_revenue atomically.',
    rollback: 'refund_payment reverses wallet debit and merchant revenue.',
  },
  create_shipment: {
    commit: 'Commits reserved inventory out of warehouse and logs shipment.',
    rollback: 'cancel_shipment restores committed stock & cancels label.',
  },
  send_notification: {
    commit: 'Records a real persistent webhook delivery to tenant notifications sink.',
    rollback: 'No rollback needed (idempotent notification).',
  },
  sync_customs: {
    commit: 'Persists customs manifest record into tenant KV & Saga ledger.',
    rollback: 'cancel_customs marks manifest cancelled & deletes KV record.',
  },
  kv_set: {
    commit: 'Writes a JSON value to tenant_kv with before-snapshot.',
    rollback: 'kv_revert restores prior value or removes key if new.',
  },
  audit_log: {
    commit: 'Appends an immutable audit entry into saga_ledger.',
    rollback: 'Append-only audit trail.',
  },
};

function toFlowNodes(nodes: WorkflowNode[]): Node<SagaNodeData>[] {
  return nodes.map((n) => ({
    id: n.id,
    type: 'sagaNode',
    position: n.position ?? { x: 100, y: 120 },
    data: {
      label: n.label ?? n.id,
      nodeType: n.type,
      config: n.config ?? {},
      isCompensatable: Boolean(n.config?.compensationHandler || n.config?.compensationUrl),
    },
  }));
}

function toFlowEdges(edges: WorkflowEdge[]): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    sourceHandle: e.condition === 'true' ? 'true' : e.condition === 'false' ? 'false' : undefined,
    label: e.label ?? (e.condition ? e.condition.toUpperCase() : undefined),
    animated: false,
    style: {
      stroke: e.condition === 'true' ? '#22e55c' : e.condition === 'false' ? '#fb7185' : '#808d99',
      strokeWidth: 2,
    },
    labelStyle: { fill: '#f1f5f9', fontSize: 10, fontWeight: 600 },
    labelBgStyle: { fill: '#15191d', fillOpacity: 0.92 },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: e.condition === 'true' ? '#22e55c' : e.condition === 'false' ? '#fb7185' : '#808d99',
    },
    data: { condition: e.condition },
  }));
}

function fromFlowGraph(
  nodes: Node<SagaNodeData>[],
  edges: Edge[]
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.nodeType ?? n.data.stepType ?? 'custom_task',
      label: n.data.label,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      config: n.data.config ?? {},
    })),
    edges: edges.map((e) => {
      const cond =
        e.sourceHandle === 'true'
          ? 'true'
          : e.sourceHandle === 'false'
          ? 'false'
          : (e.data?.condition as 'true' | 'false' | undefined);
      return {
        id: e.id,
        from: e.source,
        to: e.target,
        label: typeof e.label === 'string' ? e.label : undefined,
        condition: cond,
      };
    }),
  };
}

function autoLayoutNodes(nodes: Node<SagaNodeData>[], edges: Edge[]): Node<SagaNodeData>[] {
  const depth = new Map<string, number>();
  for (const n of nodes) depth.set(n.id, 0);
  for (let pass = 0; pass < nodes.length; pass++) {
    for (const e of edges) {
      const next = (depth.get(e.source) ?? 0) + 1;
      if (next > (depth.get(e.target) ?? 0)) depth.set(e.target, next);
    }
  }
  const cols = new Map<number, Node<SagaNodeData>[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const list = cols.get(d) ?? [];
    list.push(n);
    cols.set(d, list);
  }
  const laidOut: Node<SagaNodeData>[] = [];
  for (const [col, list] of cols.entries()) {
    const startY = Math.max(40, 220 - ((list.length - 1) * 165) / 2);
    list.forEach((n, idx) => {
      laidOut.push({
        ...n,
        position: { x: 48 + col * 305, y: startY + idx * 165 },
      });
    });
  }
  return laidOut;
}

export const WorkflowStudio: React.FC<WorkflowStudioProps> = ({
  session,
  tenantSlug,
  initialWorkflowId,
  onRunStarted,
  onOpenAiAgent,
  onNotify,
}) => {
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([]);
  const [workflowFilter, setWorkflowFilter] = useState('');
  const [activeWorkflow, setActiveWorkflow] = useState<Workflow | null>(null);
  const [versions, setVersions] = useState<WorkflowVersionSummary[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<SagaNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const [busy, setBusy] = useState(false);
  const [showRunModal, setShowRunModal] = useState(false);
  const [showBlueprintModal, setShowBlueprintModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importJsonText, setImportJsonText] = useState('');
  const [showVersions, setShowVersions] = useState(false);
  const [diffFromRef, setDiffFromRef] = useState<string>('1');
  const [diffToRef, setDiffToRef] = useState<string>('draft');
  const [diffData, setDiffData] = useState<WorkflowDiffSummary | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);

  // v6.0 Studio Blueprint Gallery & Step-by-Step Dry-Run Debugger state
  const [showBlueprints, setShowBlueprints] = useState(false);
  const [showDryRun, setShowDryRun] = useState(false);
  const [showNodePicker, setShowNodePicker] = useState(false);
  const [nodePickerQuery, setNodePickerQuery] = useState('');
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const [dryRunInput, setDryRunInput] = useState(
    '{\n  "orderId": "ORD-DRY-6001",\n  "sku": "SKU-PRO-900",\n  "qty": 2,\n  "amount": 1650,\n  "items": [{"sku": "SKU-PRO-900", "qty": 1}, {"sku": "SKU-PRO-900", "qty": 2}]\n}'
  );
  const [dryRunResult, setDryRunResult] = useState<DryRunWorkflowResult | null>(null);
  const [dryRunStepIdx, setDryRunStepIdx] = useState<number>(0);
  const [dryRunBusy, setDryRunBusy] = useState(false);
  const [showChaos, setShowChaos] = useState(false);
  const [vaultSecretNames, setVaultSecretNames] = useState<string[]>([]);
  const [runInputText, setRunInputText] = useState(
    JSON.stringify({ orderId: 'ORD-2026-1001', sku: 'SKU-PRO-900', qty: 2, amount: 249.5, credits: 150 }, null, 2)
  );
  const [idempotencyKey, setIdempotencyKey] = useState('');

  // QuickJS-WASM live sandbox tester
  const [sandboxInput, setSandboxInput] = useState('{"amount": 250, "discountPct": 10}');
  const [sandboxResult, setSandboxResult] = useState<string | null>(null);
  const [sandboxRunning, setSandboxRunning] = useState(false);

  // Live HTTP tester (NO MOCKS)
  const [httpHeadersText, setHttpHeadersText] = useState('{}');
  const [httpBodyText, setHttpBodyText] = useState('{}');
  const [httpTestResult, setHttpTestResult] = useState<string | null>(null);
  const [httpTesting, setHttpTesting] = useState(false);

  const loadWorkflowList = useCallback(
    async (selectId?: string) => {
      try {
        const res = await api.listWorkflows(session);
        setWorkflows(res.workflows);
        const targetId = selectId ?? res.workflows[0]?.id;
        if (targetId) {
          const detail = await api.getWorkflow(session, targetId);
          setActiveWorkflow(detail.workflow);
          setName(detail.workflow.name);
          setDescription(detail.workflow.description ?? '');
          setNodes(toFlowNodes(detail.workflow.nodes));
          setEdges(toFlowEdges(detail.workflow.edges));
          setSelectedNodeId(null);
          setDirty(false);
          const vers = await api.listVersions(session, targetId);
          setVersions(vers.versions);
        } else {
          setActiveWorkflow(null);
          setNodes([]);
          setEdges([]);
          setVersions([]);
        }
      } catch (err) {
        onNotify(err instanceof Error ? err.message : 'Failed to load workflows', 'err');
      }
    },
    [session, setNodes, setEdges, onNotify]
  );

  useEffect(() => {
    void loadWorkflowList(initialWorkflowId ?? undefined);
    api
      .listSecrets(session)
      .then((res) => setVaultSecretNames(res.secrets.map((s) => s.name)))
      .catch(() => setVaultSecretNames([]));
  }, [loadWorkflowList, session, initialWorkflowId]);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );

  // Interactive Upstream Data Picker: discover all ancestor nodes + likely output fields!
  const upstreamTemplates = useMemo(() => {
    const items: Array<{ label: string; expr: string; group: 'input' | 'step' | 'secret' | 'env' }> = [
      { label: 'input.orderId', expr: '{{input.orderId}}', group: 'input' },
      { label: 'input.amount', expr: '{{input.amount}}', group: 'input' },
      { label: 'input.sku', expr: '{{input.sku}}', group: 'input' },
      { label: 'input.qty', expr: '{{input.qty}}', group: 'input' },
      { label: 'env.runId', expr: '{{env.runId}}', group: 'env' },
    ];
    if (selectedNode) {
      // Traverse edges backwards from selectedNodeId to find all upstream ancestor nodes
      const ancestors = new Set<string>();
      const queue = [selectedNode.id];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const e of edges) {
          if (e.target === cur && !ancestors.has(e.source)) {
            ancestors.add(e.source);
            queue.push(e.source);
          }
        }
      }
      for (const n of nodes) {
        if (!ancestors.has(n.id)) continue;
        if (n.data.nodeType === 'script') {
          items.push({ label: `${n.id}.total`, expr: `{{steps.${n.id}.total}}`, group: 'step' });
          items.push({ label: `${n.id}.orderId`, expr: `{{steps.${n.id}.orderId}}`, group: 'step' });
        } else if (n.data.nodeType === 'http_request') {
          items.push({ label: `${n.id}.status`, expr: `{{steps.${n.id}.status}}`, group: 'step' });
          items.push({ label: `${n.id}.body`, expr: `{{steps.${n.id}.body}}`, group: 'step' });
        } else if (n.data.nodeType === 'approval') {
          items.push({ label: `${n.id}.decidedBy`, expr: `{{steps.${n.id}.decidedBy}}`, group: 'step' });
          items.push({ label: `${n.id}.decision`, expr: `{{steps.${n.id}.decision}}`, group: 'step' });
        } else if (n.data.nodeType === 'ai_agent') {
          items.push({ label: `${n.id}.riskLevel`, expr: `{{steps.${n.id}.riskLevel}}`, group: 'step' });
          items.push({ label: `${n.id}.reason`, expr: `{{steps.${n.id}.reason}}`, group: 'step' });
          items.push({ label: `${n.id}.text`, expr: `{{steps.${n.id}.text}}`, group: 'step' });
        } else if (n.data.nodeType === 'custom_task') {
          const h = String(n.data.config?.handler ?? '');
          if (h === 'charge_payment') {
            items.push({ label: `${n.id}.chargeId`, expr: `{{steps.${n.id}.chargeId}}`, group: 'step' });
            items.push({ label: `${n.id}.amount`, expr: `{{steps.${n.id}.amount}}`, group: 'step' });
          } else if (h === 'reserve_inventory') {
            items.push({ label: `${n.id}.reservationId`, expr: `{{steps.${n.id}.reservationId}}`, group: 'step' });
          } else if (h === 'create_shipment') {
            items.push({ label: `${n.id}.trackingNumber`, expr: `{{steps.${n.id}.trackingNumber}}`, group: 'step' });
          }
        }
      }
    }
    for (const s of vaultSecretNames) {
      items.push({ label: `secrets.${s}`, expr: `{{secrets.${s}}}`, group: 'secret' });
    }
    return items;
  }, [selectedNode, nodes, edges, vaultSecretNames]);

  // Sync HTTP JSON editors whenever selected node changes
  useEffect(() => {
    if (selectedNode?.data.nodeType === 'http_request') {
      const cfg = selectedNode.data.config ?? {};
      setHttpHeadersText(JSON.stringify(cfg.headers ?? { 'Content-Type': 'application/json' }, null, 2));
      setHttpBodyText(JSON.stringify(cfg.body ?? {}, null, 2));
      setHttpTestResult(null);
    }
    if (selectedNode?.data.nodeType === 'script') {
      setSandboxResult(null);
    }
    if (selectedNode) {
      const cfg = selectedNode.data.config ?? {};
      setShowChaos(Boolean(cfg.alwaysFail || Number(cfg.simulateFailures ?? cfg.failFirstNAttempts ?? 0) > 0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId]);

  const onConnect = useCallback(
    (connection: Connection) => {
      const cond =
        connection.sourceHandle === 'true'
          ? 'true'
          : connection.sourceHandle === 'false'
          ? 'false'
          : undefined;
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            id: `e_${Date.now().toString(36)}`,
            label: cond ? cond.toUpperCase() : undefined,
            style: {
              stroke: cond === 'true' ? '#22e55c' : cond === 'false' ? '#fb7185' : '#808d99',
              strokeWidth: 2,
            },
            labelStyle: { fill: '#f1f5f9', fontSize: 10, fontWeight: 600 },
            labelBgStyle: { fill: '#15191d', fillOpacity: 0.92 },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: cond === 'true' ? '#22e55c' : cond === 'false' ? '#fb7185' : '#808d99',
            },
            data: { condition: cond },
          },
          eds
        )
      );
      setDirty(true);
    },
    [setEdges]
  );

  const handleSelectWorkflow = async (id: string) => {
    try {
      const detail = await api.getWorkflow(session, id);
      setActiveWorkflow(detail.workflow);
      setName(detail.workflow.name);
      setDescription(detail.workflow.description ?? '');
      setNodes(toFlowNodes(detail.workflow.nodes));
      setEdges(toFlowEdges(detail.workflow.edges));
      setSelectedNodeId(null);
      setDirty(false);
      const vers = await api.listVersions(session, id);
      setVersions(vers.versions);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Could not open workflow', 'err');
    }
  };

  const createFromBlueprint = async (kind: 'blank' | 'saga' | 'http' | 'router') => {
    setBusy(true);
    setShowBlueprintModal(false);
    try {
      const sinkUrl = `/api/sink/${tenantSlug}/workflow-events`;
      const blueprints = {
        blank: {
          name: `Workflow ${workflows.length + 1}`,
          description: 'New durable DAG workflow',
          nodes: [
            { id: 'trigger', type: 'trigger' as const, label: 'Start Trigger', position: { x: 60, y: 180 }, config: { triggerType: 'manual' } },
            {
              id: 'task_1',
              type: 'custom_task' as const,
              label: 'Reserve Inventory',
              position: { x: 380, y: 180 },
              config: { handler: 'reserve_inventory', compensationHandler: 'release_inventory', sku: 'SKU-PRO-900', qty: 1 },
            },
          ],
          edges: [{ id: 'e_1', from: 'trigger', to: 'task_1' }],
        },
        saga: {
          name: 'Real Commerce Saga (Atomic Rollback Ready)',
          description: 'Reserves stock, locks credits, charges wallet, and rolls back automatically on failure.',
          nodes: [
            { id: 'trigger', type: 'trigger' as const, label: 'Order Webhook', position: { x: 40, y: 180 }, config: { triggerType: 'webhook' } },
            {
              id: 'reserve',
              type: 'custom_task' as const,
              label: 'Reserve Stock',
              position: { x: 340, y: 180 },
              config: { handler: 'reserve_inventory', compensationHandler: 'release_inventory', sku: 'SKU-PRO-900', qty: 2 },
            },
            {
              id: 'charge',
              type: 'custom_task' as const,
              label: 'Charge Wallet',
              position: { x: 640, y: 180 },
              config: { handler: 'charge_payment', compensationHandler: 'refund_payment' },
            },
            {
              id: 'notify',
              type: 'http_request' as const,
              label: 'Deliver Receipt (Live Sink)',
              position: { x: 940, y: 180 },
              config: {
                method: 'POST',
                url: sinkUrl,
                headers: { 'Content-Type': 'application/json' },
                body: { event: 'order.paid', orderId: '{{input.orderId}}', charged: '{{steps.charge.amount}}' },
              },
            },
          ],
          edges: [
            { id: 'e1', from: 'trigger', to: 'reserve' },
            { id: 'e2', from: 'reserve', to: 'charge' },
            { id: 'e3', from: 'charge', to: 'notify' },
          ],
        },
        http: {
          name: 'Live HTTP Enrichment & Webhook Pipeline',
          description: 'Computes payload in QuickJS-WASM, calls real live HTTP endpoint with secret header, and persists to KV.',
          nodes: [
            { id: 'trigger', type: 'trigger' as const, label: 'API Trigger', position: { x: 40, y: 180 }, config: { triggerType: 'webhook' } },
            {
              id: 'prepare',
              type: 'script' as const,
              label: 'Build Payload (WASM)',
              position: { x: 340, y: 180 },
              config: {
                code: 'const orderId = input.orderId ?? "ORD-LIVE-1";\nreturn { orderId, dispatchedAt: new Date().toISOString(), amount: Number(input.amount ?? 199) };',
              },
            },
            {
              id: 'dispatch',
              type: 'http_request' as const,
              label: 'POST to Live Sink',
              position: { x: 640, y: 180 },
              config: {
                method: 'POST',
                url: sinkUrl,
                headers: { 'X-Auth': 'Bearer {{secrets.PARTNER_WEBHOOK_TOKEN}}' },
                body: { orderId: '{{steps.prepare.orderId}}', amount: '{{steps.prepare.amount}}' },
                compensationUrl: `${sinkUrl}-cancel`,
                compensationMethod: 'POST',
              },
            },
            {
              id: 'save_kv',
              type: 'custom_task' as const,
              label: 'Persist to Tenant KV',
              position: { x: 940, y: 180 },
              config: {
                handler: 'kv_set',
                compensationHandler: 'kv_revert',
                key: 'last_order:{{steps.prepare.orderId}}',
                value: { status: 'dispatched', httpStatus: '{{steps.dispatch.status}}' },
              },
            },
          ],
          edges: [
            { id: 'e1', from: 'trigger', to: 'prepare' },
            { id: 'e2', from: 'prepare', to: 'dispatch' },
            { id: 'e3', from: 'dispatch', to: 'save_kv' },
          ],
        },
        router: {
          name: 'Conditional Branching Pipeline',
          description: 'Evaluates real QuickJS boolean condition and routes to true/false downstream paths.',
          nodes: [
            { id: 'trigger', type: 'trigger' as const, label: 'Event Trigger', position: { x: 40, y: 180 }, config: { triggerType: 'event' } },
            { id: 'check', type: 'condition' as const, label: 'Amount >= 200?', position: { x: 340, y: 180 }, config: { expression: '(input.amount ?? 0) >= 200' } },
            {
              id: 'high_val',
              type: 'http_request' as const,
              label: 'Alert VIP Sink',
              position: { x: 660, y: 90 },
              config: { method: 'POST', url: `/api/sink/${tenantSlug}/vip-alerts`, body: { tier: 'vip', amount: '{{input.amount}}' } },
            },
            {
              id: 'std_log',
              type: 'custom_task' as const,
              label: 'Record Standard Audit',
              position: { x: 660, y: 270 },
              config: { handler: 'audit_log' },
            },
          ],
          edges: [
            { id: 'e1', from: 'trigger', to: 'check' },
            { id: 'e2', from: 'check', to: 'high_val', label: 'TRUE', condition: 'true' as const },
            { id: 'e3', from: 'check', to: 'std_log', label: 'FALSE', condition: 'false' as const },
          ],
        },
      };

      const res = await api.createWorkflow(session, blueprints[kind]);
      onNotify(`Created "${res.workflow.name}"`, 'ok');
      await loadWorkflowList(res.workflow.id);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to create workflow', 'err');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveDraft = useCallback(async () => {
    if (!activeWorkflow) return;
    setBusy(true);
    try {
      const graph = fromFlowGraph(nodes, edges);
      const res = await api.saveWorkflow(session, activeWorkflow.id, {
        name,
        description,
        nodes: graph.nodes,
        edges: graph.edges,
      });
      setActiveWorkflow(res.workflow);
      setDirty(false);
      onNotify('Draft validated and saved to database', 'ok');
      const list = await api.listWorkflows(session);
      setWorkflows(list.workflows);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Validation failed', 'err');
    } finally {
      setBusy(false);
    }
  }, [activeWorkflow, nodes, edges, session, name, description, onNotify]);

  const handlePublish = async () => {
    if (!activeWorkflow) return;
    setBusy(true);
    try {
      const graph = fromFlowGraph(nodes, edges);
      await api.saveWorkflow(session, activeWorkflow.id, {
        name,
        description,
        nodes: graph.nodes,
        edges: graph.edges,
      });
      const res = await api.publishWorkflow(session, activeWorkflow.id);
      setActiveWorkflow(res.workflow);
      setDirty(false);
      const vers = await api.listVersions(session, activeWorkflow.id);
      setVersions(vers.versions);
      const list = await api.listWorkflows(session);
      setWorkflows(list.workflows);
      onNotify(`Published immutable version v${res.version.versionNumber}`, 'ok');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Publish failed', 'err');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteWorkflow = async () => {
    if (!activeWorkflow) return;
    if (!window.confirm(`Delete workflow "${activeWorkflow.name}" and its schedules?`)) return;
    setBusy(true);
    try {
      await api.deleteWorkflow(session, activeWorkflow.id);
      onNotify(`Deleted "${activeWorkflow.name}"`, 'info');
      await loadWorkflowList();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Delete failed', 'err');
    } finally {
      setBusy(false);
    }
  };

  const handleExportJson = async () => {
    if (!activeWorkflow) return;
    try {
      const data = await api.exportWorkflow(session, activeWorkflow.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${activeWorkflow.id}.sagaflow.json`;
      a.click();
      URL.revokeObjectURL(url);
      onNotify(`Exported "${activeWorkflow.name}" as portable JSON`, 'ok');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Export failed', 'err');
    }
  };

  const handleImportJson = async () => {
    if (!importJsonText.trim()) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(importJsonText);
      const res = await api.importWorkflow(session, parsed);
      setShowImportModal(false);
      setImportJsonText('');
      onNotify(`Imported "${res.workflow.name}" cleanly`, 'ok');
      await loadWorkflowList(res.workflow.id);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Invalid workflow JSON', 'err');
    } finally {
      setBusy(false);
    }
  };

  // Keyboard shortcuts: Cmd/Ctrl+S save, Cmd/Ctrl+Enter open run modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSaveDraft();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && activeWorkflow?.latestVersion) {
        e.preventDefault();
        setIdempotencyKey(`run_${Date.now()}`);
        setShowRunModal(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSaveDraft, activeWorkflow]);

  const addNodeToCanvas = (paletteItem: (typeof NODE_PALETTE)[number]) => {
    const id = `${paletteItem.type}_${Date.now().toString(36).slice(-4)}`;
    const maxX = nodes.reduce((acc, n) => Math.max(acc, n.position.x), 80);
    const defaultCfg = { ...paletteItem.defaultConfig };
    if (paletteItem.type === 'http_request') {
      defaultCfg.url = `/api/sink/${tenantSlug}/events`;
    }
    const newNode: Node<SagaNodeData> = {
      id,
      type: 'sagaNode',
      position: { x: Math.min(maxX + 180, 960), y: 120 + (nodes.length % 4) * 95 },
      data: {
        label: paletteItem.label,
        nodeType: paletteItem.type,
        config: defaultCfg,
        isCompensatable: Boolean(defaultCfg.compensationHandler),
      },
    };
    setNodes((nds) => [...nds, newNode]);
    setSelectedNodeId(id);
    setDirty(true);
  };

  const updateSelectedNode = (patch: Partial<SagaNodeData>) => {
    if (!selectedNodeId) return;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === selectedNodeId
          ? {
              ...n,
              data: {
                ...n.data,
                ...patch,
                isCompensatable: Boolean(
                  (patch.config ?? n.data.config)?.compensationHandler ||
                    (patch.config ?? n.data.config)?.compensationUrl
                ),
              },
            }
          : n
      )
    );
    setDirty(true);
  };

  const updateSelectedConfig = (key: string, value: unknown) => {
    if (!selectedNode) return;
    const nextConfig = { ...selectedNode.data.config };
    if (value === undefined || value === '') {
      delete nextConfig[key];
    } else {
      nextConfig[key] = value;
    }
    updateSelectedNode({ config: nextConfig });
  };

  const deleteSelectedNode = () => {
    if (!selectedNodeId) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
    setDirty(true);
  };

  const handleStartRun = async () => {
    if (!activeWorkflow) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(runInputText) as Record<string, unknown>;
      const key = idempotencyKey.trim() || `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const res = await api.startRun(session, activeWorkflow.id, { input: parsed }, key);
      setShowRunModal(false);
      onNotify(`Run ${res.run.id} accepted and executing live`, 'ok');
      onRunStarted(res.run.id);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Could not start run', 'err');
    } finally {
      setBusy(false);
    }
  };

  const handleTestSandbox = async () => {
    if (!selectedNode || selectedNode.data.nodeType !== 'script') return;
    setSandboxRunning(true);
    setSandboxResult(null);
    try {
      const parsedInput = JSON.parse(sandboxInput) as Record<string, unknown>;
      const res = await api.testSandbox(session, {
        code: String(selectedNode.data.config.code ?? ''),
        input: parsedInput,
        timeoutMs: Number(selectedNode.data.config.timeoutMs ?? 2000),
      });
      setSandboxResult(JSON.stringify(res.result, null, 2));
    } catch (err) {
      setSandboxResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSandboxRunning(false);
    }
  };

  const handleTestLiveHttp = async () => {
    if (!selectedNode || selectedNode.data.nodeType !== 'http_request') return;
    setHttpTesting(true);
    setHttpTestResult(null);
    try {
      const cfg = selectedNode.data.config;
      const method = (String(cfg.method ?? 'POST') as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE');
      const url = String(cfg.url ?? '').trim();
      if (!url) throw new Error('Enter a target URL first.');
      const headers = httpHeadersText.trim() ? (JSON.parse(httpHeadersText) as Record<string, string>) : {};
      const body = method === 'GET' ? undefined : httpBodyText.trim() ? JSON.parse(httpBodyText) : undefined;
      const res = await api.testHttpRequest(session, { method, url, headers, body });
      setHttpTestResult(JSON.stringify(res, null, 2));
    } catch (err) {
      setHttpTestResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setHttpTesting(false);
    }
  };

  const currentHandler = String(selectedNode?.data.config.handler ?? 'reserve_inventory');
  const handlerHelp = HANDLER_HELP[currentHandler];

  const filteredWorkflows = workflows.filter((wf) => {
    const q = workflowFilter.trim().toLowerCase();
    if (!q) return true;
    return wf.name.toLowerCase().includes(q) || wf.id.toLowerCase().includes(q);
  });

  return (
    <div className="flex h-full min-h-0 flex-1 overflow-hidden">
      {/* LEFT SIDEBAR: WORKFLOWS */}
      <aside className="flex w-[256px] shrink-0 flex-col border-r border-[#1c2227] bg-[#111417]">
        <div className="border-b border-[#1c2227] px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-mono text-[10.5px] font-bold tracking-[0.1em] text-zinc-400">
              <span>WORKFLOWS</span>
              <span className="rounded bg-[#1c2227] px-1.5 py-0.2 text-[10px] text-zinc-300">
                {workflows.length}
              </span>
            </div>
            <button
              onClick={() => setShowBlueprintModal(true)}
              disabled={busy}
              className="sf-btn-neon flex items-center gap-1 rounded px-2 py-1 font-mono text-[10.5px]"
            >
              <Plus className="h-3 w-3" /> NEW
            </button>
          </div>
          <div className="relative mt-2.5">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              value={workflowFilter}
              onChange={(e) => setWorkflowFilter(e.target.value)}
              placeholder="Filter sagas (⌘K)..."
              className="w-full rounded border border-[#262c32] bg-[#0c0e10] py-1.5 pl-8 pr-2.5 font-mono text-[11px] text-zinc-200 placeholder-zinc-500 focus:border-[#22e55c]/50 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex-1 space-y-1.5 overflow-y-auto p-2.5">
          {filteredWorkflows.map((wf) => {
            const active = wf.id === activeWorkflow?.id;
            return (
              <button
                key={wf.id}
                onClick={() => void handleSelectWorkflow(wf.id)}
                className={`group w-full rounded-md border px-2.5 py-2 text-left transition ${
                  active
                    ? 'border-[#2f373f] bg-[#15191d] shadow-[inset_2px_0_0_#22e55c]'
                    : 'border-[#1c2227] bg-[#111417] hover:border-[#2f373f]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`truncate font-mono text-[11.5px] font-semibold ${
                      active ? 'text-[#22e55c]' : 'text-zinc-100'
                    }`}
                  >
                    {wf.id}
                  </span>
                  <span className="shrink-0 rounded border border-[#262c32] bg-[#0c0e10] px-1.5 py-0.2 font-mono text-[9.5px] font-semibold text-zinc-300">
                    {wf.latestVersion ? `v${wf.latestVersion}` : 'DRAFT'}
                  </span>
                </div>
                <div className="mt-1 truncate text-[11px] text-zinc-400">{wf.name}</div>
                <div className="mt-2 flex items-center justify-between font-mono text-[9.5px]">
                  <span className="text-zinc-500">{wf.nodeCount} nodes</span>
                  <span
                    className={
                      wf.status === 'published'
                        ? 'font-semibold text-[#22e55c]'
                        : 'text-amber-300'
                    }
                  >
                    {wf.status === 'published' ? '● ACID SAFE' : '● UNPUBLISHED'}
                  </span>
                </div>
              </button>
            );
          })}
          {filteredWorkflows.length === 0 && (
            <div className="rounded-md border border-dashed border-[#262c32] p-6 text-center font-mono text-xs text-zinc-500">
              No matching sagas.
            </div>
          )}
        </div>

        <div className="space-y-1 border-t border-[#1c2227] bg-[#0c0e10] p-3 font-mono text-[10px] text-zinc-500">
          <div className="flex items-center justify-between">
            <span>Save Draft</span>
            <kbd className="rounded border border-[#262c32] bg-[#15191d] px-1.5 py-0.2 text-zinc-300">⌘S</kbd>
          </div>
          <div className="flex items-center justify-between">
            <span>Launch Run</span>
            <kbd className="rounded border border-[#262c32] bg-[#15191d] px-1.5 py-0.2 text-zinc-300">⌘↵</kbd>
          </div>
          <div className="flex items-center justify-between">
            <span>Delete Selected</span>
            <kbd className="rounded border border-rose-500/30 bg-rose-500/10 px-1.5 py-0.2 text-rose-300">Del</kbd>
          </div>
        </div>
      </aside>

      {/* CENTER: CALM TOP BAR + SPACIOUS DAG CANVAS + SEARCHABLE 16-NODE PICKER */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[#0c0e10]">
        {/* Calm, Uncluttered Workflow Header Bar */}
        <div className="flex items-center justify-between gap-3 border-b border-[#1c2227] bg-[#111417] px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
              placeholder={activeWorkflow ? 'Workflow name...' : 'No workflow selected'}
              disabled={!activeWorkflow}
              className="min-w-[100px] flex-1 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-[#f1f5f9] outline-none hover:border-[#262c32] focus:border-[#22e55c]/60 focus:bg-[#15191d] disabled:opacity-50"
            />
            {dirty && (
              <span className="shrink-0 rounded-full border border-amber-400/40 bg-amber-500/12 px-2 py-0.5 font-mono text-[10px] font-medium text-amber-300">
                Unsaved
              </span>
            )}
            {activeWorkflow?.latestVersion && (
              <span className="shrink-0 rounded-full border border-[#22e55c]/35 bg-[#22e55c]/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-[#22e55c]">
                v{activeWorkflow.latestVersion}
              </span>
            )}
          </div>

          <div className="relative flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setShowNodePicker((v) => !v);
                setNodePickerQuery('');
              }}
              disabled={!activeWorkflow}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
                showNodePicker
                  ? 'border-[#22e55c] bg-[#22e55c]/15 text-[#22e55c]'
                  : 'border-[#262c32] bg-[#15191d] text-[#f1f5f9] hover:border-[#22e55c]/50 hover:text-[#22e55c]'
              }`}
            >
              <Plus className="h-3.5 w-3.5" />
              Add Node
            </button>

            <button
              type="button"
              onClick={() => setShowDryRun((v) => !v)}
              disabled={!activeWorkflow}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition disabled:opacity-40 ${
                showDryRun
                  ? 'border-[#22e55c] bg-[#22e55c]/15 text-[#39ff14]'
                  : 'border-[#262c32] bg-[#15191d] text-[#c7d1db] hover:border-[#2f373f] hover:text-white'
              }`}
              title="Safe zero-mutation step-by-step Dry-Run Debugger"
            >
              <Bug className="h-3.5 w-3.5" />
              Test
            </button>

            <button
              type="button"
              onClick={() => void handlePublish()}
              disabled={busy || !activeWorkflow}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#22e55c]/45 bg-[#111813] px-3 py-1.5 text-xs font-medium text-[#22e55c] transition hover:bg-[#162319] disabled:opacity-40"
            >
              <Rocket className="h-3.5 w-3.5" />
              Publish
            </button>

            <button
              type="button"
              onClick={() => {
                setIdempotencyKey(`run_${Date.now()}`);
                setShowRunModal(true);
              }}
              disabled={busy || !activeWorkflow?.latestVersion}
              title={
                activeWorkflow?.latestVersion
                  ? 'Execute published version'
                  : 'Publish the workflow first to run it'
              }
              className="sf-btn-neon inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-xs font-semibold disabled:opacity-40"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              Run
            </button>

            {/* Clean More Menu (keeps secondary power tools 1 click away, never cluttering the bar) */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowMoreMenu((v) => !v)}
                className="inline-flex items-center justify-center rounded-md border border-[#262c32] bg-[#15191d] p-1.5 text-[#c7d1db] transition hover:border-[#2f373f] hover:text-white"
                title="More actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {showMoreMenu && (
                <>
                  <div
                    className="fixed inset-0 z-30"
                    onClick={() => setShowMoreMenu(false)}
                  />
                  <div className="absolute right-0 top-10 z-40 w-52 overflow-hidden rounded-lg border border-[#2f373f] bg-[#15191d] p-1.5 shadow-2xl">
                    <button
                      type="button"
                      disabled={busy || !activeWorkflow}
                      onClick={() => {
                        setShowMoreMenu(false);
                        void handleSaveDraft();
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-[#f1f5f9] hover:bg-[#1c2227] disabled:opacity-40"
                    >
                      <Save className="h-3.5 w-3.5 text-[#808d99]" />
                      Save Draft
                    </button>
                    <button
                      type="button"
                      disabled={!activeWorkflow}
                      onClick={() => {
                        setShowMoreMenu(false);
                        setNodes((nds) => autoLayoutNodes(nds, edges));
                        setDirty(true);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-[#f1f5f9] hover:bg-[#1c2227] disabled:opacity-40"
                    >
                      <LayoutGrid className="h-3.5 w-3.5 text-[#808d99]" />
                      Auto-Layout Canvas
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowMoreMenu(false);
                        setShowBlueprints(true);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-[#f1f5f9] hover:bg-[#1c2227]"
                    >
                      <BookTemplate className="h-3.5 w-3.5 text-[#22e55c]" />
                      Templates Gallery
                    </button>
                    <button
                      type="button"
                      disabled={!activeWorkflow}
                      onClick={() => {
                        setShowMoreMenu(false);
                        setShowVersions((v) => !v);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-[#f1f5f9] hover:bg-[#1c2227] disabled:opacity-40"
                    >
                      <History className="h-3.5 w-3.5 text-[#808d99]" />
                      Versions &amp; DAG Diff ({versions.length})
                    </button>
                    {onOpenAiAgent && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowMoreMenu(false);
                          onOpenAiAgent();
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-violet-300 hover:bg-violet-500/10"
                      >
                        <Sparkles className="h-3.5 w-3.5" />
                        Build with AI Copilot
                      </button>
                    )}
                    <div className="my-1 border-t border-[#262c32]" />
                    <button
                      type="button"
                      onClick={() => {
                        setShowMoreMenu(false);
                        setShowImportModal(true);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-[#c7d1db] hover:bg-[#1c2227]"
                    >
                      <Upload className="h-3.5 w-3.5 text-[#808d99]" />
                      Import JSON
                    </button>
                    <button
                      type="button"
                      disabled={!activeWorkflow}
                      onClick={() => {
                        setShowMoreMenu(false);
                        void handleExportJson();
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-[#c7d1db] hover:bg-[#1c2227] disabled:opacity-40"
                    >
                      <Download className="h-3.5 w-3.5 text-[#808d99]" />
                      Export JSON
                    </button>
                    <div className="my-1 border-t border-[#262c32]" />
                    <button
                      type="button"
                      disabled={busy || !activeWorkflow}
                      onClick={() => {
                        setShowMoreMenu(false);
                        void handleDeleteWorkflow();
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-rose-400 hover:bg-rose-500/10 disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete Workflow
                    </button>
                  </div>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowInspector((v) => !v)}
              title={showInspector || selectedNode ? 'Hide Inspector' : 'Open Inspector'}
              className="inline-flex items-center justify-center rounded-md border border-[#262c32] bg-[#15191d] p-1.5 text-[#c7d1db] transition hover:border-[#2f373f] hover:text-white"
            >
              {showInspector || selectedNode ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {/* Version History, Visual DAG Diff & 1-Click Restore Panel */}
        {showVersions && (
          <div className="space-y-2.5 border-b border-[#262c32] bg-[#15191d] px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#808d99]">
                  IMMUTABLE SNAPSHOTS:
                </span>
                {versions.length === 0 ? (
                  <span className="font-mono text-[11px] text-[#808d99]">
                    Not published yet — click Publish to freeze v1.
                  </span>
                ) : (
                  versions.map((v) => (
                    <span
                      key={v.id}
                      className="inline-flex items-center gap-1.5 rounded border border-[#262c32] bg-[#111417] px-2 py-0.5 font-mono text-[11px] text-[#c7d1db]"
                    >
                      <span className="font-bold text-[#22e55c]">v{v.versionNumber}</span>
                      <span className="text-[#808d99]">
                        · {new Date(v.createdAt).toLocaleTimeString()}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={async () => {
                          if (!activeWorkflow) return;
                          setBusy(true);
                          try {
                            const res = await api.restoreWorkflowVersion(
                              session,
                              activeWorkflow.id,
                              v.versionNumber
                            );
                            setActiveWorkflow(res.workflow);
                            setNodes(toFlowNodes(res.workflow.nodes));
                            setEdges(toFlowEdges(res.workflow.edges));
                            setName(res.workflow.name);
                            setDirty(false);
                            onNotify(`Restored v${v.versionNumber} into editable draft`, 'ok');
                          } catch (err) {
                            onNotify(
                              err instanceof Error ? err.message : 'Version restore failed',
                              'err'
                            );
                          } finally {
                            setBusy(false);
                          }
                        }}
                        className="ml-1 inline-flex items-center gap-0.5 rounded border border-[#a855f7]/35 bg-[#a855f7]/[0.10] px-1.5 py-0.2 text-[9.5px] font-semibold text-[#c084fc] hover:bg-[#a855f7]/20"
                        title={`Restore v${v.versionNumber} to Draft`}
                      >
                        <RotateCcw className="h-2.5 w-2.5" /> Restore
                      </button>
                    </span>
                  ))
                )}
              </div>

              {versions.length > 0 && activeWorkflow && (
                <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px]">
                  <span className="text-[#808d99]">DIFF:</span>
                  <select
                    value={diffFromRef}
                    onChange={(e) => setDiffFromRef(e.target.value)}
                    className="sf-input px-2 py-1 text-[10.5px]"
                  >
                    {versions.map((v) => (
                      <option key={v.id} value={String(v.versionNumber)}>
                        v{v.versionNumber}
                      </option>
                    ))}
                  </select>
                  <span className="text-[#808d99]">→</span>
                  <select
                    value={diffToRef}
                    onChange={(e) => setDiffToRef(e.target.value)}
                    className="sf-input px-2 py-1 text-[10.5px]"
                  >
                    <option value="draft">Current Draft</option>
                    {versions.map((v) => (
                      <option key={v.id} value={String(v.versionNumber)}>
                        v{v.versionNumber}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={diffBusy}
                    onClick={async () => {
                      setDiffBusy(true);
                      try {
                        if (dirty) {
                          const graph = fromFlowGraph(nodes, edges);
                          await api.saveWorkflow(session, activeWorkflow.id, {
                            name,
                            description,
                            nodes: graph.nodes,
                            edges: graph.edges,
                          });
                          setDirty(false);
                        }
                        const res = await api.diffWorkflowVersions(
                          session,
                          activeWorkflow.id,
                          diffFromRef,
                          diffToRef
                        );
                        setDiffData(res.diff);
                      } catch (err) {
                        onNotify(err instanceof Error ? err.message : 'Diff failed', 'err');
                      } finally {
                        setDiffBusy(false);
                      }
                    }}
                    className="sf-btn-primary px-2.5 py-1 text-[10px] uppercase"
                  >
                    {diffBusy ? 'Comparing...' : 'Compare DAG'}
                  </button>
                </div>
              )}
            </div>

            {diffData && (
              <div className="rounded border border-[#262c32] bg-[#111417] p-3 font-mono text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-[#f1f5f9]">
                    DAG Diff: <span className="text-[#808d99]">{diffData.fromRef}</span> →{' '}
                    <span className="text-[#22e55c]">{diffData.toRef}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setDiffData(null)}
                    className="text-[10px] text-[#808d99] hover:text-[#f1f5f9]"
                  >
                    Close
                  </button>
                </div>
                {diffData.identical ? (
                  <div className="mt-1.5 text-[#22e55c]">
                    ✓ Graphs are structurally identical (0 node or edge changes).
                  </div>
                ) : (
                  <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-3">
                    <div className="rounded border border-[#22e55c]/25 bg-[#22e55c]/[0.06] p-2">
                      <div className="text-[10px] font-bold text-[#22e55c]">
                        + ADDED ({diffData.addedNodes.length} nodes · {diffData.addedEdges.length} edges)
                      </div>
                      {diffData.addedNodes.map((n) => (
                        <div key={n.id} className="mt-1 text-[10.5px] text-[#73ff86]">
                          + [{n.type}] {n.label} ({n.id})
                        </div>
                      ))}
                      {diffData.addedEdges.map((e) => (
                        <div key={e.id} className="mt-0.5 text-[10px] text-[#22e55c]">
                          + edge {e.from} → {e.to}
                        </div>
                      ))}
                    </div>
                    <div className="rounded border border-[#f59e0b]/25 bg-[#f59e0b]/[0.06] p-2">
                      <div className="text-[10px] font-bold text-[#fbbf24]">
                        ~ MODIFIED ({diffData.modifiedNodes.length} nodes)
                      </div>
                      {diffData.modifiedNodes.map((n) => (
                        <div key={n.id} className="mt-1 text-[10.5px] text-[#fbbf24]">
                          ~ {n.label}: {n.changedFields.join(', ')}
                        </div>
                      ))}
                    </div>
                    <div className="rounded border border-[#f43f5e]/25 bg-[#f43f5e]/[0.06] p-2">
                      <div className="text-[10px] font-bold text-[#fb7185]">
                        - REMOVED ({diffData.removedNodes.length} nodes · {diffData.removedEdges.length} edges)
                      </div>
                      {diffData.removedNodes.map((n) => (
                        <div key={n.id} className="mt-1 text-[10.5px] text-[#fb7185]">
                          - [{n.type}] {n.label} ({n.id})
                        </div>
                      ))}
                      {diffData.removedEdges.map((e) => (
                        <div key={e.id} className="mt-0.5 text-[10px] text-[#fb7185]">
                          - edge {e.from} → {e.to}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* v6.0 Interactive Step-by-Step Dry-Run & Template Debugger Panel */}
        {showDryRun && activeWorkflow && (
          <div className="space-y-3 border-b border-[#22e55c]/35 bg-[#111417] px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-mono">
                <Bug className="h-4 w-4 text-[#22e55c]" />
                <span className="font-bold uppercase tracking-wider text-[#f1f5f9]">
                  STEP-BY-STEP DRY-RUN DEBUGGER
                </span>
                <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/10 px-1.5 py-0.5 text-[9.5px] text-[#22e55c]">
                  ZERO DB MUTATIONS
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={dryRunBusy}
                  onClick={async () => {
                    setDryRunBusy(true);
                    try {
                      const parsedInput = JSON.parse(dryRunInput) as Record<string, unknown>;
                      const graph = fromFlowGraph(nodes, edges);
                      const { dryRun } = await api.dryRunWorkflow(session, activeWorkflow.id, {
                        input: parsedInput,
                        nodes: graph.nodes,
                        edges: graph.edges,
                      });
                      setDryRunResult(dryRun);
                      setDryRunStepIdx(0);
                      onNotify(
                        `Dry-run traced ${dryRun.steps.length} step(s) in ${dryRun.totalDurationMs}ms (0 DB writes)`,
                        'ok'
                      );
                    } catch (err) {
                      onNotify(err instanceof Error ? err.message : 'Dry-run failed', 'err');
                    } finally {
                      setDryRunBusy(false);
                    }
                  }}
                  className="sf-btn-primary inline-flex items-center gap-1.5 px-3 py-1 font-mono text-[10.5px] uppercase"
                >
                  <Play className="h-3 w-3" />
                  {dryRunBusy ? 'Tracing...' : 'Run Dry-Run'}
                </button>
                {dryRunResult && dryRunResult.steps.length > 0 && (
                  <div className="flex items-center gap-1 font-mono text-[10.5px]">
                    <button
                      type="button"
                      disabled={dryRunStepIdx <= 0}
                      onClick={() => setDryRunStepIdx((i) => Math.max(0, i - 1))}
                      className="sf-btn-secondary px-2 py-1 disabled:opacity-40"
                    >
                      <ChevronLeft className="h-3 w-3" />
                    </button>
                    <span className="px-2 text-[#22e55c]">
                      Step {dryRunStepIdx + 1} / {dryRunResult.steps.length}
                    </span>
                    <button
                      type="button"
                      disabled={dryRunStepIdx >= dryRunResult.steps.length - 1}
                      onClick={() =>
                        setDryRunStepIdx((i) => Math.min(dryRunResult.steps.length - 1, i + 1))
                      }
                      className="sf-btn-secondary px-2 py-1 disabled:opacity-40"
                    >
                      <ChevronRight className="h-3 w-3" />
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setShowDryRun(false);
                    setDryRunResult(null);
                  }}
                  className="rounded p-1 text-[#808d99] hover:bg-[#1c2227] hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
              <div className="lg:col-span-4">
                <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-[#808d99]">
                  SAMPLE INPUT JSON
                </div>
                <textarea
                  rows={4}
                  value={dryRunInput}
                  onChange={(e) => setDryRunInput(e.target.value)}
                  className="sf-input w-full p-2 font-mono text-[10.5px] text-[#73ff86]"
                />
              </div>

              <div className="lg:col-span-8">
                {!dryRunResult ? (
                  <div className="flex h-full items-center justify-center rounded border border-dashed border-[#262c32] bg-[#15191d] p-4 font-mono text-[11px] text-[#808d99]">
                    Click <strong className="mx-1 text-[#22e55c]">RUN DRY-RUN</strong> to trace
                    templates, QuickJS-WASM outputs, and condition branches step-by-step.
                  </div>
                ) : (
                  (() => {
                    const activeTrace = dryRunResult.steps[dryRunStepIdx];
                    if (!activeTrace) return null;
                    return (
                      <div className="rounded border border-[#262c32] bg-[#15191d] p-3 font-mono text-[11px]">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="rounded bg-[#22e55c] px-1.5 py-0.5 text-[9.5px] font-bold text-[#070b07]">
                              #{activeTrace.order}
                            </span>
                            <span className="font-sans text-xs font-semibold text-[#f1f5f9]">
                              {activeTrace.label}
                            </span>
                            <span className="rounded border border-[#262c32] bg-[#111417] px-1.5 py-0.2 text-[9.5px] uppercase text-[#808d99]">
                              {activeTrace.type}
                            </span>
                            <span
                              className={`rounded border px-1.5 py-0.2 text-[9.5px] font-bold uppercase ${
                                activeTrace.status === 'would_execute'
                                  ? 'border-[#22e55c]/35 bg-[#22e55c]/10 text-[#22e55c]'
                                  : activeTrace.status === 'would_pause'
                                    ? 'border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#fbbf24]'
                                    : activeTrace.status === 'would_skip'
                                      ? 'border-[#262c32] bg-[#111417] text-[#808d99]'
                                      : 'border-[#f43f5e]/40 bg-[#f43f5e]/10 text-[#fb7185]'
                              }`}
                            >
                              {activeTrace.status.replace('_', ' ')}
                            </span>
                          </div>
                          <span className="text-[10px] text-[#808d99]">
                            {activeTrace.durationMs}ms
                          </span>
                        </div>
                        <p className="mt-1.5 font-sans text-[11.5px] text-[#c7d1db]">
                          {activeTrace.note}
                        </p>
                        <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                          <div>
                            <div className="text-[9.5px] uppercase text-[#808d99]">
                              RESOLVED TEMPLATES ({activeTrace.resolvedTemplates.length})
                            </div>
                            {activeTrace.resolvedTemplates.length === 0 ? (
                              <div className="mt-1 text-[10px] text-[#808d99]">
                                No template expressions on this node.
                              </div>
                            ) : (
                              <div className="mt-1 max-h-24 space-y-1 overflow-auto rounded border border-[#262c32] bg-[#111417] p-1.5 text-[10px]">
                                {activeTrace.resolvedTemplates.map((t, i) => (
                                  <div key={i} className="truncate">
                                    <span className="text-[#808d99]">{t.key}:</span>{' '}
                                    <span className="text-[#c084fc]">{t.expression}</span> →{' '}
                                    <span className="text-[#73ff86]">
                                      {JSON.stringify(t.value)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          <div>
                            <div className="text-[9.5px] uppercase text-[#808d99]">
                              PREVIEW OUTPUT
                            </div>
                            <pre className="mt-1 max-h-24 overflow-auto rounded border border-[#262c32] bg-[#111417] p-1.5 text-[10px] text-[#73ff86]">
                              {JSON.stringify(activeTrace.previewOutput ?? {}, null, 2)}
                            </pre>
                          </div>
                        </div>
                      </div>
                    );
                  })()
                )}
              </div>
            </div>
          </div>
        )}

        {/* React Flow DAG Canvas */}
        <div className="relative min-h-0 flex-1">
          <ReactFlow
            nodes={(() => {
              if (!diffData && !dryRunResult) return nodes;
              const addedIds = new Set(diffData?.addedNodes.map((n) => n.id) ?? []);
              const modIds = new Set(diffData?.modifiedNodes.map((n) => n.id) ?? []);
              const activeDebugNodeId = dryRunResult?.steps[dryRunStepIdx]?.nodeId;
              const debugStatusById = new Map(
                (dryRunResult?.steps ?? []).map((s) => [s.nodeId, s.status])
              );
              const decorated = nodes.map((n) => {
                const diffStatus = addedIds.has(n.id)
                  ? ('added' as const)
                  : modIds.has(n.id)
                    ? ('modified' as const)
                    : null;
                const debugStatus =
                  activeDebugNodeId === n.id
                    ? ('active' as const)
                    : (debugStatusById.get(n.id) ?? null);
                return {
                  ...n,
                  data: {
                    ...n.data,
                    diffStatus,
                    debugStatus,
                  },
                };
              });
              // Add visual ghost cards for removed nodes when comparing DAG versions
              const removedGhosts: Node<SagaNodeData>[] = (diffData?.removedNodes ?? []).map(
                (rn, idx) => ({
                  id: `__removed_${rn.id}`,
                  type: 'saga',
                  position: { x: 80 + idx * 300, y: 390 },
                  draggable: false,
                  selectable: false,
                  data: {
                    label: rn.label,
                    nodeType: rn.type,
                    stepType: rn.type,
                    config: {},
                    diffStatus: 'removed',
                  },
                })
              );
              return [...decorated, ...removedGhosts];
            })()}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => {
              onNodesChange(changes);
              if (changes.some((c) => c.type === 'position' || c.type === 'remove')) setDirty(true);
            }}
            onEdgesChange={(changes) => {
              onEdgesChange(changes);
              if (changes.some((c) => c.type === 'remove')) setDirty(true);
            }}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            deleteKeyCode={['Delete', 'Backspace']}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#262c32" />
            <Controls />
            <MiniMap
              nodeColor={(n) => {
                const t = (n.data as SagaNodeData)?.nodeType;
                if (t === 'trigger') return '#22e55c';
                if (t === 'script') return '#f59e0b';
                if (t === 'http_request') return '#22e55c';
                if (t === 'condition') return '#a855f7';
                return '#22e55c';
              }}
              maskColor="rgba(7,9,15,0.75)"
            />
          </ReactFlow>

          {/* Empty Project / Empty Canvas Friendly State */}
          {(!activeWorkflow || nodes.length === 0) && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
              <div className="pointer-events-auto max-w-md rounded-xl border border-[#262c32] bg-[#15191d]/95 p-6 text-center shadow-2xl backdrop-blur-md">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-[#22e55c]/30 bg-[#22e55c]/10 text-[#22e55c]">
                  <Zap className="h-5 w-5" />
                </div>
                <h3 className="mt-3 text-base font-semibold text-[#f1f5f9]">
                  {!activeWorkflow ? 'This project has no workflows yet' : 'Empty workflow canvas'}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-[#808d99]">
                  {!activeWorkflow
                    ? 'Create a blank workflow from scratch, install a popular automation template, or ask AI Copilot to build one.'
                    : 'Click Add Node to drop your first Trigger, Transform, Email, Slack, Database, or AI step onto the canvas.'}
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                  {!activeWorkflow ? (
                    <button
                      type="button"
                      onClick={() => void createFromBlueprint('blank')}
                      className="sf-btn-neon inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-semibold"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      New Blank Workflow
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowNodePicker(true)}
                      className="sf-btn-neon inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-xs font-semibold"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Add First Node
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowBlueprints(true)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#262c32] bg-[#111417] px-3.5 py-2 text-xs font-medium text-[#f1f5f9] hover:border-[#2f373f]"
                  >
                    <BookTemplate className="h-3.5 w-3.5 text-[#22e55c]" />
                    Popular Templates
                  </button>
                  {onOpenAiAgent && (
                    <button
                      type="button"
                      onClick={onOpenAiAgent}
                      className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/40 bg-violet-500/12 px-3.5 py-2 text-xs font-medium text-violet-200 hover:bg-violet-500/20"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      AI Copilot
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Categorized, Searchable 16-Node Picker Popover */}
          {showNodePicker && activeWorkflow && (
            <>
              <div
                className="fixed inset-0 z-20"
                onClick={() => setShowNodePicker(false)}
              />
              <div className="absolute left-1/2 top-4 z-30 flex max-h-[78%] w-[560px] max-w-[calc(100%-32px)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-[#2f373f] bg-[#15191d] shadow-[0_24px_64px_rgba(0,0,0,0.75)]">
                <div className="flex items-center gap-2 border-b border-[#262c32] bg-[#111417] px-3.5 py-2.5">
                  <Search className="h-4 w-4 text-[#808d99]" />
                  <input
                    autoFocus
                    value={nodePickerQuery}
                    onChange={(e) => setNodePickerQuery(e.target.value)}
                    placeholder="Search 16 node types (email, slack, database, switch, filter, transform, AI...)"
                    className="flex-1 bg-transparent text-xs text-[#f1f5f9] outline-none placeholder:text-[#808d99]"
                  />
                  <span className="rounded border border-[#262c32] bg-[#15191d] px-1.5 py-0.5 font-mono text-[10px] text-[#808d99]">
                    {NODE_PALETTE.length} nodes
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowNodePicker(false)}
                    className="rounded p-1 text-[#808d99] hover:bg-[#1c2227] hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="flex-1 space-y-4 overflow-y-auto p-4">
                  {NODE_CATEGORIES.map((cat) => {
                    const q = nodePickerQuery.trim().toLowerCase();
                    const items = NODE_PALETTE.filter(
                      (item) =>
                        item.category === cat &&
                        (!q ||
                          item.label.toLowerCase().includes(q) ||
                          item.short.toLowerCase().includes(q) ||
                          item.type.toLowerCase().includes(q) ||
                          item.summary.toLowerCase().includes(q))
                    );
                    if (items.length === 0) return null;
                    return (
                      <div key={cat}>
                        <div className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-[#808d99]">
                          {cat}
                        </div>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {items.map((item) => {
                            const Icon = item.icon;
                            return (
                              <button
                                key={item.type}
                                type="button"
                                onClick={() => {
                                  addNodeToCanvas(item);
                                  setShowNodePicker(false);
                                }}
                                className="flex items-start gap-2.5 rounded-lg border border-[#262c32] bg-[#111417] p-2.5 text-left transition hover:border-[#22e55c]/55 hover:bg-[#181d22]"
                              >
                                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#262c32] bg-[#15191d]">
                                  <Icon className={`h-3.5 w-3.5 ${item.color}`} />
                                </div>
                                <div className="min-w-0">
                                  <div className="truncate text-xs font-semibold text-[#f1f5f9]">
                                    {item.short}
                                  </div>
                                  <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[#808d99]">
                                    {item.summary}
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Minimal, Calm Floating Bottom Action Pill (replaces cramped cockpit dock) */}
          {activeWorkflow && nodes.length > 0 && (
            <div className="pointer-events-auto absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border border-[#2f373f]/80 bg-[#15191d]/95 px-2.5 py-1.5 shadow-[0_12px_36px_rgba(0,0,0,0.55)] backdrop-blur-md">
              <button
                type="button"
                onClick={() => {
                  setShowNodePicker(true);
                  setNodePickerQuery('');
                }}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[#22e55c] px-3 py-1 text-xs font-semibold text-[#070b07] transition hover:bg-[#39ff14]"
              >
                <Plus className="h-3.5 w-3.5 shrink-0 stroke-[2.5]" />
                Add Node
              </button>
              <button
                type="button"
                onClick={() => {
                  setNodes((nds) => autoLayoutNodes(nds, edges));
                  setDirty(true);
                }}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs text-[#c7d1db] transition hover:bg-[#1c2227] hover:text-white"
              >
                <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
                Tidy Layout
              </button>
              <button
                type="button"
                onClick={() => setShowBlueprints(true)}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs text-[#c7d1db] transition hover:bg-[#1c2227] hover:text-white"
              >
                <BookTemplate className="h-3.5 w-3.5 shrink-0 text-[#22e55c]" />
                Templates
              </button>
            </div>
          )}
        </div>
      </div>

      {/* COLLAPSIBLE RIGHT INSPECTOR PANEL (Opens automatically when you select a node) */}
      {(selectedNode || showInspector) && (
      <aside className="flex w-[340px] shrink-0 flex-col border-l border-[#262c32]/80 bg-[#111417]">
        <div className="flex items-center justify-between border-b border-[#262c32]/80 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            {selectedNode ? `Inspector · ${selectedNode.data.nodeType}` : 'Workflow Settings'}
          </div>
          <div className="flex items-center gap-1">
            {selectedNode && (
              <button
                onClick={deleteSelectedNode}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-rose-400 hover:bg-rose-500/10"
              >
                <Trash2 className="h-3 w-3" /> Delete
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setSelectedNodeId(null);
                setShowInspector(false);
              }}
              className="rounded p-1 text-[#808d99] hover:bg-[#1c2227] hover:text-white"
              title="Close inspector"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!selectedNode ? (
            <div className="space-y-4">
              <div>
                <label className="text-[11px] font-medium text-zinc-400">Description</label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    setDirty(true);
                  }}
                  className="mt-1 w-full rounded-xl border border-[#262c32] bg-[#0c0e10]/90 p-2.5 text-xs text-zinc-200 outline-none focus:border-[#22e55c]/60"
                />
              </div>
              <div className="rounded-xl border border-[#262c32]/90 bg-[#15191d]/40 p-3.5 space-y-2 text-xs text-zinc-400">
                <div className="flex items-center gap-1.5 font-semibold text-zinc-200">
                  <Sparkles className="h-3.5 w-3.5 text-[#22e55c]" />
                  100% Real Execution Engine
                </div>
                <p>
                  • Click any node on the canvas to configure real database handlers, live HTTP endpoints, or QuickJS-WASM
                  scripts.
                </p>
                <p>
                  • Drag from a node&apos;s right handle to wire dependencies. Fan-out branches execute concurrently.
                </p>
                <p>
                  • Every <code className="text-[#22e55c]">Saga Task</code> mutates real rows in the tenant DB — inspect
                  live mutations &amp; rollbacks in the <strong>State &amp; Ledger</strong> tab.
                </p>
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="text-[11px] font-medium text-zinc-400">Step Label</label>
                <input
                  value={selectedNode.data.label}
                  onChange={(e) => updateSelectedNode({ label: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 text-xs text-zinc-100 outline-none focus:border-[#22e55c]"
                />
                <div className="mt-1 font-mono text-[10px] text-zinc-500">
                  id: <span className="text-zinc-300">{selectedNode.id}</span>
                </div>
              </div>

              {/* TRIGGER */}
              {selectedNode.data.nodeType === 'trigger' && (
                <div>
                  <label className="text-[11px] font-medium text-zinc-400">Trigger Source</label>
                  <select
                    value={String(selectedNode.data.config.triggerType ?? 'manual')}
                    onChange={(e) => updateSelectedConfig('triggerType', e.target.value)}
                    className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-2 text-xs text-zinc-100"
                  >
                    <option value="manual">Manual / API Run</option>
                    <option value="webhook">Public Inbound Webhook</option>
                    <option value="cron">Durable Cron Schedule</option>
                    <option value="event">Internal Event</option>
                  </select>
                </div>
              )}

              {/* TRANSFORM / DATA MAPPER */}
              {selectedNode.data.nodeType === 'transform' && (
                <div className="space-y-3">
                  <label className="flex items-center gap-2 text-xs text-zinc-200">
                    <input
                      type="checkbox"
                      checked={Boolean(selectedNode.data.config.mergeWithInput)}
                      onChange={(e) => updateSelectedConfig('mergeWithInput', e.target.checked)}
                      className="accent-[#22e55c]"
                    />
                    Keep original input fields (merge)
                  </label>
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">
                      Field Mappings (JSON with {'{{...}}'} templates)
                    </label>
                    <textarea
                      rows={6}
                      value={JSON.stringify(selectedNode.data.config.mappings ?? {}, null, 2)}
                      onChange={(e) => {
                        try {
                          updateSelectedConfig('mappings', JSON.parse(e.target.value));
                        } catch {
                          // allow intermediate JSON editing
                        }
                      }}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] p-2.5 font-mono text-[11px] text-[#73ff86] outline-none focus:border-[#22e55c]"
                    />
                  </div>
                </div>
              )}

              {/* FILTER / GUARD */}
              {selectedNode.data.nodeType === 'filter' && (
                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Field / Template</label>
                    <input
                      value={String(selectedNode.data.config.field ?? '{{input.amount}}')}
                      onChange={(e) => updateSelectedConfig('field', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] font-medium text-zinc-400">Operator</label>
                      <select
                        value={String(selectedNode.data.config.operator ?? 'exists')}
                        onChange={(e) => updateSelectedConfig('operator', e.target.value)}
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2 py-1.5 text-xs text-zinc-100"
                      >
                        <option value="exists">Exists</option>
                        <option value="empty">Is Empty</option>
                        <option value="eq">Equals (==)</option>
                        <option value="neq">Not Equals (!=)</option>
                        <option value="gt">Greater Than (&gt;)</option>
                        <option value="gte">Greater / Equal (&gt;=)</option>
                        <option value="lt">Less Than (&lt;)</option>
                        <option value="lte">Less / Equal (&lt;=)</option>
                        <option value="contains">Contains</option>
                        <option value="not_contains">Does Not Contain</option>
                        <option value="regex">Matches Regex</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-zinc-400">Compare Value</label>
                      <input
                        value={String(selectedNode.data.config.value ?? '')}
                        onChange={(e) => updateSelectedConfig('value', e.target.value)}
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">When Filter Does Not Match</label>
                    <select
                      value={String(selectedNode.data.config.onFail ?? 'skip_downstream')}
                      onChange={(e) => updateSelectedConfig('onFail', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 text-xs text-zinc-100"
                    >
                      <option value="skip_downstream">Skip downstream steps cleanly</option>
                      <option value="fail_run">Fail run &amp; trigger Saga rollback</option>
                    </select>
                  </div>
                </div>
              )}

              {/* SWITCH (MULTI-WAY ROUTER) */}
              {selectedNode.data.nodeType === 'switch' && (
                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Value Expression</label>
                    <input
                      value={String(selectedNode.data.config.expression ?? '{{input.category}}')}
                      onChange={(e) => updateSelectedConfig('expression', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Fallback Branch Name</label>
                    <input
                      value={String(selectedNode.data.config.defaultCase ?? 'default')}
                      onChange={(e) => updateSelectedConfig('defaultCase', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Cases (JSON Array)</label>
                    <textarea
                      rows={5}
                      value={JSON.stringify(selectedNode.data.config.cases ?? [], null, 2)}
                      onChange={(e) => {
                        try {
                          updateSelectedConfig('cases', JSON.parse(e.target.value));
                        } catch {
                          // allow typing
                        }
                      }}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] p-2.5 font-mono text-[11px] text-violet-300 outline-none focus:border-[#22e55c]"
                    />
                  </div>
                </div>
              )}

              {/* EMAIL DISPATCH */}
              {selectedNode.data.nodeType === 'email' && (
                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Delivery Channel</label>
                    <select
                      value={String(selectedNode.data.config.provider ?? 'sink')}
                      onChange={(e) => updateSelectedConfig('provider', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 text-xs text-zinc-100"
                    >
                      <option value="sink">Tenant Live Inbox Sink ($0 Local &amp; Cloud)</option>
                      <option value="resend">Resend API (uses RESEND_API_KEY secret)</option>
                      <option value="webhook">Custom SMTP / Email Webhook</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Recipient (To)</label>
                    <input
                      value={String(selectedNode.data.config.to ?? '{{input.email}}')}
                      onChange={(e) => updateSelectedConfig('to', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Subject</label>
                    <input
                      value={String(selectedNode.data.config.subject ?? '')}
                      onChange={(e) => updateSelectedConfig('subject', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 text-xs text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Body</label>
                    <textarea
                      rows={4}
                      value={String(selectedNode.data.config.body ?? '')}
                      onChange={(e) => updateSelectedConfig('body', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] p-2.5 text-xs text-zinc-100"
                    />
                  </div>
                </div>
              )}

              {/* SLACK / DISCORD / TEAMS */}
              {selectedNode.data.nodeType === 'slack_discord' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] font-medium text-zinc-400">Platform</label>
                      <select
                        value={String(selectedNode.data.config.platform ?? 'slack')}
                        onChange={(e) => updateSelectedConfig('platform', e.target.value)}
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2 py-1.5 text-xs text-zinc-100"
                      >
                        <option value="slack">Slack Block Kit</option>
                        <option value="discord">Discord Embed</option>
                        <option value="teams">Microsoft Teams</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-zinc-400">Severity</label>
                      <select
                        value={String(selectedNode.data.config.severity ?? 'info')}
                        onChange={(e) => updateSelectedConfig('severity', e.target.value)}
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2 py-1.5 text-xs text-zinc-100"
                      >
                        <option value="info">Info</option>
                        <option value="success">Success</option>
                        <option value="warning">Warning</option>
                        <option value="critical">Critical</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Channel Name</label>
                    <input
                      value={String(selectedNode.data.config.channelName ?? '#alerts')}
                      onChange={(e) => updateSelectedConfig('channelName', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Title</label>
                    <input
                      value={String(selectedNode.data.config.title ?? '')}
                      onChange={(e) => updateSelectedConfig('title', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 text-xs text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Message</label>
                    <textarea
                      rows={3}
                      value={String(selectedNode.data.config.message ?? '')}
                      onChange={(e) => updateSelectedConfig('message', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] p-2.5 text-xs text-zinc-100"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">
                      Webhook URL (leave empty to deliver to live tenant chat inbox)
                    </label>
                    <input
                      value={String(selectedNode.data.config.webhookUrl ?? '')}
                      onChange={(e) => updateSelectedConfig('webhookUrl', e.target.value)}
                      placeholder="{{secrets.SLACK_WEBHOOK_URL}}"
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                    />
                  </div>
                </div>
              )}

              {/* DATABASE / KV STORE (WITH ATOMIC SAGA ROLLBACK!) */}
              {selectedNode.data.nodeType === 'database' && (
                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Database Operation</label>
                    <select
                      value={String(selectedNode.data.config.operation ?? 'set')}
                      onChange={(e) => updateSelectedConfig('operation', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 text-xs text-zinc-100"
                    >
                      <option value="set">Set / Upsert Record (auto-rollback)</option>
                      <option value="get">Get Record by Key</option>
                      <option value="increment">Increment Counter (auto-rollback)</option>
                      <option value="list">List Collection Records</option>
                      <option value="delete">Delete Record (auto-rollback)</option>
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] font-medium text-zinc-400">Collection</label>
                      <input
                        value={String(selectedNode.data.config.collection ?? 'records')}
                        onChange={(e) => updateSelectedConfig('collection', e.target.value)}
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-zinc-400">Record Key</label>
                      <input
                        value={String(selectedNode.data.config.key ?? '{{input.id}}')}
                        onChange={(e) => updateSelectedConfig('key', e.target.value)}
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                      />
                    </div>
                  </div>
                  {String(selectedNode.data.config.operation ?? 'set') === 'increment' && (
                    <div>
                      <label className="text-[11px] font-medium text-zinc-400">Delta</label>
                      <input
                        type="number"
                        value={Number(selectedNode.data.config.delta ?? 1)}
                        onChange={(e) => updateSelectedConfig('delta', Number(e.target.value))}
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                      />
                    </div>
                  )}
                  {String(selectedNode.data.config.operation ?? 'set') === 'set' && (
                    <div>
                      <label className="text-[11px] font-medium text-zinc-400">Value JSON</label>
                      <textarea
                        rows={4}
                        value={JSON.stringify(selectedNode.data.config.value ?? {}, null, 2)}
                        onChange={(e) => {
                          try {
                            updateSelectedConfig('value', JSON.parse(e.target.value));
                          } catch {
                            // allow typing
                          }
                        }}
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] p-2.5 font-mono text-[11px] text-[#73ff86]"
                      />
                    </div>
                  )}
                  <div className="rounded border border-[#22e55c]/30 bg-[#22e55c]/8 px-2.5 py-2 text-[11px] text-[#73ff86]">
                    ACID Saga Safe: <code className="font-mono">set</code>,{' '}
                    <code className="font-mono">increment</code>, and{' '}
                    <code className="font-mono">delete</code> automatically restore prior DB state
                    if any downstream step fails.
                  </div>
                </div>
              )}

              {/* CUSTOM SAGA TASK (REAL DB MUTATIONS!) */}
              {selectedNode.data.nodeType === 'custom_task' && (
                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] font-medium text-zinc-400">Real Transactional Handler</label>
                    <select
                      value={currentHandler}
                      onChange={(e) => {
                        const h = e.target.value;
                        const found = CUSTOM_TASK_HANDLERS.find((x) => x.name === h);
                        updateSelectedNode({
                          config: {
                            ...selectedNode.data.config,
                            handler: h,
                            compensationHandler: found?.compensator ?? undefined,
                          },
                        });
                      }}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-2 font-mono text-xs text-zinc-100"
                    >
                      {CUSTOM_TASK_HANDLERS.map((h) => (
                        <option key={h.name} value={h.name}>
                          {h.name} {h.compensator ? `↔ ${h.compensator}` : ''}
                        </option>
                      ))}
                    </select>
                    {handlerHelp && (
                      <div className="mt-2 rounded-lg border border-[#262c32] bg-[#15191d]/70 p-2.5 text-[11px] space-y-1">
                        <div className="text-[#22e55c]">Commit: {handlerHelp.commit}</div>
                        <div className="text-violet-300">Rollback: {handlerHelp.rollback}</div>
                      </div>
                    )}
                  </div>

                  {/* Handler-specific real parameters */}
                  {currentHandler === 'reserve_inventory' && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[11px] text-zinc-400">SKU (or template)</label>
                        <input
                          value={String(selectedNode.data.config.sku ?? '')}
                          placeholder="{{input.sku}} or SKU-PRO-900"
                          onChange={(e) => updateSelectedConfig('sku', e.target.value)}
                          className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2 py-1.5 font-mono text-xs text-zinc-100"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-zinc-400">Quantity</label>
                        <input
                          type="number"
                          min={1}
                          value={Number(selectedNode.data.config.qty ?? 1)}
                          onChange={(e) => updateSelectedConfig('qty', Number(e.target.value))}
                          className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2 py-1.5 font-mono text-xs text-zinc-100"
                        />
                      </div>
                    </div>
                  )}

                  {currentHandler === 'allocate_credits' && (
                    <div>
                      <label className="text-[11px] text-zinc-400">Credits to Lock (default: input.credits or 150)</label>
                      <input
                        type="number"
                        value={String(selectedNode.data.config.credits ?? '')}
                        placeholder="150"
                        onChange={(e) =>
                          updateSelectedConfig('credits', e.target.value ? Number(e.target.value) : undefined)
                        }
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                      />
                    </div>
                  )}

                  {currentHandler === 'charge_payment' && (
                    <div>
                      <label className="text-[11px] text-zinc-400">
                        Amount USD (blank = uses WASM total or input.amount)
                      </label>
                      <input
                        type="number"
                        step="any"
                        value={String(selectedNode.data.config.amount ?? '')}
                        placeholder="Auto from upstream step"
                        onChange={(e) =>
                          updateSelectedConfig('amount', e.target.value ? Number(e.target.value) : undefined)
                        }
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                      />
                    </div>
                  )}

                  {currentHandler === 'kv_set' && (
                    <div className="space-y-2">
                      <div>
                        <label className="text-[11px] text-zinc-400">KV Key (supports templates)</label>
                        <input
                          value={String(selectedNode.data.config.key ?? '')}
                          placeholder="order:{{input.orderId}}"
                          onChange={(e) => updateSelectedConfig('key', e.target.value)}
                          className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-zinc-400">KV Value (string or JSON)</label>
                        <input
                          value={
                            typeof selectedNode.data.config.value === 'string'
                              ? selectedNode.data.config.value
                              : JSON.stringify(selectedNode.data.config.value ?? '')
                          }
                          onChange={(e) => {
                            try {
                              updateSelectedConfig('value', JSON.parse(e.target.value));
                            } catch {
                              updateSelectedConfig('value', e.target.value);
                            }
                          }}
                          className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* LIVE HTTP REQUEST (ZERO MOCKS!) */}
              {selectedNode.data.nodeType === 'http_request' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[11px] text-zinc-400">Method</label>
                      <select
                        value={String(selectedNode.data.config.method ?? 'POST')}
                        onChange={(e) => updateSelectedConfig('method', e.target.value)}
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2 py-1.5 font-mono text-xs text-zinc-100"
                      >
                        {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] text-zinc-400">Live URL</label>
                        <button
                          type="button"
                          onClick={() => updateSelectedConfig('url', `/api/sink/${tenantSlug}/webhook`)}
                          className="text-[10px] text-[#22e55c] hover:underline"
                        >
                          Use Tenant Sink
                        </button>
                      </div>
                      <input
                        value={String(selectedNode.data.config.url ?? '')}
                        onChange={(e) => updateSelectedConfig('url', e.target.value)}
                        placeholder="https://api.example.com/... or /api/sink/..."
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2 py-1.5 font-mono text-xs text-zinc-100"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] text-zinc-400">Headers (JSON · supports {'{{secrets.*}}'})</label>
                    <textarea
                      rows={3}
                      value={httpHeadersText}
                      onChange={(e) => {
                        setHttpHeadersText(e.target.value);
                        try {
                          const parsed = JSON.parse(e.target.value);
                          if (parsed && typeof parsed === 'object') updateSelectedConfig('headers', parsed);
                        } catch {
                          // wait until valid JSON
                        }
                      }}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] p-2 font-mono text-[11px] text-sky-200 outline-none focus:border-[#22e55c]"
                    />
                  </div>

                  {String(selectedNode.data.config.method ?? 'POST') !== 'GET' && (
                    <div>
                      <label className="text-[11px] text-zinc-400">Request Body (JSON · supports {'{{steps.*}}'})</label>
                      <textarea
                        rows={4}
                        value={httpBodyText}
                        onChange={(e) => {
                          setHttpBodyText(e.target.value);
                          try {
                            updateSelectedConfig('body', JSON.parse(e.target.value));
                          } catch {
                            // wait until valid JSON
                          }
                        }}
                        className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] p-2 font-mono text-[11px] text-[#73ff86] outline-none focus:border-[#22e55c]"
                      />
                    </div>
                  )}

                  {/* Optional Live HTTP Compensation URL */}
                  <div>
                    <label className="text-[11px] text-zinc-400">
                      Saga Rollback URL (optional HTTP compensation)
                    </label>
                    <input
                      value={String(selectedNode.data.config.compensationUrl ?? '')}
                      onChange={(e) => updateSelectedConfig('compensationUrl', e.target.value)}
                      placeholder={`/api/sink/${tenantSlug}/rollback`}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-violet-200"
                    />
                  </div>

                  {/* Live HTTP Tester */}
                  <div className="rounded-xl border border-[#22e55c]/30 bg-[#22e55c]/5 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-[#22e55c]">
                        <Send className="h-3.5 w-3.5" /> Live HTTP Tester
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleTestLiveHttp()}
                        disabled={httpTesting}
                        className="rounded-lg bg-[#22e55c] px-2.5 py-1 text-[11px] font-semibold text-[#070b07] hover:bg-sky-400 disabled:opacity-50"
                      >
                        {httpTesting ? 'Sending...' : 'Send Live Request'}
                      </button>
                    </div>
                    {httpTestResult && (
                      <pre className="max-h-40 overflow-auto rounded-lg bg-[#0c0e10] p-2 font-mono text-[10px] text-[#22e55c]">
                        {httpTestResult}
                      </pre>
                    )}
                  </div>
                </div>
              )}

              {/* QUICKJS-WASM SCRIPT */}
              {selectedNode.data.nodeType === 'script' && (
                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] text-zinc-400">
                      QuickJS-WASM Transform (isolated memory + CPU limit)
                    </label>
                    <textarea
                      rows={7}
                      value={String(selectedNode.data.config.code ?? '')}
                      onChange={(e) => updateSelectedConfig('code', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] p-2.5 font-mono text-[11px] text-amber-200 outline-none focus:border-amber-500"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-zinc-400">
                      Least-Privilege Vault Secrets (comma-separated)
                    </label>
                    <input
                      value={
                        Array.isArray(selectedNode.data.config.allowedSecrets)
                          ? (selectedNode.data.config.allowedSecrets as string[]).join(', ')
                          : ''
                      }
                      onChange={(e) => {
                        const arr = e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean);
                        updateSelectedConfig('allowedSecrets', arr.length > 0 ? arr : undefined);
                      }}
                      placeholder="PARTNER_WEBHOOK_TOKEN"
                      className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                    />
                  </div>
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                        <FlaskConical className="h-3.5 w-3.5" /> QuickJS-WASM Sandbox
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleTestSandbox()}
                        disabled={sandboxRunning}
                        className="rounded-lg bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-[#070b07] hover:bg-amber-400"
                      >
                        {sandboxRunning ? 'Running...' : 'Test Script'}
                      </button>
                    </div>
                    <input
                      value={sandboxInput}
                      onChange={(e) => setSandboxInput(e.target.value)}
                      className="w-full rounded-lg border border-[#2f373f] bg-[#0c0e10] px-2 py-1 font-mono text-[11px] text-zinc-200"
                    />
                    {sandboxResult && (
                      <pre className="max-h-36 overflow-auto rounded-lg bg-[#0c0e10] p-2 font-mono text-[10px] text-[#22e55c]">
                        {sandboxResult}
                      </pre>
                    )}
                  </div>
                </div>
              )}

              {/* CONDITION */}
              {selectedNode.data.nodeType === 'condition' && (
                <div>
                  <label className="text-[11px] text-zinc-400">Boolean Expression (QuickJS-WASM)</label>
                  <input
                    value={String(selectedNode.data.config.expression ?? '')}
                    onChange={(e) => updateSelectedConfig('expression', e.target.value)}
                    placeholder="(input.amount ?? 150) >= 100"
                    className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-fuchsia-200"
                  />
                  <p className="mt-1.5 text-[10px] text-zinc-500">
                    Connect top green handle for <span className="text-[#22e55c]">TRUE</span> and bottom rose handle
                    for <span className="text-rose-400">FALSE</span>.
                  </p>
                </div>
              )}

              {/* WAIT */}
              {selectedNode.data.nodeType === 'wait' && (
                <div>
                  <label className="text-[11px] text-zinc-400">Durable Delay (ms)</label>
                  <input
                    type="number"
                    min={0}
                    max={60000}
                    value={Number(selectedNode.data.config.delayMs ?? 250)}
                    onChange={(e) => updateSelectedConfig('delayMs', Number(e.target.value))}
                    className="mt-1 w-full rounded-lg border border-[#2f373f]/80 bg-[#0c0e10] px-2.5 py-1.5 font-mono text-xs text-zinc-100"
                  />
                </div>
              )}

              {/* HUMAN-IN-THE-LOOP APPROVAL GATE */}
              {selectedNode.data.nodeType === 'approval' && (
                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] text-zinc-400">Approver Role / Team</label>
                    <input
                      value={String(selectedNode.data.config.approverRole ?? 'Operations Lead')}
                      onChange={(e) => updateSelectedConfig('approverRole', e.target.value)}
                      placeholder="CFO / Finance Lead"
                      className="mt-1 w-full rounded-lg border border-[#2f373f] bg-[#0c0e10] px-2.5 py-1.5 text-xs text-amber-200 outline-none focus:border-[#22e55c]"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-zinc-400">
                      Approval Prompt (supports {'{{input.*}}'} &amp; {'{{steps.*}}'})
                    </label>
                    <textarea
                      rows={4}
                      value={String(selectedNode.data.config.prompt ?? '')}
                      onChange={(e) => updateSelectedConfig('prompt', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f] bg-[#0c0e10] p-2.5 text-xs text-zinc-100 outline-none focus:border-amber-400"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] text-[#808d99]">SLA Timeout (min)</label>
                      <input
                        type="number"
                        min={0}
                        value={Number(selectedNode.data.config.slaMinutes ?? 60)}
                        onChange={(e) =>
                          updateSelectedConfig('slaMinutes', Number(e.target.value) || 0)
                        }
                        className="sf-input mt-1 w-full px-2 py-1.5"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-[#808d99]">On SLA Expiry</label>
                      <select
                        value={String(selectedNode.data.config.onTimeout ?? 'reject')}
                        onChange={(e) => updateSelectedConfig('onTimeout', e.target.value)}
                        className="sf-input mt-1 w-full px-2 py-1.5 font-sans text-[#fbbf24]"
                      >
                        <option value="reject">Auto-Reject (Rollback)</option>
                        <option value="escalate">Escalate Alert Rule</option>
                        <option value="approve">Auto-Approve</option>
                      </select>
                    </div>
                  </div>
                  <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-2.5 text-[11px] text-amber-200">
                    Durably pauses the Saga without holding worker threads. <strong>Approve</strong> resumes downstream
                    steps; <strong>Reject</strong> executes full reverse-order DB rollback.
                  </div>
                </div>
              )}

              {/* DYNAMIC FOR-EACH MAP FAN-OUT STEP */}
              {selectedNode.data.nodeType === 'for_each' && (
                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] text-[#808d99]">
                      Array Expression (e.g. {'{{input.items}}'})
                    </label>
                    <input
                      value={String(selectedNode.data.config.itemsExpression ?? '{{input.items}}')}
                      onChange={(e) => updateSelectedConfig('itemsExpression', e.target.value)}
                      className="sf-input mt-1 w-full px-2.5 py-1.5 text-[#73ff86]"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] text-[#808d99]">Item Mode</label>
                      <select
                        value={String(selectedNode.data.config.mode ?? 'custom_task')}
                        onChange={(e) => updateSelectedConfig('mode', e.target.value)}
                        className="sf-input mt-1 w-full px-2 py-1.5 font-sans"
                      >
                        <option value="custom_task">Saga DB Task</option>
                        <option value="script">QuickJS-WASM Script</option>
                        <option value="http_request">Live HTTP Webhook</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] text-[#808d99]">Max Concurrency</label>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={Number(selectedNode.data.config.maxConcurrency ?? 4)}
                        onChange={(e) =>
                          updateSelectedConfig(
                            'maxConcurrency',
                            Math.min(20, Math.max(1, Number(e.target.value) || 4))
                          )
                        }
                        className="sf-input mt-1 w-full px-2.5 py-1.5"
                      />
                    </div>
                  </div>
                  {String(selectedNode.data.config.mode ?? 'custom_task') === 'custom_task' && (
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[11px] text-[#808d99]">Item Handler</label>
                        <select
                          value={String(selectedNode.data.config.itemHandler ?? 'reserve_inventory')}
                          onChange={(e) => updateSelectedConfig('itemHandler', e.target.value)}
                          className="sf-input mt-1 w-full px-2 py-1.5 font-sans text-[11px]"
                        >
                          {CUSTOM_TASK_HANDLERS.map((h) => (
                            <option key={h.name} value={h.name}>
                              {h.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] text-[#808d99]">Rollback Handler</label>
                        <input
                          value={String(selectedNode.data.config.itemCompensationHandler ?? 'release_inventory')}
                          onChange={(e) =>
                            updateSelectedConfig('itemCompensationHandler', e.target.value)
                          }
                          className="sf-input mt-1 w-full px-2 py-1.5 text-[11px] text-[#c084fc]"
                        />
                      </div>
                    </div>
                  )}
                  {String(selectedNode.data.config.mode ?? 'custom_task') === 'script' && (
                    <div>
                      <label className="text-[11px] text-[#808d99]">
                        Per-Item JS (receives input.item &amp; input.index)
                      </label>
                      <textarea
                        rows={4}
                        value={String(
                          selectedNode.data.config.itemCode ??
                            'return { index: input.index, item: input.item, ok: true };'
                        )}
                        onChange={(e) => updateSelectedConfig('itemCode', e.target.value)}
                        className="sf-input mt-1 w-full p-2 text-[11px] text-[#73ff86]"
                      />
                    </div>
                  )}
                  <div className="rounded border border-[#22e55c]/30 bg-[#22e55c]/[0.06] p-2.5 font-mono text-[10.5px] text-[#73ff86]">
                    Executes each item concurrently with atomic partial-batch rollback &amp;
                    downstream reverse compensation. Output:{' '}
                    <code>{`{{steps.${selectedNode.id}.results}}`}</code>.
                  </div>
                </div>
              )}

              {/* AI AGENT STEP (LM STUDIO / GOOGLE AI STUDIO) */}
              {selectedNode.data.nodeType === 'ai_agent' && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] text-zinc-400">AI Provider</label>
                      <select
                        value={String(selectedNode.data.config.provider ?? 'default')}
                        onChange={(e) => updateSelectedConfig('provider', e.target.value)}
                        className="mt-1 w-full rounded-lg border border-[#2f373f] bg-[#0c0e10] px-2 py-1.5 text-xs text-[#22e55c] outline-none focus:border-[#22e55c]"
                      >
                        <option value="default">Tenant Default</option>
                        <option value="lm_studio">LM Studio (Local)</option>
                        <option value="google_ai_studio">Google AI Studio</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] text-zinc-400">Model Override</label>
                      <input
                        value={String(selectedNode.data.config.model ?? '')}
                        onChange={(e) => updateSelectedConfig('model', e.target.value)}
                        placeholder="default model"
                        className="mt-1 w-full rounded-lg border border-[#2f373f] bg-[#0c0e10] px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-[#22e55c]"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] text-zinc-400">System Prompt</label>
                    <textarea
                      rows={3}
                      value={String(selectedNode.data.config.systemPrompt ?? '')}
                      onChange={(e) => updateSelectedConfig('systemPrompt', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f] bg-[#0c0e10] p-2 text-xs text-zinc-200 outline-none focus:border-[#22e55c]"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-zinc-400">
                      Task Prompt (supports {'{{input.*}}'} &amp; {'{{steps.*}}'})
                    </label>
                    <textarea
                      rows={4}
                      value={String(selectedNode.data.config.prompt ?? '')}
                      onChange={(e) => updateSelectedConfig('prompt', e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#2f373f] bg-[#0c0e10] p-2 text-xs text-[#73ff86] outline-none focus:border-[#22e55c]"
                    />
                  </div>
                  <label className="flex items-center justify-between rounded-lg border border-[#262c32] bg-[#0c0e10] px-2.5 py-2 text-[11px] text-zinc-300">
                    <span>Parse JSON output into step fields</span>
                    <input
                      type="checkbox"
                      checked={selectedNode.data.config.expectJson !== false}
                      onChange={(e) => updateSelectedConfig('expectJson', e.target.checked)}
                      className="accent-[#22e55c]"
                    />
                  </label>
                  {onOpenAiAgent && (
                    <button
                      type="button"
                      onClick={onOpenAiAgent}
                      className="w-full rounded-lg border border-[#22e55c]/40 bg-[#22e55c]/10 py-1.5 text-[11px] font-semibold text-[#22e55c] hover:bg-[#22e55c]/20"
                    >
                      Configure LM Studio / Gemini API Key →
                    </button>
                  )}
                </div>
              )}

              {/* NESTED SUB-WORKFLOW STEP */}
              {selectedNode.data.nodeType === 'sub_workflow' && (
                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] text-[#808d99]">
                      Target Published Child Workflow
                    </label>
                    <select
                      value={String(selectedNode.data.config.workflowId ?? '')}
                      onChange={(e) => updateSelectedConfig('workflowId', e.target.value)}
                      className="sf-input mt-1 w-full px-2.5 py-1.5 font-sans text-[#c084fc]"
                    >
                      <option value="">Select published workflow...</option>
                      {workflows
                        .filter((w) => w.latestVersion !== null && w.id !== activeWorkflow?.id)
                        .map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name} ({w.id} · v{w.latestVersion})
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[11px] text-[#808d99]">Timeout (ms)</label>
                      <input
                        type="number"
                        value={Number(selectedNode.data.config.timeoutMs ?? 15000)}
                        onChange={(e) =>
                          updateSelectedConfig('timeoutMs', Number(e.target.value) || 15000)
                        }
                        className="sf-input mt-1 w-full px-2.5 py-1.5"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-[#808d99]">Rollback Workflow (opt.)</label>
                      <select
                        value={String(selectedNode.data.config.compensationWorkflowId ?? '')}
                        onChange={(e) =>
                          updateSelectedConfig('compensationWorkflowId', e.target.value || undefined)
                        }
                        className="sf-input mt-1 w-full px-2 py-1.5 font-sans text-[11px]"
                      >
                        <option value="">None</option>
                        {workflows
                          .filter((w) => w.latestVersion !== null && w.id !== activeWorkflow?.id)
                          .map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] text-[#808d99]">
                      Child Input JSON (supports {'{{input.*}}'} &amp; {'{{steps.*}}'})
                    </label>
                    <textarea
                      rows={4}
                      value={JSON.stringify(selectedNode.data.config.input ?? {}, null, 2)}
                      onChange={(e) => {
                        try {
                          updateSelectedConfig('input', JSON.parse(e.target.value));
                        } catch {
                          // allow intermediate invalid JSON while typing
                        }
                      }}
                      className="sf-input mt-1 w-full p-2 text-[11px] text-[#73ff86]"
                    />
                  </div>
                  <div className="rounded border border-[#a855f7]/30 bg-[#a855f7]/[0.07] p-2.5 font-mono text-[10.5px] text-[#c084fc]">
                    Recursion guard active (max depth 5). Child output exposed as{' '}
                    <code>{`{{steps.${selectedNode.id}.childRunId}}`}</code> &amp;{' '}
                    <code>{`{{steps.${selectedNode.id}.output.*}}`}</code>.
                  </div>
                </div>
              )}

              {/* INTERACTIVE UPSTREAM DATA PICKER */}
              {selectedNode.data.nodeType !== 'trigger' && (
                <div className="rounded-xl border border-[#262c32] bg-[#15191d]/50 p-2.5">
                  <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                    <span>Upstream Data Picker</span>
                    <span className="font-normal normal-case text-zinc-500">click to copy</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {upstreamTemplates.map((item) => (
                      <button
                        key={item.expr}
                        type="button"
                        onClick={() => {
                          void navigator.clipboard?.writeText(item.expr);
                          onNotify(`Copied ${item.expr}`, 'info');
                        }}
                        className={`rounded border px-2 py-0.5 font-mono text-[10.5px] transition ${
                          item.group === 'secret'
                            ? 'border-violet-500/40 bg-violet-500/12 text-violet-300 hover:border-violet-400'
                            : item.group === 'step'
                            ? 'border-[#2f373f] bg-[#15191d] text-zinc-100 hover:border-[#22e55c]/60'
                            : 'border-[#22e55c]/35 bg-[#22e55c]/10 text-[#22e55c] hover:border-[#22e55c]'
                        }`}
                      >
                        {item.expr}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* RETRY & CHAOS FAULT INJECTION */}
              {selectedNode.data.nodeType !== 'trigger' && (
                <div className="rounded-xl border border-[#262c32]/90 bg-[#15191d]/40 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowChaos((s) => !s)}
                    className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[11px] font-semibold text-zinc-300 hover:bg-[#1c2227]/50"
                  >
                    <span className="flex items-center gap-1.5">
                      <ShieldAlert className="h-3.5 w-3.5 text-rose-400" />
                      Retry Policy &amp; Fault Injection
                    </span>
                    {showChaos ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>
                  {showChaos && (
                    <div className="space-y-3 border-t border-[#262c32]/80 p-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] text-zinc-400">Max Attempts</label>
                          <input
                            type="number"
                            min={1}
                            max={10}
                            value={Number(
                              (selectedNode.data.config.retryPolicy as { maxAttempts?: number } | undefined)
                                ?.maxAttempts ?? 3
                            )}
                            onChange={(e) =>
                              updateSelectedConfig('retryPolicy', {
                                ...(selectedNode.data.config.retryPolicy as Record<string, unknown> | undefined),
                                maxAttempts: Number(e.target.value),
                              })
                            }
                            className="mt-1 w-full rounded-lg border border-[#2f373f] bg-[#0c0e10] px-2 py-1 font-mono text-xs text-zinc-100"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-zinc-400">Fail First N Tries</label>
                          <input
                            type="number"
                            min={0}
                            max={5}
                            value={Number(
                              selectedNode.data.config.simulateFailures ??
                                selectedNode.data.config.failFirstNAttempts ??
                                0
                            )}
                            onChange={(e) =>
                              updateSelectedConfig(
                                'simulateFailures',
                                Number(e.target.value) > 0 ? Number(e.target.value) : undefined
                              )
                            }
                            className="mt-1 w-full rounded-lg border border-[#2f373f] bg-[#0c0e10] px-2 py-1 font-mono text-xs text-zinc-100"
                          />
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-rose-300">
                        <input
                          type="checkbox"
                          checked={Boolean(selectedNode.data.config.alwaysFail)}
                          onChange={(e) => updateSelectedConfig('alwaysFail', e.target.checked || undefined)}
                          className="accent-rose-500"
                        />
                        Force permanent failure (triggers real Saga DB rollback)
                      </label>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {selectedNode && (
          <div className="flex shrink-0 items-center gap-2 border-t border-[#1c2227] bg-[#111417] p-3">
            <button
              type="button"
              onClick={() => {
                setSelectedNodeId(null);
                setShowInspector(false);
              }}
              className="flex-1 rounded border border-[#2f373f] bg-[#15191d] py-2 font-mono text-[11px] font-semibold text-zinc-200 hover:border-zinc-500 hover:text-white"
            >
              Done
            </button>
            <button
              type="button"
              disabled={busy || !activeWorkflow}
              onClick={() => void handleSaveDraft()}
              className="sf-btn-neon flex-1 rounded py-2 font-mono text-[11px] disabled:opacity-40"
            >
              Apply Step
            </button>
          </div>
        )}
      </aside>
      )}

      {/* IMPORT WORKFLOW JSON MODAL */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="sf-card w-full max-w-lg rounded-2xl p-6 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold text-white">Import Portable Workflow JSON</h3>
                <p className="text-xs text-zinc-400">
                  Upload a <code className="text-[#22e55c]">.sagaflow.json</code> file or paste exported JSON below.
                </p>
              </div>
              <button
                onClick={() => setShowImportModal(false)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-[#1c2227] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                file.text().then((txt) => setImportJsonText(txt));
              }}
              className="block w-full text-xs text-zinc-300 file:mr-3 file:rounded-lg file:border-0 file:bg-[#22e55c]/15 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-[#22e55c] hover:file:bg-[#22e55c]/25"
            />
            <textarea
              rows={9}
              value={importJsonText}
              onChange={(e) => setImportJsonText(e.target.value)}
              placeholder='{"name":"My Workflow","nodes":[...],"edges":[...]}'
              className="w-full rounded-xl border border-[#2f373f] bg-[#0c0e10] p-3 font-mono text-[11px] text-[#73ff86] outline-none focus:border-[#22e55c]"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowImportModal(false)}
                className="rounded-lg border border-[#2f373f] px-4 py-2 text-xs text-zinc-300 hover:bg-[#1c2227]"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleImportJson()}
                disabled={busy || !importJsonText.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-[#22e55c] px-4 py-2 text-xs font-semibold text-[#070b07] hover:bg-[#39ff14] disabled:opacity-40"
              >
                <Upload className="h-3.5 w-3.5" /> Import Workflow
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BLUEPRINT GALLERY MODAL */}
      {showBlueprintModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="sf-card w-full max-w-xl rounded-2xl p-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-white">Create Workflow</h3>
                <p className="text-xs text-zinc-400">
                  Start from a real production Saga template or an empty canvas.
                </p>
              </div>
              <button
                onClick={() => setShowBlueprintModal(false)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-[#1c2227] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[
                {
                  id: 'saga' as const,
                  title: 'Commerce Saga + Rollback',
                  desc: 'Reserves real DB stock, charges wallet, delivers live webhook receipt, rolls back atomically.',
                  badge: 'Transactional DB',
                },
                {
                  id: 'http' as const,
                  title: 'Live HTTP + Vault + KV',
                  desc: 'QuickJS-WASM transform, real HTTP POST with AES-GCM secret header, persists to Tenant KV.',
                  badge: 'Live HTTP Sink',
                },
                {
                  id: 'router' as const,
                  title: 'Conditional VIP Router',
                  desc: 'Evaluates QuickJS boolean expression and routes orders across true/false branches.',
                  badge: 'Branching DAG',
                },
                {
                  id: 'blank' as const,
                  title: 'Blank Workflow',
                  desc: 'Minimal Trigger + Saga Task starter ready for your own custom DAG.',
                  badge: 'Starter',
                },
              ].map((b) => (
                <button
                  key={b.id}
                  onClick={() => void createFromBlueprint(b.id)}
                  className="rounded-xl border border-[#262c32] bg-[#0c0e10]/80 p-4 text-left transition hover:border-[#22e55c]/50 hover:bg-[#15191d]"
                >
                  <span className="rounded-md bg-[#22e55c]/10 px-2 py-0.5 text-[10px] font-semibold text-[#22e55c]">
                    {b.badge}
                  </span>
                  <div className="mt-2 text-sm font-semibold text-white">{b.title}</div>
                  <p className="mt-1 text-xs text-zinc-400">{b.desc}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* RUN EXECUTION MODAL */}
      {showRunModal && activeWorkflow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="sf-card w-full max-w-lg rounded-2xl p-6 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold text-white">Execute: {activeWorkflow.name}</h3>
                <p className="text-xs text-zinc-400">
                  Runs against immutable v{activeWorkflow.latestVersion} with real persistent database state.
                </p>
              </div>
              <button
                onClick={() => setShowRunModal(false)}
                className="rounded-lg p-1.5 text-zinc-400 hover:bg-[#1c2227] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-300">Idempotency-Key (required)</label>
              <input
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[#2f373f] bg-[#0c0e10] px-3 py-2 font-mono text-xs text-[#22e55c] outline-none focus:border-[#22e55c]"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-300">JSON Input Payload</label>
              <textarea
                rows={6}
                value={runInputText}
                onChange={(e) => setRunInputText(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[#2f373f] bg-[#0c0e10] p-3 font-mono text-xs text-zinc-100 outline-none focus:border-[#22e55c]"
              />
            </div>
            {dirty && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                You have unsaved draft changes — this run executes the last published snapshot (v
                {activeWorkflow.latestVersion}).
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowRunModal(false)}
                className="rounded-lg border border-[#2f373f] px-4 py-2 text-xs text-zinc-300 hover:bg-[#1c2227]"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleStartRun()}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-lg bg-[#22e55c] px-4 py-2 text-xs font-semibold text-[#070b07] hover:bg-[#39ff14]"
              >
                <Play className="h-3.5 w-3.5 fill-current" /> Execute Now
              </button>
            </div>
          </div>
        </div>
      )}
      {/* v6.0 PRODUCTION BLUEPRINT GALLERY MODAL */}
      {showBlueprints && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="sf-popover flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg">
            <div className="flex items-center justify-between border-b border-[#262c32] bg-[#111417] px-5 py-3.5">
              <div>
                <div className="flex items-center gap-2">
                  <BookTemplate className="h-4 w-4 text-[#22e55c]" />
                  <h3 className="text-sm font-semibold text-[#f1f5f9]">
                    Production Saga Blueprint Gallery
                  </h3>
                  <span className="rounded border border-[#22e55c]/30 bg-[#22e55c]/10 px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-[#22e55c]">
                    {WORKFLOW_BLUEPRINTS.length} TEMPLATES
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-[#808d99]">
                  Clone ready-to-run automation workflows directly into your project, validated and
                  ready to dry-run or execute.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowBlueprints(false)}
                className="rounded p-1.5 text-[#808d99] hover:bg-[#1c2227] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 overflow-y-auto p-5 md:grid-cols-2">
              {WORKFLOW_BLUEPRINTS.map((bp: WorkflowBlueprint) => (
                <div
                  key={bp.id}
                  className="sf-card flex flex-col justify-between p-4 transition hover:border-[#22e55c]/45"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded border border-[#262c32] bg-[#111417] px-1.5 py-0.5 font-mono text-[9.5px] font-bold uppercase tracking-wider text-[#22e55c]">
                        {bp.category}
                      </span>
                      <span className="font-mono text-[10px] text-[#808d99]">
                        {bp.definition.nodes.length} nodes · {bp.definition.edges.length} edges
                      </span>
                    </div>
                    <h4 className="mt-2 text-sm font-semibold text-[#f1f5f9]">{bp.name}</h4>
                    <p className="mt-1 text-xs leading-relaxed text-[#808d99]">{bp.summary}</p>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {bp.highlights.map((h) => (
                        <span
                          key={h}
                          className="rounded border border-[#262c32] bg-[#111417] px-1.5 py-0.5 font-mono text-[9.5px] text-[#c7d1db]"
                        >
                          {h}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-end gap-2 border-t border-[#262c32] pt-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const created = await api.createWorkflow(session, bp.definition);
                          const published = await api.publishWorkflow(session, created.workflow.id);
                          await loadWorkflowList(published.workflow.id);
                          setDryRunInput(JSON.stringify(bp.sampleInput, null, 2));
                          setRunInputText(JSON.stringify(bp.sampleInput, null, 2));
                          setShowBlueprints(false);
                          onNotify(`Cloned & published "${bp.name}"`, 'ok');
                        } catch (err) {
                          onNotify(
                            err instanceof Error ? err.message : 'Failed to clone blueprint',
                            'err'
                          );
                        } finally {
                          setBusy(false);
                        }
                      }}
                      className="sf-btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10.5px] uppercase"
                    >
                      <Plus className="h-3 w-3" />
                      Clone &amp; Publish
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
