import { buildPageLines, type PageLine } from "../pdf/buildLines";
import type { BibEntry, CitationStyle, PageText } from "../types";

// Compared against the line with whitespace/periods stripped, so letter-spaced
// small-caps headings ("R E F E R E N C E S") and "7. References" both match.
const COMPACT_HEADING_RE = /^\d{0,2}(references|bibliography)$/;
const STOP_RE = /^([A-Z0-9]{1,3}[.\s:]+)?(appendix|acknowledg(e)?ments?|supplementary material)\b/i;
// ACL-style appendices often start as "A Human Evaluation" rather than with
// the word "Appendix". Stop there so appendix list items cannot masquerade as
// bracket-key bibliography entries.
const APPENDIX_LETTER_HEADING_RE =
  /^[A-Z](?:\.\d+)*\.?\s+[\p{Lu}0-9][\p{L}\p{M}0-9 "'’‘,:;()/-]{2,80}$/u;
const YEAR_RE = /\b(?:19|20)\d{2}[a-z]?\b/;
const RUNNING_HEADER_RE = /^published as\s+/i;
const BRACKET_NUMBER_RE = /^\[(\d+)\]\s*/;
const BRACKET_LABEL_RE = /^\[([A-Za-z][A-Za-z0-9+_.:-]{1,24})\]\s*/;
const DOTTED_NUMBER_RE = /^(\d{1,3})\.\s+(?=[A-Z(])/;
// A reference's opening author, written either surname-first ("Devlin, J.",
// "Ben-Porat, O.") or initials-first ("C. Toups", "K. A. Creel", "R. H.
// Thaler"). Both are needed: a single-line entry sitting at the same left
// margin as the next entry gives the hanging-indent geometry nothing to split
// on, so this explicit author-start is the only signal separating them.
const AUTHOR_YEAR_ENTRY_RE = new RegExp(
  String.raw`^(?:` +
    // surname-first: "Surname, I. ..."
    String.raw`[\p{Lu}][\p{L}\p{M}'’-]+,\s*(?:[\p{Lu}]\.[\s-]*)+` +
    String.raw`|` +
    // initials-first: "I. Surname" / "I. J. Surname"
    String.raw`(?:[\p{Lu}]\.[\s-]*){1,4}[\p{Lu}][\p{L}\p{M}'’-]+` +
    String.raw`)`,
  "u",
);

export interface BibliographyParseResult {
  entries: BibEntry[];
  /** Citation scheme inferred from how the entries are labelled. */
  style: CitationStyle;
  headingPage: number;
  headingStart: number;
  /** Page/offset of the line that ends the bibliography (appendix or
   * acknowledgments heading), or null when it runs to the end of the doc. */
  endPage: number | null;
  endOffset: number | null;
}

/**
 * Locates the References/Bibliography section and splits it into individual
 * entries. Entries are detected primarily by hanging-indent (a line whose
 * left edge outdents relative to the previous line starts a new entry),
 * with numbered-bracket/dotted prefixes as a higher-confidence override.
 * Column and page breaks are excluded from the indent comparison since a
 * two-column layout's column jump looks like an outdent otherwise.
 */
export function parseBibliography(pages: PageText[]): BibliographyParseResult | null {
  const allLines = pages.flatMap(buildPageLines);

  const headingIdx = allLines.findIndex((l) =>
    COMPACT_HEADING_RE.test(l.text.replace(/[\s.]+/g, "").toLowerCase()),
  );
  if (headingIdx === -1) return null;
  const heading = allLines[headingIdx];

  let stopIdx = allLines.length;
  for (let i = headingIdx + 1; i < allLines.length; i++) {
    if (isBibliographyStopLine(allLines[i], allLines)) {
      stopIdx = i;
      break;
    }
  }
  const stopLine = stopIdx < allLines.length ? allLines[stopIdx] : null;

  const bibLines = allLines
    .slice(headingIdx + 1, stopIdx)
    .filter((l) => l.text.trim().length > 0)
    // Bare page numbers between entries would otherwise be glued into
    // whichever entry spans the page break.
    .filter((l) => !/^\d{1,4}$/.test(l.text.trim()))
    // Repeated conference/journal running heads can appear inside the
    // extracted reference stream at page breaks.
    .filter((l) => !RUNNING_HEADER_RE.test(l.text.trim()));
  if (bibLines.length === 0) return null;

  const groups = groupLinesIntoEntries(bibLines, hasHangingIndent(bibLines));
  const numberedGroups = groups.filter(groupStartsWithNumber);
  // In numbered bibliographies, any unnumbered groups after the final entry
  // are almost always later sections/captions that follow the references.
  const referenceGroups =
    groups[0] && groupStartsWithNumber(groups[0]) && numberedGroups.length >= 2
      ? numberedGroups
      : groups;

  const entries: BibEntry[] = referenceGroups
    .map((lines, index) => buildEntry(lines, index))
    .filter((e) => e.rawText.length > 8)
    .map((entry, index) => ({ ...entry, index }));

  return {
    entries,
    style: inferCitationStyle(entries),
    headingPage: heading.page,
    headingStart: heading.start,
    endPage: stopLine?.page ?? null,
    endOffset: stopLine?.start ?? null,
  };
}

/**
 * The scheme most entries are labelled with. In-text markers follow the same
 * scheme, so this lets the detector run only the marker forms that can appear.
 */
function inferCitationStyle(entries: BibEntry[]): CitationStyle {
  if (entries.length === 0) return "author-year";
  const numbered = entries.filter((e) => e.number !== undefined).length;
  const keyed = entries.filter((e) => e.citationKey !== undefined).length;
  if (numbered >= entries.length * 0.6) return "numbered";
  if (keyed >= entries.length * 0.6) return "alpha";
  return "author-year";
}

/**
 * Whether the bibliography uses a hanging indent (entry starts flush at the
 * column edge, continuation lines indented). When it does, "a line at the
 * column edge starts an entry" — which separates two single-line entries at the
 * same margin that the outdent-vs-previous rule would otherwise merge.
 */
function hasHangingIndent(lines: PageLine[]): boolean {
  let indented = 0;
  for (const line of lines) if (!isAtColumnStart(line, lines)) indented++;
  return indented >= 2;
}

function isBibliographyStopLine(line: PageLine, lines: PageLine[]): boolean {
  const text = line.text.trim();
  if (STOP_RE.test(text)) return true;
  return (
    APPENDIX_LETTER_HEADING_RE.test(text) &&
    !YEAR_RE.test(text) &&
    isAtColumnStart(line, lines)
  );
}

function groupStartsWithNumber(lines: PageLine[]): boolean {
  const first = lines[0]?.text.trim() ?? "";
  return BRACKET_NUMBER_RE.test(first) || BRACKET_LABEL_RE.test(first) || DOTTED_NUMBER_RE.test(first);
}

const COLUMN_X_JUMP = 100;
const COLUMN_Y_JUMP = 150;
const OUTDENT_EPS = 3;

function isBreakBetween(a: PageLine, b: PageLine): boolean {
  return (
    b.page !== a.page || b.y > a.y + COLUMN_Y_JUMP || Math.abs(b.x - a.x) > COLUMN_X_JUMP
  );
}

function groupLinesIntoEntries(lines: PageLine[], hangingIndent: boolean): PageLine[][] {
  const groups: PageLine[][] = [];
  let current: PageLine[] = [];
  let prev: PageLine | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.text.trim();
    const continuesHyphenatedWord = !!prev?.text.trim().endsWith("-");
    const continuesOpenAuthorList =
      !!prev && !isBreakBetween(prev, line) && /(?:[,;:]|[-–])$/.test(prev.text.trim());
    const explicitNumberedStart =
      !continuesHyphenatedWord &&
      (BRACKET_NUMBER_RE.test(trimmed) ||
        BRACKET_LABEL_RE.test(trimmed) ||
        DOTTED_NUMBER_RE.test(trimmed));
    const explicitAuthorYearStart =
      !continuesHyphenatedWord &&
      !continuesOpenAuthorList &&
      AUTHOR_YEAR_ENTRY_RE.test(trimmed) &&
      isAtColumnStart(line, lines);

    let isNewEntry: boolean;
    if (explicitNumberedStart || explicitAuthorYearStart) {
      isNewEntry = true;
    } else if (!prev) {
      isNewEntry = true;
    } else if (!isBreakBetween(prev, line)) {
      // With a hanging indent, continuation lines are always indented, so any
      // line back at the column edge begins a new entry — this splits adjacent
      // single-line entries at the same margin. Otherwise fall back to a plain
      // outdent relative to the previous line.
      isNewEntry =
        hangingIndent && !continuesHyphenatedWord && !continuesOpenAuthorList
          ? isAtColumnStart(line, lines)
          : line.x < prev.x - OUTDENT_EPS;
    } else {
      // The indent comparison is meaningless across a column/page break, so
      // peek ahead instead: a hanging-indent entry starts flush left with its
      // continuation indented, so a following line that indents relative to
      // this one marks this line as an entry start (not a continuation of the
      // entry left hanging in the previous column).
      const next = lines[i + 1];
      isNewEntry = !!next && !isBreakBetween(line, next) && next.x > line.x + OUTDENT_EPS;
    }

    if (isNewEntry && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(line);
    prev = line;
  }
  if (current.length > 0) groups.push(current);

  return groups;
}

function isAtColumnStart(line: PageLine, lines: PageLine[]): boolean {
  const columnStart = Math.min(
    ...lines
      .filter((candidate) => {
        return (
          candidate.page === line.page &&
          Math.abs(candidate.x - line.x) < COLUMN_X_JUMP
        );
      })
      .map((candidate) => candidate.x),
  );
  return line.x <= columnStart + OUTDENT_EPS;
}

function buildEntry(lines: PageLine[], index: number): BibEntry {
  const rawJoined = lines
    .map((l) => l.text.trim())
    .join(" ")
    .replace(/-\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const bracketMatch = rawJoined.match(/^\[(\d+)\]\s*/);
  const labelMatch = !bracketMatch ? rawJoined.match(BRACKET_LABEL_RE) : null;
  const dottedMatch =
    !bracketMatch && !labelMatch ? rawJoined.match(/^(\d{1,3})\.\s+/) : null;
  const number = bracketMatch
    ? Number(bracketMatch[1])
    : dottedMatch
      ? Number(dottedMatch[1])
      : undefined;
  const citationKey = labelMatch?.[1];

  const rawText = rawJoined
    .replace(/^\[(?:\d+|[A-Za-z][A-Za-z0-9+_.:-]{1,24})\]\s*/, "")
    .replace(/^\d{1,3}\.\s+/, "");

  return {
    index,
    number,
    citationKey,
    authorYearKey: extractAuthorYearKey(rawText),
    rawText,
  };
}

export function extractAuthorYearKey(text: string): { surname: string; year: string } | undefined {
  const year = extractPublicationYear(text);
  if (!year) return undefined;
  // In-text markers cite the first author's SURNAME, which is the last word
  // of the first author however the list is written: "Alan Akbik, Duncan
  // Blythe…" → Akbik; "Devlin, J." → Devlin; "J. K. Smith and B. Jones" →
  // Smith. Cut the author sentence, take the first author (up to a comma or
  // "and"), then its last capitalized word of 2+ letters (skips initials).
  // Unicode letter classes keep accented surnames whole ("Brückner", not "Br").
  const authorSentence = text.split(/(?<=[\p{Ll})])\.\s+/u)[0];
  const firstAuthor = authorSentence.split(/,|\band\b|&/)[0];
  const capWords = firstAuthor.match(/\p{Lu}[\p{L}\p{M}'’-]*/gu);
  const surname = capWords?.[capWords.length - 1];
  if (surname) return { surname, year };
  return undefined;
}

/**
 * The publication year an in-text author-year marker cites. Scans left to right
 * but skips 4-digit numbers that are actually a page range ("pages 1929–1938")
 * or part of an arXiv id ("arXiv:1906.04043"), so the real year wins even when
 * a year-shaped page number appears earlier in the entry.
 */
function extractPublicationYear(text: string): string | undefined {
  const yearRe = /\b(?:19|20)\d{2}[a-z]?\b/g;
  let m: RegExpExecArray | null;
  while ((m = yearRe.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 2), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 2);
    if (/^\.\d/.test(after)) continue; // arXiv id fragment: 1906.04043
    if (/[-–]\s*$/.test(before)) continue; // page-range end: 1929–[1938]
    if (/^\s*[-–]\s*\d/.test(after)) continue; // page-range start: [1929]–1938
    return m[0];
  }
  return undefined;
}
