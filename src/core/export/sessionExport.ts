import type { ExplorationGraph, GraphNode } from "../graph/explorationGraph";
import type { GraphLayout, NodePos } from "../graph/layoutGraph";

/**
 * Target-neutral snapshot of an exploration session, consumed by every export
 * target (Obsidian vault, Semble collection, …). Nodes are listed in trail
 * order — roots first, each subtree in the order it was explored — so all
 * targets present the session in the same sequence.
 */
export interface SessionExport {
  /** ISO date (yyyy-mm-dd) the export was taken. */
  exportedAt: string;
  /** Human-readable session title, e.g. "Paper exploration — 2026-07-06". */
  title: string;
  nodes: SessionExportNode[];
  rootIds: string[];
}

export interface SessionExportNode {
  id: string;
  title: string;
  kind: "pdf" | "external" | "author";
  /** Best public URL for the node; undefined for title-only placeholder nodes. */
  canonicalUrl?: string;
  links: {
    pdfUrl?: string;
    semanticScholarUrl?: string;
    googleScholarUrl?: string;
    homepage?: string;
    /** User-supplied link from a node annotation. */
    custom?: string;
  };
  authors?: string[];
  year?: number;
  venue?: string;
  abstract?: string;
  /** User-written annotation. */
  note?: string;
  paperCount?: number;
  citationCount?: number;
  hIndex?: number;
  /** Parent/child node ids (edge order preserved). */
  parents: string[];
  children: string[];
  isRoot: boolean;
  /** Index in trail order. */
  order: number;
  /** Panel position (auto layout merged with manual drags) when provided. */
  position?: NodePos;
}

export function canonicalNodeUrl(node: GraphNode): string | undefined {
  return (
    node.userUrl ?? node.pdfUrl ?? node.semanticScholarUrl ?? node.googleScholarUrl ?? node.homepage
  );
}

/**
 * Trail order: DFS pre-order from roots in insertion order — the same walk
 * layoutGraph uses to assign lanes — then any leftover pure-cycle nodes.
 */
export function trailOrder(graph: ExplorationGraph): string[] {
  const idSet = new Set(graph.nodes.map((n) => n.id));
  const hasParent = new Set<string>();
  const children = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    hasParent.add(e.to);
    const list = children.get(e.from);
    if (list) list.push(e.to);
    else children.set(e.from, [e.to]);
  }

  const order: string[] = [];
  const visited = new Set<string>();
  const dfs = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    order.push(id);
    for (const c of children.get(id) ?? []) dfs(c);
  };
  for (const n of graph.nodes) if (!hasParent.has(n.id)) dfs(n.id);
  for (const n of graph.nodes) dfs(n.id);
  return order;
}

export function buildSessionExport(
  graph: ExplorationGraph,
  layout?: GraphLayout,
  now: Date = new Date(),
): SessionExport {
  const exportedAt = now.toISOString().slice(0, 10);
  const ids = graph.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const parents = new Map<string, string[]>(ids.map((id) => [id, []]));
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    parents.get(e.to)?.push(e.from);
    children.get(e.from)?.push(e.to);
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const order = trailOrder(graph);
  const nodes = order.map((id, index): SessionExportNode => {
    const n = byId.get(id)!;
    const nodeParents = parents.get(id) ?? [];
    return {
      id,
      title: n.title,
      kind: n.kind,
      canonicalUrl: canonicalNodeUrl(n),
      links: {
        pdfUrl: n.pdfUrl,
        semanticScholarUrl: n.semanticScholarUrl,
        googleScholarUrl: n.googleScholarUrl,
        homepage: n.homepage,
        custom: n.userUrl,
      },
      authors: n.authors,
      year: n.year,
      venue: n.venue,
      abstract: n.abstract,
      note: n.note,
      paperCount: n.paperCount,
      citationCount: n.citationCount,
      hIndex: n.hIndex,
      parents: nodeParents,
      children: children.get(id) ?? [],
      isRoot: nodeParents.length === 0,
      order: index,
      position: layout?.positions.get(id),
    };
  });

  return {
    exportedAt,
    title: `Paper exploration — ${exportedAt}`,
    nodes,
    rootIds: nodes.filter((n) => n.isRoot).map((n) => n.id),
  };
}
