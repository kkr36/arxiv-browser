import { useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { fetchPdfBytes } from "./core/net/fetchPdfBytes";
import { resolveInputToPdfUrl } from "./core/resolveInput";
import { loadPdfDocument } from "./core/pdf/loadPdf";
import { buildCitationData, resetResolutionCache, type CitationData } from "./core/citationService";
import { PdfViewer } from "./viewer/PdfViewer";
import "./app.css";

type LoadState =
  | { status: "idle" }
  | { status: "loading"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; doc: PDFDocumentProxy; citations: CitationData };

export default function App() {
  const [input, setInput] = useState("1706.03762");
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function loadFromBytes(bytes: ArrayBuffer) {
    setState({ status: "loading", message: "Parsing PDF…" });
    resetResolutionCache();
    const doc = await loadPdfDocument(bytes);
    setState({ status: "loading", message: "Finding citations…" });
    const citations = await buildCitationData(doc);
    setState({ status: "ready", doc, citations });
  }

  async function handleLoad() {
    if (!input.trim()) return;
    try {
      setState({ status: "loading", message: "Fetching PDF…" });
      const url = resolveInputToPdfUrl(input);
      const bytes = await fetchPdfBytes(url);
      await loadFromBytes(bytes);
    } catch (err) {
      setState({ status: "error", message: (err as Error).message });
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const bytes = await file.arrayBuffer();
      await loadFromBytes(bytes);
    } catch (err) {
      setState({ status: "error", message: (err as Error).message });
    }
  }

  const entryCount = state.status === "ready" ? state.citations.entries.length : 0;
  const markerCount =
    state.status === "ready"
      ? [...state.citations.markersByPage.values()].reduce((sum, m) => sum + m.length, 0)
      : 0;

  return (
    <div className="app">
      <header className="app-header">
        <h1>arxiv-browser</h1>
        <div className="load-bar">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLoad()}
            placeholder="arXiv id (1706.03762), arXiv URL, or PDF URL"
          />
          <button onClick={handleLoad} disabled={state.status === "loading"}>
            Load
          </button>
          <button onClick={() => fileInputRef.current?.click()} disabled={state.status === "loading"}>
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
        {state.status === "ready" && (
          <div className="status-line">
            {entryCount} references parsed · {markerCount} in-text citations linked
          </div>
        )}
        {state.status === "loading" && <div className="status-line">{state.message}</div>}
        {state.status === "error" && <div className="status-line error">{state.message}</div>}
      </header>

      {state.status === "ready" && (
        <PdfViewer
          doc={state.doc}
          pages={state.citations.pages}
          markersByPage={state.citations.markersByPage}
          entries={state.citations.entries}
        />
      )}
    </div>
  );
}
