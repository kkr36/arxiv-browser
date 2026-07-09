/**
 * Run: `npm run test:citations`
 *
 * Verifies inline-citation detection per style and bibliography key extraction
 * against real snippets from the sample papers (see inlineCitations.cases.ts).
 */
import { detectMarkersOnPage } from "../src/core/citations/detectMarkers";
import { matchMarkersToEntries } from "../src/core/citations/matchMarkersToEntries";
import { extractAuthorYearKey } from "../src/core/citations/parseBibliography";
import {
  DETECTION_CASES,
  KEY_CASES,
  pageOf,
  type Style,
} from "./inlineCitations.cases";

let failures = 0;
const fail = (name: string, msg: string) => {
  failures++;
  console.error(`  ✗ ${name}\n      ${msg}`);
};
const pass = (name: string) => console.log(`  ✓ ${name}`);

const idOf = (surname: string, year: string) => `${surname.toLowerCase()}|${year.toLowerCase()}`;

/**
 * Resolve `text` end to end: detect markers for `style`, then match them
 * against a bibliography built from `expect` (the works that legitimately
 * exist). Detection is deliberately liberal; matching against real references
 * is the filter, so the user-visible contract is what *resolves*.
 */
function resolve(text: string, style: Style, expect: { authorYears?: string[]; refNumbers?: number[]; authorOnly?: string[] }) {
  const entries = [
    ...(expect.authorYears ?? []).map((ay, i) => {
      const [surname, year] = ay.split("|");
      return { index: i, rawText: ay, authorYearKey: { surname, year } };
    }),
    ...(expect.refNumbers ?? []).map((n, i) => ({ index: 1000 + i, rawText: `[${n}]`, number: n })),
    ...(expect.authorOnly ?? []).map((s, i) => ({ index: 2000 + i, rawText: s, authorYearKey: { surname: s, year: "2099" } })),
  ];
  const markers = detectMarkersOnPage(pageOf(text), undefined, style);
  const matched = matchMarkersToEntries(markers, entries);
  const resolvedAY = new Set<string>();
  const resolvedRN = new Set<number>();
  const resolvedSurname = new Set<string>();
  for (const m of matched) {
    for (const ay of m.authorYears ?? []) resolvedAY.add(idOf(ay.surname, ay.year));
    for (const n of m.refNumbers ?? []) if (m.entryIndices.length) resolvedRN.add(n);
    for (const s of m.authorSurnames ?? []) if (m.entryIndices.length) resolvedSurname.add(s.toLowerCase());
  }
  return { resolvedAY, resolvedRN, resolvedSurname };
}

console.log("\ninline citation detection + resolution:");
for (const c of DETECTION_CASES) {
  const { resolvedAY, resolvedRN, resolvedSurname } = resolve(c.text, c.style, c.expect);
  const missing: string[] = [];
  for (const ay of c.expect.authorYears ?? []) if (!resolvedAY.has(ay)) missing.push(ay);
  for (const n of c.expect.refNumbers ?? []) if (!resolvedRN.has(n)) missing.push(`[${n}]`);
  for (const s of c.expect.authorOnly ?? []) if (!resolvedSurname.has(s)) missing.push(`${s} (author-only)`);
  // Forbidden works must not resolve to any reference.
  const wrong: string[] = [];
  for (const ay of c.forbid?.authorYears ?? []) if (resolvedAY.has(ay)) wrong.push(ay);
  for (const n of c.forbid?.refNumbers ?? []) if (resolvedRN.has(n)) wrong.push(`[${n}]`);
  for (const s of c.forbid?.authorOnly ?? []) if (resolvedSurname.has(s)) wrong.push(`${s} (author-only)`);

  if (missing.length === 0 && wrong.length === 0) {
    pass(c.name);
  } else {
    const parts: string[] = [];
    if (missing.length) parts.push(`did not resolve ${JSON.stringify(missing)}`);
    if (wrong.length) parts.push(`wrongly resolved ${JSON.stringify(wrong)}`);
    parts.push(`(resolvedAY=${JSON.stringify([...resolvedAY])} resolvedRN=${JSON.stringify([...resolvedRN])})`);
    fail(c.name, parts.join("; "));
  }
}

console.log("\nstyle conditioning (only the paper's own scheme is detected):");
{
  const authorYearInNumbered = detectMarkersOnPage(pageOf("as shown by (Smith et al., 2020) we"), undefined, "numbered");
  if (authorYearInNumbered.length === 0) pass("author-year forms suppressed in a numbered paper");
  else fail("style conditioning", `numbered paper produced ${JSON.stringify(authorYearInNumbered.map((m) => m.raw))}`);

  const numberedInAuthorYear = detectMarkersOnPage(pageOf("the dataset [12] was used"), undefined, "author-year");
  if (!numberedInAuthorYear.some((m) => m.refNumbers)) pass("bare [n] suppressed in an author-year paper");
  else fail("style conditioning", `author-year paper produced numbered ${JSON.stringify(numberedInAuthorYear.map((m) => m.raw))}`);
}

console.log("\nbibliography key extraction:");
for (const c of KEY_CASES) {
  const key = extractAuthorYearKey(c.rawText);
  if (!key) {
    fail(c.name, "no key extracted");
  } else if (key.surname.toLowerCase() !== c.expectSurname.toLowerCase() || key.year !== c.expectYear) {
    fail(c.name, `expected ${c.expectSurname}|${c.expectYear}, got ${key.surname}|${key.year}`);
  } else {
    pass(c.name);
  }
}

console.log("\ncross-side normalization (marker ↔ entry):");
{
  // A marker surname with an accent must resolve to an entry whose key was
  // computed from the reference text — proving both sides normalize alike.
  const markers = detectMarkersOnPage(pageOf("[Brückner et al., 2012]"), undefined, "author-year");
  const entryKey = extractAuthorYearKey(
    "Michael Brückner, Christian Kanzow, and Tobias Scheffer. Static prediction games. JMLR, 13(1):2617–2654, 2012.",
  )!;
  const matched = matchMarkersToEntries(markers, [
    { index: 0, rawText: "x", authorYearKey: entryKey },
  ]);
  if (matched.some((m) => m.entryIndices.includes(0))) pass("Brückner marker resolves to Brückner entry");
  else fail("accent normalization", `marker did not resolve to entry (entryKey=${JSON.stringify(entryKey)})`);
}

if (failures > 0) {
  console.error(`\n${failures} failing case(s)\n`);
  process.exit(1);
}
console.log("\nall citation cases passed\n");
