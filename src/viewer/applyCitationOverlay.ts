import type { CitationMarker, PageTextItem } from "../core/types";

/**
 * Wraps the portions of a rendered text layer's spans that fall inside a
 * detected citation marker in a `.citation-mark` span, so they can be
 * hovered/clicked. Relies on pdf.js's guarantee that `textDivs[i]`
 * corresponds 1:1 to `textContent.items[i]` (same order, same count).
 */
export function applyCitationOverlay(
  textDivs: HTMLElement[],
  items: PageTextItem[],
  markers: CitationMarker[],
): void {
  if (markers.length === 0) return;

  for (let i = 0; i < items.length && i < textDivs.length; i++) {
    const item = items[i];
    const div = textDivs[i];
    if (!div || item.str.length === 0) continue;

    const overlapping = markers
      .map((m) => ({ m, from: Math.max(m.start, item.start), to: Math.min(m.end, item.end) }))
      .filter((o) => o.from < o.to)
      .sort((a, b) => a.from - b.from);

    if (overlapping.length === 0) continue;

    const frag = document.createDocumentFragment();
    let cursor = item.start;
    for (const { m, from, to } of overlapping) {
      if (from > cursor) {
        frag.appendChild(document.createTextNode(item.str.slice(cursor - item.start, from - item.start)));
      }
      const mark = document.createElement("span");
      mark.className = "citation-mark";
      mark.dataset.markerId = m.id;
      mark.tabIndex = 0;
      mark.textContent = item.str.slice(from - item.start, to - item.start);
      frag.appendChild(mark);
      cursor = to;
    }
    if (cursor < item.end) {
      frag.appendChild(document.createTextNode(item.str.slice(cursor - item.start)));
    }

    div.textContent = "";
    div.appendChild(frag);
    // pdf.js's per-item spans can overlap slightly at their edges; without a
    // z-index bump, a later sibling span painted on top can steal pointer
    // events away from our nested mark.
    div.classList.add("has-citation-mark");
  }
}
