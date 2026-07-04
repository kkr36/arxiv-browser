export interface PageTextItem {
  str: string;
  start: number;
  end: number;
  x: number;
  y: number;
  hasEOL: boolean;
}

export interface PageText {
  pageNumber: number;
  text: string;
  items: PageTextItem[];
  /** The pdf.js TextContent these items were built from, kept so the viewer
   * can feed its TextLayer without re-parsing the page. Type-only coupling —
   * consumers cast it back via pdfjs' own types. */
  textContent?: unknown;
}

export interface BibEntry {
  index: number;
  number?: number;
  authorYearKey?: { surname: string; year: string };
  rawText: string;
}

export interface CitationMarker {
  id: string;
  page: number;
  start: number;
  end: number;
  raw: string;
  refNumbers?: number[];
  /** One per cited work — multi-cites like "(A, 2019; B, 2020)" carry several. */
  authorYears?: { surname: string; year: string }[];
  entryIndices: number[];
}

export interface ResolvedPaper {
  title: string;
  abstract?: string;
  authors: string[];
  year?: number;
  venue?: string;
  pdfUrl?: string;
  semanticScholarUrl?: string;
  source: "direct-pdf" | "arxiv" | "semantic-scholar-page" | "none";
}
