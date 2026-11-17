import type {
  GraphIssue,
  WorkflowDiffSummary,
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeDiff,
} from './schemas.js';

export interface GraphValidationResult {
  valid: boolean;
  nodeCount: number;
  edgeCount: number;
  issues: GraphIssue[];
  topologicalOrder: string[];
}

/**
 * Validates a workflow DAG:
 * - Duplicate node IDs
 * - Duplicate edge IDs
 * - Missing node references on edges (from / to)
 * - Cycles (self-loops and multi-node cycles) with exact nodeId / edgeId attribution
 */
export function validateWorkflowGraph(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): GraphValidationResult {
  const issues: GraphIssue[] = [];
  const nodeIds = new Set<string>();
  const duplicateNodes = new Set<string>();

  for (const node of nodes) {
    if (nodeIds.has(node.id)) {
      if (!duplicateNodes.has(node.id)) {
        duplicateNodes.add(node.id);
        issues.push({
          code: 'duplicate_node_id',
          message: `Duplicate node ID "${node.id}". Every node must have a unique ID.`,
          nodeId: node.id,
        });
      }
    } else {
      nodeIds.add(node.id);
    }
  }

  const edgeIds = new Set<string>();
  const validEdges: WorkflowEdge[] = [];

  for (const edge of edges) {
    let edgeHasError = false;
    if (edgeIds.has(edge.id)) {
      issues.push({
        code: 'duplicate_edge_id',
        message: `Duplicate edge ID "${edge.id}". Every edge must have a unique ID.`,
        edgeId: edge.id,
      });
      edgeHasError = true;
    } else {
      edgeIds.add(edge.id);
    }

    if (!nodeIds.has(edge.from)) {
      issues.push({
        code: 'missing_node_reference',
        message: `Edge "${edge.id}" references unknown source node "${edge.from}".`,
        edgeId: edge.id,
        nodeId: edge.from,
      });
      edgeHasError = true;
    }

    if (!nodeIds.has(edge.to)) {
      issues.push({
        code: 'missing_node_reference',
        message: `Edge "${edge.id}" references unknown target node "${edge.to}".`,
        edgeId: edge.id,
        nodeId: edge.to,
      });
      edgeHasError = true;
    }

    if (edge.from === edge.to && nodeIds.has(edge.from)) {
      issues.push({
        code: 'cycle',
        message: `Node "${edge.from}" has a self-loop edge "${edge.id}"; DAGs must be acyclic.`,
        nodeId: edge.from,
        edgeId: edge.id,
      });
      edgeHasError = true;
    }

    if (!edgeHasError) {
      validEdges.push(edge);
    }
  }

  // Kahn's topological sort for DAG verification + cycle detection
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, WorkflowEdge[]>();
  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }
  for (const edge of validEdges) {
    adjacency.get(edge.from)!.push(edge);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    topologicalOrder.push(curr);
    for (const edge of adjacency.get(curr) ?? []) {
      const nextDeg = (inDegree.get(edge.to) ?? 1) - 1;
      inDegree.set(edge.to, nextDeg);
      if (nextDeg === 0) {
        queue.push(edge.to);
      }
    }
  }

  // If not all nodes were ordered, find exact cycle edges using DFS on remaining nodes
  if (topologicalOrder.length < nodeIds.size) {
    const remaining = new Set<string>();
    for (const id of nodeIds) {
      if (!topologicalOrder.includes(id)) {
        remaining.add(id);
      }
    }

    const color = new Map<string, 0 | 1 | 2>(); // 0=white, 1=gray, 2=black
    for (const id of remaining) color.set(id, 0);

    const reportedEdges = new Set<string>();
    const dfs = (u: string) => {
      color.set(u, 1);
      for (const edge of adjacency.get(u) ?? []) {
        if (!remaining.has(edge.to)) continue;
        const c = color.get(edge.to) ?? 0;
        if (c === 1) {
          if (!reportedEdges.has(edge.id)) {
            reportedEdges.add(edge.id);
            issues.push({
              code: 'cycle',
              message: `Workflow graph contains a cycle involving "${edge.from}" -> "${edge.to}"; DAGs must be acyclic.`,
              nodeId: edge.to,
              edgeId: edge.id,
            });
          }
        } else if (c === 0) {
          dfs(edge.to);
        }
      }
      color.set(u, 2);
    };

    for (const id of remaining) {
      if (color.get(id) === 0) {
        dfs(id);
      }
    }

    // Fallback safety in case cycle wasn't emitted
    if (reportedEdges.size === 0) {
      const firstNode = Array.from(remaining)[0];
      issues.push({
        code: 'cycle',
        message: 'Workflow graph contains a cycle; DAGs must be acyclic.',
        nodeId: firstNode,
      });
    }
  }

  return {
    valid: issues.length === 0,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    issues,
    topologicalOrder: issues.length === 0 ? topologicalOrder : [],
  };
}

/**
 * Computes clean left-to-right layered positions for DAG auto-layout.
 */
export function computeAutoLayout(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): Record<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();

  for (const n of nodes) {
    depth.set(n.id, 0);
    parents.set(n.id, []);
    children.set(n.id, []);
  }
  for (const e of edges) {
    if (parents.has(e.to) && children.has(e.from) && e.from !== e.to) {
      parents.get(e.to)!.push(e.from);
      children.get(e.from)!.push(e.to);
    }
  }

  // Relax depths up to nodes.length times (cycle-safe)
  for (let iter = 0; iter < nodes.length; iter++) {
    let changed = false;
    for (const e of edges) {
      const df = depth.get(e.from);
      const dt = depth.get(e.to);
      if (df !== undefined && dt !== undefined && dt < df + 1) {
        depth.set(e.to, df + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const layers = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(n.id);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  const colSpacing = 310;
  const rowSpacing = 150;

  for (const [layerIdx, ids] of layers.entries()) {
    const totalHeight = (ids.length - 1) * rowSpacing;
    const startY = Math.max(60, 220 - totalHeight / 2);
    ids.forEach((id, rowIdx) => {
      positions[id] = {
        x: 60 + layerIdx * colSpacing,
        y: Math.round(startY + rowIdx * rowSpacing),
      };
    });
  }

  return positions;
}

/**
 * Computes a deterministic structural diff between two workflow DAG graphs
 * (e.g. published v1 vs v2, or published v1 vs current editable draft).
 */
export function computeWorkflowDiff(params: {
  workflowId: string;
  fromRef: string;
  toRef: string;
  fromNodes: WorkflowNode[];
  fromEdges: WorkflowEdge[];
  toNodes: WorkflowNode[];
  toEdges: WorkflowEdge[];
}): WorkflowDiffSummary {
  const { workflowId, fromRef, toRef, fromNodes, fromEdges, toNodes, toEdges } = params;
  const fromNodeMap = new Map(fromNodes.map((n) => [n.id, n]));
  const toNodeMap = new Map(toNodes.map((n) => [n.id, n]));

  const addedNodes: WorkflowDiffSummary['addedNodes'] = [];
  const removedNodes: WorkflowDiffSummary['removedNodes'] = [];
  const modifiedNodes: WorkflowNodeDiff[] = [];

  for (const n of toNodes) {
    if (!fromNodeMap.has(n.id)) {
      addedNodes.push({ id: n.id, label: n.label ?? n.id, type: n.type });
    } else {
      const prev = fromNodeMap.get(n.id)!;
      const changedFields: string[] = [];
      if (prev.type !== n.type) changedFields.push('type');
      if ((prev.label ?? prev.id) !== (n.label ?? n.id)) changedFields.push('label');

      const prevCfg = prev.config ?? {};
      const nextCfg = n.config ?? {};
      const allKeys = new Set([...Object.keys(prevCfg), ...Object.keys(nextCfg)]);
      for (const k of allKeys) {
        if (JSON.stringify(prevCfg[k]) !== JSON.stringify(nextCfg[k])) {
          changedFields.push(`config.${k}`);
        }
      }

      if (changedFields.length > 0) {
        modifiedNodes.push({
          id: n.id,
          label: n.label ?? n.id,
          type: n.type,
          changedFields,
          before: prevCfg,
          after: nextCfg,
        });
      }
    }
  }

  for (const n of fromNodes) {
    if (!toNodeMap.has(n.id)) {
      removedNodes.push({ id: n.id, label: n.label ?? n.id, type: n.type });
    }
  }

  const edgeKey = (e: WorkflowEdge) => `${e.from}->${e.to}:${e.condition ?? 'always'}`;
  const fromEdgeKeys = new Set(fromEdges.map(edgeKey));
  const toEdgeKeys = new Set(toEdges.map(edgeKey));

  const addedEdges = toEdges
    .filter((e) => !fromEdgeKeys.has(edgeKey(e)))
    .map((e) => ({ id: e.id, from: e.from, to: e.to, condition: e.condition }));

  const removedEdges = fromEdges
    .filter((e) => !toEdgeKeys.has(edgeKey(e)))
    .map((e) => ({ id: e.id, from: e.from, to: e.to, condition: e.condition }));

  const identical =
    addedNodes.length === 0 &&
    removedNodes.length === 0 &&
    modifiedNodes.length === 0 &&
    addedEdges.length === 0 &&
    removedEdges.length === 0;

  return {
    workflowId,
    fromRef,
    toRef,
    identical,
    addedNodes,
    removedNodes,
    modifiedNodes,
    addedEdges,
    removedEdges,
  };
}
