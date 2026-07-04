import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { fetchPdfBytes } from "./core/net/fetchPdfBytes";
import { resolveInputToPdfUrl } from "./core/resolveInput";
import { loadPdfDocument } from "./core/pdf/loadPdf";
import { buildCitationData, resetResolutionCache, type CitationData } from "./core/citationService";
import { getPaperByArxivId } from "./core/semanticScholar/client";
import { toResolvedPaper } from "./core/semanticScholar/resolvePaper";
import type { ResolvedPaper } from "./core/types";
import {
  EMPTY_GRAPH,
  addPaperNode,
  nodeFromPaper,
  nodeIdForPaper,
  removeNode,
  upgradePlaceholderTitle,
  type ExplorationGraph,
  type GraphNode,
} from "./core/graph/explorationGraph";
import { PdfViewer } from "./viewer/PdfViewer";
import { CitationsPanel } from "./viewer/CitationsPanel";
import { GraphPanel } from "./graph/GraphPanel";
import "./app.css";

interface PaperView {
  doc: PDFDocumentProxy;
  citations: CitationData;
  label: string;
}

interface HistoryEntry {
  /** Master copy of the PDF — pdf.js transfers (detaches) whatever buffer it
   * receives, so loads always get a `.slice(0)` and this copy stays usable
   * for back/forward. */
  bytes: ArrayBuffer;
  label: string;
  /** Address-bar value for this entry: the PDF URL, or a file name for uploads. */
  address: string;
  /** Exploration-graph node this entry belongs to, so back/forward keeps the
   * graph's "current paper" (and thus citation-click parenting) in sync. */
  nodeId: string;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string; link?: { url: string; text: string } };

/** How a load was initiated, which decides its place in the exploration graph:
 * address-bar loads are roots, citation clicks hang off the paper they were
 * clicked in, and graph-node revisits leave the graph untouched. */
type OpenOrigin =
  | { kind: "root" }
  | { kind: "citation"; paper: ResolvedPaper; parentId: string | null }
  | { kind: "revisit"; nodeId: string };

export default function App() {
  const [input, setInput] = useState("1706.03762");
  const [view, setView] = useState<PaperView | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [history, setHistory] = useState<{ entries: HistoryEntry[]; index: number }>({
    entries: [],
    index: -1,
  });
  const [graph, setGraph] = useState<ExplorationGraph>(EMPTY_GRAPH);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [graphOpen, setGraphOpen] = useState(true);
  const [citationsOpen, setCitationsOpen] = useState(false);
  // Monotonic id per load; a stale async load bails out instead of clobbering
  // a newer one (e.g. two citation clicks in quick succession).
  const loadSeq = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function showEntry(
    entry: HistoryEntry,
    seq: number,
    nav: { push: true } | { push: false; index: number },
  ): Promise<PDFDocumentProxy | null> {
    setStatus({ kind: "loading", message: "Parsing PDF…" });
    resetResolutionCache();
    const doc = await loadPdfDocument(entry.bytes.slice(0));
    if (seq !== loadSeq.current) return null;
    setStatus({ kind: "loading", message: "Finding citations…" });
    const citations = await buildCitationData(doc);
    if (seq !== loadSeq.current) return null;
    setView({ doc, citations, label: entry.label });
    setInput(entry.address);
    setStatus({ kind: "idle" });
    setCurrentNodeId(entry.nodeId);
    setHistory((h) =>
      nav.push
        ? { entries: [...h.entries.slice(0, h.index + 1), entry], index: h.index + 1 }
        : { ...h, index: nav.index },
    );
    return doc;
  }

  async function openFromUrl(url: string, label: string | undefined, origin: OpenOrigin) {
    const seq = ++loadSeq.current;
    const nodeId =
      origin.kind === "root"
        ? url
        : origin.kind === "citation"
          ? nodeIdForPaper(origin.paper)
          : origin.nodeId;
    try {
      setStatus({ kind: "loading", message: "Fetching PDF…" });
      const bytes = await fetchPdfBytes(url);
      if (seq !== loadSeq.current) return;
      const doc = await showEntry({ bytes, label: label ?? url, address: url, nodeId }, seq, {
        push: true,
      });
      if (!doc) return;
      if (origin.kind === "root") {
        setGraph((g) =>
          addPaperNode(
            g,
            { id: nodeId, title: label ?? url, address: url, pdfUrl: url, kind: "pdf" },
            null,
          ),
        );
        void enrichRootNode(url, nodeId, doc, setGraph);
      } else if (origin.kind === "citation") {
        setGraph((g) => addPaperNode(g, nodeFromPaper(origin.paper), origin.parentId));
      }
    } catch (err) {
      if (seq === loadSeq.current) setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  function handleLoad() {
    if (!input.trim()) return;
    try {
      void openFromUrl(resolveInputToPdfUrl(input), undefined, { kind: "root" });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const seq = ++loadSeq.current;
    try {
      const bytes = await file.arrayBuffer();
      if (seq !== loadSeq.current) return;
      const nodeId = file.name;
      const doc = await showEntry(
        { bytes, label: file.name, address: file.name, nodeId },
        seq,
        { push: true },
      );
      if (!doc) return;
      setGraph((g) =>
        addPaperNode(g, { id: nodeId, title: file.name, address: file.name, kind: "pdf" }, null),
      );
      const title = await readPdfTitle(doc);
      if (title) setGraph((g) => upgradePlaceholderTitle(g, nodeId, title));
    } catch (err) {
      if (seq === loadSeq.current) setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function navigate(delta: number) {
    const target = history.index + delta;
    const entry = history.entries[target];
    if (!entry) return;
    const seq = ++loadSeq.current;
    try {
      await showEntry(entry, seq, { push: false, index: target });
    } catch (err) {
      if (seq === loadSeq.current) setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  /** A citation marker was clicked and resolved: open its PDF in-app, so the
   * cited work gets the same annotated treatment. Papers with no PDF anywhere
   * (Semantic Scholar page only) can't be rendered here and open in a new tab.
   * Either way the paper joins the exploration graph as a child of the paper
   * the citation was clicked in. */
  function handleOpenPaper(paper: ResolvedPaper) {
    const parentId = currentNodeId;
    if (paper.pdfUrl) {
      void openFromUrl(paper.pdfUrl, paper.title, { kind: "citation", paper, parentId });
      return;
    }
    if (paper.semanticScholarUrl) {
      setGraph((g) => addPaperNode(g, nodeFromPaper(paper), parentId));
      const win = window.open(paper.semanticScholarUrl, "_blank", "noopener");
      if (!win) {
        // Popup blocked (resolution outlived the click's user activation) —
        // surface the link so opening it is a direct user gesture.
        setStatus({
          kind: "error",
          message: `No PDF found for “${paper.title}”.`,
          link: { url: paper.semanticScholarUrl, text: "Open on Semantic Scholar" },
        });
      }
      return;
    }
    setStatus({ kind: "error", message: `No link found for “${paper.title}”.` });
  }

  /** A node in the exploration graph was clicked: bring that paper back up.
   * Prefer replaying its bytes from history (works for uploads, skips the
   * refetch); fall back to refetching by address. Revisits never add edges. */
  function handleGraphSelect(node: GraphNode) {
    if (node.id === currentNodeId || status.kind === "loading") return;
    if (!node.address) {
      if (node.semanticScholarUrl) window.open(node.semanticScholarUrl, "_blank", "noopener");
      return;
    }
    for (let i = history.entries.length - 1; i >= 0; i--) {
      if (history.entries[i].nodeId === node.id) {
        void navigate(i - history.index);
        return;
      }
    }
    void openFromUrl(node.address, node.title, { kind: "revisit", nodeId: node.id });
  }

  /** Removing a node only edits the graph — the paper stays open in the
   * viewer. If it was the current node, citation clicks made afterwards
   * start a fresh root instead of hanging off a ghost. */
  function handleRemoveNode(id: string) {
    setGraph((g) => removeNode(g, id));
    if (currentNodeId === id) setCurrentNodeId(null);
  }

  const canBack = history.index > 0;
  const canForward = history.index < history.entries.length - 1;
  const loading = status.kind === "loading";

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || (e.target instanceof HTMLElement && e.target.tagName === "INPUT")) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        void navigate(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        void navigate(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const entryCount = view ? view.citations.entries.length : 0;
  const markerCount = view
    ? [...view.citations.markersByPage.values()].reduce((sum, m) => sum + m.length, 0)
    : 0;

  return (
    <div className="app">
      <header className="app-header">
        <h1>arxiv-browser</h1>
        <div className="load-bar">
          <button
            className="nav-button"
            onClick={() => navigate(-1)}
            disabled={!canBack || loading}
            title="Back (Alt+←)"
          >
            ←
          </button>
          <button
            className="nav-button"
            onClick={() => navigate(1)}
            disabled={!canForward || loading}
            title="Forward (Alt+→)"
          >
            →
          </button>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLoad()}
            placeholder="arXiv id (1706.03762), arXiv URL, or PDF URL"
          />
          <button onClick={handleLoad} disabled={loading}>
            Load
          </button>
          <button onClick={() => fileInputRef.current?.click()} disabled={loading}>
            Upload PDF
          </button>
          <button
            onClick={() => setCitationsOpen((o) => !o)}
            disabled={!view}
            title="List of this paper's parsed references"
          >
            {citationsOpen ? "Hide citations" : "Citations"}
          </button>
          <button onClick={() => setGraphOpen((o) => !o)}>
            {graphOpen ? "Hide graph" : "Graph"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            hidden
            onChange={handleFileChange}
          />
        </div>
        {loading && <div className="status-line">{status.message}</div>}
        {status.kind === "error" && (
          <div className="status-line error">
            {status.message}
            {status.link && (
              <>
                {" "}
                <a href={status.link.url} target="_blank" rel="noopener noreferrer">
                  {status.link.text}
                </a>
              </>
            )}
          </div>
        )}
        {status.kind === "idle" && view && (
          <div className="status-line">
            {view.label} · {entryCount} references parsed · {markerCount} in-text citations linked
          </div>
        )}
      </header>

      <div className="app-main">
        {view ? (
          <PdfViewer
            doc={view.doc}
            pages={view.citations.pages}
            markersByPage={view.citations.markersByPage}
            entries={view.citations.entries}
            onOpenPaper={handleOpenPaper}
          />
        ) : (
          <div className="app-content-empty" />
        )}
        {citationsOpen && view && (
          <CitationsPanel
            entries={view.citations.entries}
            markersByPage={view.citations.markersByPage}
            onOpenPaper={handleOpenPaper}
            onClose={() => setCitationsOpen(false)}
          />
        )}
        {graphOpen && (
          <GraphPanel
            graph={graph}
            currentNodeId={currentNodeId}
            onSelectNode={handleGraphSelect}
            onRemoveNode={handleRemoveNode}
            onClose={() => setGraphOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

/** Root nodes start out labeled with what the user typed (a URL). Swap in
 * real metadata: Semantic Scholar by arXiv id when the URL is an arXiv PDF
 * (title, authors, abstract — feeds the hover preview and export), else the
 * PDF's own metadata title. Best-effort; the URL label stays on failure. */
async function enrichRootNode(
  url: string,
  nodeId: string,
  doc: PDFDocumentProxy,
  setGraph: React.Dispatch<React.SetStateAction<ExplorationGraph>>,
): Promise<void> {
  const arxivId = url.match(/arxiv\.org\/pdf\/([^?#]+?)(?:\.pdf)?$/i)?.[1];
  if (arxivId) {
    try {
      const s2 = await getPaperByArxivId(arxivId);
      if (s2) {
        const node = nodeFromPaper(toResolvedPaper(s2));
        setGraph((g) =>
          addPaperNode(g, { ...node, id: nodeId, address: url, pdfUrl: url, kind: "pdf" }, null),
        );
        return;
      }
    } catch {
      // rate limit / network — fall back to the PDF's own metadata
    }
  }
  const title = await readPdfTitle(doc);
  if (title) setGraph((g) => upgradePlaceholderTitle(g, nodeId, title));
}

/** Pulls a usable title out of the PDF's own metadata, to replace URL-shaped
 * placeholder labels on root nodes. Returns null for junk (empty, "untitled",
 * LaTeX build artifacts like "paper.dvi"). */
async function readPdfTitle(doc: PDFDocumentProxy): Promise<string | null> {
  try {
    const { info } = await doc.getMetadata();
    const raw = (info as { Title?: unknown }).Title;
    if (typeof raw !== "string") return null;
    const title = raw.trim();
    if (title.length < 4) return null;
    if (/^untitled/i.test(title) || /\.(dvi|tex|pdf|ps)$/i.test(title)) return null;
    return title;
  } catch {
    return null;
  }
}
