/**
 * Run: `npm run test:bibtex`
 *
 * Exercises the BibTeX compilation of exploration graphs (no network):
 * entry types, citation keys, arXiv detection, escaping, and node skipping.
 */
import { buildGraphBibtex } from "../src/core/export/bibtex";
import type { ExplorationGraph, GraphNode } from "../src/core/graph/explorationGraph";

let failures = 0;
const fail = (name: string, msg: string) => {
  failures++;
  console.error(`  ✗ ${name}\n      ${msg}`);
};
const check = (name: string, cond: boolean, msg = "expected true") => {
  if (cond) console.log(`  ✓ ${name}`);
  else fail(name, msg);
};

const graphOf = (nodes: GraphNode[]): ExplorationGraph => ({ nodes, edges: [] });

console.log("\narXiv papers:");
{
  const bib = buildGraphBibtex(
    graphOf([
      {
        id: "https://arxiv.org/pdf/1706.03762",
        title: "Attention Is All You Need",
        pdfUrl: "https://arxiv.org/pdf/1706.03762",
        authors: ["Ashish Vaswani", "Noam Shazeer"],
        year: 2017,
        kind: "pdf",
      },
    ]),
  );
  check("misc entry with eprint", bib.includes("@misc{") && bib.includes("eprint = {1706.03762}"));
  check("arXiv journal note", bib.includes("journal = {arXiv preprint arXiv:1706.03762}"));
  check("citation key", bib.includes("@misc{vaswani2017attention,"));
  check("authors joined with and", bib.includes("author = {Ashish Vaswani and Noam Shazeer}"));
  check("url emitted", bib.includes("url = {https://arxiv.org/pdf/1706.03762}"));
}

console.log("\nvenue-based entry types:");
{
  const bib = buildGraphBibtex(
    graphOf([
      {
        id: "a",
        title: "Some Conference Paper",
        authors: ["Ada Lovelace"],
        year: 2020,
        venue: "Proceedings of the 37th International Conference on Machine Learning",
        kind: "external",
      },
      {
        id: "b",
        title: "Some Journal Paper",
        authors: ["Alan Turing"],
        year: 1950,
        venue: "Mind",
        doi: "10.1093/mind/LIX.236.433",
        kind: "external",
      },
    ]),
  );
  check("proceedings venue → @inproceedings + booktitle", bib.includes("@inproceedings{lovelace2020some,") && bib.includes("booktitle = {Proceedings of the 37th"));
  check("journal venue → @article + journal", bib.includes("@article{turing1950some,") && bib.includes("journal = {Mind}"));
  check("doi emitted", bib.includes("doi = {10.1093/mind/LIX.236.433}"));
}

console.log("\nedge cases:");
{
  const bib = buildGraphBibtex(
    graphOf([
      { id: "author-node", title: "Yoshua Bengio", kind: "author" },
      { id: "t1", title: "Placeholder & Título_1", kind: "external" },
      { id: "up", title: "upload.pdf paper", pdfUrl: "data:application/pdf;base64,AAAA", kind: "pdf" },
      { id: "dup1", title: "Same Title", authors: ["Jane Doe"], year: 2021, kind: "external" },
      { id: "dup2", title: "Same Title", authors: ["Jane Doe"], year: 2021, kind: "external" },
    ]),
  );
  check("author nodes skipped", !bib.includes("Yoshua Bengio"));
  check("special chars escaped", bib.includes("Placeholder \\& T") && bib.includes("\\_1"));
  check("data: URLs not cited", !bib.includes("url = {data:"));
  check(
    "duplicate keys deduped",
    bib.includes("@misc{doe2021same,") && bib.includes("@misc{doe2021samea,"),
  );
  check("title-only node still emitted", bib.includes("title = {Placeholder"));
}

console.log("\nempty graph:");
check("empty graph → empty string", buildGraphBibtex(graphOf([])) === "");

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll bibtex tests passed.");
