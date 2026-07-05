import type { ResolvedPaper } from "./types";
import { hasExtensionRuntime, sendExtensionRequest } from "../extension/runtimeBridge";

export interface PublicPdfSearchRequest {
  title?: string;
  rawText: string;
}

export interface PublicPdfSearchResult {
  pdfUrl: string;
  title?: string;
  source: "openalex" | "web-search" | "reference-url";
}

export async function findPublicPdf(
  request: PublicPdfSearchRequest,
): Promise<PublicPdfSearchResult | null> {
  if (hasExtensionRuntime()) {
    const response = await sendExtensionRequest({ type: "find-public-pdf", request });
    if (!response.ok) throw new Error(response.error);
    if (response.type !== "public-pdf") {
      throw new Error("Extension returned the wrong response type.");
    }
    return response.result;
  }

  const params = new URLSearchParams();
  if (request.title) params.set("title", request.title);
  params.set("rawText", request.rawText);

  const res = await fetch(`/api/find-public-pdf?${params.toString()}`);
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`PDF search failed (HTTP ${res.status}${detail ? `: ${detail}` : ""})`);
  }
  const data = (await res.json()) as { result?: PublicPdfSearchResult | null };
  return data.result ?? null;
}

export function paperWithFoundPdf(
  base: ResolvedPaper | null | undefined,
  result: PublicPdfSearchResult,
  fallbackTitle: string,
): ResolvedPaper {
  return {
    title: base?.title ?? result.title ?? fallbackTitle,
    abstract: base?.abstract,
    authors: base?.authors ?? [],
    year: base?.year,
    venue: base?.venue,
    semanticScholarUrl: base?.semanticScholarUrl,
    pdfUrl: result.pdfUrl,
    source: "direct-pdf",
  };
}
