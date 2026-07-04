import type { PageText } from "../types";

export interface PageLine {
  page: number;
  text: string;
  x: number;
  y: number;
  start: number;
  end: number;
}

/**
 * Groups a page's text items into visual lines using pdf.js's own
 * end-of-line markers, which are far more reliable than clustering by
 * y-coordinate (and cheap, since pdf.js already computed them).
 */
export function buildPageLines(page: PageText): PageLine[] {
  const lines: PageLine[] = [];
  let start = -1;
  let x = 0;
  let y = 0;
  let text = "";

  for (const item of page.items) {
    if (start === -1) {
      start = item.start;
      x = item.x;
      y = item.y;
    }
    text += item.str;
    if (item.hasEOL) {
      lines.push({ page: page.pageNumber, text, x, y, start, end: start + text.length });
      start = -1;
      text = "";
    }
  }

  if (start !== -1) {
    lines.push({ page: page.pageNumber, text, x, y, start, end: start + text.length });
  }

  return lines;
}
