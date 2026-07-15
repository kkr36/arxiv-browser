/**
 * Run: `npm run test:metadata`
 *
 * Exercises the pure mapping/validation logic of the Crossref and OpenAlex
 * clients (no network): response-shape mapping, match validation, title
 * comparison, abstract reconstruction, and author-name matching.
 */
import { normalizeTitle, titlesRoughlyEqual } from "../src/core/metadata/titleMatch";
import { guessTitle } from "../src/core/semanticScholar/client";
import { arxivIdFromDoi, extractArxivId, extractDoi } from "../src/core/metadata/identifiers";
import {
  crossrefMatchLooksRight,
  crossrefWorkToResolvedPaper,
  type CrossrefWork,
} from "../src/core/metadata/crossref";
import {
  abstractFromInvertedIndex,
  arxivIdFromOaWork,
  authorshipMatchesName,
  dedupeAuthorWorks,
  oaWorkToResolvedPaper,
  shortOpenAlexId,
  type OaWork,
} from "../src/core/metadata/openalex";

let failures = 0;
const fail = (name: string, msg: string) => {
  failures++;
  console.error(`  ✗ ${name}\n      ${msg}`);
};
const check = (name: string, cond: boolean, msg = "expected true") => {
  if (cond) console.log(`  ✓ ${name}`);
  else fail(name, msg);
};

console.log("\ntitle matching:");
check("exact after punctuation damage", titlesRoughlyEqual("Machine-generated text", "machinegenerated text"));
check("lost subtitle accepted", titlesRoughlyEqual("Strategic classification", "Strategic classification."));
check(
  "different follow-up paper rejected",
  !titlesRoughlyEqual("Strategic classification", "Strategic classification made practical"),
);
check("empty rejected", !titlesRoughlyEqual("", "anything"));
check("normalizeTitle strips accents to letters", normalizeTitle("Café-Terrace") === "caféterrace" || normalizeTitle("Café-Terrace") === "cafeterrace");

console.log("\ntitle guessing:");
check(
  "IEEE curly-quoted title (initials-first authors)",
  guessTitle(
    "A. Vaswani, N. Shazeer, N. Parmar, J. Uszkoreit, L. Jones, A. N. Gomez, L. Kaiser, and I. Polosukhin, “Attention is all you need,” tech. rep., Preprint, arXiv. Jun. 12, 2017.",
  ) === "Attention is all you need",
);
check(
  "straight-quoted title",
  guessTitle(
    'M. Hicks, J. Humphries, and J. Slater, "Chatgpt is bullshit," Ethics and Information Technology., vol. 26, pp. 1–10, 2024.',
  ) === "Chatgpt is bullshit",
);
check(
  "surname-first unquoted title still extracted",
  guessTitle("Garg, S., Wu, Y., and Lipton, Z. Strategic classification. In Proceedings of ITCS, 2016.") ===
    "Strategic classification",
);
check(
  "short quoted fragment ignored",
  guessTitle('J. Smith, “so-called” reasoning in models. Journal of AI, 2020.') !==
    "so-called",
);

console.log("\nidentifier extraction:");
check("modern arXiv id", extractArxivId("arXiv preprint arXiv:2310.05130, 2023") === "2310.05130");
check("old-style arXiv id", extractArxivId("arxiv.org/abs/cs/0112017") === "cs/0112017");
check("DOI with trailing period stripped", extractDoi("doi:10.1145/3442188.3445922.") === "10.1145/3442188.3445922");
check("arXiv DOI decodes", arxivIdFromDoi("10.48550/arXiv.1706.03762") === "1706.03762");
check("non-arXiv DOI ignored", arxivIdFromDoi("10.1145/3442188") === null);

console.log("\ncrossref mapping + validation:");
const crWork: CrossrefWork = {
  title: ["Attention Is All You Need"],
  author: [
    { given: "Ashish", family: "Vaswani" },
    { given: "Noam", family: "Shazeer" },
  ],
  DOI: "10.48550/arXiv.1706.03762",
  issued: { "date-parts": [[2017, 6]] },
  "container-title": ["Advances in Neural Information Processing Systems"],
  URL: "https://doi.org/10.48550/arXiv.1706.03762",
  abstract: "<jats:p>The dominant sequence transduction models…</jats:p>",
};
{
  const paper = crossrefWorkToResolvedPaper(crWork)!;
  check("title mapped", paper.title === "Attention Is All You Need");
  check("authors joined", paper.authors[0] === "Ashish Vaswani");
  check("year from date-parts", paper.year === 2017);
  check("venue from container-title", paper.venue === "Advances in Neural Information Processing Systems");
  check("arXiv DOI yields arXiv PDF", paper.pdfUrl === "https://arxiv.org/pdf/1706.03762.pdf" && paper.source === "arxiv");
  check("JATS abstract stripped", !!paper.abstract && !paper.abstract.includes("<"));
  check("author profiles carry paper hint", paper.authorProfiles?.[0]?.paperHint?.doi === "10.48550/arXiv.1706.03762");
}
check(
  "guessed title validates match",
  crossrefMatchLooksRight(crWork, "irrelevant", "Attention is all you need"),
);
check(
  "wrong guessed title rejects match",
  !crossrefMatchLooksRight(crWork, "irrelevant", "A totally different paper title"),
);
check(
  "no title guess: surname+year in raw text accepted",
  crossrefMatchLooksRight(crWork, "Vaswani et al. NeurIPS, 2017.", null),
);
check(
  "no title guess: missing year rejects",
  !crossrefMatchLooksRight(crWork, "Vaswani et al. NeurIPS.", null),
);

console.log("\nopenalex mapping:");
const oaWork: OaWork = {
  id: "https://openalex.org/W2741809807",
  display_name: "Attention Is All You Need",
  doi: "https://doi.org/10.48550/arXiv.1706.03762",
  publication_year: 2017,
  cited_by_count: 100000,
  authorships: [
    { author: { id: "https://openalex.org/A5103024730", display_name: "Ashish Vaswani" } },
    { author: { id: "https://openalex.org/A5021878400", display_name: "Noam Shazeer" } },
  ],
  primary_location: {
    landing_page_url: "https://arxiv.org/abs/1706.03762",
    source: { display_name: "arXiv" },
  },
  locations: [{ pdf_url: null, landing_page_url: "https://arxiv.org/abs/1706.03762" }],
  open_access: { oa_url: "https://arxiv.org/pdf/1706.03762" },
  abstract_inverted_index: { The: [0], dominant: [1], models: [2] },
};
{
  const paper = oaWorkToResolvedPaper(oaWork)!;
  check("arXiv id found via DOI", arxivIdFromOaWork(oaWork) === "1706.03762");
  check("pdf prefers arXiv", paper.pdfUrl === "https://arxiv.org/pdf/1706.03762.pdf");
  check("source arxiv", paper.source === "arxiv");
  check("abstract rebuilt in order", paper.abstract === "The dominant models");
  check("author ids shortened", paper.authorProfiles?.[0]?.openAlexAuthorId === "A5103024730");
  check("doi stripped of prefix", paper.doi === "10.48550/arXiv.1706.03762");
}
check("short id idempotent", shortOpenAlexId("A5103024730") === "A5103024730");
check(
  "inverted index handles interleaved positions",
  abstractFromInvertedIndex({ b: [1], a: [0], c: [2] }) === "a b c",
);

console.log("\nauthorship name matching:");
const authorship = { author: { display_name: "Nikhil Garg" } };
check("exact match", authorshipMatchesName(authorship, "Nikhil Garg"));
check("abbreviated given name", authorshipMatchesName(authorship, "N. Garg"));
check("diacritics ignored", authorshipMatchesName({ author: { display_name: "José Álvarez" } }, "Jose Alvarez"));
check("different surname rejected", !authorshipMatchesName(authorship, "Nikhil Gupta"));
check("different initial rejected", !authorshipMatchesName(authorship, "Mohit Garg"));

console.log("\nauthor works dedupe:");
{
  const works = dedupeAuthorWorks([
    { title: "Attention Is All You Need", year: 2017 },
    { title: "Attention is all you need.", abstract: "dup with abstract", pdfUrl: "https://x/y.pdf" },
    { title: "A Different Paper" },
  ]);
  check("duplicates collapsed", works.length === 2, `got ${works.length}`);
  check("kept record backfilled from duplicate", works[0].pdfUrl === "https://x/y.pdf" && works[0].abstract === "dup with abstract");
  check("kept record keeps own fields", works[0].year === 2017);
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall metadata client tests passed");
