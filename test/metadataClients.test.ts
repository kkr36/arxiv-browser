/**
 * Run: `npm run test:metadata`
 *
 * Exercises the pure mapping/validation logic of the Crossref and OpenAlex
 * clients (no network): response-shape mapping, match validation, title
 * comparison, abstract reconstruction, and author-name matching.
 */
import { normalizeTitle, titlesRoughlyEqual } from "../src/core/metadata/titleMatch";
import { detectAuthorMarkers, extractAuthorCandidates } from "../src/core/authors/detectAuthorMarkers";
import { maybeKnownPaperUrl, resolveKnownPaperPdfUrl } from "../src/core/pdfSources";
import { guessTitle } from "../src/core/semanticScholar/client";
import { arxivIdFromDoi, extractArxivId, extractDoi } from "../src/core/metadata/identifiers";
import type { PageText } from "../src/core/types";
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
check(
  "FAccT given-name reference title",
  guessTitle(
    "Maarten Buyl, Hadi Khalaf, Claudio Mayrink Verdun, Lucas Monteiro Paes, Caio Cesar Vieira Machado, and Flavio du Pin Calmon. AI Alignment at Your Discretion. In Proceedings of the 2025 ACM Conference on Fairness, Accountability, and Transparency, 2025. 2",
  ) === "AI Alignment at Your Discretion",
);
check(
  "ICLR reference title",
  guessTitle(
    "Gihoon Kim and Euntai Kim. Swap-Guided Preference Learning for Personalized Reinforcement Learning from Human Feedback. In The Fourteenth International Conference on Learning Representations, 2026. 17",
  ) === "Swap-Guided Preference Learning for Personalized Reinforcement Learning from Human Feedback",
);
check(
  "ACL reference title",
  guessTitle(
    "Thom Lake, Eunsol Choi, and Greg Durrett. From Distributional to Overton Pluralism: Investigating Large Language Model Alignment. In Proceedings of the 2025 Conference of the Nations of the Americas Chapter of the Association for Computational Linguistics: Human Language Technologies (Volume 1: Long Papers), 2025. 16",
  ) === "From Distributional to Overton Pluralism: Investigating Large Language Model Alignment",
);

console.log("\nidentifier extraction:");
check("modern arXiv id", extractArxivId("arXiv preprint arXiv:2310.05130, 2023") === "2310.05130");
check("old-style arXiv id", extractArxivId("arxiv.org/abs/cs/0112017") === "cs/0112017");
check("DOI with trailing period stripped", extractDoi("doi:10.1145/3442188.3445922.") === "10.1145/3442188.3445922");
check("arXiv DOI decodes", arxivIdFromDoi("10.48550/arXiv.1706.03762") === "1706.03762");
check("non-arXiv DOI ignored", arxivIdFromDoi("10.1145/3442188") === null);

console.log("\nknown PDF sources:");
check(
  "NBER conference PDF kept fetchable",
  resolveKnownPaperPdfUrl("https://conference.nber.org/conf_papers/f243813.pdf") ===
    "https://conference.nber.org/conf_papers/f243813.pdf",
);
check(
  "NBER conference paper id normalized",
  resolveKnownPaperPdfUrl("https://conference.nber.org/conf_papers/f243813") ===
    "https://conference.nber.org/conf_papers/f243813.pdf",
);
check(
  "NBER conference host recognized",
  maybeKnownPaperUrl("https://conference.nber.org/conf_papers/f243813.pdf"),
);
check(
  "ACL Anthology page normalized to PDF",
  resolveKnownPaperPdfUrl("https://aclanthology.org/2025.naacl-long.346/") ===
    "https://aclanthology.org/2025.naacl-long.346.pdf",
);
check(
  "ACL Anthology DOI normalized to PDF",
  resolveKnownPaperPdfUrl("https://doi.org/10.18653/v1/2025.naacl-long.346") ===
    "https://aclanthology.org/2025.naacl-long.346.pdf",
);
check("ACL Anthology DOI host recognized", maybeKnownPaperUrl("https://doi.org/10.18653/v1/2025.naacl-long.346"));
check(
  "OpenReview forum normalized to PDF",
  resolveKnownPaperPdfUrl("https://openreview.net/forum?id=pOq9vDIYev") ===
    "https://openreview.net/pdf?id=pOq9vDIYev",
);
check("OpenReview host recognized", maybeKnownPaperUrl("https://openreview.net/forum?id=pOq9vDIYev"));

console.log("\nauthor extraction:");
{
  const page = pageFromLines([
    ["AI Alignment From Social Choice Perspectives", 18],
    ["DANIEL HALPERN", 10],
    ["Google Research", 9],
    ["EVI MICHA", 10],
    ["University of Southern California", 9],
    ["ARIEL D. PROCACCIA", 10],
    ["Harvard University", 9],
    ["BENJAMIN SCHIFFER", 10],
    ["Harvard University", 9],
    ["ITAI SHAPIRA", 10],
    ["Harvard University", 9],
    ["and", 10],
    ["SHIRLEY ZHANG", 10],
    ["Harvard University", 9],
    ["Alignment from human feedback uses human judgments about model outputs.", 9],
    ["1. INTRODUCTION", 12],
  ]);
  const names = extractAuthorCandidates([page]).map((author) => author.name);
  check(
    "stacked all-caps affiliation authors extracted",
    names.join("|") ===
      "Daniel Halpern|Evi Micha|Ariel D. Procaccia|Benjamin Schiffer|Itai Shapira|Shirley Zhang",
    names.join(", "),
  );
  const markers = detectAuthorMarkers([page], []);
  const rawMarkedNames = (markers.get(1) ?? []).map((marker) => marker.raw).join("|");
  check(
    "stacked all-caps authors get green markers",
    rawMarkedNames ===
      "DANIEL HALPERN|EVI MICHA|ARIEL D. PROCACCIA|BENJAMIN SCHIFFER|ITAI SHAPIRA|SHIRLEY ZHANG",
    rawMarkedNames,
  );
}
{
  // ACM PACM layout (arXiv:2310.10858): no "Abstract" heading, affiliation on
  // the same line as each all-caps name, and the 20pt rotated arXiv stamp is
  // the largest font on the page.
  const page = pageFromLines([
    ["Designing Shared Information Displays for Agents of Varying", 14.3],
    ["Strategic Sophistication", 14.3],
    ["DONGPING ZHANG, Northwestern University, USA", 10.9],
    ["JASON HARTLINE, Northwestern University, USA", 10.9],
    ["JESSICA HULLMAN, Northwestern University, USA", 10.9],
    ["Data-driven predictions are often perceived as inaccurate in hindsight due to behavioral responses.", 9],
    ["1 INTRODUCTION", 10],
    ["arXiv:2310.10858v3 [cs.HC] 26 Apr 2024", 20],
  ]);
  const names = extractAuthorCandidates([page]).map((author) => author.name);
  check(
    "inline-affiliation authors extracted despite arXiv stamp font",
    names.join("|") === "Dongping Zhang|Jason Hartline|Jessica Hullman",
    names.join(", "),
  );
}

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
{
  const paper = crossrefWorkToResolvedPaper({
    title: ["From Distributional to Overton Pluralism: Investigating Large Language Model Alignment"],
    DOI: "10.18653/v1/2025.naacl-long.346",
    URL: "https://doi.org/10.18653/v1/2025.naacl-long.346",
  })!;
  check("ACL DOI yields anthology PDF", paper.pdfUrl === "https://aclanthology.org/2025.naacl-long.346.pdf");
  check("ACL DOI source direct PDF", paper.source === "direct-pdf");
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
{
  const paper = oaWorkToResolvedPaper({
    display_name: "Diverse Preference Learning for Capabilities and Alignment",
    primary_location: {
      landing_page_url: "https://openreview.net/forum?id=pOq9vDIYev",
      source: { display_name: "ICLR" },
    },
  })!;
  check("OpenAlex OpenReview landing page yields PDF", paper.pdfUrl === "https://openreview.net/pdf?id=pOq9vDIYev");
  check("OpenAlex OpenReview source direct PDF", paper.source === "direct-pdf");
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

function pageFromLines(lines: Array<[text: string, fontSize: number]>): PageText {
  let text = "";
  let y = 760;
  const items: PageText["items"] = [];
  for (const [line, fontSize] of lines) {
    const start = text.length;
    text += line;
    const end = text.length;
    items.push({ str: line, start, end, x: 48, y, fontSize, hasEOL: true });
    text += "\n";
    y -= 14;
  }
  return { pageNumber: 1, text, items };
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall metadata client tests passed");
