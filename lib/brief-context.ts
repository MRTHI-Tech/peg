/**
 * What the graph already knows about a brief.
 *
 * A brief on its own describes a picture. A brief that knows which breakpoint
 * it is destined for can describe a *composition* — subject at the focal point,
 * the copy-safe band left quiet. That is the whole "compose, don't crop" thesis,
 * so the enhancer is given the target rather than left to guess.
 *
 * Kept separate from the canvas component, and pure, so the walk is testable
 * without mounting an editor.
 */

export interface BriefGraphNode {
  id: string;
  type: string;
  params: Record<string, string | number | boolean>;
}

export interface BriefGraphEdge {
  fromNode: string;
  toNode: string;
  toPort: string;
}

/**
 * Where a brief's target geometry was found, and the params holding it.
 *
 * The params are returned raw rather than converted, so this stays a pure graph
 * walk with no dependency on the format tables — `format` params go through
 * toRunFormat, `canvas-node` params through toOutpaintFormat.
 */
export interface BriefTarget {
  source: 'format' | 'canvas-node';
  params: Record<string, string | number | boolean>;
}

/** How far downstream to look before giving up. Guards against a long chain. */
const MAX_DEPTH = 8;

/**
 * Find the canvas a brief is ultimately composed for.
 *
 * Walks forward along prompt edges — a brief usually reaches its model through
 * Art Direct, so stopping at the first hop would find nothing — and returns the
 * first target on that path.
 *
 * Fan-out is real and deliberate: one brief feeds desktop, mobile, and square.
 * Breadth-first order means the nearest target wins, which is the one the user
 * wired first. Returns undefined when nothing downstream names a canvas, and
 * the enhancement simply proceeds without composition direction.
 */
export function resolveBriefTarget(
  briefId: string,
  nodes: readonly BriefGraphNode[],
  edges: readonly BriefGraphEdge[],
): BriefTarget | undefined {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const seen = new Set<string>([briefId]);
  let frontier = [briefId];

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const consumers = frontier.flatMap(id =>
      edges.filter(edge => edge.fromNode === id && edge.toPort === 'prompt').map(e => e.toNode),
    );

    const next: string[] = [];
    for (const id of consumers) {
      if (seen.has(id)) continue; // a user-built graph can contain a cycle
      seen.add(id);
      next.push(id);

      const formatEdge = edges.find(edge => edge.toNode === id && edge.toPort === 'format');
      const formatNode = formatEdge ? byId.get(formatEdge.fromNode) : undefined;
      if (formatNode) return {source: 'format', params: formatNode.params};

      // Extend Canvas carries its own target, so a brief feeding one still
      // knows the shape it has to survive even with no Format node wired up.
      const consumer = byId.get(id);
      if (consumer?.type === 'genfill') return {source: 'canvas-node', params: consumer.params};
    }
    frontier = next;
  }

  return undefined;
}
