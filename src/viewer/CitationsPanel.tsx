import { useEffect, useMemo, useState } from "react";
import type { BibEntry, CitationMarker, ResolvedPaper } from "../core/types";
import { resolveEntry } from "../core/citationService";
import { guessTitle } from "../core/semanticScholar/client";
import { findPublicPdf, paperWithFoundPdf } from "../core/webPdfSearch";
import { useRightPanelResize } from "../useRightPanelResize";
import "./citationsPanel.css";

interface CitationsPanelProps {
  entries: BibEntry[];
  markersByPage: Map<number, CitationMarker[]>;
  onFindReferences: (entryIndex: number) => void;
  /** Same handler as clicking an in-text marker: open the resolved paper. */
  onOpenPaper: (paper: ResolvedPaper) => void;
  onClose: () => void;
}

const WIDTH_KEY = "arxiv-browser:citations-panel-width";

/** Per-entry click feedback; resolution itself is cached in citationService. */
type ItemStatus =
  | { kind: "resolving" }
  | { kind: "no-match" }
  | { kind: "no-pdf"; paper: ResolvedPaper }
  | { kind: "error"; message: string }
  | { kind: "searching"; paper?: ResolvedPaper | null }
  | { kind: "search-not-found"; paper?: ResolvedPaper | null }
  | { kind: "search-error"; message: string; paper?: ResolvedPaper | null };

export function CitationsPanel({
  entries,
  markersByPage,
  onFindReferences,
  onOpenPaper,
  onClose,
}: CitationsPanelProps) {
  const { width, resizeHandleRef } = useRightPanelResize(WIDTH_KEY, 340);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState<Map<number, ItemStatus>>(new Map());
  const [sortMode, setSortMode] = useState<CitationSortMode>("paper-order");

  // A new paper's entries arrive as a new array; drop the old paper's
  // expansion/resolution feedback rather than showing it against new items.
  useEffect(() => {
    setExpanded(new Set());
    setStatus(new Map());
  }, [entries]);

  const markerCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const markers of markersByPage.values()) {
      for (const m of markers) {
        for (const i of m.entryIndices) counts.set(i, (counts.get(i) ?? 0) + 1);
      }
    }
    return counts;
  }, [markersByPage]);

  const sortedEntries = useMemo(
    () => sortCitationEntries(entries, sortMode),
    [entries, sortMode],
  );

  function toggleExpanded(index: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function setItemStatus(index: number, s: ItemStatus | null) {
    setStatus((prev) => {
      const next = new Map(prev);
      if (s) next.set(index, s);
      else next.delete(index);
      return next;
    });
  }

  function handleOpen(index: number) {
    if (isBusy(status.get(index))) return;
    setItemStatus(index, { kind: "resolving" });
    resolveEntry(entries, index)
      .then((paper) => {
        if (!paper) {
          setItemStatus(index, { kind: "no-match" });
          return;
        }
        if (!paper.pdfUrl) {
          setItemStatus(index, { kind: "no-pdf", paper });
          return;
        }
        setItemStatus(index, null);
        onOpenPaper(paper);
      })
      .catch((err) => {
        setItemStatus(index, { kind: "error", message: (err as Error).message });
      });
  }

  function handleSearchPublicPdf(index: number, paper?: ResolvedPaper | null) {
    const entry = entries[index];
    if (!entry) return;
    const title = paper?.title ?? guessTitle(entry.rawText) ?? undefined;
    const fallbackTitle = title ?? entry.rawText.slice(0, 120);

    setItemStatus(index, { kind: "searching", paper });
    findPublicPdf({ title, rawText: entry.rawText })
      .then((result) => {
        if (!result) {
          setItemStatus(index, { kind: "search-not-found", paper });
          return;
        }
        setItemStatus(index, null);
        onOpenPaper(paperWithFoundPdf(paper, result, fallbackTitle));
      })
      .catch((err) => {
        setItemStatus(index, {
          kind: "search-error",
          message: (err as Error).message,
          paper,
        });
      });
  }

  function openPaperPage(paper: ResolvedPaper) {
    const pageUrl = paper.pageUrl ?? paper.semanticScholarUrl;
    if (pageUrl) window.open(pageUrl, "_blank", "noopener");
  }

  return (
    <aside className="cites-panel" style={{ width }}>
      <div
        ref={resizeHandleRef}
        className="cites-resizer"
        title="Drag to resize"
      />
      <div className="cites-panel-header">
        <span className="cites-panel-title">
          Citations
          {entries.length > 0 && <span className="cites-panel-count"> · {entries.length}</span>}
        </span>
        <select
          className="cites-sort"
          value={sortMode}
          onChange={(e) => setSortMode(e.currentTarget.value as CitationSortMode)}
          title="Sort citations"
        >
          <option value="paper-order">Paper order</option>
          <option value="year-asc">Year ↑</option>
          <option value="year-desc">Year ↓</option>
          <option value="alpha">A-Z</option>
        </select>
        <button onClick={onClose} title="Hide citations">
          ✕
        </button>
      </div>

      {entries.length === 0 ? (
        <div className="cites-empty">
          No reference entries were parsed from this PDF. The bibliography splitter is heuristic —
          unusual reference-list layouts can defeat it.
        </div>
      ) : (
        <ol className="cites-list">
          {sortedEntries.map((entry) => {
            const count = markerCounts.get(entry.index) ?? 0;
            const isExpanded = expanded.has(entry.index);
            const itemStatus = status.get(entry.index);
            return (
              <li key={entry.index} className="cites-item">
                <div
                  className="cites-item-main"
                  onClick={() => toggleExpanded(entry.index)}
                  title={isExpanded ? "Collapse" : "Show full reference"}
                >
                  <span className="cites-item-label">{entryLabel(entry)}</span>
                  <span className={`cites-item-text${isExpanded ? " expanded" : ""}`}>
                    {entry.rawText}
                  </span>
                </div>
                <div className="cites-item-side">
                  {count > 0 && (
                    <span className="cites-item-count" title={`Cited ${count}× in the text`}>
                      {count}×
                    </span>
                  )}
                  <button
                    className="cites-item-action"
                    onClick={() => onFindReferences(entry.index)}
                    disabled={count === 0}
                    title={
                      count > 0
                        ? "Find all in-text citations for this reference"
                        : "No in-text citations matched this reference"
                    }
                  >
                    Find
                  </button>
                  <button
                    className="cites-item-action"
                    onClick={() => handleOpen(entry.index)}
                    disabled={isBusy(itemStatus)}
                    title="Open this paper's PDF"
                  >
                    {isBusy(itemStatus) ? "..." : "PDF"}
                  </button>
                </div>
                {itemStatus?.kind === "no-match" && (
                  <div className="cites-item-status">
                    No API match found.
                    <button type="button" onClick={() => handleSearchPublicPdf(entry.index)}>
                      Search web
                    </button>
                  </div>
                )}
                {itemStatus?.kind === "no-pdf" && (
                  <div className="cites-item-status">
                    No open-access PDF found.
                    {(itemStatus.paper.pageUrl ?? itemStatus.paper.semanticScholarUrl) && (
                      <button type="button" onClick={() => openPaperPage(itemStatus.paper)}>
                        Open page
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleSearchPublicPdf(entry.index, itemStatus.paper)}
                    >
                      Search web
                    </button>
                  </div>
                )}
                {itemStatus?.kind === "error" && (
                  <div className="cites-item-status">
                    {itemStatus.message}
                    <button type="button" onClick={() => handleSearchPublicPdf(entry.index)}>
                      Search web
                    </button>
                  </div>
                )}
                {itemStatus?.kind === "searching" && (
                  <div className="cites-item-status neutral">Searching the web for a PDF...</div>
                )}
                {itemStatus?.kind === "search-not-found" && (
                  <div className="cites-item-status">
                    No public PDF found.
                    {itemStatus.paper &&
                      (itemStatus.paper.pageUrl ?? itemStatus.paper.semanticScholarUrl) && (
                        <button
                          type="button"
                          onClick={() => {
                            if (itemStatus.paper) openPaperPage(itemStatus.paper);
                          }}
                        >
                          Open page
                        </button>
                      )}
                  </div>
                )}
                {itemStatus?.kind === "search-error" && (
                  <div className="cites-item-status">
                    {itemStatus.message}
                    <button
                      type="button"
                      onClick={() => handleSearchPublicPdf(entry.index, itemStatus.paper)}
                    >
                      Try again
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

type CitationSortMode = "paper-order" | "year-asc" | "year-desc" | "alpha";

function sortCitationEntries(entries: BibEntry[], mode: CitationSortMode): BibEntry[] {
  const sorted = [...entries];
  if (mode === "paper-order") return sorted.sort((a, b) => a.index - b.index);
  if (mode === "alpha") {
    return sorted.sort((a, b) => normalizedTitle(a).localeCompare(normalizedTitle(b)));
  }
  return sorted.sort((a, b) => {
    const fallback = mode === "year-asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    const ay = citationYear(a) ?? fallback;
    const by = citationYear(b) ?? fallback;
    return mode === "year-asc"
      ? ay - by || a.index - b.index
      : by - ay || a.index - b.index;
  });
}

function citationYear(entry: BibEntry): number | null {
  const keyed = entry.authorYearKey?.year;
  if (keyed && /^\d{4}$/.test(keyed)) return Number(keyed);
  const matches = [...entry.rawText.matchAll(/\b(19|20)\d{2}\b/g)];
  const years = matches.map((m) => Number(m[0])).filter((year) => year >= 1900 && year <= 2099);
  return years.length ? Math.max(...years) : null;
}

function normalizedTitle(entry: BibEntry): string {
  return entry.rawText
    .replace(/^\s*(\[\d+\]|\d+\.|\([A-Za-z][^)]+,\s*\d{4}\))\s*/, "")
    .toLowerCase();
}

/** Short handle for an entry: its bibliography number, its author-year key,
 * or its 1-based position when the list is unnumbered and unkeyed. */
function entryLabel(entry: BibEntry): string {
  if (entry.number !== undefined) return `[${entry.number}]`;
  if (entry.citationKey) return `[${entry.citationKey}]`;
  if (entry.authorYearKey) return `${entry.authorYearKey.surname} ${entry.authorYearKey.year}`;
  return `${entry.index + 1}.`;
}

function isBusy(status: ItemStatus | undefined): boolean {
  return status?.kind === "resolving" || status?.kind === "searching";
}
