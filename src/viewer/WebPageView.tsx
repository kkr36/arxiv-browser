import type { WebPageContent } from "../core/web/fetchWebPage";
import "./webPageView.css";

/**
 * In-app reader for a cited web page (a reference that links a site rather
 * than a paper). Shows the fetched page's readable text; sites that need
 * JavaScript to render fall back to the description plus the original link.
 */
export function WebPageView({ page }: { page: WebPageContent }) {
  return (
    <div className="webpage-view">
      <article className="webpage-article">
        <div className="webpage-source">
          <span>{page.siteName ?? hostnameOf(page.url)}</span>
          <a href={page.url} target="_blank" rel="noopener noreferrer">
            Open original ↗
          </a>
        </div>
        {page.title && <h1>{page.title}</h1>}
        {page.description && <p className="webpage-description">{page.description}</p>}
        {page.blocks.map((block, i) =>
          block.kind === "heading" ? (
            <h3 key={i}>{block.text}</h3>
          ) : (
            <p key={i}>{block.text}</p>
          ),
        )}
        {page.blocks.length === 0 && !page.description && (
          <p className="webpage-empty">
            No readable text could be extracted from this page (it may need JavaScript to
            render). Use “Open original” above.
          </p>
        )}
      </article>
    </div>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
