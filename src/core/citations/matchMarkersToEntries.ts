import type { RawMarker } from "./detectMarkers";
import type { BibEntry, CitationMarker } from "../types";

function keyOf(surname: string, year: string): string {
  return `${normalizeSurname(surname)}|${year.toLowerCase()}`;
}

function normalizeSurname(surname: string): string {
  return surname
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}0-9]+/gu, "")
    .toLowerCase();
}

function normalizeCitationKey(key: string): string {
  return key.replace(/[^\p{L}0-9]+/gu, "").toLowerCase();
}

/**
 * Resolves each detected marker to bibliography entry indices, and drops
 * markers that couldn't be matched to anything (nothing to hover to).
 */
export function matchMarkersToEntries(markers: RawMarker[], entries: BibEntry[]): CitationMarker[] {
  const byNumber = new Map<number, number>();
  const byCitationKey = new Map<string, number>();
  const byAuthorYear = new Map<string, number>();
  for (const e of entries) {
    if (e.number !== undefined && !byNumber.has(e.number)) byNumber.set(e.number, e.index);
    if (e.citationKey) {
      const key = normalizeCitationKey(e.citationKey);
      if (key && !byCitationKey.has(key)) byCitationKey.set(key, e.index);
    }
    if (e.authorYearKey) {
      const key = keyOf(e.authorYearKey.surname, e.authorYearKey.year);
      if (!byAuthorYear.has(key)) byAuthorYear.set(key, e.index);
    }
  }

  return markers
    .map((m) => {
      let entryIndices: number[] = [];
      if (m.refNumbers) {
        entryIndices = m.refNumbers
          .map((n) => byNumber.get(n))
          .filter((i): i is number => i !== undefined);
      } else if (m.citationKeys) {
        entryIndices = [
          ...new Set(
            m.citationKeys
              .map((key) => byCitationKey.get(normalizeCitationKey(key)))
              .filter((i): i is number => i !== undefined),
          ),
        ];
      } else if (m.authorYears) {
        entryIndices = [
          ...new Set(
            m.authorYears
              .map((ay) => byAuthorYear.get(keyOf(ay.surname, ay.year)))
              .filter((i): i is number => i !== undefined),
          ),
        ];
      }
      return { ...m, entryIndices };
    })
    .filter((m) => m.entryIndices.length > 0);
}
