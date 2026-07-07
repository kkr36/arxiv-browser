import type { ExplorationGraph, GraphNode } from "../core/graph/explorationGraph";
import { rootIds } from "../core/graph/explorationGraph";
import { buildSessionExport } from "../core/export/sessionExport";
import { layoutGraph, NODE_H, NODE_W, type GraphLayout } from "../core/graph/layoutGraph";

/**
 * Renders the exploration graph as a fully self-contained HTML document:
 * inline CSS/JS, no external requests. Hovering a node previews the paper;
 * clicking opens its PDF in a new tab, falling back to Semantic Scholar.
 */
export function buildGraphExportHtml(
  graph: ExplorationGraph,
  layout: GraphLayout = layoutGraph(graph),
): string {
  const roots = rootIds(graph);

  const edgeMarkup = graph.edges
    .map((e) => {
      const a = layout.positions.get(e.from);
      const b = layout.positions.get(e.to);
      if (!a || !b) return "";
      const x1 = a.x + NODE_W / 2;
      const y1 = a.y + NODE_H;
      const x2 = b.x + NODE_W / 2;
      const y2 = b.y;
      const my = (y1 + y2) / 2;
      return `<path class="edge" d="M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2 - 3}" marker-end="url(#arrow)"/>`;
    })
    .join("\n");

  const nodeMarkup = graph.nodes
    .map((n) => {
      const p = layout.positions.get(n.id);
      if (!p) return "";
      const classes = [
        "node",
        n.kind === "external" ? "external" : "",
        n.kind === "author" ? "author" : "",
        roots.has(n.id) ? "root" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const link = n.pdfUrl ?? n.semanticScholarUrl ?? n.googleScholarUrl;
      return [
        `<g class="${classes}" data-id="${esc(n.id)}" transform="translate(${p.x},${p.y})"${link ? ` tabindex="0" role="link"` : ""}>`,
        `<rect class="node-box" width="${NODE_W}" height="${NODE_H}" rx="7"/>`,
        roots.has(n.id) ? `<rect class="root-bar" width="3" height="${NODE_H}" rx="1.5"/>` : "",
        `<text class="node-title" x="10" y="17">${esc(truncate(n.title, 25))}</text>`,
        `<text class="node-meta" x="10" y="31">${esc(metaLine(n))}</text>`,
        `</g>`,
      ].join("");
    })
    .join("\n");

  const previewData: Record<string, unknown> = {};
  for (const n of graph.nodes) {
    previewData[n.id] = {
      title: n.title,
      authors: n.authors ?? [],
      year: n.year ?? null,
      venue: n.venue ?? null,
      abstract: n.abstract ?? null,
      pdfUrl: n.pdfUrl ?? null,
      semanticScholarUrl: n.semanticScholarUrl ?? null,
      googleScholarUrl: n.googleScholarUrl ?? null,
      kind: n.kind,
    };
  }
  // <-escape so no "</script>" inside a title can terminate the script block.
  const dataJson = JSON.stringify(previewData).replace(/</g, "\\u003c");
  const sessionJson = JSON.stringify({
    schema: "arxiv-browser-session",
    version: 1,
    session: buildSessionExport(graph, layout),
  }).replace(/</g, "\\u003c");

  const date = new Date().toISOString().slice(0, 10);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Paper exploration graph — ${esc(date)}</title>
<style>
  :root {
    --surface: #fcfcfb; --panel: #ffffff;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --edge: #a9a8a1; --node-fill: #ffffff; --node-stroke: rgba(11, 11, 11, 0.22);
    --accent: #2a78d6; --root: #1baf7a; --hairline: rgba(11, 11, 11, 0.1);
    --shadow: 0 6px 24px rgba(0, 0, 0, 0.15);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #16161a; --panel: #1f1f24;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --edge: #55555f; --node-fill: #23232a; --node-stroke: rgba(255, 255, 255, 0.18);
      --accent: #3987e5; --root: #199e70; --hairline: rgba(255, 255, 255, 0.1);
      --shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--surface); color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header { padding: 18px 24px 10px; }
  header h1 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
  header p { margin: 0; font-size: 12px; color: var(--ink-2); }
  .canvas { overflow: auto; padding: 8px 24px 40px; }
  .edge { stroke: var(--edge); stroke-width: 1.5; fill: none; }
  #arrow path { fill: var(--edge); }
  .node { cursor: default; }
  .node[role="link"] { cursor: pointer; }
  .node-box { fill: var(--node-fill); stroke: var(--node-stroke); }
  .node:hover .node-box, .node:focus .node-box { stroke: var(--accent); stroke-width: 1.5; }
  .node.external .node-box { stroke-dasharray: 4 3; }
  .root-bar { fill: var(--root); }
  .node-title { fill: var(--ink); font-size: 11px; font-weight: 600; pointer-events: none; }
  .node-meta { fill: var(--muted); font-size: 10px; pointer-events: none; }
  #card {
    position: fixed; z-index: 10; max-width: 340px; padding: 10px 12px;
    background: var(--panel); border: 1px solid var(--hairline); border-radius: 8px;
    box-shadow: var(--shadow); font-size: 13px; line-height: 1.4; pointer-events: none;
  }
  #card .t { font-weight: 600; margin-bottom: 4px; }
  #card .m { color: var(--ink-2); margin-bottom: 6px; font-size: 12px; }
  #card .a {
    color: var(--ink-2); font-size: 12px; overflow: hidden; display: -webkit-box;
    -webkit-line-clamp: 6; -webkit-box-orient: vertical;
  }
  #card .f { margin-top: 6px; font-size: 11px; color: var(--muted); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>Paper exploration graph</h1>
  <p>Exported ${esc(date)} · ${graph.nodes.length} nodes · green bar = opened directly · dashed = no PDF</p>
</header>
<div class="canvas">
<svg width="${Math.max(layout.width, 1)}" height="${Math.max(layout.height, 1)}" viewBox="0 0 ${Math.max(layout.width, 1)} ${Math.max(layout.height, 1)}">
<defs>
  <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0 0 L8 4 L0 8 z"/>
  </marker>
</defs>
${edgeMarkup}
${nodeMarkup}
</svg>
</div>
<div id="card" hidden>
  <div class="t"></div>
  <div class="m"></div>
  <div class="a"></div>
  <div class="f"></div>
</div>
<script id="arxiv-browser-session" type="application/json">${sessionJson}</script>
<script>
(function () {
  var DATA = ${dataJson};
  var card = document.getElementById("card");
  var fields = {
    t: card.querySelector(".t"),
    m: card.querySelector(".m"),
    a: card.querySelector(".a"),
    f: card.querySelector(".f"),
  };

  function nodeFor(target) {
    var g = target instanceof Element ? target.closest("g.node") : null;
    return g ? { g: g, paper: DATA[g.getAttribute("data-id")] } : null;
  }

  function openPaper(paper) {
    var href = paper.pdfUrl || paper.semanticScholarUrl || paper.googleScholarUrl;
    if (href) window.open(href, "_blank", "noopener");
  }

  function showCard(paper, x, y) {
    fields.t.textContent = paper.title;
    var meta = paper.authors.slice(0, 4).join(", ");
    if (paper.authors.length > 4) meta += ", et al.";
    if (paper.year) meta += (meta ? " · " : "") + paper.year;
    if (paper.venue) meta += (meta ? " · " : "") + paper.venue;
    fields.m.textContent = meta;
    fields.m.hidden = !meta;
    fields.a.textContent = paper.abstract || "";
    fields.a.hidden = !paper.abstract;
    fields.f.textContent = paper.kind === "author"
      ? "Click to open the author profile"
      : paper.pdfUrl
      ? "Click to open the PDF in a new tab"
      : paper.semanticScholarUrl
        ? "Click to open on Semantic Scholar"
        : "No link available for this paper";
    card.hidden = false;
    var rect = card.getBoundingClientRect();
    card.style.left = Math.max(8, Math.min(x + 14, window.innerWidth - rect.width - 8)) + "px";
    card.style.top = Math.max(8, Math.min(y + 14, window.innerHeight - rect.height - 8)) + "px";
  }

  document.addEventListener("mousemove", function (e) {
    var hit = nodeFor(e.target);
    if (hit && hit.paper) showCard(hit.paper, e.clientX, e.clientY);
    else card.hidden = true;
  });
  document.addEventListener("click", function (e) {
    var hit = nodeFor(e.target);
    if (hit && hit.paper) openPaper(hit.paper);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var hit = nodeFor(e.target);
    if (hit && hit.paper) openPaper(hit.paper);
  });
})();
</script>
</body>
</html>
`;
}

function metaLine(n: GraphNode): string {
  const bits: string[] = [];
  if (n.kind === "author") {
    bits.push("author");
    if (n.paperCount !== undefined) bits.push(`${n.paperCount} works`);
    return bits.join(" · ");
  }
  if (n.year) bits.push(String(n.year));
  if (n.authors?.length) {
    bits.push(truncate(n.authors[0], 16) + (n.authors.length > 1 ? " et al." : ""));
  }
  if (n.kind === "external") bits.push("no PDF");
  return bits.join(" · ");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
