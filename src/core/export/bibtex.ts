import type { ExplorationGraph, GraphNode } from "../graph/explorationGraph";
import { trailOrder } from "./sessionExport";

/**
 * Compiles the exploration graph's paper nodes into a BibTeX file, in trail
 * order (roots first, each subtree in exploration order). Author nodes are
 * skipped. Entries are best-effort: whatever metadata the session collected
 * (title, authors, year, venue, DOI, URLs) is emitted, so even a title-only
 * placeholder node gets a citable stub.
 */
export function buildGraphBibtex(graph: ExplorationGraph): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const usedKeys = new Set<string>();
  const entries: string[] = [];
  for (const id of trailOrder(graph)) {
    const node = byId.get(id);
    if (!node || node.kind === "author") continue;
    entries.push(bibtexEntry(node, usedKeys));
  }
  return entries.length ? `${entries.join("\n\n")}\n` : "";
}

function bibtexEntry(node: GraphNode, usedKeys: Set<string>): string {
  const arxivId = arxivIdFromNode(node);
  const venue = node.venue?.trim();
  const url = citableUrl(node);

  const fields: Array<[string, string]> = [];
  fields.push(["title", `{${escapeBibtex(node.title)}}`]);
  if (node.authors?.length) {
    fields.push(["author", `{${node.authors.map(escapeBibtex).join(" and ")}}`]);
  }
  if (node.year) fields.push(["year", `{${node.year}}`]);

  let type = "misc";
  if (venue && !/^arxiv/i.test(venue)) {
    const isProceedings = /proceedings|conference|workshop|symposium|meeting/i.test(venue);
    type = isProceedings ? "inproceedings" : "article";
    fields.push([isProceedings ? "booktitle" : "journal", `{${escapeBibtex(venue)}}`]);
  } else if (arxivId) {
    fields.push(["journal", `{arXiv preprint arXiv:${arxivId}}`]);
  }
  if (arxivId) {
    fields.push(["eprint", `{${arxivId}}`]);
    fields.push(["archiveprefix", "{arXiv}"]);
  }
  if (node.doi) fields.push(["doi", `{${node.doi}}`]);
  if (url) fields.push(["url", `{${url}}`]);

  const key = uniqueCitationKey(node, arxivId, usedKeys);
  const body = fields.map(([name, value]) => `  ${name} = ${value}`).join(",\n");
  return `@${type}{${key},\n${body}\n}`;
}

function arxivIdFromNode(node: GraphNode): string | undefined {
  for (const candidate of [node.pdfUrl, node.address, node.semanticScholarUrl, node.id]) {
    const match = candidate?.match(/arxiv\.org\/(?:pdf|abs)\/([^?#]+?)(?:\.pdf)?(?:[?#]|$)/i);
    if (match) return match[1];
  }
  return undefined;
}

/** Best public link for the entry; uploaded PDFs carry data: URLs, which
 * aren't citable and are skipped. */
function citableUrl(node: GraphNode): string | undefined {
  for (const candidate of [node.pdfUrl, node.address, node.semanticScholarUrl]) {
    if (candidate && /^https?:\/\//i.test(candidate)) return candidate;
  }
  return undefined;
}

/** `vaswani2017attention`-style key from first-author surname, year, and the
 * first distinctive title word; suffixed a, b, c… on collision. */
function uniqueCitationKey(
  node: GraphNode,
  arxivId: string | undefined,
  usedKeys: Set<string>,
): string {
  const surname = asciiWord(node.authors?.[0]?.trim().split(/\s+/).at(-1) ?? "");
  const titleWord = asciiWord(
    node.title
      .split(/[^A-Za-z0-9]+/)
      .find((word) => word.length > 3 && !STOP_WORDS.has(word.toLowerCase())) ?? "",
  );
  const base =
    [surname, node.year ? String(node.year) : "", titleWord].join("") ||
    (arxivId ? `arxiv${asciiWord(arxivId)}` : "") ||
    "paper";

  let key = base;
  for (let i = 0; usedKeys.has(key); i++) {
    key = `${base}${String.fromCharCode(97 + (i % 26))}`;
  }
  usedKeys.add(key);
  return key;
}

const STOP_WORDS = new Set(["with", "from", "that", "this", "into", "over", "under", "about"]);

function asciiWord(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

/** Escapes BibTeX-special characters in free-text fields (not URLs/DOIs). */
function escapeBibtex(s: string): string {
  return s.replace(/\\/g, "\\textbackslash{}").replace(/([&%#_$])/g, "\\$1").replace(/~/g, "\\textasciitilde{}");
}
