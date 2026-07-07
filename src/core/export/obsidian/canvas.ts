import type { SessionExport, SessionExportNode } from "../sessionExport";

/**
 * JSON Canvas 1.0 (jsoncanvas.org) rendering of the session: one file card
 * per note, positioned from the panel layout (manual drags included), edges
 * top-to-bottom matching the panel's geometry.
 *
 * Card `file` paths are vault-root-relative, so they resolve when the export
 * folder sits at the vault root (stated in the bundled README). Falling back
 * to text cards with [[wikilinks]] would resolve anywhere, at the cost of the
 * nicer note-preview cards.
 */

const CARD_W = 320;
const CARD_H = 96;
// Panel node boxes are 168×42 (layoutGraph NODE_W/NODE_H); spread positions
// so the larger canvas cards keep similar spacing.
const SCALE_X = 2.2;
const SCALE_Y = 2.6;

export function buildCanvasFile(
  session: SessionExport,
  noteNames: Map<string, string>,
  root: string,
): string {
  const canvasIds = new Map(session.nodes.map((n) => [n.id, `n${n.order}`]));

  const nodes = session.nodes.map((node) => {
    const dir = node.kind === "author" ? "authors" : "papers";
    const { x, y } = canvasPosition(node);
    return {
      id: canvasIds.get(node.id)!,
      type: "file" as const,
      file: `${root}/${dir}/${noteNames.get(node.id)}.md`,
      x,
      y,
      width: CARD_W,
      height: CARD_H,
    };
  });

  const edges: object[] = [];
  for (const node of session.nodes) {
    for (const childId of node.children) {
      const toNode = canvasIds.get(childId);
      if (!toNode) continue;
      edges.push({
        id: `e${edges.length}`,
        fromNode: canvasIds.get(node.id)!,
        fromSide: "bottom",
        toNode,
        toSide: "top",
      });
    }
  }

  return JSON.stringify({ nodes, edges }, null, "\t");
}

function canvasPosition(node: SessionExportNode): { x: number; y: number } {
  if (node.position) {
    return { x: Math.round(node.position.x * SCALE_X), y: Math.round(node.position.y * SCALE_Y) };
  }
  // No layout supplied: simple two-column grid in trail order.
  return {
    x: (node.order % 2) * (CARD_W + 40),
    y: Math.floor(node.order / 2) * (CARD_H + 40),
  };
}
