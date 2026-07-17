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
/** Width budget before a node's children wrap onto the next row (~3 columns).
 * Keeps branchy graphs growing vertically instead of forcing horizontal
 * scrolling in the side panel. */
const MAX_ROW_W = 3 * NODE_W + 2 * X_GAP;

/** A laid-out subtree: its bounding box, plus a placer that assigns absolute
 * positions once the block's top-left corner is known. */
interface Block {
  w: number;
  h: number;
  place: (x: number, y: number) => void;
}

/**
 * Compact tree-block layout. Each node is centered above its children, and a
 * node's child blocks wrap into multiple rows once they exceed MAX_ROW_W —
 * so exploring many citations from one paper grows the graph downward, not
 * into an unscrollable horizontal sprawl. The spanning tree follows each
 * node's first-discovered parent (DFS from roots in insertion order, with
 * leftover citation-cycle nodes picked up as extra roots); any additional
 * edges are simply drawn between the placed nodes.
 */
export function layoutGraph(graph: ExplorationGraph): GraphLayout {
  const positions = new Map<string, NodePos>();
  if (graph.nodes.length === 0) return { positions, width: 0, height: 0 };

  const ids = graph.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const hasParent = new Set<string>();
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    hasParent.add(e.to);
    children.get(e.from)?.push(e.to);
  }

  // Spanning forest: each node hangs under the parent that first reaches it.
  const treeChildren = new Map<string, string[]>(ids.map((id) => [id, []]));
  const visited = new Set<string>();
  const claim = (id: string) => {
    visited.add(id);
    for (const c of children.get(id) ?? []) {
      if (visited.has(c)) continue;
      treeChildren.get(id)?.push(c);
      claim(c);
    }
  };
  const roots: string[] = [];
  for (const id of ids) {
    if (!hasParent.has(id)) {
      roots.push(id);
      claim(id);
    }
  }
  // Components that are pure cycles have no root; pick them up in id order.
  for (const id of ids) {
    if (!visited.has(id)) {
      roots.push(id);
      claim(id);
    }
  }

  const blockOf = (id: string): Block => {
    const kids = (treeChildren.get(id) ?? []).map(blockOf);
    if (kids.length === 0) {
      return {
        w: NODE_W,
        h: NODE_H,
        place: (x, y) => positions.set(id, { x, y }),
      };
    }
    const rows = wrapIntoRows(kids);
    const kidsW = Math.max(...rows.map(rowWidth));
    const kidsH =
      rows.reduce((sum, row) => sum + rowHeight(row), 0) + (rows.length - 1) * Y_GAP;
    const w = Math.max(NODE_W, kidsW);
    return {
      w,
      h: NODE_H + Y_GAP + kidsH,
      place: (x, y) => {
        positions.set(id, { x: x + (w - NODE_W) / 2, y });
        let rowY = y + NODE_H + Y_GAP;
        for (const row of rows) {
          let colX = x + (w - rowWidth(row)) / 2;
          for (const kid of row) {
            kid.place(colX, rowY);
            colX += kid.w + X_GAP;
          }
          rowY += rowHeight(row) + Y_GAP;
        }
      },
    };
  };

  // Roots stack with the same wrapping, so several small explorations share a
  // row while a deep one still gets a band of its own.
  const rootRows = wrapIntoRows(roots.map(blockOf));
  let y = PAD;
  let width = 0;
  for (const row of rootRows) {
    let x = PAD;
    for (const block of row) {
      block.place(x, y);
      x += block.w + X_GAP;
    }
    width = Math.max(width, x - X_GAP + PAD);
    y += rowHeight(row) + Y_GAP;
  }

  return { positions, width, height: y - Y_GAP + PAD };
}

function wrapIntoRows(blocks: Block[]): Block[][] {
  const rows: Block[][] = [];
  let row: Block[] = [];
  let rowW = 0;
  for (const block of blocks) {
    const nextW = rowW === 0 ? block.w : rowW + X_GAP + block.w;
    if (row.length > 0 && nextW > MAX_ROW_W) {
      rows.push(row);
      row = [block];
      rowW = block.w;
    } else {
      row.push(block);
      rowW = nextW;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

function rowWidth(row: Block[]): number {
  return row.reduce((sum, b) => sum + b.w, 0) + (row.length - 1) * X_GAP;
}

function rowHeight(row: Block[]): number {
  return Math.max(...row.map((b) => b.h));
}
