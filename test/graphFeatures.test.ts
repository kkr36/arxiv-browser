/**
 * Run: `npm run test:graph`
 *
 * Exercises the exploration-graph features that don't need a browser:
 * the wrapping block layout, node annotations, and the reading-list /
 * session exports that carry them.
 */
import type { ExplorationGraph, GraphNode } from "../src/core/graph/explorationGraph";
import { addPaperNode, annotateNode } from "../src/core/graph/explorationGraph";
import { layoutGraph, NODE_H, NODE_W } from "../src/core/graph/layoutGraph";
import { buildSessionExport } from "../src/core/export/sessionExport";
import { buildReadingListHtml } from "../src/core/export/readingList";

let failures = 0;
const fail = (name: string, msg: string) => {
  failures++;
  console.error(`  ✗ ${name}\n      ${msg}`);
};
const check = (name: string, cond: boolean, msg = "expected true") => {
  if (cond) console.log(`  ✓ ${name}`);
  else fail(name, msg);
};

const paper = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  title: `Paper ${id}`,
  kind: "external",
  ...extra,
});

const fanOut = (childCount: number): ExplorationGraph => ({
  nodes: [paper("root"), ...Array.from({ length: childCount }, (_, i) => paper(`c${i}`))],
  edges: Array.from({ length: childCount }, (_, i) => ({ from: "root", to: `c${i}` })),
});

console.log("\nlayout: wrapping keeps width bounded:");
{
  const layout = layoutGraph(fanOut(12));
  check(
    "12 children wrap instead of one 12-wide row",
    layout.width < 4.5 * NODE_W,
    `width ${layout.width} suggests no wrapping`,
  );
  check("graph grows downward", layout.height > 3 * NODE_H, `height ${layout.height}`);
  const positions = [...layout.positions.values()];
  const overlapping = positions.some((a, i) =>
    positions.some(
      (b, j) =>
        i < j && Math.abs(a.x - b.x) < NODE_W && Math.abs(a.y - b.y) < NODE_H,
    ),
  );
  check("no overlapping nodes", !overlapping);
  const root = layout.positions.get("root")!;
  const kids = Array.from({ length: 12 }, (_, i) => layout.positions.get(`c${i}`)!);
  check(
    "children sit below their parent",
    kids.every((k) => k.y > root.y),
  );
}

console.log("\nlayout: structure edge cases:");
{
  check("empty graph", layoutGraph({ nodes: [], edges: [] }).width === 0);
  const cycle: ExplorationGraph = {
    nodes: [paper("a"), paper("b")],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
  };
  const layout = layoutGraph(cycle);
  check("pure cycle still gets positions", layout.positions.size === 2);
  const diamond: ExplorationGraph = {
    nodes: [paper("r1"), paper("r2"), paper("shared")],
    edges: [
      { from: "r1", to: "shared" },
      { from: "r2", to: "shared" },
    ],
  };
  check("multi-parent node placed once", layoutGraph(diamond).positions.size === 3);
}

console.log("\nannotations:");
{
  const g: ExplorationGraph = { nodes: [paper("a")], edges: [] };
  const annotated = annotateNode(g, "a", { note: "  key baseline  ", userUrl: "https://example.com/project" });
  const node = annotated.nodes[0];
  check("note trimmed and stored", node.note === "key baseline");
  check("web link stored without PDF upgrade", node.userUrl === "https://example.com/project" && !node.pdfUrl);

  const withPdf = annotateNode(g, "a", { userUrl: "https://example.com/paper.pdf" });
  check(
    "PDF-shaped link becomes the node address",
    withPdf.nodes[0].pdfUrl === "https://example.com/paper.pdf" &&
      withPdf.nodes[0].address === "https://example.com/paper.pdf" &&
      withPdf.nodes[0].kind === "pdf",
  );
  const unlinked = annotateNode(withPdf, "a", { note: "", userUrl: "" });
  check(
    "clearing the link reverses the upgrade",
    !unlinked.nodes[0].pdfUrl && !unlinked.nodes[0].address && unlinked.nodes[0].kind === "external",
  );
  const resolved = annotateNode(
    { nodes: [paper("b", { pdfUrl: "https://arxiv.org/pdf/1", address: "https://arxiv.org/pdf/1", kind: "pdf" })], edges: [] },
    "b",
    { userUrl: "https://example.com/other.pdf" },
  );
  check(
    "resolved PDF is never clobbered by the custom link",
    resolved.nodes[0].pdfUrl === "https://arxiv.org/pdf/1",
  );

  const merged = addPaperNode(
    annotateNode(g, "a", { note: "keep me", userUrl: "https://example.com" }),
    paper("a", { year: 2024 }),
    null,
  );
  check(
    "re-adding a node keeps its annotation",
    merged.nodes[0].note === "keep me" && merged.nodes[0].userUrl === "https://example.com",
  );
}

console.log("\nsession export carries annotations:");
{
  const g = annotateNode(
    { nodes: [paper("a", { pdfUrl: "https://arxiv.org/pdf/1" })], edges: [] },
    "a",
    { note: "read first", userUrl: "https://example.com/project" },
  );
  const session = buildSessionExport(g, undefined, new Date("2026-07-16T12:00:00Z"));
  check("note exported", session.nodes[0].note === "read first");
  check("custom link exported", session.nodes[0].links.custom === "https://example.com/project");
  check("custom link is canonical", session.nodes[0].canonicalUrl === "https://example.com/project");
}

console.log("\nreading list HTML:");
{
  let g: ExplorationGraph = { nodes: [], edges: [] };
  g = addPaperNode(
    g,
    paper("root", {
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      year: 2017,
      venue: "NeurIPS",
      pdfUrl: "https://arxiv.org/pdf/1706.03762",
      kind: "pdf",
    }),
    null,
  );
  g = addPaperNode(
    g,
    paper("child", { title: "Cited <Work> & Co", authors: ["Jane Doe"] }),
    "root",
  );
  g = addPaperNode(g, { id: "auth", title: "Yoshua Bengio", kind: "author" }, "root");
  g = addPaperNode(
    g,
    paper("upload", { title: "Local upload", pdfUrl: "data:application/pdf;base64,AAAA", kind: "pdf" }),
    null,
  );
  g = annotateNode(g, "child", { note: "note <with> markup", userUrl: "https://example.com/page" });

  const html = buildReadingListHtml(g, new Date("2026-07-16T12:00:00Z"));
  check("root paper listed with link", html.includes('href="https://arxiv.org/pdf/1706.03762"'));
  check("full author list present", html.includes("Ashish Vaswani, Noam Shazeer"));
  check("year and venue present", html.includes("2017 · NeurIPS"));
  check("titles escaped", html.includes("Cited &lt;Work&gt; &amp; Co"));
  check("note included and escaped", html.includes("note &lt;with&gt; markup"));
  check("custom link used for the entry", html.includes('href="https://example.com/page"'));
  // The embedded resume-session JSON keeps every node; only the visible list
  // should skip authors.
  const listBody = html.slice(0, html.indexOf("<script"));
  check("author nodes excluded from the list", !listBody.includes("Yoshua Bengio"));
  check("data: PDFs not linked", !html.includes('href="data:'));
  check("3 papers counted", html.includes("3 papers"));
  check("resumable session embedded", html.includes('id="arxiv-browser-session"'));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll graph feature tests passed.");
