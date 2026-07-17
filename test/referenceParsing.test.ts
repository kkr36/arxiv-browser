/**
 * Run: `npm run test:references`
 *
 * Regression tests for reference-text parsing against real entries from the
 * sample papers (notably arXiv:2503.18962, whose LaTeX PDF produces detached
 * accents and web-only references):
 *  - detached-diacritic repair ("W ¨uthrich" → "Wüthrich"),
 *  - title guessing (accent-broken author lists, trailing ", 2025" years),
 *  - reference URL extraction (URLs split across lines by PDF wrapping),
 *  - readable-content extraction for the in-app web page view.
 */
import { repairDetachedDiacritics } from "../src/core/pdf/repairDiacritics";
import { guessTitle } from "../src/core/semanticScholar/client";
import { extractReferenceUrl } from "../src/core/metadata/identifiers";
import { extractAuthorYearKey } from "../src/core/citations/parseBibliography";
import { extractReadableContent } from "../src/core/web/fetchWebPage";

let failures = 0;
const fail = (name: string, msg: string) => {
  failures++;
  console.error(`  ✗ ${name}\n      ${msg}`);
};
const pass = (name: string) => console.log(`  ✓ ${name}`);
const expectEqual = (name: string, actual: unknown, expected: unknown) => {
  if (actual === expected) pass(name);
  else fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

console.log("detached-diacritic repair:");
expectEqual("diaeresis mid-surname", repairDetachedDiacritics("W ¨uthrich, M."), "Wüthrich, M.");
expectEqual(
  "acute in double surname",
  repairDetachedDiacritics("S ´anchez-Fern ´andez, L."),
  "Sánchez-Fernández, L.",
);
expectEqual("caron", repairDetachedDiacritics("Peke ˇc, A."), "Pekeč, A.");
expectEqual("grave", repairDetachedDiacritics("M `arquez, L."), "Màrquez, L.");
expectEqual("trailing accented letter", repairDetachedDiacritics("Erkkil ¨a, T."), "Erkkilä, T.");
expectEqual(
  "uppercase accented word keeps its boundary",
  repairDetachedDiacritics("the ¨Uber paper"),
  "the Über paper",
);
expectEqual("plain text untouched", repairDetachedDiacritics("Smith and Jones, 2020"), "Smith and Jones, 2020");
expectEqual(
  "backtick quoting untouched",
  repairDetachedDiacritics("run `make` to build"),
  "run `make` to build",
);

console.log("\nbibliography keys from repaired text:");
{
  const key = extractAuthorYearKey(
    repairDetachedDiacritics(
      "B ¨achtiger, A., Dryzek, J. S., Mansbridge, J., and Warren, M. E. The Oxford Handbook of Deliberative Democracy. Oxford University Press, 2018.",
    ),
  );
  expectEqual("Bächtiger surname", key?.surname, "Bächtiger");
  expectEqual("Bächtiger year", key?.year, "2018");
}

console.log("\ntitle guessing:");
// The Halpern reference whose broken "W ¨uthrich" previously polluted the
// title guess, sending every downstream matcher after the wrong paper.
const HALPERN_RAW =
  "Halpern, D., Kehne, G., Procaccia, A. D., Tucker-Foltz, J., and Wüthrich, M. Representation with Incomplete Votes. In Proceedings of the AAAI Conference on Artificial Intelligence, pp. 5657–5664, 2023.";
expectEqual("AAAI entry (Halpern 2023)", guessTitle(HALPERN_RAW), "Representation with Incomplete Votes");

// A web-only reference: the title must not keep the ", 2025" tail (it made
// scholarly search return unrelated papers).
const META_RAW =
  "Meta. Community Notes: A New Way to Add Context to Posts , 2025. URL https://transparency.meta. com/features/community-notes. Meta Transparency Center.";
expectEqual(
  "web reference (Meta 2025) drops trailing year",
  guessTitle(META_RAW),
  "Community Notes: A New Way to Add Context to Posts",
);

console.log("\nreference URL extraction:");
expectEqual(
  "URL split by PDF line wrap is rejoined",
  extractReferenceUrl(META_RAW),
  "https://transparency.meta.com/features/community-notes",
);
expectEqual(
  "path split after slash is rejoined",
  extractReferenceUrl(
    "TikTok. Testing a new feature, 2025. URL https://newsroom.tiktok.com/ en-us/footnotes. TikTok Newsroom.",
  ),
  "https://newsroom.tiktok.com/en-us/footnotes",
);
expectEqual(
  "prose after the URL is not glued on",
  extractReferenceUrl("See https://example.com/report. Second sentence here."),
  "https://example.com/report",
);
expectEqual("no URL yields null", extractReferenceUrl("Smith, J. Some Paper. JMLR, 2020."), null);

console.log("\nweb page content extraction:");
{
  const page = extractReadableContent(
    "https://example.com/post",
    `<html><head><title>Community Notes: A New Way to Add Context</title>
      <meta property="og:site_name" content="Meta Transparency Center"/>
      <meta property="og:description" content="A new way to add context to posts."/>
      <style>.x{color:red}</style><script>var x=1;</script></head>
      <body><nav><li>Home</li><li>About</li></nav>
      <h2>How it works</h2>
      <p>Contributors can write and rate notes, and notes are only published when
      enough contributors from different perspectives agree.</p></body></html>`,
  );
  expectEqual("title", page.title, "Community Notes: A New Way to Add Context");
  expectEqual("site name", page.siteName, "Meta Transparency Center");
  expectEqual("description", page.description, "A new way to add context to posts.");
  expectEqual("heading extracted", page.blocks[0]?.text, "How it works");
  expectEqual(
    "paragraph extracted, nav chrome skipped",
    page.blocks[1]?.text.startsWith("Contributors can write") && page.blocks.length === 2,
    true,
  );
}

if (failures > 0) {
  console.error(`\n${failures} failing case(s)\n`);
  process.exit(1);
}
console.log("\nall reference parsing tests passed\n");
