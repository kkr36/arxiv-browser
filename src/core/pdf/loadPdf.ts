import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

// Vite-friendly worker URL resolution (no bundler-specific `?url` suffix needed).
const workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export async function loadPdfDocument(
  bytes: ArrayBuffer,
): Promise<PDFDocumentProxy> {
  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  return loadingTask.promise;
}

export { pdfjsLib };
