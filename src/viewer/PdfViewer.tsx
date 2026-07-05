import { useEffect, useRef, useState } from "react";
import { TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, TextContent } from "pdfjs-dist/types/src/display/api";
import type {
  AuthorMarker,
  AuthorProfileRef,
  BibEntry,
  CitationMarker,
  PageText,
  ResolvedPaper,
} from "../core/types";
import { resolveEntry } from "../core/citationService";
import { guessTitle } from "../core/semanticScholar/client";
import { findPublicPdf, paperWithFoundPdf } from "../core/webPdfSearch";
import { applyCitationOverlay } from "./applyCitationOverlay";
import { CitationTooltip } from "./CitationTooltip";
import "./pdfViewer.css";

interface PdfViewerProps {
  doc: PDFDocumentProxy;
  pages: PageText[];
  markersByPage: Map<number, CitationMarker[]>;
  authorMarkersByPage?: Map<number, AuthorMarker[]>;
  entries: BibEntry[];
  focusedEntryIndex: number | null;
  /** Called with the resolved paper when a citation marker is clicked. */
  onOpenPaper: (paper: ResolvedPaper) => void;
  onOpenAuthor?: (author: AuthorProfileRef) => void;
}

interface TooltipState {
  marker: CitationMarker;
  x: number;
  y: number;
  status: "loading" | "ready" | "error";
  paper?: ResolvedPaper | null;
  errorMessage?: string;
  pdfSearchStatus?: "idle" | "searching" | "not-found" | "error";
  pdfSearchMessage?: string;
}

const SCALE = 1.5;
const TOOLTIP_HIDE_DELAY_MS = 180;

export function PdfViewer({
  doc,
  pages,
  markersByPage,
  authorMarkersByPage = new Map(),
  entries,
  focusedEntryIndex,
  onOpenPaper,
  onOpenAuthor,
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const markerLookupRef = useRef(new Map<string, CitationMarker>());
  const authorMarkerLookupRef = useRef(new Map<string, AuthorMarker>());
  const tooltipHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderRunRef = useRef(0);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderVersion, setRenderVersion] = useState(0);

  function cancelTooltipHide() {
    if (!tooltipHideTimerRef.current) return;
    clearTimeout(tooltipHideTimerRef.current);
    tooltipHideTimerRef.current = null;
  }

  function closeTooltip() {
    cancelTooltipHide();
    setTooltip((prev) => (prev?.pdfSearchStatus === "searching" ? prev : null));
  }

  function scheduleTooltipHide(markerId: string) {
    cancelTooltipHide();
    tooltipHideTimerRef.current = setTimeout(() => {
      tooltipHideTimerRef.current = null;
      setTooltip((prev) =>
        prev?.marker.id === markerId && prev.pdfSearchStatus !== "searching" ? null : prev,
      );
    }, TOOLTIP_HIDE_DELAY_MS);
  }

  useEffect(() => () => cancelTooltipHide(), []);

  useEffect(() => {
    const lookup = new Map<string, CitationMarker>();
    for (const markers of markersByPage.values()) {
      for (const m of markers) lookup.set(m.id, m);
    }
    markerLookupRef.current = lookup;
  }, [markersByPage]);

  useEffect(() => {
    const lookup = new Map<string, AuthorMarker>();
    for (const markers of authorMarkersByPage.values()) {
      for (const m of markers) lookup.set(m.id, m);
    }
    authorMarkerLookupRef.current = lookup;
  }, [authorMarkersByPage]);

  useEffect(() => {
    let cancelled = false;
    const renderRun = ++renderRunRef.current;
    const isStale = () => cancelled || renderRun !== renderRunRef.current;
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";
    setRenderError(null);
    // Browser-like navigation: a newly opened document starts at the top
    // rather than inheriting the previous paper's scroll offset.
    scrollRef.current?.scrollTo({ top: 0 });

    (async () => {
      const renderedPages = new Set<number>();
      for (const pageText of pages) {
        if (isStale() || renderedPages.has(pageText.pageNumber)) continue;
        renderedPages.add(pageText.pageNumber);
        const page = await doc.getPage(pageText.pageNumber);
        if (isStale()) return;
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
        if (isStale()) return;

        const textContent =
          (pageText.textContent as TextContent | undefined) ?? (await page.getTextContent());
        if (isStale()) return;
        const textLayer = new TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
        });
        await textLayer.render();
        if (isStale()) return;

        const markers = markersByPage.get(pageText.pageNumber) ?? [];
        applyCitationOverlay(
          textLayerDiv,
          textLayer.textDivs,
          pageText.items,
          markers,
          authorMarkersByPage.get(pageText.pageNumber) ?? [],
        );
      }
      if (!isStale()) setRenderVersion((v) => v + 1);
    })().catch((err) => {
      if (!isStale()) setRenderError(`Failed to render PDF: ${(err as Error).message}`);
    });

    return () => {
      cancelled = true;
    };
  }, [doc, pages, markersByPage, authorMarkersByPage]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const marked = [...container.querySelectorAll<HTMLElement>(".citation-mark-selected")];
    for (const el of marked) el.classList.remove("citation-mark-selected");
    if (focusedEntryIndex === null) return;

    const markerIds = new Set<string>();
    for (const markers of markersByPage.values()) {
      for (const marker of markers) {
        if (marker.entryIndices.includes(focusedEntryIndex)) markerIds.add(marker.id);
      }
    }
    if (markerIds.size === 0) return;

    const matches = [...container.querySelectorAll<HTMLElement>(".citation-mark")].filter(
      (el) => !!el.dataset.markerId && markerIds.has(el.dataset.markerId),
    );
    for (const el of matches) el.classList.add("citation-mark-selected");
    matches[0]?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }, [focusedEntryIndex, markersByPage, renderVersion]);

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

    const findAuthorMarker = (
      target: EventTarget | null,
    ): { marker: AuthorMarker; el: HTMLElement } | null => {
      if (!(target instanceof HTMLElement)) return null;
      const el = target.closest<HTMLElement>(".author-mark");
      if (!el?.dataset.authorMarkerId) return null;
      const marker = authorMarkerLookupRef.current.get(el.dataset.authorMarkerId);
      return marker ? { marker, el } : null;
    };

    const handleOver = (e: MouseEvent) => {
      const found = findMarker(e.target);
      if (!found) return;
      cancelTooltipHide();
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
      if (
        related instanceof HTMLElement &&
        related.closest<HTMLElement>(".citation-mark")?.dataset.markerId === found.marker.id
      ) {
        return;
      }
      if (related instanceof HTMLElement && related.closest(".citation-tooltip")) return;
      scheduleTooltipHide(found.marker.id);
    };

    const handleClick = (e: MouseEvent) => {
      const foundAuthor = findAuthorMarker(e.target);
      if (foundAuthor) {
        e.preventDefault();
        cancelTooltipHide();
        setTooltip(null);
        onOpenAuthor?.(foundAuthor.marker.author);
        return;
      }
      const found = findMarker(e.target);
      if (!found) return;
      e.preventDefault();
      cancelTooltipHide();
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
  }, [entries, onOpenPaper, onOpenAuthor]);

  function handleSearchPublicPdf(marker: CitationMarker, paper?: ResolvedPaper | null) {
    const entry = entries[marker.entryIndices[0]];
    if (!entry) return;
    const title = paper?.title ?? guessTitle(entry.rawText) ?? undefined;
    const fallbackTitle = title ?? entry.rawText.slice(0, 120);

    setTooltip((prev) =>
      prev && prev.marker.id === marker.id
        ? { ...prev, pdfSearchStatus: "searching", pdfSearchMessage: undefined }
        : prev,
    );
    findPublicPdf({ title, rawText: entry.rawText })
      .then((result) => {
        if (!result) {
          setTooltip((prev) =>
            prev && prev.marker.id === marker.id
              ? { ...prev, pdfSearchStatus: "not-found" }
              : prev,
          );
          return;
        }
        setTooltip(null);
        onOpenPaper(paperWithFoundPdf(paper, result, fallbackTitle));
      })
      .catch((err) => {
        setTooltip((prev) =>
          prev && prev.marker.id === marker.id
            ? {
                ...prev,
                pdfSearchStatus: "error",
                pdfSearchMessage: (err as Error).message,
              }
            : prev,
        );
      });
  }

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
          pdfSearchStatus={tooltip.pdfSearchStatus}
          pdfSearchMessage={tooltip.pdfSearchMessage}
          onSearchPdf={() => handleSearchPublicPdf(tooltip.marker, tooltip.paper)}
          onMouseEnter={cancelTooltipHide}
          onMouseLeave={closeTooltip}
        />
      )}
    </div>
  );
}
