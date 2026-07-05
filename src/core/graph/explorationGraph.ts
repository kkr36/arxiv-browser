import type { ResolvedAuthorPage, ResolvedPaper } from "../types";

export interface GraphNode {
  id: string;
  title: string;
  /** Address the in-app browser can reload (a PDF URL, or an uploaded file's name). */
  address?: string;
  pdfUrl?: string;
  semanticScholarUrl?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  abstract?: string;
  /** "external" papers had no fetchable PDF — they open on Semantic Scholar in a new tab. */
  kind: "pdf" | "external" | "author";
  source?: "google-scholar" | "semantic-scholar";
  googleScholarUrl?: string;
  homepage?: string;
  paperCount?: number;
  citationCount?: number;
  hIndex?: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

/**
 * The session's exploration history as a directed graph: an edge A → B means
 * "B was opened from a citation clicked while reading A". Papers opened
 * directly (address bar, upload) have no incoming edge and are roots.
 */
export interface ExplorationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const EMPTY_GRAPH: ExplorationGraph = { nodes: [], edges: [] };

export function nodeIdForPaper(paper: ResolvedPaper): string {
  return paper.pdfUrl ?? paper.semanticScholarUrl ?? `title:${paper.title}`;
}

export function nodeFromPaper(paper: ResolvedPaper): GraphNode {
  return {
    id: nodeIdForPaper(paper),
    title: paper.title,
    address: paper.pdfUrl,
    pdfUrl: paper.pdfUrl,
    semanticScholarUrl: paper.semanticScholarUrl,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    abstract: paper.abstract,
    kind: paper.pdfUrl ? "pdf" : "external",
  };
}

export function nodeIdForAuthor(author: ResolvedAuthorPage): string {
  return author.id;
}

export function nodeFromAuthor(author: ResolvedAuthorPage): GraphNode {
  return {
    id: nodeIdForAuthor(author),
    title: author.name,
    address: author.url ?? author.googleScholarUrl ?? author.semanticScholarUrl,
    semanticScholarUrl: author.semanticScholarUrl,
    kind: "author",
    source: author.source,
    googleScholarUrl: author.googleScholarUrl,
    homepage: author.homepage,
    paperCount: author.paperCount,
    citationCount: author.citationCount,
    hIndex: author.hIndex,
  };
}

/**
 * Adds `node` to the graph — merging metadata when a node with the same id
 * already exists — and, when `parentId` is given, records the edge
 * parent → node. Pure: returns a new graph.
 */
export function addPaperNode(
  graph: ExplorationGraph,
  node: GraphNode,
  parentId: string | null,
): ExplorationGraph {
  const exists = graph.nodes.some((n) => n.id === node.id);
  const nodes = exists
    ? graph.nodes.map((n) => (n.id === node.id ? mergeNodes(n, node) : n))
    : [...graph.nodes, node];

  const needEdge =
    parentId !== null &&
    parentId !== node.id &&
    graph.nodes.some((n) => n.id === parentId) &&
    !graph.edges.some((e) => e.from === parentId && e.to === node.id);
  const edges = needEdge
    ? [...graph.edges, { from: parentId as string, to: node.id }]
    : graph.edges;

  return { nodes, edges };
}

/**
 * Replaces a node's title, but only while the current one is still an
 * address-shaped placeholder (URL / arXiv id / file name) — a real title,
 * e.g. from Semantic Scholar, is never downgraded.
 */
export function upgradePlaceholderTitle(
  graph: ExplorationGraph,
  id: string,
  title: string,
): ExplorationGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === id && looksLikeAddress(n.title) ? { ...n, title } : n,
    ),
  };
}

/** Removes a node and its incident edges. Children of the removed node keep
 * their other parents, or become roots. Pure: returns a new graph. */
export function removeNode(graph: ExplorationGraph, id: string): ExplorationGraph {
  return {
    nodes: graph.nodes.filter((n) => n.id !== id),
    edges: graph.edges.filter((e) => e.from !== id && e.to !== id),
  };
}

/** Node ids with no incoming edge — the papers the user opened directly. */
export function rootIds(graph: ExplorationGraph): Set<string> {
  const targets = new Set(graph.edges.map((e) => e.to));
  return new Set(graph.nodes.filter((n) => !targets.has(n.id)).map((n) => n.id));
}

function mergeNodes(existing: GraphNode, incoming: GraphNode): GraphNode {
  return {
    ...existing,
    title:
      looksLikeAddress(existing.title) && !looksLikeAddress(incoming.title)
        ? incoming.title
        : existing.title,
    address: existing.address ?? incoming.address,
    pdfUrl: existing.pdfUrl ?? incoming.pdfUrl,
    semanticScholarUrl: existing.semanticScholarUrl ?? incoming.semanticScholarUrl,
    authors: existing.authors?.length ? existing.authors : incoming.authors,
    year: existing.year ?? incoming.year,
    venue: existing.venue ?? incoming.venue,
    abstract: existing.abstract ?? incoming.abstract,
    source: existing.source ?? incoming.source,
    googleScholarUrl: existing.googleScholarUrl ?? incoming.googleScholarUrl,
    homepage: existing.homepage ?? incoming.homepage,
    paperCount: existing.paperCount ?? incoming.paperCount,
    citationCount: existing.citationCount ?? incoming.citationCount,
    hIndex: existing.hIndex ?? incoming.hIndex,
    kind:
      existing.kind === "pdf" || incoming.kind === "pdf"
        ? "pdf"
        : existing.kind === "author" || incoming.kind === "author"
          ? "author"
          : "external",
  };
}

function looksLikeAddress(s: string): boolean {
  return /^https?:\/\//i.test(s) || /\.pdf$/i.test(s) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(s);
}
