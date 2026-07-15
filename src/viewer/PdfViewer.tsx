import { useEffect, useRef, useState } from "react";
import { AnnotationLayer, TextLayer } from "pdfjs-dist";
import type { PDFDocumentProxy, TextContent } from "pdfjs-dist/types/src/display/api";
import type { PageViewport } from "pdfjs-dist/types/src/display/display_utils";
import type { IPDFLinkService } from "pdfjs-dist/types/web/interfaces";
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
  onDownloadPdf?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  showCitationHighlights?: boolean;
  onToggleCitationHighlights?: (enabled: boolean) => void;
  showAuthorHighlights?: boolean;
  onToggleAuthorHighlights?: (enabled: boolean) => void;
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
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.2;
const CANVAS_QUALITY_SCALE = 1.5;
const MIN_CANVAS_OUTPUT_SCALE = 2;
const MAX_CANVAS_OUTPUT_SCALE = 4;
const MAX_CANVAS_PIXELS = 20_000_000;
const TOOLTIP_HIDE_DELAY_MS = 180;
const EXPANDED_CONTROLS_WIDTH = 208;
const EXPANDED_CONTROLS_HEIGHT = 224;
const CONTROLS_OFFSET = 16;

export function PdfViewer({
  doc,
  pages,
  markersByPage,
  authorMarkersByPage = new Map(),
  entries,
  focusedEntryIndex,
  onOpenPaper,
  onOpenAuthor,
  onDownloadPdf,
  isFullscreen = false,
  onToggleFullscreen,
  showCitationHighlights = true,
  onToggleCitationHighlights,
  showAuthorHighlights = true,
  onToggleAuthorHighlights,
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const markerLookupRef = useRef(new Map<string, CitationMarker>());
  const authorMarkerLookupRef = useRef(new Map<string, AuthorMarker>());
  const tooltipHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renderRunRef = useRef(0);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderVersion, setRenderVersion] = useState(0);
  const [renderPixelRatio, setRenderPixelRatio] = useState(getDevicePixelRatio);
  const [controlsCompact, setControlsCompact] = useState(false);
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const [controlsManuallyMinimized, setControlsManuallyMinimized] = useState(false);
  const [zoom, setZoom] = useState(1);
  const prevDocRef = useRef<PDFDocumentProxy | null>(null);

  function zoomBy(factor: number) {
    setZoom((z) => clampZoom(Math.round(z * factor * 100) / 100));
  }

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
    let frame = 0;
    const updatePixelRatio = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setRenderPixelRatio((prev) => {
          const next = getDevicePixelRatio();
          return Math.abs(prev - next) > 0.01 ? next : prev;
        });
      });
    };
    window.addEventListener("resize", updatePixelRatio);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePixelRatio);
    };
  }, []);

  useEffect(() => {
    if (!showCitationHighlights) closeTooltip();
  }, [showCitationHighlights]);

  useEffect(() => {
    let frame = 0;
    const updateControlLayout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const scroll = scrollRef.current;
        const container = containerRef.current;
        if (!scroll || !container) return;
        const scrollRect = scroll.getBoundingClientRect();
        const controlRect = {
          left: scrollRect.left + CONTROLS_OFFSET,
          right: scrollRect.left + CONTROLS_OFFSET + EXPANDED_CONTROLS_WIDTH,
          top: scrollRect.top + CONTROLS_OFFSET,
          bottom: scrollRect.top + CONTROLS_OFFSET + EXPANDED_CONTROLS_HEIGHT,
        };
        const overlapsPage = [...container.querySelectorAll<HTMLElement>(".pdf-page")].some(
          (page) => rectsOverlap(controlRect, page.getBoundingClientRect()),
        );
        setControlsCompact(overlapsPage);
      });
    };

    const scroll = scrollRef.current;
    const container = containerRef.current;
    updateControlLayout();
    window.addEventListener("resize", updateControlLayout);
    scroll?.addEventListener("scroll", updateControlLayout, { passive: true });
    const resizeObserver = new ResizeObserver(updateControlLayout);
    if (scroll) resizeObserver.observe(scroll);
    if (container) resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", updateControlLayout);
      scroll?.removeEventListener("scroll", updateControlLayout);
      resizeObserver.disconnect();
    };
  }, [renderVersion, isFullscreen]);

  useEffect(() => {
    if (!controlsCompact && !controlsManuallyMinimized) setControlsMenuOpen(false);
  }, [controlsCompact, controlsManuallyMinimized]);

  useEffect(() => {
    if (!controlsMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (controlsRef.current?.contains(event.target as Node)) return;
      setControlsMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setControlsMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [controlsMenuOpen]);

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
    // Browser-like navigation: a newly opened document starts at the top.
    // Re-renders of the same document (zoom, highlight toggles) instead keep
    // the reader's place by restoring the proportional scroll offset.
    const sameDoc = prevDocRef.current === doc;
    prevDocRef.current = doc;
    const scrollEl = scrollRef.current;
    const scrollFraction =
      sameDoc && scrollEl && scrollEl.scrollHeight > 0
        ? scrollEl.scrollTop / scrollEl.scrollHeight
        : 0;
    container.innerHTML = "";
    setRenderError(null);
    scrollEl?.scrollTo({ top: 0 });

    (async () => {
      const renderedPages = new Set<number>();
      const renderedPageDivs = new Map<number, HTMLElement>();
      const renderedViewports = new Map<number, PageViewport>();
      const linkService = createPdfLinkService(doc, scrollRef, renderedPageDivs, renderedViewports);
      for (const pageText of pages) {
        if (isStale() || renderedPages.has(pageText.pageNumber)) continue;
        renderedPages.add(pageText.pageNumber);
        const page = await doc.getPage(pageText.pageNumber);
        if (isStale()) return;
        const viewport = page.getViewport({ scale: SCALE * zoom });
        // Render at device resolution but lay out at CSS pixels, so text
        // isn't blurry on high-DPI displays. The extra capped oversampling
        // makes dense, thin-font papers closer to native PDF viewer quality.
        const outputScale = canvasOutputScale(viewport.width, viewport.height, renderPixelRatio);

        const pageDiv = document.createElement("div");
        pageDiv.className = "pdf-page";
        pageDiv.dataset.pageNumber = String(pageText.pageNumber);
        pageDiv.style.width = `${viewport.width}px`;
        pageDiv.style.height = `${viewport.height}px`;
        // pdf.js's TextLayer sizes/positions its spans with
        // calc(var(--scale-factor) * ...); without this variable the
        // declarations are invalid and selectable text drifts off the
        // painted glyphs.
        pageDiv.style.setProperty("--scale-factor", String(viewport.scale));

        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        pageDiv.appendChild(canvas);

        const textLayerDiv = document.createElement("div");
        textLayerDiv.className = "textLayer";
        pageDiv.appendChild(textLayerDiv);

        const annotationLayerDiv = document.createElement("div");
        annotationLayerDiv.className = "annotationLayer";
        pageDiv.appendChild(annotationLayerDiv);

        container.appendChild(pageDiv);
        renderedPageDivs.set(pageText.pageNumber, pageDiv);
        renderedViewports.set(pageText.pageNumber, viewport);

        const ctx = canvas.getContext("2d");
        if (ctx) {
          const renderScaleX = canvas.width / viewport.width;
          const renderScaleY = canvas.height / viewport.height;
          await page.render({
            canvasContext: ctx,
            viewport,
            transform:
              renderScaleX !== 1 || renderScaleY !== 1
                ? [renderScaleX, 0, 0, renderScaleY, 0, 0]
                : undefined,
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

        const annotations = await page.getAnnotations({ intent: "display" });
        if (isStale()) return;
        if (annotations.length > 0) {
          const annotationLayer = new AnnotationLayer({
            div: annotationLayerDiv,
            page,
            viewport: viewport.clone({ dontFlip: true }),
            accessibilityManager: null,
            annotationCanvasMap: null,
            annotationEditorUIManager: null,
            structTreeLayer: null,
          });
          await annotationLayer.render({
            annotations,
            div: annotationLayerDiv,
            page,
            viewport: viewport.clone({ dontFlip: true }),
            linkService,
            renderForms: false,
          });
          if (isStale()) return;
        }

        const markers = showCitationHighlights ? (markersByPage.get(pageText.pageNumber) ?? []) : [];
        const authorMarkers = showAuthorHighlights
          ? (authorMarkersByPage.get(pageText.pageNumber) ?? [])
          : [];
        applyCitationOverlay(
          textLayerDiv,
          pageDiv,
          textLayer.textDivs,
          pageText.items,
          markers,
          authorMarkers,
        );
      }
      if (isStale()) return;
      if (sameDoc && scrollFraction > 0 && scrollEl) {
        scrollEl.scrollTo({ top: scrollFraction * scrollEl.scrollHeight });
      }
      setRenderVersion((v) => v + 1);
    })().catch((err) => {
      if (!isStale()) setRenderError(`Failed to render PDF: ${(err as Error).message}`);
    });

    return () => {
      cancelled = true;
    };
  }, [
    doc,
    pages,
    markersByPage,
    authorMarkersByPage,
    showCitationHighlights,
    showAuthorHighlights,
    renderPixelRatio,
    zoom,
  ]);

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

  const actionButtons = (
    <div className="pdf-icon-row">
      {onToggleFullscreen && (
        <button
          type="button"
          className="pdf-icon-button"
          onClick={onToggleFullscreen}
          title={isFullscreen ? "Exit PDF fullscreen" : "PDF fullscreen"}
          aria-label={isFullscreen ? "Exit PDF fullscreen" : "PDF fullscreen"}
        >
          {isFullscreen ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 3v5H3" />
              <path d="M16 3v5h5" />
              <path d="M8 21v-5H3" />
              <path d="M16 21v-5h5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 8V3h5" />
              <path d="M21 8V3h-5" />
              <path d="M3 16v5h5" />
              <path d="M21 16v5h-5" />
            </svg>
          )}
        </button>
      )}
      {onDownloadPdf && (
        <button
          type="button"
          className="pdf-icon-button"
          onClick={onDownloadPdf}
          title="Download PDF"
          aria-label="Download PDF"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
        </button>
      )}
    </div>
  );

  const zoomControls = (
    <div className="pdf-zoom-row" aria-label="Zoom controls">
      <button
        type="button"
        className="pdf-icon-button"
        onClick={() => zoomBy(1 / ZOOM_STEP)}
        disabled={zoom <= ZOOM_MIN}
        title="Zoom out"
        aria-label="Zoom out"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h14" />
        </svg>
      </button>
      <button
        type="button"
        className="pdf-zoom-level"
        onClick={() => setZoom(1)}
        disabled={zoom === 1}
        title="Reset zoom to 100%"
        aria-label={`Zoom level ${Math.round(zoom * 100)}%, click to reset`}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        className="pdf-icon-button"
        onClick={() => zoomBy(ZOOM_STEP)}
        disabled={zoom >= ZOOM_MAX}
        title="Zoom in"
        aria-label="Zoom in"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      </button>
    </div>
  );

  const displayOptions = (
    <>
      <div className="pdf-control-divider" aria-hidden="true" />
      <div className="pdf-display-options">
        <label
          className="pdf-highlight-toggle"
          title="Browser-added citation highlights. Turn off to use the PDF's original citation links."
        >
          <input
            type="checkbox"
            checked={showCitationHighlights}
            onChange={(e) => onToggleCitationHighlights?.(e.currentTarget.checked)}
            disabled={!onToggleCitationHighlights}
          />
          <span>Citation highlights</span>
        </label>
        <label className="pdf-highlight-toggle" title="Browser-added author name highlights">
          <input
            type="checkbox"
            checked={showAuthorHighlights}
            onChange={(e) => onToggleAuthorHighlights?.(e.currentTarget.checked)}
            disabled={!onToggleAuthorHighlights}
          />
          <span>Author highlights</span>
        </label>
      </div>
    </>
  );

  const shouldShowCompactControls = controlsCompact || controlsManuallyMinimized;

  return (
    <div ref={scrollRef} className={isFullscreen ? "pdf-viewer-scroll fullscreen" : "pdf-viewer-scroll"}>
      <div
        ref={controlsRef}
        className={
          shouldShowCompactControls ? "pdf-floating-controls compact" : "pdf-floating-controls"
        }
        aria-label="PDF view controls"
      >
        {shouldShowCompactControls ? (
          <>
            <button
              type="button"
              className="pdf-icon-button pdf-compact-trigger"
              onClick={() => {
                if (controlsManuallyMinimized && !controlsCompact) {
                  setControlsManuallyMinimized(false);
                  setControlsMenuOpen(false);
                  return;
                }
                setControlsManuallyMinimized(false);
                setControlsMenuOpen((open) => !open);
              }}
              aria-label={
                controlsManuallyMinimized && !controlsCompact
                  ? "Expand PDF controls"
                  : "PDF view controls"
              }
              aria-expanded={controlsCompact ? controlsMenuOpen : undefined}
              aria-haspopup={controlsCompact ? "menu" : undefined}
              title={
                controlsManuallyMinimized && !controlsCompact
                  ? "Expand controls"
                  : "PDF view controls"
              }
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h16" />
                <path d="M4 12h16" />
                <path d="M4 17h16" />
              </svg>
            </button>
            {controlsMenuOpen && (
              <div className="pdf-compact-menu">
                {actionButtons}
                {zoomControls}
                {displayOptions}
              </div>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              className="pdf-minimize-button"
              onClick={() => {
                setControlsManuallyMinimized(true);
                setControlsMenuOpen(false);
              }}
              aria-label="Minimize PDF controls"
              title="Minimize controls"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 12h10" />
              </svg>
            </button>
            {actionButtons}
            {zoomControls}
            {displayOptions}
          </>
        )}
      </div>
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

function getDevicePixelRatio(): number {
  return window.devicePixelRatio || 1;
}

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

function canvasOutputScale(width: number, height: number, devicePixelRatio: number): number {
  const desired = Math.min(
    Math.max(devicePixelRatio * CANVAS_QUALITY_SCALE, MIN_CANVAS_OUTPUT_SCALE),
    MAX_CANVAS_OUTPUT_SCALE,
  );
  const maxForPage = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(width * height, 1));
  return Math.max(1, Math.min(desired, maxForPage));
}

function createPdfLinkService(
  doc: PDFDocumentProxy,
  scrollRef: React.RefObject<HTMLDivElement>,
  pageDivs: Map<number, HTMLElement>,
  viewports: Map<number, PageViewport>,
): IPDFLinkService {
  let currentPage = 1;
  const scrollToPage = (pageNumber: number, y = 0) => {
    const pageDiv = pageDivs.get(pageNumber);
    const scroll = scrollRef.current;
    if (!pageDiv || !scroll) return;
    currentPage = pageNumber;
    scroll.scrollTo({ top: Math.max(0, pageDiv.offsetTop + y - 16), behavior: "smooth" });
  };

  return {
    externalLinkEnabled: true,
    get pagesCount() {
      return doc.numPages;
    },
    get page() {
      return currentPage;
    },
    set page(value: number) {
      if (Number.isFinite(value)) scrollToPage(value);
    },
    get rotation() {
      return 0;
    },
    set rotation(_value: number) {},
    get isInPresentationMode() {
      return false;
    },
    async goToDestination(dest: string | unknown[]) {
      const explicitDest = typeof dest === "string" ? await doc.getDestination(dest) : dest;
      if (!Array.isArray(explicitDest) || explicitDest.length === 0) return;

      const pageRef = explicitDest[0];
      const pageNumber =
        typeof pageRef === "number" ? pageRef + 1 : (await doc.getPageIndex(pageRef)) + 1;
      const viewport = viewports.get(pageNumber);
      const pageTop =
        viewport && typeof explicitDest[3] === "number"
          ? viewport.convertToViewportPoint(0, explicitDest[3])[1]
          : 0;
      scrollToPage(pageNumber, pageTop);
    },
    goToPage(value: number | string) {
      const pageNumber = typeof value === "number" ? value : Number.parseInt(value, 10);
      if (Number.isFinite(pageNumber)) scrollToPage(pageNumber);
    },
    addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow = false) {
      link.href = url;
      if (newWindow || /^https?:/i.test(url)) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    },
    getDestinationHash(dest: unknown) {
      return typeof dest === "string" ? `#${encodeURIComponent(dest)}` : "";
    },
    getAnchorUrl(hash: string) {
      return hash;
    },
    setHash(hash: string) {
      const pageMatch = hash.match(/page=(\d+)/i);
      if (pageMatch) this.goToPage(Number.parseInt(pageMatch[1], 10));
    },
    executeNamedAction(action: string) {
      if (action === "NextPage") scrollToPage(Math.min(doc.numPages, currentPage + 1));
      if (action === "PrevPage") scrollToPage(Math.max(1, currentPage - 1));
    },
    async executeSetOCGState(_action: object) {},
  };
}

interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function rectsOverlap(a: RectLike, b: RectLike): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
