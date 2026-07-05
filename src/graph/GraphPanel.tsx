import { useMemo, useRef, useState } from "react";
import type { ExplorationGraph, GraphNode } from "../core/graph/explorationGraph";
import { rootIds } from "../core/graph/explorationGraph";
import { layoutGraph, NODE_H, NODE_W } from "../core/graph/layoutGraph";
import { buildGraphExportHtml } from "./exportGraphHtml";
import "./graphPanel.css";

interface GraphPanelProps {
  graph: ExplorationGraph;
  /** Node of the paper currently shown in the viewer (highlighted). */
  currentNodeId: string | null;
  onSelectNode: (node: GraphNode) => void;
  onRemoveNode: (id: string) => void;
  onClose: () => void;
}

const WIDTH_KEY = "arxiv-browser:graph-panel-width";
const MIN_WIDTH = 240;

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
  onClose,
}: GraphPanelProps) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const roots = useMemo(() => rootIds(graph), [graph]);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [width, setWidth] = useState(initialWidth);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  function handleResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    dragStart.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function handleResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = dragStart.current;
    if (!start) return;
    // The panel hugs the right edge, so dragging left grows it.
    const next = Math.min(
      Math.max(MIN_WIDTH, start.width + (start.x - e.clientX)),
      Math.round(window.innerWidth * 0.85),
    );
    setWidth(next);
  }

  function handleResizeEnd() {
    if (!dragStart.current) return;
    dragStart.current = null;
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // persistence is a nice-to-have
    }
  }

  function handleExport() {
    const blob = new Blob([buildGraphExportHtml(graph)], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "paper-exploration-graph.html";
    a.click();
    URL.revokeObjectURL(url);
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
        <button onClick={handleExport} disabled={graph.nodes.length === 0} title="Download as a standalone HTML page">
          Export
        </button>
        <button onClick={onClose} title="Hide graph">
          ✕
        </button>
      </div>

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
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <g
                  key={n.id}
                  className={classes}
                  transform={`translate(${p.x},${p.y})`}
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setHover({ node: n, x: rect.left, y: rect.top });
                  }}
                  onMouseLeave={() => setHover((h) => (h?.node.id === n.id ? null : h))}
                  onClick={() => onSelectNode(n)}
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
    </aside>
  );
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
