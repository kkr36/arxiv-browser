import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthorMarker, AuthorProfileRef } from "../core/types";
import "./citationsPanel.css";

interface AuthorsPanelProps {
  authors: AuthorProfileRef[];
  authorMarkersByPage: Map<number, AuthorMarker[]>;
  onOpenAuthor: (author: AuthorProfileRef) => void;
  onClose: () => void;
}

const WIDTH_KEY = "arxiv-browser:authors-panel-width";
const MIN_WIDTH = 240;

function initialWidth(): number {
  const stored = Number(localStorage.getItem(WIDTH_KEY));
  return stored >= MIN_WIDTH ? stored : 340;
}

export function AuthorsPanel({
  authors,
  authorMarkersByPage,
  onOpenAuthor,
  onClose,
}: AuthorsPanelProps) {
  const [width, setWidth] = useState(initialWidth);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    setExpanded(new Set());
  }, [authors]);

  const markerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const markers of authorMarkersByPage.values()) {
      for (const marker of markers) {
        const key = authorKey(marker.author);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  }, [authorMarkersByPage]);

  function handleResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    dragStart.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }

  function handleResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = dragStart.current;
    if (!start) return;
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

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
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
          Authors
          {authors.length > 0 && <span className="cites-panel-count"> · {authors.length}</span>}
        </span>
        <button onClick={onClose} title="Hide authors">
          ✕
        </button>
      </div>

      {authors.length === 0 ? (
        <div className="cites-empty">
          No author names were found for this PDF. Author extraction works best when metadata is
          available or names appear near the start of the paper.
        </div>
      ) : (
        <ol className="cites-list">
          {authors.map((author, index) => {
            const key = authorKey(author);
            const count = markerCounts.get(key) ?? 0;
            const detail = authorDetail(author);
            const isExpanded = expanded.has(key);
            return (
              <li key={`${key}:${index}`} className="cites-item">
                <div
                  className="cites-item-main"
                  onClick={() => toggleExpanded(key)}
                  title={isExpanded ? "Collapse" : "Show author details"}
                >
                  <span className="cites-item-label">{index + 1}.</span>
                  <span className={`cites-item-text${isExpanded ? " expanded" : ""}`}>
                    <strong>{author.name}</strong>
                    {detail && <span className="cites-item-detail"> {detail}</span>}
                  </span>
                </div>
                <div className="cites-item-side">
                  {count > 0 && (
                    <span className="cites-item-count" title={`Linked ${count}× in the text`}>
                      {count}×
                    </span>
                  )}
                  <button
                    className="cites-item-action"
                    onClick={() => onOpenAuthor(author)}
                    title="Open this author's works"
                  >
                    Open
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

function authorKey(author: AuthorProfileRef): string {
  return (
    author.semanticScholarAuthorId ??
    author.semanticScholarUrl ??
    author.googleScholarUrl ??
    author.name
  )
    .trim()
    .toLowerCase();
}

function authorDetail(author: AuthorProfileRef): string {
  if (author.semanticScholarAuthorId) return "Semantic Scholar";
  if (author.semanticScholarUrl) return "Semantic Scholar";
  if (author.googleScholarUrl) return "Google Scholar";
  return "";
}
