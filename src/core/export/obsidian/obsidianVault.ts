import type { SessionExport, SessionExportNode } from "../sessionExport";
import { buildCanvasFile } from "./canvas";

/**
 * Renders a session as an Obsidian-ready folder: one Markdown note per node
 * whose "Opened from" / "Led to" wikilinks encode every graph edge (so
 * Obsidian's graph view reproduces the exploration graph), a session index
 * note, and a JSON Canvas file preserving the panel layout.
 *
 * Returns zip-relative path → file content.
 */
export function buildObsidianVault(session: SessionExport): Map<string, string> {
  const root = `Paper exploration ${session.exportedAt}`;
  const noteNames = assignNoteNames(session.nodes);
  const byId = new Map(session.nodes.map((n) => [n.id, n]));

  const files = new Map<string, string>();
  for (const node of session.nodes) {
    const dir = node.kind === "author" ? "authors" : "papers";
    files.set(`${root}/${dir}/${noteNames.get(node.id)}.md`, renderNote(node, byId, noteNames, session));
  }
  files.set(`${root}/${root}.md`, renderIndexNote(session, byId, noteNames, root));
  files.set(`${root}/${root}.canvas`, buildCanvasFile(session, noteNames, root));
  files.set(`${root}/README.md`, renderReadme(root));
  return files;
}

/**
 * Safe, unique note base names (no extension). Obsidian resolves [[wikilinks]]
 * by base name vault-wide, so uniqueness within the export is what matters.
 */
function assignNoteNames(nodes: SessionExportNode[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const node of nodes) {
    const base = sanitizeFileName(node.title) || `Untitled ${node.order + 1}`;
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i})`;
    used.add(name.toLowerCase());
    names.set(node.id, name);
  }
  return names;
}

function sanitizeFileName(title: string): string {
  return title
    .replace(/[[\]#^|\\/:*?"<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
}

/** Wikilink to a node, aliased with the full title when the filename differs. */
function wikilink(node: SessionExportNode, noteNames: Map<string, string>): string {
  const name = noteNames.get(node.id) ?? node.title;
  return name === node.title ? `[[${name}]]` : `[[${name}|${escapeAlias(node.title)}]]`;
}

function escapeAlias(s: string): string {
  return s.replace(/[[\]|]/g, " ").replace(/\s+/g, " ").trim();
}

function yamlValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderNote(
  node: SessionExportNode,
  byId: Map<string, SessionExportNode>,
  noteNames: Map<string, string>,
  session: SessionExport,
): string {
  const fm: string[] = ["---"];
  fm.push(`title: ${yamlValue(node.title)}`);
  if (node.authors?.length) {
    fm.push("authors:");
    for (const a of node.authors) fm.push(`  - ${yamlValue(a)}`);
  }
  if (node.year !== undefined) fm.push(`year: ${node.year}`);
  if (node.venue) fm.push(`venue: ${yamlValue(node.venue)}`);
  fm.push(`kind: ${node.kind === "author" ? "author" : "paper"}`);
  if (node.links.custom) fm.push(`custom_url: ${node.links.custom}`);
  if (node.links.pdfUrl) fm.push(`pdf_url: ${node.links.pdfUrl}`);
  if (node.links.semanticScholarUrl) fm.push(`semantic_scholar_url: ${node.links.semanticScholarUrl}`);
  if (node.links.googleScholarUrl) fm.push(`google_scholar_url: ${node.links.googleScholarUrl}`);
  if (node.links.homepage) fm.push(`homepage: ${node.links.homepage}`);
  if (node.paperCount !== undefined) fm.push(`paper_count: ${node.paperCount}`);
  if (node.citationCount !== undefined) fm.push(`citation_count: ${node.citationCount}`);
  if (node.hIndex !== undefined) fm.push(`h_index: ${node.hIndex}`);
  fm.push(`exported: ${session.exportedAt}`);
  fm.push("tags:");
  fm.push("  - paper-exploration");
  fm.push("---");

  const body: string[] = ["", `# ${node.title}`];

  if (node.note) {
    body.push("", "## Notes");
    for (const line of node.note.split(/\r?\n/)) body.push(line);
  }

  if (node.abstract) {
    body.push("");
    body.push("> [!abstract]- Abstract");
    for (const line of node.abstract.split(/\r?\n/)) body.push(`> ${line}`);
  }

  const links: string[] = [];
  // A PDF-shaped custom link doubles as the node's pdfUrl; don't list it twice.
  if (node.links.custom && node.links.custom !== node.links.pdfUrl)
    links.push(`- [Link](${node.links.custom})`);
  if (node.links.pdfUrl) links.push(`- [PDF](${node.links.pdfUrl})`);
  if (node.links.semanticScholarUrl) links.push(`- [Semantic Scholar](${node.links.semanticScholarUrl})`);
  if (node.links.googleScholarUrl) links.push(`- [Google Scholar](${node.links.googleScholarUrl})`);
  if (node.links.homepage) links.push(`- [Homepage](${node.links.homepage})`);
  if (links.length) {
    body.push("", "## Links", ...links);
  }

  const parentLinks = node.parents
    .map((id) => byId.get(id))
    .filter((n): n is SessionExportNode => !!n)
    .map((n) => `- ${wikilink(n, noteNames)}`);
  if (parentLinks.length) body.push("", "## Opened from", ...parentLinks);

  const childLinks = node.children
    .map((id) => byId.get(id))
    .filter((n): n is SessionExportNode => !!n)
    .map((n) => `- ${wikilink(n, noteNames)}`);
  if (childLinks.length) body.push("", "## Led to", ...childLinks);

  body.push("");
  return fm.join("\n") + body.join("\n");
}

function renderIndexNote(
  session: SessionExport,
  byId: Map<string, SessionExportNode>,
  noteNames: Map<string, string>,
  root: string,
): string {
  const edgeCount = session.nodes.reduce((sum, n) => sum + n.children.length, 0);
  const lines: string[] = [
    "---",
    "kind: exploration-session",
    `date: ${session.exportedAt}`,
    `nodes: ${session.nodes.length}`,
    `edges: ${edgeCount}`,
    "tags:",
    "  - paper-exploration",
    "---",
    "",
    `# ${session.title}`,
    "",
    "Exploration trail — each nested item was opened from a citation in its parent.",
    "Nodes reached through more than one paper list every parent in their own",
    '"Opened from" section.',
    "",
  ];

  // Trail as a nested list: children indented under the first parent that
  // reached them (trail order); repeat visits are not re-listed.
  const listed = new Set<string>();
  const emit = (node: SessionExportNode, depth: number) => {
    if (listed.has(node.id)) return;
    listed.add(node.id);
    const meta = node.year !== undefined ? ` (${node.year})` : "";
    lines.push(`${"    ".repeat(depth)}- ${wikilink(node, noteNames)}${meta}`);
    for (const childId of node.children) {
      const child = byId.get(childId);
      if (child) emit(child, depth + 1);
    }
  };
  for (const node of session.nodes) emit(node, 0);

  lines.push("", `Graph view with the original layout: [[${root}.canvas|Exploration canvas]]`, "");
  return lines.join("\n");
}

function renderReadme(root: string): string {
  return [
    `# ${root}`,
    "",
    "Exported from arxiv-browser.",
    "",
    `Drop this whole folder into your Obsidian vault (at the vault root, so the`,
    `canvas file's note references resolve). Each paper/author is a note; the`,
    `"Opened from" / "Led to" links reproduce the exploration graph in Obsidian's`,
    `graph view, and \`${root}.canvas\` shows it with the original layout.`,
    "",
  ].join("\n");
}
