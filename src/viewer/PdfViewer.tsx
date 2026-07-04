import { useEffect, useRef, useState } from "react";
import { TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, TextContent } from "pdfjs-dist/types/src/display/api";
import type { BibEntry, CitationMarker, PageText, ResolvedPaper } from "../core/types";
import { resolveEntry } from "../core/citationService";
import { applyCitationOverlay } from "./applyCitationOverlay";
import { CitationTooltip } from "./CitationTooltip";
import "./pdfViewer.css";

interface PdfViewerProps {
  doc: PDFDocumentProxy;
  pages: PageText[];
  markersByPage: Map<number, CitationMarker[]>;
  entries: BibEntry[];
  /** Called with the resolved paper when a citation marker is clicked. */
  onOpenPaper: (paper: ResolvedPaper) => void;
}

interface TooltipState {
  marker: CitationMarker;
  x: number;
  y: number;
  status: "loading" | "ready" | "error";
  paper?: ResolvedPaper | null;
  errorMessage?: string;
}

const SCALE = 1.5;

export function PdfViewer({ doc, pages, markersByPage, entries, onOpenPaper }: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const markerLookupRef = useRef(new Map<string, CitationMarker>());
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const lookup = new Map<string, CitationMarker>();
    for (const markers of markersByPage.values()) {
      for (const m of markers) lookup.set(m.id, m);
    }
    markerLookupRef.current = lookup;
  }, [markersByPage]);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";
    setRenderError(null);
    // Browser-like navigation: a newly opened document starts at the top
    // rather than inheriting the previous paper's scroll offset.
    scrollRef.current?.scrollTo({ top: 0 });

    (async () => {
      for (const pageText of pages) {
        if (cancelled) return;
        const page = await doc.getPage(pageText.pageNumber);
        const viewport = page.getViewport({ scale: SCALE });
        // Render at device resolution but lay out at CSS pixels, so text
        // isn't blurry on high-DPI displays.
        const outputScale = window.devicePixelRatio || 1;

        const pageDiv = document.createElement("div");
        pageDiv.className = "pdf-page";
        pageDiv.style.width = `${viewport.width}px`;
        pageDiv.style.height = `${viewport.height}px`;

        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        pageDiv.appendChild(canvas);

        const textLayerDiv = document.createElement("div");
        textLayerDiv.className = "textLayer";
        pageDiv.appendChild(textLayerDiv);

        container.appendChild(pageDiv);

        const ctx = canvas.getContext("2d");
        if (ctx) {
          await page.render({
            canvasContext: ctx,
            viewport,
            transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
          }).promise;
        }
        if (cancelled) return;

        const textContent =
          (pageText.textContent as TextContent | undefined) ?? (await page.getTextContent());
        const textLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
        });
        await textLayer.render();
        if (cancelled) return;

        const markers = markersByPage.get(pageText.pageNumber) ?? [];
        applyCitationOverlay(textLayer.textDivs, pageText.items, markers);
      }
    })().catch((err) => {
      if (!cancelled) setRenderError(`Failed to render PDF: ${(err as Error).message}`);
    });

    return () => {
      cancelled = true;
    };
  }, [doc, pages, markersByPage]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const findMarker = (target: EventTarget | null): { marker: CitationMarker; el: HTMLElement } | null => {
      if (!(target instanceof HTMLElement)) return null;
      const el = target.closest<HTMLElement>(".citation-mark");
      if (!el?.dataset.markerId) return null;
      const marker = markerLookupRef.current.get(el.dataset.markerId);
      return marker ? { marker, el } : null;
    };

    const handleOver = (e: MouseEvent) => {
      const found = findMarker(e.target);
      if (!found) return;
      const rect = found.el.getBoundingClientRect();
      setTooltip({ marker: found.marker, x: rect.left, y: rect.bottom, status: "loading" });

      resolveEntry(entries, found.marker.entryIndices[0])
        .then((paper) => {
          setTooltip((prev) =>
            prev && prev.marker.id === found.marker.id
              ? { ...prev, status: paper ? "ready" : "error", paper }
              : prev,
          );
        })
        .catch((err) => {
          setTooltip((prev) =>
            prev && prev.marker.id === found.marker.id
              ? { ...prev, status: "error", errorMessage: (err as Error).message }
              : prev,
          );
        });
    };

    const handleOut = (e: MouseEvent) => {
      const found = findMarker(e.target);
      if (!found) return;
      const related = e.relatedTarget;
      if (related instanceof HTMLElement && related.closest(".citation-mark") === found.el) return;
      setTooltip((prev) => (prev?.marker.id === found.marker.id ? null : prev));
    };

    const handleClick = (e: MouseEvent) => {
      const found = findMarker(e.target);
      if (!found) return;
      e.preventDefault();
      const rect = found.el.getBoundingClientRect();
      setTooltip({ marker: found.marker, x: rect.left, y: rect.bottom, status: "loading" });
      resolveEntry(entries, found.marker.entryIndices[0])
        .then((paper) => {
          if (!paper) {
            setTooltip((prev) =>
              prev && prev.marker.id === found.marker.id
                ? { ...prev, status: "error", paper }
                : prev,
            );
            return;
          }
          setTooltip(null);
          onOpenPaper(paper);
        })
        .catch((err) => {
          setTooltip((prev) =>
            prev && prev.marker.id === found.marker.id
              ? { ...prev, status: "error", errorMessage: (err as Error).message }
              : prev,
          );
        });
    };

    container.addEventListener("mouseover", handleOver);
    container.addEventListener("mouseout", handleOut);
    container.addEventListener("click", handleClick);
    return () => {
      container.removeEventListener("mouseover", handleOver);
      container.removeEventListener("mouseout", handleOut);
      container.removeEventListener("click", handleClick);
    };
  }, [entries, onOpenPaper]);

  return (
    <div ref={scrollRef} className="pdf-viewer-scroll">
      {renderError && <div className="status-line error">{renderError}</div>}
      <div ref={containerRef} className="pdf-viewer" />
      {tooltip && (
        <CitationTooltip
          x={tooltip.x}
          y={tooltip.y}
          status={tooltip.status}
          paper={tooltip.paper}
          entry={entries[tooltip.marker.entryIndices[0]]}
          errorMessage={tooltip.errorMessage}
        />
      )}
    </div>
  );
}
