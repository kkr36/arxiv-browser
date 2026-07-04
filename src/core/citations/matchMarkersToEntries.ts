import type { RawMarker } from "./detectMarkers";
import type { BibEntry, CitationMarker } from "../types";

function keyOf(surname: string, year: string): string {
  return `${surname.toLowerCase()}|${year.toLowerCase()}`;
}

/**
 * Resolves each detected marker to bibliography entry indices, and drops
 * markers that couldn't be matched to anything (nothing to hover to).
 */
export function matchMarkersToEntries(markers: RawMarker[], entries: BibEntry[]): CitationMarker[] {
  const byNumber = new Map<number, number>();
  const byAuthorYear = new Map<string, number>();
  for (const e of entries) {
    if (e.number !== undefined) byNumber.set(e.number, e.index);
    if (e.authorYearKey) byAuthorYear.set(keyOf(e.authorYearKey.surname, e.authorYearKey.year), e.index);
  }

  return markers
    .map((m) => {
      let entryIndices: number[] = [];
      if (m.refNumbers) {
        entryIndices = m.refNumbers
          .map((n) => byNumber.get(n))
          .filter((i): i is number => i !== undefined);
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
