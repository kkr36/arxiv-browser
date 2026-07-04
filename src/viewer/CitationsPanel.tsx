import { useEffect, useMemo, useRef, useState } from "react";
import type { BibEntry, CitationMarker, ResolvedPaper } from "../core/types";
import { resolveEntry } from "../core/citationService";
import "./citationsPanel.css";

interface CitationsPanelProps {
  entries: BibEntry[];
  markersByPage: Map<number, CitationMarker[]>;
  /** Same handler as clicking an in-text marker: open the resolved paper. */
  onOpenPaper: (paper: ResolvedPaper) => void;
  onClose: () => void;
}

const WIDTH_KEY = "arxiv-browser:citations-panel-width";
const MIN_WIDTH = 240;

function initialWidth(): number {
  const stored = Number(localStorage.getItem(WIDTH_KEY));
  return stored >= MIN_WIDTH ? stored : 340;
}

/** Per-entry click feedback; resolution itself is cached in citationService. */
type ItemStatus = { kind: "resolving" } | { kind: "no-match" } | { kind: "error"; message: string };

export function CitationsPanel({ entries, markersByPage, onOpenPaper, onClose }: CitationsPanelProps) {
  const [width, setWidth] = useState(initialWidth);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState<Map<number, ItemStatus>>(new Map());
  const dragStart = useRef<{ x: number; width: number } | null>(null);

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

  function handleResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    dragStart.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function handleResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = dragStart.current;
    if (!start) return;
    // The panel sits at the right side, so dragging left grows it.
    const next = Math.min(
      Math.max(MIN_WIDTH, start.width + (start.x - e.clientX)),
      Math.round(window.innerWidth * 0.85),
    );
    setWidth(next);
  }

  function handleResizeEnd() {
    if (!dragStart.current) return;
    dragStart.current = null;
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // persistence is a nice-to-have
    }
  }

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
    if (status.get(index)?.kind === "resolving") return;
    setItemStatus(index, { kind: "resolving" });
    resolveEntry(entries, index)
      .then((paper) => {
        if (!paper) {
          setItemStatus(index, { kind: "no-match" });
          return;
        }
        setItemStatus(index, null);
        onOpenPaper(paper);
      })
      .catch((err) => {
        setItemStatus(index, { kind: "error", message: (err as Error).message });
      });
  }

  return (
    <aside className="cites-panel" style={{ width }}>
      <div
        className="cites-resizer"
        title="Drag to resize"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      <div className="cites-panel-header">
        <span className="cites-panel-title">
          Citations
          {entries.length > 0 && <span className="cites-panel-count"> · {entries.length}</span>}
        </span>
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
          {entries.map((entry) => {
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
                    className="cites-item-open"
                    onClick={() => handleOpen(entry.index)}
                    disabled={itemStatus?.kind === "resolving"}
                    title="Open this paper"
                  >
                    {itemStatus?.kind === "resolving" ? "…" : "↗"}
                  </button>
                </div>
                {itemStatus?.kind === "no-match" && (
                  <div className="cites-item-status">No match found for this reference.</div>
                )}
                {itemStatus?.kind === "error" && (
                  <div className="cites-item-status">{itemStatus.message}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

/** Short handle for an entry: its bibliography number, its author-year key,
 * or its 1-based position when the list is unnumbered and unkeyed. */
function entryLabel(entry: BibEntry): string {
  if (entry.number !== undefined) return `[${entry.number}]`;
  if (entry.authorYearKey) return `${entry.authorYearKey.surname} ${entry.authorYearKey.year}`;
  return `${entry.index + 1}.`;
}
