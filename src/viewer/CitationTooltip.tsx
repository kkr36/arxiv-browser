import type { BibEntry, ResolvedPaper } from "../core/types";

interface CitationTooltipProps {
  x: number;
  y: number;
  status: "loading" | "ready" | "error";
  paper?: ResolvedPaper | null;
  entry?: BibEntry;
  /** Transient failure detail (e.g. rate limiting) — hovering again retries. */
  errorMessage?: string;
  pdfSearchStatus?: "idle" | "searching" | "not-found" | "error";
  pdfSearchMessage?: string;
  onSearchPdf?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export function CitationTooltip({
  x,
  y,
  status,
  paper,
  entry,
  errorMessage,
  pdfSearchStatus = "idle",
  pdfSearchMessage,
  onSearchPdf,
  onMouseEnter,
  onMouseLeave,
}: CitationTooltipProps) {
  const left = Math.min(x, window.innerWidth - 340);
  const top = Math.min(y + 6, window.innerHeight - 180);
  const canSearchPdf = !!onSearchPdf && (status === "error" || (status === "ready" && !!paper && !paper.pdfUrl));

  return (
    <div
      className="citation-tooltip"
      style={{ left, top }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {status === "loading" && <div className="citation-tooltip-loading">Looking up citation…</div>}

      {status === "error" && (
        <div>
          <div className="citation-tooltip-title">
            {errorMessage ?? "Couldn't resolve this citation"}
          </div>
          {entry && <div className="citation-tooltip-raw">{entry.rawText}</div>}
        </div>
      )}

      {status === "ready" && paper && (
        <div>
          <div className="citation-tooltip-title">{paper.title}</div>
          <div className="citation-tooltip-meta">
            {paper.authors.slice(0, 4).join(", ")}
            {paper.authors.length > 4 ? ", et al." : ""}
            {paper.year ? ` · ${paper.year}` : ""}
            {paper.venue ? ` · ${paper.venue}` : ""}
          </div>
          {paper.abstract && <div className="citation-tooltip-abstract">{paper.abstract}</div>}
          <div className="citation-tooltip-footer">
            {paper.pdfUrl ? "Click to open here" : "Click to open the paper page"}
          </div>
        </div>
      )}

      {canSearchPdf && (
        <div className="citation-tooltip-actions">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSearchPdf();
            }}
            disabled={pdfSearchStatus === "searching"}
          >
            {pdfSearchStatus === "searching" ? "Searching..." : "Search web for PDF"}
          </button>
          {pdfSearchStatus === "not-found" && (
            <div className="citation-tooltip-search-status">No public PDF found.</div>
          )}
          {pdfSearchStatus === "error" && (
            <div className="citation-tooltip-search-status">
              {pdfSearchMessage ?? "PDF search failed."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
