export interface PageTextItem {
  str: string;
  start: number;
  end: number;
  x: number;
  y: number;
  /** Font size in page units (the text matrix's vertical scale). Lets callers
   * tell a large title line from smaller author/body lines. */
  fontSize: number;
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
  citationKey?: string;
  authorYearKey?: { surname: string; year: string };
  rawText: string;
}

/**
 * The citation scheme a paper uses, inferred from how its bibliography entries
 * are labelled. Governs which in-text marker forms are worth detecting.
 *  - "numbered": `[12]`, `[3, 4]`, `[5-7]` (and "Author et al. [12]").
 *  - "alpha": bracketed keys like `[GBC16]`.
 *  - "author-year": `(Smith, 2020)`, `[Smith et al., 2020]`, `Smith (2020)`.
 */
export type CitationStyle = "numbered" | "alpha" | "author-year";

export interface CitationMarker {
  id: string;
  page: number;
  start: number;
  end: number;
  raw: string;
  refNumbers?: number[];
  citationKeys?: string[];
  /** One per cited work — multi-cites like "(A, 2019; B, 2020)" carry several. */
  authorYears?: { surname: string; year: string }[];
  entryIndices: number[];
}

export interface AuthorProfileRef {
  name: string;
  semanticScholarAuthorId?: string;
  semanticScholarUrl?: string;
  googleScholarUrl?: string;
}

export interface AuthorMarker {
  id: string;
  page: number;
  start: number;
  end: number;
  raw: string;
  author: AuthorProfileRef;
}

export interface AuthorWork {
  title: string;
  authors?: string[];
  year?: number;
  venue?: string;
  abstract?: string;
  pdfUrl?: string;
  semanticScholarUrl?: string;
  rawText?: string;
}

export interface ResolvedAuthorPage {
  id: string;
  name: string;
  source: "google-scholar" | "semantic-scholar";
  url?: string;
  googleScholarUrl?: string;
  semanticScholarUrl?: string;
  homepage?: string;
  paperCount?: number;
  citationCount?: number;
  hIndex?: number;
  works: AuthorWork[];
}

export interface ResolvedPaper {
  title: string;
  abstract?: string;
  authors: string[];
  authorProfiles?: AuthorProfileRef[];
  year?: number;
  venue?: string;
  pdfUrl?: string;
  semanticScholarUrl?: string;
  source: "direct-pdf" | "arxiv" | "semantic-scholar-page" | "none";
}
