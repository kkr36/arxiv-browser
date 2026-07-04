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
const H_GAP = 48;
const V_GAP = 14;
const PAD = 16;

/**
 * Layered left-to-right layout: column = citation depth (longest path from a
 * root, with a stack guard so citation cycles can't recurse forever), rows
 * assigned in DFS pre-order so children sit near their parents. Plenty for
 * the tens of nodes a browsing session produces.
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

  const rowsUsed = new Map<number, number>();
  let maxDepth = 0;
  let maxRow = 0;
  for (const id of order) {
    const d = depth.get(id) ?? 0;
    const row = rowsUsed.get(d) ?? 0;
    rowsUsed.set(d, row + 1);
    positions.set(id, {
      x: PAD + d * (NODE_W + H_GAP),
      y: PAD + row * (NODE_H + V_GAP),
    });
    maxDepth = Math.max(maxDepth, d);
    maxRow = Math.max(maxRow, row);
  }

  return {
    positions,
    width: PAD * 2 + (maxDepth + 1) * NODE_W + maxDepth * H_GAP,
    height: PAD * 2 + (maxRow + 1) * NODE_H + maxRow * V_GAP,
  };
}
