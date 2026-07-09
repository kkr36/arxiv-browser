import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { fetchPdfBytes } from "./core/net/fetchPdfBytes";
import { resolveInputToPdfUrl } from "./core/resolveInput";
import { loadPdfDocument } from "./core/pdf/loadPdf";
import { buildCitationData, resetResolutionCache, type CitationData } from "./core/citationService";
import { detectAuthorMarkers, extractAuthorCandidates } from "./core/authors/detectAuthorMarkers";
import {
  looksLikeAuthorUrl,
  resolveAuthorInput,
  resolveAuthorRef,
} from "./core/authors/resolveAuthor";
import { getPaperByArxivId } from "./core/semanticScholar/client";
import { toResolvedPaper } from "./core/semanticScholar/resolvePaper";
import type { AuthorMarker, AuthorProfileRef, ResolvedAuthorPage, ResolvedPaper } from "./core/types";
import {
  EMPTY_GRAPH,
  addGraphEdge,
  addPaperNode,
  nodeFromAuthor,
  nodeFromPaper,
  nodeIdForPaper,
  removeNode,
  upgradePlaceholderTitle,
  type ExplorationGraph,
  type GraphNode,
} from "./core/graph/explorationGraph";
import { PdfViewer } from "./viewer/PdfViewer";
import { AuthorPageView } from "./viewer/AuthorPageView";
import { AuthorsPanel } from "./viewer/AuthorsPanel";
import { CitationsPanel } from "./viewer/CitationsPanel";
import { GraphPanel } from "./graph/GraphPanel";
import { downloadBlob } from "./graph/download";
import { parseSessionExportHtml } from "./core/export/sessionImport";
import "./app.css";

interface PaperView {
  kind: "paper";
  doc: PDFDocumentProxy;
  citations: CitationData;
  authors: AuthorProfileRef[];
  authorMarkersByPage: Map<number, AuthorMarker[]>;
  label: string;
}

interface AuthorView {
  kind: "author";
  author: ResolvedAuthorPage;
  label: string;
}

type MainView = PaperView | AuthorView;

interface HistoryEntry {
  kind: "paper" | "author";
  /** Master copy of the PDF — pdf.js transfers (detaches) whatever buffer it
   * receives, so loads always get a `.slice(0)` and this copy stays usable
   * for back/forward. */
  bytes?: ArrayBuffer;
  author?: ResolvedAuthorPage;
  paper?: ResolvedPaper;
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
  | { kind: "notice"; message: string }
  | { kind: "error"; message: string; link?: { url: string; text: string } };

/** How a load was initiated, which decides its place in the exploration graph:
 * address-bar loads are roots, citation clicks hang off the paper they were
 * clicked in, and graph-node revisits leave the graph untouched. */
type OpenOrigin =
  | { kind: "root" }
  | { kind: "citation"; paper: ResolvedPaper; parentId: string | null }
  | { kind: "author"; author: ResolvedAuthorPage; parentId: string | null }
  | { kind: "revisit"; nodeId: string };

interface AppProps {
  initialInput?: string;
  autoLoadInitial?: boolean;
  title?: string;
  onOpenedUrl?: (url: string, label?: string) => void;
  pendingRootRequest?: { id: number; input: string } | null;
  onPendingRootHandled?: (id: number) => void;
  onPendingRootNewSession?: (id: number, input: string) => void;
}

export default function App({
  initialInput = "1706.03762",
  autoLoadInitial = false,
  title = "arxiv-browser",
  onOpenedUrl,
  pendingRootRequest = null,
  onPendingRootHandled,
  onPendingRootNewSession,
}: AppProps = {}) {
  const [input, setInput] = useState(initialInput);
  const [view, setView] = useState<MainView | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [history, setHistory] = useState<{ entries: HistoryEntry[]; index: number }>({
    entries: [],
    index: -1,
  });
  const [graph, setGraph] = useState<ExplorationGraph>(EMPTY_GRAPH);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [graphOpen, setGraphOpen] = useState(true);
  const [citationsOpen, setCitationsOpen] = useState(false);
  const [authorsOpen, setAuthorsOpen] = useState(false);
  const [pdfFullscreen, setPdfFullscreen] = useState(false);
  const [citationHighlightsEnabled, setCitationHighlightsEnabled] = useState(true);
  const [authorHighlightsEnabled, setAuthorHighlightsEnabled] = useState(true);
  const [focusedCitationEntry, setFocusedCitationEntry] = useState<number | null>(null);
  const [pendingRootInput, setPendingRootInput] = useState<{ id: number; input: string } | null>(
    null,
  );
  // Monotonic id per load; a stale async load bails out instead of clobbering
  // a newer one (e.g. two citation clicks in quick succession).
  const loadSeq = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sessionInputRef = useRef<HTMLInputElement>(null);

  async function showEntry(
    entry: HistoryEntry,
    seq: number,
    nav: { push: true } | { push: false; index: number },
  ): Promise<PDFDocumentProxy | null> {
    if (entry.kind === "author") {
      if (!entry.author) return null;
      setView({ kind: "author", author: entry.author, label: entry.label });
      setFocusedCitationEntry(null);
      setInput(entry.address);
      setStatus({ kind: "idle" });
      setCurrentNodeId(entry.nodeId);
      setHistory((h) =>
        nav.push
          ? { entries: [...h.entries.slice(0, h.index + 1), entry], index: h.index + 1 }
          : { ...h, index: nav.index },
      );
      return null;
    }

    if (!entry.bytes) return null;
    setStatus({ kind: "loading", message: "Parsing PDF…" });
    resetResolutionCache();
    const doc = await loadPdfDocument(entry.bytes.slice(0));
    if (seq !== loadSeq.current) return null;
    setStatus({ kind: "loading", message: "Finding citations…" });
    const citations = await buildCitationData(doc);
    if (seq !== loadSeq.current) return null;
    const authors = authorsForPaper(entry.paper, citations.pages);
    const authorMarkersByPage = detectAuthorMarkers(citations.pages, authors);
    setView({ kind: "paper", doc, citations, authors, authorMarkersByPage, label: entry.label });
    setFocusedCitationEntry(null);
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
          : origin.kind === "author"
            ? origin.author.id
            : origin.nodeId;
    try {
      setStatus({ kind: "loading", message: "Fetching PDF…" });
      const bytes = await fetchPdfBytes(url);
      if (seq !== loadSeq.current) return;
      const doc = await showEntry(
        {
          kind: "paper",
          bytes,
          label: label ?? url,
          address: url,
          nodeId,
          paper: origin.kind === "citation" ? origin.paper : undefined,
        },
        seq,
        { push: true },
      );
      if (!doc) return;
      onOpenedUrl?.(url, label);
      if (origin.kind === "root") {
        setGraph((g) =>
          addPaperNode(
            g,
            { id: nodeId, title: label ?? url, address: url, pdfUrl: url, kind: "pdf" },
            null,
          ),
        );
        void enrichRootNode(url, nodeId, doc, setGraph, (paper) => {
          if (seq !== loadSeq.current) return;
          setHistory((h) => ({
            ...h,
            entries: h.entries.map((entry, index) =>
              index === h.index && entry.nodeId === nodeId ? { ...entry, paper } : entry,
            ),
          }));
          setView((current) =>
            current?.kind === "paper"
              ? {
                  ...current,
                  authors: authorsForPaper(paper, current.citations.pages),
                  authorMarkersByPage: detectAuthorMarkers(
                    current.citations.pages,
                    paper.authorProfiles ?? paper.authors.map((name) => ({ name })),
                  ),
                }
              : current,
          );
        });
      } else if (origin.kind === "citation") {
        setGraph((g) => addPaperNode(g, nodeFromPaper(origin.paper), origin.parentId));
      } else if (origin.kind === "author") {
        setGraph((g) => addPaperNode(g, nodeFromAuthor(origin.author), origin.parentId));
      }
    } catch (err) {
      if (seq === loadSeq.current) setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  useEffect(() => {
    if (!autoLoadInitial || !initialInput.trim()) return;
    try {
      if (looksLikeAuthorUrl(initialInput)) {
        void openAuthorFromInput(initialInput, { kind: "root" });
        return;
      }
      void openFromUrl(resolveInputToPdfUrl(initialInput), undefined, { kind: "root" });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
    // Only auto-open the URL provided at mount time; later navigation is
    // managed by the viewer's own history and citation click handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!pendingRootRequest) return;
    setPendingRootInput(pendingRootRequest);
  }, [pendingRootRequest]);

  function handleLoad() {
    if (!input.trim()) return;
    try {
      if (looksLikeAuthorUrl(input)) {
        void openAuthorFromInput(input, { kind: "root" });
        return;
      }
      void openFromUrl(resolveInputToPdfUrl(input), undefined, { kind: "root" });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  function handlePendingRootLoad() {
    const pending = pendingRootInput;
    if (!pending) return;
    try {
      if (looksLikeAuthorUrl(pending.input)) {
        void openAuthorFromInput(pending.input, { kind: "root" });
      } else {
        void openFromUrl(resolveInputToPdfUrl(pending.input), undefined, { kind: "root" });
      }
      onPendingRootHandled?.(pending.id);
      setPendingRootInput(null);
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  function handlePendingRootNewSession() {
    const pending = pendingRootInput;
    if (!pending) return;
    onPendingRootNewSession?.(pending.id, pending.input);
    setPendingRootInput(null);
  }

  async function openAuthorFromInput(raw: string, origin: { kind: "root" } | { kind: "paper"; parentId: string | null }) {
    const seq = ++loadSeq.current;
    try {
      setStatus({ kind: "loading", message: "Loading author profile…" });
      const author = await resolveAuthorInput(raw);
      if (seq !== loadSeq.current) return;
      await showAuthor(author, seq, { push: true });
      setGraph((g) => addPaperNode(g, nodeFromAuthor(author), origin.kind === "paper" ? origin.parentId : null));
    } catch (err) {
      if (seq === loadSeq.current) setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function openAuthorFromRef(ref: AuthorProfileRef) {
    const seq = ++loadSeq.current;
    const parentId = currentNodeId;
    try {
      setStatus({ kind: "loading", message: "Loading author profile…" });
      const author = await resolveAuthorRef(ref);
      if (seq !== loadSeq.current) return;
      await showAuthor(author, seq, { push: true });
      setGraph((g) => addPaperNode(g, nodeFromAuthor(author), parentId));
    } catch (err) {
      if (seq === loadSeq.current) setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  async function showAuthor(
    author: ResolvedAuthorPage,
    seq: number,
    nav: { push: true } | { push: false; index: number },
  ) {
    await showEntry(
      {
        kind: "author",
        author,
        label: author.name,
        address: author.url ?? author.googleScholarUrl ?? author.semanticScholarUrl ?? author.name,
        nodeId: author.id,
      },
      seq,
      nav,
    );
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const inputEl = e.currentTarget;
    const file = inputEl.files?.[0];
    if (!file) return;
    const seq = ++loadSeq.current;
    try {
      const bytes = await file.arrayBuffer();
      if (seq !== loadSeq.current) return;
      const nodeId = file.name;
      const dataUrl = arrayBufferToPdfDataUrl(bytes);
      const doc = await showEntry(
        { kind: "paper", bytes, label: file.name, address: file.name, nodeId },
        seq,
        { push: true },
      );
      if (!doc) return;
      setGraph((g) =>
        addPaperNode(
          g,
          { id: nodeId, title: file.name, address: file.name, pdfUrl: dataUrl, kind: "pdf" },
          null,
        ),
      );
      const title = await readPdfTitle(doc);
      if (title) setGraph((g) => upgradePlaceholderTitle(g, nodeId, title));
    } catch (err) {
      if (seq === loadSeq.current) setStatus({ kind: "error", message: (err as Error).message });
    } finally {
      inputEl.value = "";
    }
  }

  async function handleSessionFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const inputEl = e.currentTarget;
    const file = inputEl.files?.[0];
    if (!file) return;
    const seq = ++loadSeq.current;
    try {
      const html = await file.text();
      if (seq !== loadSeq.current) return;
      const imported = parseSessionExportHtml(html);
      setGraph(imported.graph);
      setCurrentNodeId(null);
      setHistory({ entries: [], index: -1 });
      setView(null);
      setFocusedCitationEntry(null);
      setCitationsOpen(false);
      setAuthorsOpen(false);
      setGraphOpen(true);
      const firstReloadable = imported.graph.nodes.find(
        (n) => n.address || n.pdfUrl || n.semanticScholarUrl,
      );
      setInput(
        firstReloadable?.address ??
          firstReloadable?.pdfUrl ??
          firstReloadable?.semanticScholarUrl ??
          "",
      );
      setStatus({
        kind: "notice",
        message: imported.degraded
          ? `Resumed ${imported.graph.nodes.length} nodes and ${imported.graph.edges.length} edges from an older HTML export.`
          : `Resumed ${imported.graph.nodes.length} nodes from ${imported.title ?? "HTML session"}.`,
      });
    } catch (err) {
      if (seq === loadSeq.current) setStatus({ kind: "error", message: (err as Error).message });
    } finally {
      inputEl.value = "";
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

  function handleOpenAuthor(author: AuthorProfileRef) {
    void openAuthorFromRef(author);
  }

  function handleDownloadCurrentPdf() {
    const entry = history.entries[history.index];
    if (entry?.kind !== "paper" || !entry.bytes) return;
    downloadBlob(
      new Blob([entry.bytes.slice(0)], { type: "application/pdf" }),
      pdfDownloadFilename(entry),
    );
  }

  /** A node in the exploration graph was clicked: bring that paper back up.
   * Prefer replaying its bytes from history (works for uploads, skips the
   * refetch); fall back to refetching by address. Revisits never add edges. */
  function handleGraphSelect(node: GraphNode) {
    if (node.id === currentNodeId || status.kind === "loading") return;
    if (node.kind === "author") {
      for (let i = history.entries.length - 1; i >= 0; i--) {
        if (history.entries[i].nodeId === node.id) {
          void navigate(i - history.index);
          return;
        }
      }
      if (node.address && looksLikeAuthorUrl(node.address)) {
        void openAuthorFromInput(node.address, { kind: "root" });
      } else {
        setStatus({ kind: "error", message: `No reloadable author link for “${node.title}”.` });
      }
      return;
    }
    const reloadAddress = node.address ?? node.pdfUrl;
    if (!reloadAddress) {
      if (node.semanticScholarUrl) window.open(node.semanticScholarUrl, "_blank", "noopener");
      return;
    }
    for (let i = history.entries.length - 1; i >= 0; i--) {
      if (history.entries[i].nodeId === node.id) {
        void navigate(i - history.index);
        return;
      }
    }
    void openFromUrl(reloadAddress, node.title, { kind: "revisit", nodeId: node.id });
  }

  /** Removing a node only edits the graph — the paper stays open in the
   * viewer. If it was the current node, citation clicks made afterwards
   * start a fresh root instead of hanging off a ghost. */
  function handleRemoveNode(id: string) {
    setGraph((g) => removeNode(g, id));
    if (currentNodeId === id) setCurrentNodeId(null);
  }

  function handleAddGraphEdge(from: string, to: string) {
    setGraph((g) => addGraphEdge(g, from, to));
  }

  const canBack = history.index > 0;
  const canForward = history.index < history.entries.length - 1;
  const loading = status.kind === "loading";

  useEffect(() => {
    if (view?.kind !== "paper") setPdfFullscreen(false);
  }, [view?.kind]);

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

  const entryCount = view?.kind === "paper" ? view.citations.entries.length : 0;
  const markerCount = view?.kind === "paper"
    ? [...view.citations.markersByPage.values()].reduce((sum, m) => sum + m.length, 0)
    : 0;
  const authorMarkerCount = view?.kind === "paper"
    ? [...view.authorMarkersByPage.values()].reduce((sum, m) => sum + m.length, 0)
    : 0;
  const authorCount = view?.kind === "paper" ? view.authors.length : 0;
  const canDownloadCurrentPdf =
    view?.kind === "paper" &&
    history.entries[history.index]?.kind === "paper" &&
    !!history.entries[history.index]?.bytes;

  return (
    <div className={pdfFullscreen ? "app pdf-fullscreen-mode" : "app"}>
      {!pdfFullscreen && (
      <header className="app-header">
        <h1>{title}</h1>
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
            placeholder="arXiv id, PDF/source URL, or Google Scholar/Semantic Scholar author URL"
          />
          <button onClick={handleLoad} disabled={loading}>
            Load
          </button>
          <button onClick={() => fileInputRef.current?.click()} disabled={loading}>
            Upload PDF
          </button>
          <button onClick={() => sessionInputRef.current?.click()} disabled={loading}>
            Resume session
          </button>
          <button
            onClick={() => setCitationsOpen((o) => !o)}
            disabled={view?.kind !== "paper"}
            title="List of this paper's parsed references"
          >
            {citationsOpen ? "Hide citations" : "Citations"}
          </button>
          <button
            onClick={() => setAuthorsOpen((o) => !o)}
            disabled={view?.kind !== "paper"}
            title="List of this paper's authors"
          >
            {authorsOpen ? "Hide authors" : "Authors"}
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
          <input
            ref={sessionInputRef}
            type="file"
            accept="text/html,.html,.htm"
            hidden
            onChange={handleSessionFileChange}
          />
        </div>
        {loading && <div className="status-line">{status.message}</div>}
        {status.kind === "notice" && <div className="status-line">{status.message}</div>}
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
        {status.kind === "idle" && view?.kind === "paper" && (
          <div className="status-line">
            {view.label} · {entryCount} references parsed · {markerCount} in-text citations linked
            {authorCount > 0 ? ` · ${authorCount} authors` : ""}
            {authorMarkerCount > 0 ? ` · ${authorMarkerCount} author links` : ""}
          </div>
        )}
        {status.kind === "idle" && view?.kind === "author" && (
          <div className="status-line">
            {view.label} · {view.author.works.length} works
          </div>
        )}
        {pendingRootInput && (
          <div className="pending-root-banner">
            <span>{pendingRootInput.input}</span>
            <button onClick={handlePendingRootLoad} disabled={loading}>
              Add as root
            </button>
            {onPendingRootNewSession && (
              <button onClick={handlePendingRootNewSession}>
                New window
              </button>
            )}
            <button
              onClick={() => {
                onPendingRootHandled?.(pendingRootInput.id);
                setPendingRootInput(null);
              }}
            >
              Dismiss
            </button>
          </div>
        )}
      </header>
      )}

      <div className="app-main">
        {view?.kind === "paper" ? (
          <PdfViewer
            doc={view.doc}
            pages={view.citations.pages}
            markersByPage={view.citations.markersByPage}
            authorMarkersByPage={view.authorMarkersByPage}
            entries={view.citations.entries}
            focusedEntryIndex={focusedCitationEntry}
            onOpenPaper={handleOpenPaper}
            onOpenAuthor={handleOpenAuthor}
            onDownloadPdf={canDownloadCurrentPdf ? handleDownloadCurrentPdf : undefined}
            isFullscreen={pdfFullscreen}
            onToggleFullscreen={() => setPdfFullscreen((value) => !value)}
            showCitationHighlights={citationHighlightsEnabled}
            onToggleCitationHighlights={setCitationHighlightsEnabled}
            showAuthorHighlights={authorHighlightsEnabled}
            onToggleAuthorHighlights={setAuthorHighlightsEnabled}
          />
        ) : view?.kind === "author" ? (
          <AuthorPageView author={view.author} onOpenPaper={handleOpenPaper} />
        ) : (
          <div className="app-content-empty" />
        )}
        {!pdfFullscreen && citationsOpen && view?.kind === "paper" && (
          <CitationsPanel
            entries={view.citations.entries}
            markersByPage={view.citations.markersByPage}
            onFindReferences={setFocusedCitationEntry}
            onOpenPaper={handleOpenPaper}
            onClose={() => setCitationsOpen(false)}
          />
        )}
        {!pdfFullscreen && authorsOpen && view?.kind === "paper" && (
          <AuthorsPanel
            authors={view.authors}
            authorMarkersByPage={view.authorMarkersByPage}
            onOpenAuthor={handleOpenAuthor}
            onClose={() => setAuthorsOpen(false)}
          />
        )}
        {!pdfFullscreen && graphOpen && (
          <GraphPanel
            graph={graph}
            currentNodeId={currentNodeId}
            onSelectNode={handleGraphSelect}
            onRemoveNode={handleRemoveNode}
            onAddEdge={handleAddGraphEdge}
            onClose={() => setGraphOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

function authorsForPaper(
  paper: ResolvedPaper | undefined,
  pages: CitationData["pages"],
): AuthorProfileRef[] {
  const metadataAuthors =
    paper?.authorProfiles?.length
      ? paper.authorProfiles
      : paper?.authors.map((name) => ({ name })) ?? [];
  return dedupeAuthors([...metadataAuthors, ...extractAuthorCandidates(pages)]);
}

function dedupeAuthors(authors: AuthorProfileRef[]): AuthorProfileRef[] {
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  const out: AuthorProfileRef[] = [];
  for (const author of authors) {
    const name = author.name.replace(/\s+/g, " ").trim();
    const nameKey = name.toLowerCase();
    const key = (
      author.semanticScholarAuthorId ??
      author.semanticScholarUrl ??
      author.googleScholarUrl ??
      name
    ).toLowerCase();
    if (!name || seen.has(key) || seenNames.has(nameKey)) continue;
    seen.add(key);
    seenNames.add(nameKey);
    out.push({ ...author, name });
  }
  return out;
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
  onResolvedPaper?: (paper: ResolvedPaper) => void,
): Promise<void> {
  const arxivId = url.match(/arxiv\.org\/pdf\/([^?#]+?)(?:\.pdf)?$/i)?.[1];
  if (arxivId) {
    try {
      const s2 = await getPaperByArxivId(arxivId);
      if (s2) {
        const paper = toResolvedPaper(s2);
        const node = nodeFromPaper(paper);
        setGraph((g) =>
          addPaperNode(g, { ...node, id: nodeId, address: url, pdfUrl: url, kind: "pdf" }, null),
        );
        onResolvedPaper?.({ ...paper, pdfUrl: url });
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

function arrayBufferToPdfDataUrl(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:application/pdf;base64,${btoa(binary)}`;
}

function pdfDownloadFilename(entry: HistoryEntry): string {
  const raw = filenameBase(entry.label) ?? filenameBase(entry.address) ?? "paper";
  const cleaned = raw
    .replace(/\.pdf$/i, "")
    .replace(/[<>:"|?*\x00-\x1f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  return `${cleaned || "paper"}.pdf`;
}

function filenameBase(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("data:")) return null;
  try {
    const url = new URL(trimmed);
    const last = url.pathname.split("/").filter(Boolean).at(-1);
    return decodeURIComponent(last || url.hostname);
  } catch {
    return trimmed;
  }
}
