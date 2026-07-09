import { fetchJson } from "../net/fetchJson";
import { createThrottledQueue } from "../net/throttle";
import { isLikelyProxyHostilePdfUrl } from "../semanticScholar/resolvePaper";
import { MAILTO } from "./politeness";

// Unpaywall asks for max 10 req/s (100k/day).
const throttled = createThrottledQueue(120);

interface UnpaywallLocation {
  url_for_pdf?: string | null;
  url?: string | null;
}

interface UnpaywallResponse {
  is_oa?: boolean;
  best_oa_location?: UnpaywallLocation | null;
  oa_locations?: UnpaywallLocation[] | null;
}

/**
 * The best open-access URL Unpaywall knows for a DOI — the canonical OA
 * database, far better coverage than Semantic Scholar's openAccessPdf field.
 * Prefers direct PDF links, skips hosts that block our proxy fetches. The
 * returned URL may still be a landing page (e.g. a doi.org redirect); the
 * PDF-loading pipeline validates and rewrites those downstream.
 */
export async function findUnpaywallPdfUrl(doi: string): Promise<string | null> {
  const res = await throttled(() =>
    fetchJson<UnpaywallResponse>(
      `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(MAILTO)}`,
    ),
  );
  if (!res.ok || !res.data?.is_oa) return null;
  const locations = [res.data.best_oa_location, ...(res.data.oa_locations ?? [])];
  const candidates = locations
    .flatMap((l) => [l?.url_for_pdf, l?.url])
    .filter((u): u is string => !!u);
  return candidates.find((u) => !isLikelyProxyHostilePdfUrl(u)) ?? null;
}
