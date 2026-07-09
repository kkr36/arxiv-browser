import { useState } from "react";
import { paperFromAuthorWork } from "../core/authors/resolveAuthor";
import { findPublicPdf, paperWithFoundPdf } from "../core/webPdfSearch";
import type { AuthorWork, ResolvedAuthorPage, ResolvedPaper } from "../core/types";
import "./authorPageView.css";

interface AuthorPageViewProps {
  author: ResolvedAuthorPage;
  onOpenPaper: (paper: ResolvedPaper) => void;
}

type WorkStatus =
  | { kind: "searching" }
  | { kind: "not-found" }
  | { kind: "error"; message: string };

export function AuthorPageView({ author, onOpenPaper }: AuthorPageViewProps) {
  const [status, setStatus] = useState<Map<number, WorkStatus>>(new Map());

  function setWorkStatus(index: number, next: WorkStatus | null) {
    setStatus((prev) => {
      const copy = new Map(prev);
      if (next) copy.set(index, next);
      else copy.delete(index);
      return copy;
    });
  }

  function handleOpenWork(index: number, work: AuthorWork) {
    if (!work.pdfUrl && !work.pageUrl && !work.semanticScholarUrl) {
      handleSearchPdf(index, work);
      return;
    }
    onOpenPaper(paperFromAuthorWork(work));
  }

  function handleSearchPdf(index: number, work: AuthorWork) {
    setWorkStatus(index, { kind: "searching" });
    findPublicPdf({
      title: work.title,
      rawText: work.rawText ?? [work.authors?.join(", "), work.title, work.venue, work.year]
        .filter(Boolean)
        .join(". "),
    })
      .then((result) => {
        if (!result) {
          setWorkStatus(index, { kind: "not-found" });
          return;
        }
        setWorkStatus(index, null);
        onOpenPaper(paperWithFoundPdf(paperFromAuthorWork(work), result, work.title));
      })
      .catch((err) => setWorkStatus(index, { kind: "error", message: (err as Error).message }));
  }

  const meta = [
    author.paperCount !== undefined ? `${author.paperCount} papers` : "",
    author.citationCount !== undefined ? `${author.citationCount} citations` : "",
    author.hIndex !== undefined ? `h-index ${author.hIndex}` : "",
    author.source === "google-scholar"
      ? "Google Scholar"
      : author.source === "openalex"
        ? "OpenAlex"
        : "Semantic Scholar",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="author-page-scroll">
      <main className="author-page">
        <header className="author-page-header">
          <div>
            <h2>{author.name}</h2>
            {meta && <div className="author-page-meta">{meta}</div>}
          </div>
          <div className="author-page-links">
            {author.googleScholarUrl && (
              <a href={author.googleScholarUrl} target="_blank" rel="noopener noreferrer">
                Google Scholar
              </a>
            )}
            {author.openAlexUrl && (
              <a href={author.openAlexUrl} target="_blank" rel="noopener noreferrer">
                OpenAlex
              </a>
            )}
            {author.semanticScholarUrl && (
              <a href={author.semanticScholarUrl} target="_blank" rel="noopener noreferrer">
                Semantic Scholar
              </a>
            )}
            {author.homepage && (
              <a href={author.homepage} target="_blank" rel="noopener noreferrer">
                Homepage
              </a>
            )}
          </div>
        </header>

        {author.works.length === 0 ? (
          <div className="author-page-empty">No works were found for this author profile.</div>
        ) : (
          <ol className="author-works">
            {author.works.map((work, index) => {
              const itemStatus = status.get(index);
              return (
                <li key={`${work.title}:${index}`} className="author-work">
                  <button className="author-work-main" onClick={() => handleOpenWork(index, work)}>
                    <span className="author-work-title">{work.title}</span>
                    <span className="author-work-meta">{workMeta(work)}</span>
                  </button>
                  <div className="author-work-actions">
                    <button onClick={() => handleOpenWork(index, work)}>
                      {work.pdfUrl
                        ? "Open PDF"
                        : work.pageUrl ?? work.semanticScholarUrl
                          ? "Open page"
                          : "Find PDF"}
                    </button>
                    {!work.pdfUrl && (
                      <button
                        onClick={() => handleSearchPdf(index, work)}
                        disabled={itemStatus?.kind === "searching"}
                      >
                        {itemStatus?.kind === "searching" ? "Searching..." : "Search PDF"}
                      </button>
                    )}
                  </div>
                  {itemStatus?.kind === "not-found" && (
                    <div className="author-work-status">No public PDF found.</div>
                  )}
                  {itemStatus?.kind === "error" && (
                    <div className="author-work-status">{itemStatus.message}</div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </main>
    </div>
  );
}

function workMeta(work: AuthorWork): string {
  const authors = work.authors?.slice(0, 5).join(", ") ?? "";
  return [
    authors + ((work.authors?.length ?? 0) > 5 ? ", et al." : ""),
    work.year ? String(work.year) : "",
    work.venue ?? "",
    work.pdfUrl ? "PDF available" : work.pageUrl ?? work.semanticScholarUrl ? "page only" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
