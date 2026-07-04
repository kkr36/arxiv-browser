import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { fetchPdfBytes } from "./core/net/fetchPdfBytes";
import { resolveInputToPdfUrl } from "./core/resolveInput";
import { loadPdfDocument } from "./core/pdf/loadPdf";
import { buildCitationData, resetResolutionCache, type CitationData } from "./core/citationService";
import type { ResolvedPaper } from "./core/types";
import { PdfViewer } from "./viewer/PdfViewer";
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
}

type Status =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string; link?: { url: string; text: string } };

export default function App() {
  const [input, setInput] = useState("1706.03762");
  const [view, setView] = useState<PaperView | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [history, setHistory] = useState<{ entries: HistoryEntry[]; index: number }>({
    entries: [],
    index: -1,
  });
  // Monotonic id per load; a stale async load bails out instead of clobbering
  // a newer one (e.g. two citation clicks in quick succession).
  const loadSeq = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function showEntry(
    entry: HistoryEntry,
    seq: number,
    nav: { push: true } | { push: false; index: number },
  ) {
    setStatus({ kind: "loading", message: "Parsing PDF…" });
    resetResolutionCache();
    const doc = await loadPdfDocument(entry.bytes.slice(0));
    if (seq !== loadSeq.current) return;
    setStatus({ kind: "loading", message: "Finding citations…" });
    const citations = await buildCitationData(doc);
    if (seq !== loadSeq.current) return;
    setView({ doc, citations, label: entry.label });
    setInput(entry.address);
    setStatus({ kind: "idle" });
    setHistory((h) =>
      nav.push
        ? { entries: [...h.entries.slice(0, h.index + 1), entry], index: h.index + 1 }
        : { ...h, index: nav.index },
    );
  }

  async function openFromUrl(url: string, label?: string) {
    const seq = ++loadSeq.current;
    try {
      setStatus({ kind: "loading", message: "Fetching PDF…" });
      const bytes = await fetchPdfBytes(url);
      if (seq !== loadSeq.current) return;
      await showEntry({ bytes, label: label ?? url, address: url }, seq, { push: true });
    } catch (err) {
      if (seq === loadSeq.current) setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  function handleLoad() {
    if (!input.trim()) return;
    try {
      void openFromUrl(resolveInputToPdfUrl(input));
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
      await showEntry({ bytes, label: file.name, address: file.name }, seq, { push: true });
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
   * (Semantic Scholar page only) can't be rendered here and open in a new tab. */
  function handleOpenPaper(paper: ResolvedPaper) {
    if (paper.pdfUrl) {
      void openFromUrl(paper.pdfUrl, paper.title);
      return;
    }
    if (paper.semanticScholarUrl) {
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

      {view && (
        <PdfViewer
          doc={view.doc}
          pages={view.citations.pages}
          markersByPage={view.citations.markersByPage}
          entries={view.citations.entries}
          onOpenPaper={handleOpenPaper}
        />
      )}
    </div>
  );
}
