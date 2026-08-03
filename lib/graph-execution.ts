/** The subset of an edge needed to plan execution. */
export interface DependencyEdge {
  fromNode: string;
  toNode: string;
}

/** Model steps and PEG's deterministic local renderers execute in the service. */
export function isExecutableNode<T extends {provider?: string; model?: string}>(
  node: T,
): node is T & {provider: 'gmicloud-image' | 'bria-direct' | 'peg-local'; model: string} {
  return (
    (node.provider === 'gmicloud-image' ||
      node.provider === 'bria-direct' ||
      node.provider === 'peg-local') &&
    Boolean(node.model)
  );
}

export interface ExecutionPlan {
  ordered: string[];
  /** Nodes in, or blocked behind, a dependency cycle. */
  blocked: string[];
}

/**
 * Put runnable nodes after every runnable node that feeds them.
 *
 * Dependencies outside `ids` are intentionally ignored: running a selected
 * branch is allowed to consume an already-produced result from an unselected
 * upstream node.
 */
export function planDependencyOrder(
  ids: readonly string[],
  edges: readonly DependencyEdge[],
): ExecutionPlan {
  const uniqueIds = [...new Set(ids)];
  const included = new Set(uniqueIds);
  const dependencies = new Map(uniqueIds.map(id => [id, new Set<string>()]));

  for (const edge of edges) {
    if (included.has(edge.fromNode) && included.has(edge.toNode)) {
      dependencies.get(edge.toNode)!.add(edge.fromNode);
    }
  }

  const ordered: string[] = [];
  const remaining = new Set(uniqueIds);
  while (remaining.size > 0) {
    const ready = uniqueIds.filter(
      id => remaining.has(id) && [...dependencies.get(id)!].every(dep => !remaining.has(dep)),
    );
    if (ready.length === 0) break;
    for (const id of ready) {
      ordered.push(id);
      remaining.delete(id);
    }
  }

  return {ordered, blocked: uniqueIds.filter(id => remaining.has(id))};
}

export type SkipReason =
  | {kind: 'dependency-cycle'}
  | {kind: 'failed-dependency'; dependencyId: string};

export interface ExecutionSummary {
  completed: string[];
  failed: string[];
  skipped: string[];
}

interface ExecuteOptions {
  ids: readonly string[];
  edges: readonly DependencyEdge[];
  /** Re-resolve the node inside this callback so each step sees fresh state. */
  run: (id: string) => Promise<boolean>;
  onSkip?: (id: string, reason: SkipReason) => void;
}

/**
 * Execute a DAG sequentially while keeping independent fan-out branches alive.
 *
 * A failed plate skips everything downstream from that plate. A failed desktop
 * branch does not suppress its mobile sibling, because neither depends on the
 * other.
 */
export async function executeInDependencyOrder({
  ids,
  edges,
  run,
  onSkip,
}: ExecuteOptions): Promise<ExecutionSummary> {
  const uniqueIds = [...new Set(ids)];
  const included = new Set(uniqueIds);
  const {ordered, blocked} = planDependencyOrder(uniqueIds, edges);
  const failed = new Set<string>();
  const skipped: string[] = [];
  const completed: string[] = [];

  for (const id of blocked) {
    failed.add(id);
    skipped.push(id);
    onSkip?.(id, {kind: 'dependency-cycle'});
  }

  for (const id of ordered) {
    const failedDependency = edges.find(
      edge => edge.toNode === id && included.has(edge.fromNode) && failed.has(edge.fromNode),
    )?.fromNode;

    if (failedDependency) {
      failed.add(id);
      skipped.push(id);
      onSkip?.(id, {kind: 'failed-dependency', dependencyId: failedDependency});
      continue;
    }

    if (await run(id)) {
      completed.push(id);
    } else {
      failed.add(id);
    }
  }

  return {completed, failed: [...failed], skipped};
}
