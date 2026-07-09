import type { BibEntry, PageText } from "../src/core/types";

/**
 * Real in-text citation contexts pulled from the sample papers, each paired
 * with the works it must resolve to. These encode the behaviour the viewer
 * needs per citation *style* — add a row here whenever a paper surfaces a form
 * the detector should handle.
 *
 * Papers:
 *  - NeurIPS 2023 d3602fc… "Improved Bayes Risk…" — bracketed author-year,
 *    comma-separated multi-cites, narrative "Author [year, year]".
 *  - arXiv:2312.09841 "Monoculture in Matching Markets" — parenthetical
 *    author-year, semicolon-separated, narrative "Author et al. (year)".
 *  - arXiv:1706.03762 "Attention Is All You Need" — numbered [n].
 *  - arXiv:2601.20920 "Do LLMs Favor LLMs?" — numbered, incl. "Author [n]".
 */

export type Style = "numbered" | "author-year" | "alpha";

export interface Expected {
  /** author-year works this text must yield, as "surname|year" (lower-cased). */
  authorYears?: string[];
  /** numbered refs this text must yield. */
  refNumbers?: number[];
  /** author-only mentions (no year) that must resolve, as lower-cased surname. */
  authorOnly?: string[];
}

export interface DetectionCase {
  name: string;
  style: Style;
  text: string;
  expect: Expected;
  /** author-year/number identifiers that must NOT be produced (false positives). */
  forbid?: Expected;
}

export const DETECTION_CASES: DetectionCase[] = [
  // ---- NeurIPS: bracketed author-year, comma-separated multi-cites ----
  {
    name: "neurips: three works, comma-separated in one bracket",
    style: "author-year",
    text:
      "increasing the number of model parameters [Kaplan et al., 2020, Sharma and Kaplan, 2020, Bahri et al., 2021] and amount of data",
    expect: { authorYears: ["kaplan|2020", "sharma|2020", "bahri|2021"] },
  },
  {
    name: "neurips: comma-separated across a line break",
    style: "author-year",
    text:
      "algorithms that do not directly optimize for market share [Ginart et al., 2021,\nKwon et al., 2022, Dean et al., 2022], competition",
    expect: { authorYears: ["ginart|2021", "kwon|2022", "dean|2022"] },
  },
  {
    name: "neurips: three works incl. 'A and B' inside comma list",
    style: "author-year",
    text:
      "recommendation algorithm [Carroll et al., 2022, Dean and Morgenstern, 2022, Curmei et al., 2022], strategic adaptation",
    expect: { authorYears: ["carroll|2022", "dean|2022", "curmei|2022"] },
  },
  {
    name: "neurips: same author cited for two years",
    style: "author-year",
    text: "the long-term impact of algorithmic decisions [Liu et al., 2018, 2020].",
    expect: { authorYears: ["liu|2018", "liu|2020"] },
  },
  {
    name: "neurips: single bracketed cite",
    style: "author-year",
    text: "between algorithms dueling for a user [Immorlica et al., 2011]. Our work",
    expect: { authorYears: ["immorlica|2011"] },
  },
  {
    name: "neurips: editorial prefix 'see, e.g.,' then comma list",
    style: "author-year",
    text:
      "the emerging area of platform competition [see, e.g., Jullien and Sand-Zantman, 2021, Calvano and Polo, 2021].",
    expect: { authorYears: ["jullien|2021", "calvano|2021"] },
  },
  {
    name: "neurips: narrative author with two bracketed years",
    style: "author-year",
    text: "shares similarities with Ben-Porat and Tennenholtz [2017, 2019], who studied",
    expect: { authorYears: ["ben-porat|2017", "ben-porat|2019"] },
  },
  {
    name: "neurips: narrative 'et al.' with bracketed year",
    style: "author-year",
    text: "However, Feng et al. [2019] focus on the equilibrium strategies",
    expect: { authorYears: ["feng|2019"] },
  },
  {
    name: "neurips: accented surname in bracket",
    style: "author-year",
    text: "strategic adaptation by users under a classifier [Brückner et al., 2012, Hardt et al., 2016],",
    expect: { authorYears: ["brückner|2012", "hardt|2016"] },
  },
  {
    name: "neurips: '(NeurIPS 2023)' venue tag must not resolve as a cite",
    style: "author-year",
    text: "37th Conference on Neural Information Processing Systems (NeurIPS 2023).",
    expect: {},
    forbid: { authorYears: ["neurips|2023", "nips|2023"] },
  },

  // ---- arXiv:2403.07183: \citet / \citeauthor narrative forms ----
  {
    name: "citet: 'Author et al. (year)' narrative resolves",
    style: "author-year",
    text: "conditional probabilities. Tulchinskii et al. (2023) show that these methods",
    expect: { authorYears: ["tulchinskii|2023"] },
  },
  {
    name: "citeauthor: author-only 'Author et al. find …' (no year) resolves by surname",
    style: "author-year",
    text: "examining individual cases of use. Bommasani et al. find that the monocultural use",
    expect: { authorOnly: ["bommasani"] },
  },
  {
    name: "citeauthor: a second author-only mention 'Cao et al.'",
    style: "author-year",
    text: "detected by evaluating hiring decisions one-by-one. Cao et al. find that prompts",
    expect: { authorOnly: ["cao"] },
  },
  {
    name: "author-only inside a parenthetical cite is not double-counted or mis-resolved",
    style: "author-year",
    text: "output homogenization (Bommasani et al., 2022; Kleinberg & Raghavan, 2021).",
    expect: { authorYears: ["bommasani|2022"] },
    forbid: { authorOnly: ["kleinberg"] },
  },
  {
    name: "author-only 'et al.' with no matching reference must not resolve",
    style: "author-year",
    text: "as many practitioners et al. have noted in passing,",
    expect: {},
    forbid: { authorOnly: ["practitioners"] },
  },

  // ---- arXiv:2312.09841: parenthetical author-year, semicolon-separated ----
  {
    name: "arxiv1: four works, semicolon-separated in parens (line break)",
    style: "author-year",
    text:
      "an applicant is denied from all opportunities (Creel and Hellman,\n2022; Bommasani et al., 2022; Toups et al., 2023; Jain et al., 2023).",
    expect: {
      authorYears: ["creel|2022", "bommasani|2022", "toups|2023", "jain|2023"],
    },
  },
  {
    name: "arxiv1: narrative 'et al.' with parenthetical year across line break",
    style: "author-year",
    text: "In the context of algorithmic classifiers, Bommasani\net al. (2022) study this",
    expect: { authorYears: ["bommasani|2022"] },
  },
  {
    name: "arxiv1: narrative 'A and B (year)'",
    style: "author-year",
    text: "Creel and Hellman (2022) argue that arbitrariness in algorithmic decision-making",
    expect: { authorYears: ["creel|2022"] },
  },

  // ---- Numbered papers: attn / arxiv2 ----
  {
    name: "attn: single numbered ref",
    style: "numbered",
    text: "encoder-decoder architectures [5]. Recent work",
    expect: { refNumbers: [5] },
  },
  {
    name: "attn: comma-separated numbered refs",
    style: "numbered",
    text: "sequence modeling and transduction problems [2, 5].",
    expect: { refNumbers: [2, 5] },
  },
  {
    name: "attn: numbered range expands",
    style: "numbered",
    text: "have been firmly established as state of the art [38, 24, 15].",
    expect: { refNumbers: [38, 24, 15] },
  },
  {
    name: "arxiv2: narrative 'Author et al. [n]'",
    style: "numbered",
    text: "Liang et al. [9] found that up to 17% of reviews",
    expect: { refNumbers: [9] },
  },
  {
    name: "numbered: a bare '(2020)' must not resolve as a numbered cite",
    style: "numbered",
    text: "as proposed in the original work (2020) we adopt",
    expect: {},
    forbid: { refNumbers: [2020] },
  },
];

/**
 * Bibliography entries (real reference text) with the author-year key each must
 * yield. Exercises accented surnames and page-range-vs-year disambiguation.
 */
export interface KeyCase {
  name: string;
  rawText: string;
  expectSurname: string;
  expectYear: string;
}

export const KEY_CASES: KeyCase[] = [
  {
    name: "accented surname stays whole (Brückner, not Br)",
    rawText:
      "Michael Brückner, Christian Kanzow, and Tobias Scheffer. Static prediction games for adversarial learning problems. JMLR, 13(1):2617–2654, 2012.",
    expectSurname: "Brückner",
    expectYear: "2012",
  },
  {
    name: "publication year wins over a year-shaped page range",
    rawText:
      "Tatsunori Hashimoto, Megha Srivastava, Hongseok Namkoong, and Percy Liang. Fairness without demographics in repeated loss minimization. In ICML, pages 1929–1938. PMLR, 10–15 Jul 2018.",
    expectSurname: "Hashimoto",
    expectYear: "2018",
  },
  {
    name: "firstname-lastname entry keys on the surname",
    rawText:
      "Harold Hotelling. Stability in competition. Economic Journal, 39(153):41–57, 1981.",
    expectSurname: "Hotelling",
    expectYear: "1981",
  },
  {
    name: "initials-first entry",
    rawText:
      "C. Toups, R. Bommasani, K. A. Creel, S. H. Bana, D. Jurafsky, and P. Liang. Ecosystem-level analysis of deployed machine learning reveals homogeneous outcomes. arXiv preprint arXiv:2307.05862, 2023.",
    expectSurname: "Toups",
    expectYear: "2023",
  },
];

/** Build a minimal PageText for the detector (only `text` + `pageNumber` are read). */
export function pageOf(text: string): PageText {
  return { pageNumber: 1, text, items: [] };
}

export function entry(
  index: number,
  fields: Partial<BibEntry> & { rawText: string },
): BibEntry {
  return { index, rawText: fields.rawText, ...fields };
}
