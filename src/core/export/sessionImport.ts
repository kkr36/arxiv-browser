import type { ExplorationGraph, GraphEdge, GraphNode } from "../graph/explorationGraph";
import { NODE_H, NODE_W } from "../graph/layoutGraph";
import type { SessionExport, SessionExportNode } from "./sessionExport";

export interface ImportedSession {
  graph: ExplorationGraph;
  title?: string;
  exportedAt?: string;
  degraded: boolean;
}

interface SessionPayload {
  schema?: string;
  version?: number;
  session?: SessionExport;
}

interface LegacyPreviewNode {
  title?: unknown;
  authors?: unknown;
  year?: unknown;
  venue?: unknown;
  abstract?: unknown;
  pdfUrl?: unknown;
  semanticScholarUrl?: unknown;
  googleScholarUrl?: unknown;
  kind?: unknown;
}

export function parseSessionExportHtml(html: string): ImportedSession {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const payloadText = doc.getElementById("arxiv-browser-session")?.textContent;
  if (payloadText) {
    const payload = JSON.parse(payloadText) as SessionPayload;
    if (payload.schema !== "arxiv-browser-session" || !payload.session) {
      throw new Error("This HTML file does not contain a readable arxiv-browser session.");
    }
    return {
      graph: graphFromSession(payload.session),
      title: payload.session.title,
      exportedAt: payload.session.exportedAt,
      degraded: false,
    };
  }

  const legacy = parseLegacyPreviewData(doc);
  if (legacy) return legacy;
  throw new Error("This does not look like an arxiv-browser HTML session export.");
}

function graphFromSession(session: SessionExport): ExplorationGraph {
  const nodes = session.nodes.map(nodeFromSessionNode);
  const ids = new Set(nodes.map((n) => n.id));
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];
  const addEdge = (from: string, to: string) => {
    if (!ids.has(from) || !ids.has(to)) return;
    const key = `${from}\u0000${to}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to });
  };

  for (const node of session.nodes) {
    for (const parent of node.parents) addEdge(parent, node.id);
    for (const child of node.children) addEdge(node.id, child);
  }

  return { nodes, edges };
}

function nodeFromSessionNode(node: SessionExportNode): GraphNode {
  const address =
    node.kind === "author"
      ? node.links.googleScholarUrl ?? node.links.semanticScholarUrl
      : node.links.pdfUrl;
  return {
    id: node.id,
    title: node.title,
    address,
    pdfUrl: node.links.pdfUrl,
    semanticScholarUrl: node.links.semanticScholarUrl,
    authors: node.authors,
    year: node.year,
    venue: node.venue,
    abstract: node.abstract,
    kind: node.kind,
    googleScholarUrl: node.links.googleScholarUrl,
    homepage: node.links.homepage,
    paperCount: node.paperCount,
    citationCount: node.citationCount,
    hIndex: node.hIndex,
  };
}

function parseLegacyPreviewData(doc: Document): ImportedSession | null {
  const script = [...doc.scripts].find((s) => s.textContent?.includes("var DATA ="));
  const source = script?.textContent;
  if (!source) return null;
  const match = source.match(/var DATA = (\{[\s\S]*?\});\s*var card =/);
  if (!match) return null;

  const parsed = JSON.parse(match[1]) as Record<string, LegacyPreviewNode>;
  const nodes: GraphNode[] = [];
  for (const [id, raw] of Object.entries(parsed)) {
    if (typeof raw.title !== "string") continue;
    const kind = raw.kind === "author" || raw.kind === "external" ? raw.kind : "pdf";
    const pdfUrl = typeof raw.pdfUrl === "string" ? raw.pdfUrl : undefined;
    nodes.push({
      id,
      title: raw.title,
      address: pdfUrl,
      pdfUrl,
      semanticScholarUrl:
        typeof raw.semanticScholarUrl === "string" ? raw.semanticScholarUrl : undefined,
      googleScholarUrl:
        typeof raw.googleScholarUrl === "string" ? raw.googleScholarUrl : undefined,
      authors: Array.isArray(raw.authors)
        ? raw.authors.filter((a): a is string => typeof a === "string")
        : undefined,
      year: typeof raw.year === "number" ? raw.year : undefined,
      venue: typeof raw.venue === "string" ? raw.venue : undefined,
      abstract: typeof raw.abstract === "string" ? raw.abstract : undefined,
      kind,
    });
  }

  return nodes.length ? { graph: { nodes, edges: parseLegacyEdges(doc) }, degraded: true } : null;
}

function parseLegacyEdges(doc: Document): GraphEdge[] {
  const positions = new Map<string, { x: number; y: number }>();
  for (const el of [...doc.querySelectorAll("g.node[data-id]")]) {
    const id = el.getAttribute("data-id");
    const transform = el.getAttribute("transform") ?? "";
    const match = transform.match(/translate\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
    if (!id || !match) continue;
    positions.set(id, { x: Number(match[1]), y: Number(match[2]) });
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const path of [...doc.querySelectorAll("path.edge")]) {
    const nums = (path.getAttribute("d") ?? "").match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    if (!nums || nums.length < 8) continue;
    const from = closestNode(positions, { x: nums[0], y: nums[1] }, "bottom");
    const to = closestNode(positions, { x: nums[6], y: nums[7] + 3 }, "top");
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  return edges;
}

function closestNode(
  positions: Map<string, { x: number; y: number }>,
  point: { x: number; y: number },
  anchor: "top" | "bottom",
): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const [id, pos] of positions) {
    const nodePoint = {
      x: pos.x + NODE_W / 2,
      y: anchor === "bottom" ? pos.y + NODE_H : pos.y,
    };
    const distance = Math.hypot(point.x - nodePoint.x, point.y - nodePoint.y);
    if (!best || distance < best.distance) best = { id, distance };
  }
  return best && best.distance < 4 ? best.id : null;
}
