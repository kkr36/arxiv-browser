import type { PDFDocumentProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import type { PageText } from "../types";

export async function extractAllPageText(
  doc: PDFDocumentProxy,
): Promise<PageText[]> {
  const pages: PageText[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();

    let text = "";
    const items: PageText["items"] = [];

    for (const raw of content.items) {
      const item = raw as TextItem;
      const str = item.str ?? "";
      const start = text.length;
      text += str;
      const end = text.length;
      items.push({
        str,
        start,
        end,
        x: item.transform[4],
        y: item.transform[5],
        hasEOL: !!item.hasEOL,
      });
      if (item.hasEOL) text += "\n";
    }

    pages.push({ pageNumber, text, items, textContent: content });
  }

  return pages;
}
