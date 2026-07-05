import type { ExplorationGraph } from "./explorationGraph";

export interface NodePos {
  x: number;
  y: number;
}

export interface GraphLayout {
  positions: Map<string, NodePos>;
  width: number;
  height: number;
}

export const NODE_W = 168;
export const NODE_H = 42;
const X_GAP = 16;
const Y_GAP = 34;
const PAD = 16;

/**
 * Layered top-to-bottom layout: row = citation depth (longest path from a
 * root, with a stack guard so citation cycles can't recurse forever), lanes
 * assigned in DFS pre-order so children sit near their parents. This favors
 * vertical growth for the side panel while still letting branchy graphs fan
 * out horizontally when needed.
 */
export function layoutGraph(graph: ExplorationGraph): GraphLayout {
  const positions = new Map<string, NodePos>();
  if (graph.nodes.length === 0) return { positions, width: 0, height: 0 };

  const ids = graph.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const parents = new Map<string, string[]>(ids.map((id) => [id, []]));
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    parents.get(e.to)?.push(e.from);
    children.get(e.from)?.push(e.to);
  }

  const depth = new Map<string, number>();
  const onStack = new Set<string>();
  const depthOf = (id: string): number => {
    const memo = depth.get(id);
    if (memo !== undefined) return memo;
    onStack.add(id);
    let d = 0;
    for (const p of parents.get(id) ?? []) {
      if (onStack.has(p)) continue;
      d = Math.max(d, depthOf(p) + 1);
    }
    onStack.delete(id);
    depth.set(id, d);
    return d;
  };
  ids.forEach(depthOf);

  const order: string[] = [];
  const visited = new Set<string>();
  const dfs = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    order.push(id);
    for (const c of children.get(id) ?? []) dfs(c);
  };
  for (const id of ids) if ((parents.get(id) ?? []).length === 0) dfs(id);
  // Components that are pure cycles have no root; pick them up in id order.
  for (const id of ids) dfs(id);

  const lanesUsed = new Map<number, number>();
  let maxDepth = 0;
  let maxLane = 0;
  for (const id of order) {
    const d = depth.get(id) ?? 0;
    const lane = lanesUsed.get(d) ?? 0;
    lanesUsed.set(d, lane + 1);
    positions.set(id, {
      x: PAD + lane * (NODE_W + X_GAP),
      y: PAD + d * (NODE_H + Y_GAP),
    });
    maxDepth = Math.max(maxDepth, d);
    maxLane = Math.max(maxLane, lane);
  }

  return {
    positions,
    width: PAD * 2 + (maxLane + 1) * NODE_W + maxLane * X_GAP,
    height: PAD * 2 + (maxDepth + 1) * NODE_H + maxDepth * Y_GAP,
  };
}
