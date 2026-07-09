import { useEffect, useMemo, useRef, useState } from "react";
import type { ExplorationGraph, GraphNode } from "../core/graph/explorationGraph";
import { rootIds } from "../core/graph/explorationGraph";
import { layoutGraph, NODE_H, NODE_W, type GraphLayout, type NodePos } from "../core/graph/layoutGraph";
import { buildSessionExport } from "../core/export/sessionExport";
import { createZip } from "../core/export/zip";
import { buildObsidianVault } from "../core/export/obsidian/obsidianVault";
import { buildGraphExportHtml } from "./exportGraphHtml";
import { SESSION_DOWNLOAD_DIR, downloadBlob } from "./download";
import { SembleDialog } from "./SembleDialog";
import "./graphPanel.css";

interface GraphPanelProps {
  graph: ExplorationGraph;
  /** Node of the paper currently shown in the viewer (highlighted). */
  currentNodeId: string | null;
  onSelectNode: (node: GraphNode) => void;
  onRemoveNode: (id: string) => void;
  onAddEdge: (from: string, to: string) => void;
  onClose: () => void;
}

const WIDTH_KEY = "arxiv-browser:graph-panel-width";
const POSITIONS_KEY = "arxiv-browser:graph-node-positions";
const MIN_WIDTH = 240;
const CANVAS_PAD = 16;
const DRAG_THRESHOLD = 3;

function initialWidth(): number {
  const stored = Number(localStorage.getItem(WIDTH_KEY));
  return stored >= MIN_WIDTH ? stored : 400;
}

interface HoverState {
  node: GraphNode;
  /** Viewport coords of the hovered node box, for anchoring the preview card. */
  x: number;
  y: number;
}

export function GraphPanel({
  graph,
  currentNodeId,
  onSelectNode,
  onRemoveNode,
  onAddEdge,
  onClose,
}: GraphPanelProps) {
  const baseLayout = useMemo(() => layoutGraph(graph), [graph]);
  const roots = useMemo(() => rootIds(graph), [graph]);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [width, setWidth] = useState(initialWidth);
  const [manualPositions, setManualPositions] = useState(initialManualPositions);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [manualCitationOpen, setManualCitationOpen] = useState(false);
  const [sembleOpen, setSembleOpen] = useState(false);
  const [linkFromId, setLinkFromId] = useState("");
  const [linkToId, setLinkToId] = useState("");
  const [sortMode, setSortMode] = useState<GraphSortMode>("manual");
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const manualCitationRef = useRef<HTMLDivElement | null>(null);
  const layout = useMemo(
    () => layoutWithManualPositions(baseLayout, graph, manualPositions),
    [baseLayout, graph, manualPositions],
  );
  const manualPositionCount = useMemo(
    () => graph.nodes.reduce((count, n) => count + (manualPositions.has(n.id) ? 1 : 0), 0),
    [graph.nodes, manualPositions],
  );
  const resizeDrag = useRef<{ x: number; width: number } | null>(null);
  const nodeDrag = useRef<{
    id: string;
    pointerId: number;
    pointerOffset: NodePos;
    startClientX: number;
    startClientY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickNodeId = useRef<string | null>(null);

  useEffect(() => {
    setLinkFromId((id) => (graph.nodes.some((n) => n.id === id) ? id : graph.nodes[0]?.id ?? ""));
    setLinkToId((id) => (graph.nodes.some((n) => n.id === id) ? id : graph.nodes[1]?.id ?? ""));
  }, [graph.nodes]);

  useEffect(() => {
    if (!exportMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!exportMenuRef.current?.contains(e.target as Node)) setExportMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExportMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [exportMenuOpen]);

  useEffect(() => {
    if (!manualCitationOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!manualCitationRef.current?.contains(e.target as Node)) setManualCitationOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setManualCitationOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [manualCitationOpen]);

  function handleResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    resizeDrag.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function handleResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = resizeDrag.current;
    if (!start) return;
    // The panel hugs the right edge, so dragging left grows it.
    const next = Math.min(
      Math.max(MIN_WIDTH, start.width + (start.x - e.clientX)),
      Math.round(window.innerWidth * 0.85),
    );
    setWidth(next);
  }

  function handleResizeEnd() {
    if (!resizeDrag.current) return;
    resizeDrag.current = null;
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // persistence is a nice-to-have
    }
  }

  function handleNodeDragStart(e: React.PointerEvent<SVGGElement>, id: string, position: NodePos) {
    if (e.button !== 0) return;
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const pointer = svgPoint(e, svg);
    nodeDrag.current = {
      id,
      pointerId: e.pointerId,
      pointerOffset: {
        x: pointer.x - position.x,
        y: pointer.y - position.y,
      },
      startClientX: e.clientX,
      startClientY: e.clientY,
      moved: false,
    };
    setDraggingNodeId(id);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handleNodeDragMove(e: React.PointerEvent<SVGGElement>) {
    const drag = nodeDrag.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;

    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

    drag.moved = true;
    setHover(null);
    const pointer = svgPoint(e, svg);
    const nextPosition = clampNodePosition({
      x: pointer.x - drag.pointerOffset.x,
      y: pointer.y - drag.pointerOffset.y,
    });
    setManualPositions((prev) => {
      const next = new Map(prev);
      next.set(drag.id, nextPosition);
      persistManualPositions(next);
      return next;
    });
  }

  function handleNodeDragEnd(e: React.PointerEvent<SVGGElement>) {
    const drag = nodeDrag.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.moved) suppressClickNodeId.current = drag.id;
    nodeDrag.current = null;
    setDraggingNodeId(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // The browser may already have released capture on pointer cancel.
    }
  }

  function handleResetLayout() {
    setSortMode("manual");
    setManualPositions((prev) => {
      const next = new Map(prev);
      for (const node of graph.nodes) next.delete(node.id);
      persistManualPositions(next);
      return next;
    });
    setHover(null);
  }

  function handleAddManualEdge() {
    if (!linkFromId || !linkToId || linkFromId === linkToId) return;
    onAddEdge(linkFromId, linkToId);
    setManualCitationOpen(false);
  }

  function handleSort(mode: GraphSortMode) {
    setSortMode(mode);
    if (mode === "manual") {
      handleResetLayout();
      return;
    }
    const sorted = sortedGraphNodes(graph.nodes, mode);
    setManualPositions((prev) => {
      const next = new Map(prev);
      sorted.forEach((node, index) => {
        next.set(node.id, {
          x: CANVAS_PAD,
          y: CANVAS_PAD + index * (NODE_H + 14),
        });
      });
      persistManualPositions(next);
      return next;
    });
    setHover(null);
  }

  function handleExportHtml() {
    setExportMenuOpen(false);
    const blob = new Blob([buildGraphExportHtml(graph, layout)], { type: "text/html" });
    downloadBlob(blob, "paper-exploration-graph.html", { directory: SESSION_DOWNLOAD_DIR });
  }

  function handleExportObsidian() {
    setExportMenuOpen(false);
    const session = buildSessionExport(graph, layout);
    const files = buildObsidianVault(session);
    const zip = createZip([...files].map(([path, data]) => ({ path, data })));
    downloadBlob(
      new Blob([zip], { type: "application/zip" }),
      `paper-exploration-${session.exportedAt}.zip`,
      { directory: SESSION_DOWNLOAD_DIR },
    );
  }

  function handlePublishSemble() {
    setExportMenuOpen(false);
    setSembleOpen(true);
  }

  return (
    <aside className="graph-panel" style={{ width }}>
      <div
        className="graph-resizer"
        title="Drag to resize"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      <div className="graph-panel-header">
        <span className="graph-panel-title">
          Exploration graph
          {graph.nodes.length > 0 && (
            <span className="graph-panel-count"> · {graph.nodes.length}</span>
          )}
        </span>
        <div className="graph-export" ref={exportMenuRef}>
          <button
            onClick={() => setExportMenuOpen((open) => !open)}
            disabled={graph.nodes.length === 0}
            title="Export or share the graph"
          >
            Export ▾
          </button>
          {exportMenuOpen && (
            <div className="graph-export-menu">
              <button data-export="html" onClick={handleExportHtml}>
                HTML page
              </button>
              <button data-export="obsidian" onClick={handleExportObsidian}>
                Obsidian vault (.zip)
              </button>
              <button data-export="semble" onClick={handlePublishSemble}>
                Publish to Semble…
              </button>
            </div>
          )}
        </div>
        <button onClick={handleResetLayout} disabled={manualPositionCount === 0} title="Reset moved nodes to the automatic layout">
          Reset
        </button>
        <button onClick={onClose} title="Hide graph">
          ✕
        </button>
      </div>

      {graph.nodes.length > 1 && (
        <div className="graph-tools">
          <select
            value={sortMode}
            onChange={(e) => handleSort(e.currentTarget.value as GraphSortMode)}
            title="Physically sort nodes"
          >
            <option value="manual">Manual order</option>
            <option value="year-asc">Year ↑</option>
            <option value="year-desc">Year ↓</option>
            <option value="citations-desc">Citations ↓</option>
            <option value="citations-asc">Citations ↑</option>
          </select>
          <div className="graph-manual-citation" ref={manualCitationRef}>
            <button
              onClick={() => setManualCitationOpen((open) => !open)}
              title="Manually connect two papers with a citation edge"
            >
              Manually Connect Nodes
            </button>
            {manualCitationOpen && (
              <div className="graph-manual-citation-menu">
                <select
                  value={linkFromId}
                  onChange={(e) => setLinkFromId(e.currentTarget.value)}
                  title="Paper 1"
                >
                  {graph.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {truncate(node.title, 48)}
                    </option>
                  ))}
                </select>
                <span className="graph-link-arrow">→</span>
                <select
                  value={linkToId}
                  onChange={(e) => setLinkToId(e.currentTarget.value)}
                  title="Paper 2"
                >
                  {graph.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {truncate(node.title, 48)}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleAddManualEdge}
                  disabled={!linkFromId || !linkToId || linkFromId === linkToId}
                >
                  Link
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {graph.nodes.length === 0 ? (
        <div className="graph-empty">
          Load a paper to start the graph. Papers opened from the address bar become roots;
          papers opened by clicking a citation become children of the paper you were reading.
        </div>
      ) : (
        <div className="graph-canvas" onMouseLeave={() => setHover(null)}>
          <svg width={layout.width} height={layout.height}>
            <defs>
              <marker
                id="graph-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L8 4 L0 8 z" className="graph-arrow-head" />
              </marker>
            </defs>

            {graph.edges.map((e) => {
              const a = layout.positions.get(e.from);
              const b = layout.positions.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + NODE_W / 2;
              const y1 = a.y + NODE_H;
              const x2 = b.x + NODE_W / 2;
              const y2 = b.y;
              const my = (y1 + y2) / 2;
              return (
                <path
                  key={`${e.from}→${e.to}`}
                  className="graph-edge"
                  d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2 - 3}`}
                  markerEnd="url(#graph-arrow)"
                />
              );
            })}

            {graph.nodes.map((n) => {
              const p = layout.positions.get(n.id);
              if (!p) return null;
              const classes = [
                "graph-node",
                n.id === currentNodeId ? "current" : "",
                n.kind === "external" ? "external" : "",
                n.kind === "author" ? "author" : "",
                n.id === draggingNodeId ? "dragging" : "",
                manualPositions.has(n.id) ? "moved" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <g
                  key={n.id}
                  className={classes}
                  transform={`translate(${p.x},${p.y})`}
                  onPointerDown={(e) => handleNodeDragStart(e, n.id, p)}
                  onPointerMove={handleNodeDragMove}
                  onPointerUp={handleNodeDragEnd}
                  onPointerCancel={handleNodeDragEnd}
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setHover({ node: n, x: rect.left, y: rect.top });
                  }}
                  onMouseLeave={() => setHover((h) => (h?.node.id === n.id ? null : h))}
                  onClick={() => {
                    if (suppressClickNodeId.current === n.id) {
                      suppressClickNodeId.current = null;
                      return;
                    }
                    onSelectNode(n);
                  }}
                >
                  <rect className="graph-node-box" width={NODE_W} height={NODE_H} rx={7} />
                  {roots.has(n.id) && (
                    <rect className="graph-node-rootbar" width={3} height={NODE_H} rx={1.5} />
                  )}
                  <text className="graph-node-title" x={10} y={17}>
                    {truncate(n.title, 25)}
                  </text>
                  <text className="graph-node-meta" x={10} y={31}>
                    {metaLine(n)}
                  </text>
                  <g
                    className="graph-node-remove"
                    transform={`translate(${NODE_W - 11}, 11)`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setHover(null);
                      onRemoveNode(n.id);
                    }}
                  >
                    <title>Remove from graph</title>
                    <circle r={7} />
                    <path d="M -2.6 -2.6 L 2.6 2.6 M 2.6 -2.6 L -2.6 2.6" />
                  </g>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {hover && <HoverCard hover={hover} isCurrent={hover.node.id === currentNodeId} />}

      {sembleOpen && (
        <SembleDialog
          session={buildSessionExport(graph, layout)}
          onClose={() => setSembleOpen(false)}
        />
      )}
    </aside>
  );
}

type GraphSortMode = "manual" | "year-asc" | "year-desc" | "citations-asc" | "citations-desc";

function sortedGraphNodes(
  nodes: GraphNode[],
  mode: Exclude<GraphSortMode, "manual">,
): GraphNode[] {
  return [...nodes].sort((a, b) => {
    if (mode === "year-asc" || mode === "year-desc") {
      const missing = mode === "year-asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      const av = a.year ?? missing;
      const bv = b.year ?? missing;
      return mode === "year-asc" ? av - bv || titleCompare(a, b) : bv - av || titleCompare(a, b);
    }
    const missing =
      mode === "citations-asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    const av = a.citationCount ?? missing;
    const bv = b.citationCount ?? missing;
    return mode === "citations-asc" ? av - bv || titleCompare(a, b) : bv - av || titleCompare(a, b);
  });
}

function titleCompare(a: GraphNode, b: GraphNode): number {
  return a.title.localeCompare(b.title);
}

function HoverCard({ hover, isCurrent }: { hover: HoverState; isCurrent: boolean }) {
  const { node } = hover;
  // The panel hugs the right edge, so the card opens to the left of the node.
  const right = Math.max(8, window.innerWidth - hover.x + 10);
  const top = Math.min(hover.y, window.innerHeight - 260);

  const authors = node.authors ?? [];
  const meta =
    node.kind === "author"
      ? [
          node.source === "google-scholar" ? "Google Scholar" : "Semantic Scholar",
          node.paperCount !== undefined ? `${node.paperCount} works` : "",
          node.citationCount !== undefined ? `${node.citationCount} citations` : "",
          node.hIndex !== undefined ? `h-index ${node.hIndex}` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : [
          authors.slice(0, 4).join(", ") + (authors.length > 4 ? ", et al." : ""),
          node.year ? String(node.year) : "",
          node.venue ?? "",
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="graph-hover-card" style={{ right, top }}>
      <div className="graph-hover-title">{node.title}</div>
      {meta && <div className="graph-hover-meta">{meta}</div>}
      {node.abstract && <div className="graph-hover-abstract">{node.abstract}</div>}
      <div className="graph-hover-footer">
        {isCurrent
          ? "Currently open"
            : node.kind === "author"
              ? "Click to open this author's works"
              : node.address
            ? "Click to open in the browser"
            : node.semanticScholarUrl
              ? "Click to open on Semantic Scholar"
              : "No link available"}
      </div>
    </div>
  );
}

function metaLine(n: GraphNode): string {
  const bits: string[] = [];
  if (n.year) bits.push(String(n.year));
  if (n.kind === "author") {
    bits.push("author");
    if (n.paperCount !== undefined) bits.push(`${n.paperCount} works`);
    return bits.join(" · ");
  }
  if (n.authors?.length) {
    bits.push(truncate(n.authors[0], 16) + (n.authors.length > 1 ? " et al." : ""));
  }
  if (n.kind === "external") bits.push("no PDF");
  return bits.join(" · ");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function initialManualPositions(): Map<string, NodePos> {
  try {
    const parsed = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}") as Record<
      string,
      Partial<NodePos>
    >;
    const positions = new Map<string, NodePos>();
    for (const [id, pos] of Object.entries(parsed)) {
      if (typeof pos.x === "number" && typeof pos.y === "number") {
        positions.set(id, clampNodePosition(pos as NodePos));
      }
    }
    return positions;
  } catch {
    return new Map();
  }
}

function persistManualPositions(positions: Map<string, NodePos>) {
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(Object.fromEntries(positions)));
  } catch {
    // persistence is a nice-to-have
  }
}

function layoutWithManualPositions(
  baseLayout: GraphLayout,
  graph: ExplorationGraph,
  manualPositions: Map<string, NodePos>,
): GraphLayout {
  const positions = new Map(baseLayout.positions);
  for (const node of graph.nodes) {
    const manual = manualPositions.get(node.id);
    if (manual) positions.set(node.id, manual);
  }

  let width = Math.max(baseLayout.width, 1);
  let height = Math.max(baseLayout.height, 1);
  for (const pos of positions.values()) {
    width = Math.max(width, pos.x + NODE_W + CANVAS_PAD);
    height = Math.max(height, pos.y + NODE_H + CANVAS_PAD);
  }
  return {
    positions,
    width: Math.ceil(width),
    height: Math.ceil(height),
  };
}

function svgPoint(e: React.PointerEvent, svg: SVGSVGElement): NodePos {
  const rect = svg.getBoundingClientRect();
  const width = Number(svg.getAttribute("width")) || rect.width || 1;
  const height = Number(svg.getAttribute("height")) || rect.height || 1;
  return {
    x: ((e.clientX - rect.left) * width) / Math.max(rect.width, 1),
    y: ((e.clientY - rect.top) * height) / Math.max(rect.height, 1),
  };
}

function clampNodePosition(pos: NodePos): NodePos {
  return {
    x: Math.max(CANVAS_PAD / 2, Math.round(pos.x)),
    y: Math.max(CANVAS_PAD / 2, Math.round(pos.y)),
  };
}
