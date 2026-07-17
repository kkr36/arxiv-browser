import type { ExplorationGraph } from "../graph/explorationGraph";
import { buildSessionExport, type SessionExportNode } from "./sessionExport";

/**
 * Renders the exploration graph as a self-contained HTML reading list: one
 * entry per paper (trail order — roots first, each subtree as it was
 * explored) with title, full author list, venue/year, the user's note, and
 * links to the work. Embeds the session payload, so the file also works with
 * "Resume session".
 */
export function buildReadingListHtml(graph: ExplorationGraph, now: Date = new Date()): string {
  const session = buildSessionExport(graph, undefined, now);
  const papers = session.nodes.filter((n) => n.kind !== "author");

  const items = papers
    .map((n) => {
      const title = titleUrl(n)
        ? `<a class="title" href="${esc(titleUrl(n)!)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>`
        : `<span class="title">${esc(n.title)}</span>`;
      const authors = n.authors?.length
        ? `<div class="authors">${esc(n.authors.join(", "))}</div>`
        : "";
      const meta = [n.year ? String(n.year) : "", n.venue ?? ""].filter(Boolean).join(" · ");
      const metaHtml = meta ? `<div class="meta">${esc(meta)}</div>` : "";
      const note = n.note ? `<div class="note">${esc(n.note)}</div>` : "";
      const links = linkRow(n);
      return `<li>${title}${authors}${metaHtml}${note}${links}</li>`;
    })
    .join("\n");

  const sessionJson = JSON.stringify({
    schema: "arxiv-browser-session",
    version: 1,
    session,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Reading list — ${esc(session.exportedAt)}</title>
<style>
  :root {
    --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --accent: #2a78d6; --note: #8a6410; --hairline: rgba(11, 11, 11, 0.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #16161a; --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --accent: #7ab8ff; --note: #e8c268; --hairline: rgba(255, 255, 255, 0.12);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; max-width: 760px; padding: 32px 24px 64px;
    background: var(--surface); color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5;
  }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header p { margin: 0 0 8px; font-size: 13px; color: var(--ink-2); }
  ol { margin: 24px 0 0; padding-left: 28px; }
  li { padding: 10px 0 12px; border-bottom: 1px solid var(--hairline); }
  li::marker { color: var(--muted); font-size: 13px; }
  .title { font-size: 15px; font-weight: 600; color: var(--ink); text-decoration: none; }
  a.title { color: var(--accent); }
  a.title:hover { text-decoration: underline; }
  .authors { font-size: 13px; color: var(--ink-2); margin-top: 2px; }
  .meta { font-size: 12.5px; color: var(--muted); margin-top: 1px; }
  .note { font-size: 13px; color: var(--note); font-style: italic; margin-top: 4px; white-space: pre-wrap; }
  .links { margin-top: 4px; font-size: 12.5px; }
  .links a { color: var(--accent); text-decoration: none; margin-right: 12px; }
  .links a:hover { text-decoration: underline; }
</style>
</head>
<body>
<header>
  <h1>Reading list</h1>
  <p>Exported ${esc(session.exportedAt)} from arxiv-browser · ${papers.length} paper${papers.length === 1 ? "" : "s"}</p>
</header>
<ol>
${items}
</ol>
<script id="arxiv-browser-session" type="application/json">${sessionJson}</script>
</body>
</html>
`;
}

/** Best clickable URL for the entry title (data: PDF uploads are not linkable). */
function titleUrl(n: SessionExportNode): string | undefined {
  return (
    httpUrl(n.links.custom) ??
    httpUrl(n.links.pdfUrl) ??
    httpUrl(n.links.semanticScholarUrl) ??
    httpUrl(n.links.googleScholarUrl) ??
    httpUrl(n.links.homepage)
  );
}

function linkRow(n: SessionExportNode): string {
  const links: string[] = [];
  const custom = httpUrl(n.links.custom);
  const pdf = httpUrl(n.links.pdfUrl);
  if (custom && custom !== pdf) links.push(anchor(custom, "Link"));
  if (pdf) links.push(anchor(pdf, "PDF"));
  if (httpUrl(n.links.semanticScholarUrl)) links.push(anchor(n.links.semanticScholarUrl!, "Paper page"));
  if (httpUrl(n.links.googleScholarUrl)) links.push(anchor(n.links.googleScholarUrl!, "Google Scholar"));
  return links.length ? `<div class="links">${links.join("")}</div>` : "";
}

function anchor(url: string, label: string): string {
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function httpUrl(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
