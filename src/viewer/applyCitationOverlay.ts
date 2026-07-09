import type { AuthorMarker, CitationMarker, PageTextItem } from "../core/types";

type OverlayMarker =
  | (CitationMarker & { overlayKind?: "citation" })
  | (AuthorMarker & { overlayKind: "author" });

/**
 * Measures the portions of a rendered text layer's spans that fall inside a
 * detected citation marker and places clickable highlight rectangles over
 * them. Keeping pdf.js's text spans intact preserves its per-line scaling.
 */
export function applyCitationOverlay(
  textLayerDiv: HTMLElement,
  pageDiv: HTMLElement,
  textDivs: HTMLElement[],
  items: PageTextItem[],
  markers: CitationMarker[],
  authorMarkers: AuthorMarker[] = [],
): void {
  const overlayMarkers: OverlayMarker[] = [
    ...markers,
    ...authorMarkers.map((m) => ({ ...m, overlayKind: "author" as const })),
  ];
  if (overlayMarkers.length === 0) return;

  const overlayLayer = document.createElement("div");
  overlayLayer.className = "citation-overlay-layer";
  pageDiv.appendChild(overlayLayer);
  const ctx = document.createElement("canvas").getContext("2d");

  for (let i = 0; i < items.length && i < textDivs.length; i++) {
    const item = items[i];
    const div = textDivs[i];
    if (!div || item.str.length === 0) continue;
    const textNode = div.firstChild;
    if (!div.isConnected || textNode?.nodeType !== Node.TEXT_NODE) continue;
    const textLength = textNode.textContent?.length ?? 0;

    const overlapping = overlayMarkers
      .map((m) => ({ m, from: Math.max(m.start, item.start), to: Math.min(m.end, item.end) }))
      .filter((o) => o.from < o.to)
      .sort((a, b) => a.from - b.from);

    if (overlapping.length === 0) continue;

    const layerRect = textLayerDiv.getBoundingClientRect();
    const divRect = div.getBoundingClientRect();
    const text = textNode.textContent ?? "";
    for (const { m, from, to } of overlapping) {
      const startOffset = Math.min(from - item.start, textLength);
      const endOffset = Math.min(to - item.start, textLength);
      if (startOffset >= endOffset) continue;

      const rect = measureTextSlice(ctx, div, divRect, text, startOffset, endOffset);
      if (!rect || rect.width === 0 || rect.height === 0) continue;

      const mark = document.createElement("span");
      const isAuthor = m.overlayKind === "author";
      mark.className = isAuthor ? "author-mark" : "citation-mark";
      if (isAuthor) mark.dataset.authorMarkerId = m.id;
      else mark.dataset.markerId = m.id;
      mark.tabIndex = 0;
      mark.style.left = `${rect.left - layerRect.left}px`;
      mark.style.top = `${rect.top - layerRect.top}px`;
      mark.style.width = `${rect.width}px`;
      mark.style.height = `${rect.height}px`;
      overlayLayer.appendChild(mark);
    }
  }
}

interface SliceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function measureTextSlice(
  ctx: CanvasRenderingContext2D | null,
  div: HTMLElement,
  divRect: DOMRect,
  text: string,
  startOffset: number,
  endOffset: number,
): SliceRect | null {
  if (divRect.width === 0 || divRect.height === 0) return null;

  const style = getComputedStyle(div);
  const transform = style.transform;
  const isHorizontal =
    transform === "none" ||
    /^matrix\([^,]+,\s*0(?:px)?,\s*0(?:px)?,/i.test(transform);

  if (!ctx || !isHorizontal) {
    return measureRange(div.firstChild, startOffset, endOffset);
  }

  ctx.font = style.font;
  const fullWidth = ctx.measureText(text).width;
  if (fullWidth <= 0) return measureRange(div.firstChild, startOffset, endOffset);

  const prefixWidth = ctx.measureText(text.slice(0, startOffset)).width;
  const sliceWidth = ctx.measureText(text.slice(startOffset, endOffset)).width;
  const scale = divRect.width / fullWidth;

  if (style.direction === "rtl" || div.dir === "rtl") {
    return {
      left: divRect.right - (prefixWidth + sliceWidth) * scale,
      top: divRect.top,
      width: sliceWidth * scale,
      height: divRect.height,
    };
  }

  return {
    left: divRect.left + prefixWidth * scale,
    top: divRect.top,
    width: sliceWidth * scale,
    height: divRect.height,
  };
}

function measureRange(
  node: ChildNode | null,
  startOffset: number,
  endOffset: number,
): SliceRect | null {
  if (!node) return null;

  const range = document.createRange();
  range.setStart(node, startOffset);
  range.setEnd(node, endOffset);
  const rect = range.getBoundingClientRect();
  range.detach();

  return rect.width === 0 || rect.height === 0
    ? null
    : { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}
